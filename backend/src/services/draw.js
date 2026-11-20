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
 * Runs the draw (once). Walks entries in draw order giving each its 1 or 2 tickets while the
 * lottery allocation lasts; everyone after that joins the waitlist in draw order.
 */
export function runDraw(event) {
  if (event.drawnAt) throw Object.assign(new Error('The draw already happened'), { status: 409 })
  if (sha256(event.seed) !== event.seedHash) throw new Error('Seed does not match the committed hash')

  const entries = db.prepare("SELECT * FROM entries WHERE eventId = ? AND status = 'entered' ORDER BY id").all(event.id)
  const ordered = drawOrder(event.seed, entries)
  let remaining = event.lotteryTickets
  let winners = 0
  let waitlist = 0
  const update = db.prepare('UPDATE entries SET status = ?, drawRank = ?, drawKey = ? WHERE id = ?')

  db.transaction(() => {
    ordered.forEach((e, i) => {
      const won = e.quantity <= remaining
      if (won) {
        remaining -= e.quantity
        winners++
      } else waitlist++
      update.run(won ? 'won' : 'waitlist', i + 1, e.drawKey, e.id)
    })
    const now = new Date().toISOString()
    db.prepare('UPDATE events SET drawnAt = ?, lotteryClose = MIN(lotteryClose, ?) WHERE id = ?').run(now, now, event.id)
  })()

  logActivity({ eventId: event.id, kind: 'draw', detail: `${winners} winners, ${waitlist} waitlisted` })
  return { entries: entries.length, winners, waitlist, ticketsAllocated: event.lotteryTickets - remaining }
}

/** Minting progress per event, for the dashboard. */
export const mintProgress = new Map()

/**
 * Mints every ticket owed to winners that isn't minted yet. Safe to call again after a failure.
 * Transactions are broadcast back-to-back and confirmed in parallel (see quai.js).
 */
export async function mintWinners(event) {
  const owed = db
    .prepare("SELECT * FROM entries WHERE eventId = ? AND status = 'won' AND ticketsMinted < quantity ORDER BY drawRank")
    .all(event.id)
  const jobs = owed.flatMap((e) => Array.from({ length: e.quantity - e.ticketsMinted }, () => e))
  const progress = { total: jobs.length, done: 0, failed: 0, running: true, errors: [], startedAt: Date.now() }
  mintProgress.set(event.id, progress)

  const bump = db.prepare('UPDATE entries SET ticketsMinted = ticketsMinted + 1 WHERE id = ?')
  await Promise.all(
    jobs.map(async (entry) => {
      try {
        await mintToUser(event, getUser(entry.userId))
        bump.run(entry.id)
        progress.done++
      } catch (err) {
        progress.failed++
        progress.errors.push(`entry ${entry.id}: ${err.message}`)
        console.error(`[draw] mint for entry ${entry.id} failed:`, err.message)
      }
    }),
  )
  progress.running = false
  progress.finishedAt = Date.now()
  return progress
}
