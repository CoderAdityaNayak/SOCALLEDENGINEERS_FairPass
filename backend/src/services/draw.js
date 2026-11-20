// Commit-reveal lottery draw and minting to winners.
//
// When the lottery opens, the organiser commits to a random seed by publishing sha256(seed).
// At the draw the seed is revealed and every entry gets key = sha256(seed + ":" + entryId).
// Entries sorted by key ascending = the draw order. Anyone can recompute it from the public proof,
// and the organiser can't pick a seed after seeing the entries because the hash was public first.
import crypto from 'node:crypto'
import { db, logActivity } from '../db.js'
import { getUser } from './users.js'
import { mintToUser } from './tickets.js'

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
export const drawKey = (seed, entryId) => sha256(`${seed}:${entryId}`)

/** Entries in draw order. */
export function drawOrder(seed, entries) {
  return entries
    .map((e) => ({ ...e, drawKey: drawKey(seed, e.id) }))
    .sort((a, b) => (a.drawKey < b.drawKey ? -1 : a.drawKey > b.drawKey ? 1 : a.id - b.id))
}

/**
 * Runs the draw (once). Walks entries in draw order giving each the quantity it asked for while the
 * lottery allocation lasts. The entry where supply runs out gets what's left (status 'partial'; the rest of
 * its quantity waits on the waitlist); everyone after that is waitlisted, in draw order.
 */
export function runDraw(event) {
  if (event.drawnAt) throw Object.assign(new Error('The draw already happened'), { status: 409 })
  if (sha256(event.seed) !== event.seedHash) throw new Error('Seed does not match the committed hash')

  const entries = db.prepare("SELECT * FROM entries WHERE eventId = ? AND status = 'entered' ORDER BY id").all(event.id)
  const ordered = drawOrder(event.seed, entries)
  let remaining = event.lotteryTickets
  let winners = 0
  let partial = 0
  let waitlist = 0
  const update = db.prepare('UPDATE entries SET status = ?, ticketsWon = ?, drawRank = ?, drawKey = ? WHERE id = ?')

  db.transaction(() => {
    ordered.forEach((e, i) => {
      const given = Math.min(e.quantity, remaining)
      remaining -= given
      const status = given === e.quantity ? 'won' : given > 0 ? 'partial' : 'waitlist'
      if (status === 'won') winners++
      else if (status === 'partial') partial++
      else waitlist++
      update.run(status, given, i + 1, e.drawKey, e.id)
    })
    const now = new Date().toISOString()
    db.prepare('UPDATE events SET drawnAt = ?, lotteryClose = MIN(lotteryClose, ?) WHERE id = ?').run(now, now, event.id)
  })()

  const ticketsAllocated = event.lotteryTickets - remaining
  logActivity({ eventId: event.id, kind: 'draw', detail: `${winners} won, ${partial} partial, ${waitlist} waitlisted, ${ticketsAllocated} tickets` })
  return { entries: entries.length, winners, partial, waitlist, ticketsAllocated }
}

/** Minting progress per event, for the dashboard. */
export const mintProgress = new Map()

/**
 * Mints every ticket owed to winners that isn't minted yet (one batch transaction per winner).
 * Safe to call again after a failure. Transactions are broadcast back-to-back and confirmed in parallel.
 */
export async function mintWinners(event) {
  const owed = db
    .prepare(
      "SELECT * FROM entries WHERE eventId = ? AND status IN ('won','partial') AND ticketsMinted < ticketsWon ORDER BY drawRank",
    )
    .all(event.id)
  const total = owed.reduce((n, e) => n + (e.ticketsWon - e.ticketsMinted), 0)
  const progress = { total, done: 0, failed: 0, running: true, errors: [], startedAt: Date.now() }
  mintProgress.set(event.id, progress)

  const bump = db.prepare('UPDATE entries SET ticketsMinted = ticketsMinted + ? WHERE id = ?')
  await Promise.all(
    owed.map(async (entry) => {
      const n = entry.ticketsWon - entry.ticketsMinted
      try {
        await mintToUser(event, getUser(entry.userId), n)
        bump.run(n, entry.id)
        progress.done += n
      } catch (err) {
        progress.failed += n
        progress.errors.push(`entry ${entry.id}: ${err.message}`)
        console.error(`[draw] mint for entry ${entry.id} failed:`, err.message)
      }
    }),
  )
  progress.running = false
  progress.finishedAt = Date.now()
  return progress
}
