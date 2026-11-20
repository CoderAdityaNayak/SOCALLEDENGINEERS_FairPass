// Event listing and creation (organiser creates the event on-chain).
import crypto from 'node:crypto'
import { Router } from 'express'
import { config } from '../config.js'
import { db, logActivity } from '../db.js'
import { HttpError, loadUser, requireRole } from '../auth.js'
import * as quai from '../services/quai.js'

export const router = Router()

export const getEvent = (id) => db.prepare('SELECT * FROM events WHERE id = ?').get(id)

export function requireEvent(id) {
  const event = getEvent(Number(id))
  if (!event) throw new HttpError(404, 'Event not found')
  return event
}

/** Corporate pool is capped at 5% of supply. */
export const corporateCap = (event) => Math.floor(event.supply * 0.05)

/** Event as shown to anyone: the draw seed stays secret until the draw (commit-reveal). */
export function publicEvent(e) {
  const now = Date.now()
  const counts = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM entries WHERE eventId = @id) AS entries,
        (SELECT COUNT(*) FROM tickets WHERE eventId = @id) AS minted`,
    )
    .get({ id: e.id })
  const status = e.drawnAt
    ? 'drawn'
    : now < Date.parse(e.lotteryOpen)
      ? 'upcoming'
      : now <= Date.parse(e.lotteryClose)
        ? 'open'
        : 'closed'
  return {
    id: e.id,
    chainEventId: e.chainEventId,
    name: e.name,
    artist: e.artist,
    date: e.date,
    venue: e.venue,
    city: e.city,
    facePrice: e.facePrice,
    maxResalePrice: String((Number(e.facePrice) * (100 + e.resaleCapPct)) / 100),
    supply: e.supply,
    lotteryTickets: e.lotteryTickets,
    corporateCap: corporateCap(e),
    resaleCapPct: e.resaleCapPct,
    maxPerId: 2,
    antiBot: { scheme: 'x402 Work', profile: 'quai/sha256d-v1', guesses: config.x402Amount },
    lotteryOpen: e.lotteryOpen,
    lotteryClose: e.lotteryClose,
    lotteryStatus: status,
    seedHash: e.seedHash,
    seed: e.drawnAt ? e.seed : null,
    drawnAt: e.drawnAt,
    createTx: e.createTx ? quai.explorerTx(e.createTx) : null,
    contract: quai.explorerAddress(quai.contract.target),
    ...counts,
  }
}

router.get('/', (_req, res) => {
  const events = db.prepare('SELECT * FROM events ORDER BY date').all()
  res.json({ events: events.map(publicEvent) })
})

router.get('/:id', (req, res) => {
  const event = requireEvent(req.params.id)
  const user = loadUser(req)
  const myEntry = user
    ? db.prepare('SELECT id, quantity, status, drawRank, createdAt FROM entries WHERE eventId = ? AND userId = ?').get(event.id, user.id)
    : null
  res.json({ event: publicEvent(event), myEntry: myEntry || null })
})

/**
 * Organiser creates an event. By default this creates it on-chain (createEvent). Pass
 * `chainEventId` to link an event that already exists on-chain (e.g. the demo event from deploy.js).
 */
router.post('/', requireRole('organiser'), async (req, res) => {
  const b = req.body || {}
  const name = String(b.name || '').trim()
  const date = new Date(b.date)
  const supply = Number(b.supply)
  const facePrice = String(b.facePrice ?? '')
  const resaleCapPct = Number(b.resaleCapPct ?? 10)
  if (!name) throw new HttpError(400, 'name is required')
  if (Number.isNaN(date.getTime())) throw new HttpError(400, 'date must be a valid date')
  if (!Number.isInteger(supply) || supply < 1 || supply > 100000) throw new HttpError(400, 'supply must be 1..100000')
  if (!(Number(facePrice) > 0)) throw new HttpError(400, 'facePrice (QUAI) must be > 0')
  if (!Number.isInteger(resaleCapPct) || resaleCapPct < 0 || resaleCapPct > 100) throw new HttpError(400, 'resaleCapPct must be 0..100')

  let chainEventId = b.chainEventId ? Number(b.chainEventId) : null
  let createTx = null
  if (chainEventId) {
    const onChain = await quai.chainEvent(chainEventId)
    if (Number(onChain.maxSupply) === 0) throw new HttpError(400, `On-chain event ${chainEventId} does not exist`)
  } else {
    const created = await quai.createEvent({ name, date, facePrice, maxSupply: supply, resaleCapPct })
    chainEventId = created.chainEventId
    createTx = created.hash
  }

  // Commit-reveal: the seed is fixed now; only its hash is public until the draw.
  const seed = crypto.randomBytes(32).toString('hex')
  const seedHash = crypto.createHash('sha256').update(seed).digest('hex')
  const now = new Date()
  const lotteryOpen = b.lotteryOpen ? new Date(b.lotteryOpen) : now
  const lotteryClose = b.lotteryClose ? new Date(b.lotteryClose) : new Date(now.getTime() + 2 * 86400_000)
  const lotteryTickets = Number(b.lotteryTickets ?? supply - Math.floor(supply * 0.05))

  const info = db
    .prepare(
      `INSERT INTO events (chainEventId, name, artist, date, venue, city, facePrice, supply, lotteryTickets, resaleCapPct,
         lotteryOpen, lotteryClose, seedHash, seed, createTx)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      chainEventId,
      name,
      b.artist || null,
      date.toISOString(),
      b.venue || null,
      b.city || null,
      facePrice,
      supply,
      lotteryTickets,
      resaleCapPct,
      lotteryOpen.toISOString(),
      lotteryClose.toISOString(),
      seedHash,
      seed,
      createTx,
    )
  const event = getEvent(info.lastInsertRowid)
  logActivity({ eventId: event.id, kind: 'event_created', txHash: createTx, detail: `chainEventId ${chainEventId}` })
  res.status(201).json({ event: publicEvent(event) })
})
