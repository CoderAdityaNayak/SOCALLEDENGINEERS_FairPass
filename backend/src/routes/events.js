// Events: listing, creation (on-chain) and the organiser-controlled resale cap.
import crypto from 'node:crypto'
import { Router } from 'express'
import { config } from '../config.js'
import { db, logActivity } from '../db.js'
import { HttpError, loadUser, requireRole } from '../auth.js'
import * as quai from '../services/quai.js'
import { faceInr, inrToWei, maxResaleInr, maxResaleWei } from '../services/money.js'

export const router = Router()

export const getEvent = (id) => db.prepare('SELECT * FROM events WHERE id = ?').get(id)

export function requireEvent(id) {
  const event = getEvent(Number(id))
  if (!event) throw new HttpError(404, 'Event not found')
  return event
}

export const INVALID_LISTING = 'invalid – above new cap'

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
    facePriceInr: faceInr(e),
    maxResalePrice: quai.quais.formatQuai(maxResaleWei(e)),
    maxResalePriceInr: maxResaleInr(e),
    inrPerQuai: config.inrPerQuai,
    supply: e.supply,
    lotteryTickets: e.lotteryTickets,
    resaleCapPct: e.resaleCapPct,
    resaleCapTx: e.resaleCapTx ? quai.explorerTx(e.resaleCapTx) : null,
    resaleCapUpdatedAt: e.resaleCapUpdatedAt,
    lotteryOpen: e.lotteryOpen,
    lotteryClose: e.lotteryClose,
    lotteryStatus: status,
    antiBot: { scheme: 'x402 Work', profile: 'quai/sha256d-v1', guesses: config.x402Amount, oneEntryPerPerson: true },
    seedHash: e.seedHash,
    seed: e.drawnAt ? e.seed : null,
    drawnAt: e.drawnAt,
    createTx: e.createTx ? quai.explorerTx(e.createTx) : null,
    contract: quai.explorerAddress(quai.contract.target),
    ...counts,
  }
}

/** GET /events: all events by date. Logged-in fans also get `myEntry` per event (null if not entered). */
router.get('/', (req, res) => {
  const user = loadUser(req)
  const mine = new Map(
    user
      ? db
          .prepare('SELECT id, eventId, quantity, ticketsWon, entryNumber, status, drawRank FROM entries WHERE userId = ?')
          .all(user.id)
          .map((e) => [e.eventId, e])
      : [],
  )
  const events = db.prepare('SELECT * FROM events ORDER BY date').all()
  res.json({ events: events.map((e) => ({ ...publicEvent(e), myEntry: user ? mine.get(e.id) || null : undefined })) })
})

router.get('/:id', (req, res) => {
  const event = requireEvent(req.params.id)
  const user = loadUser(req)
  const myEntry = user
    ? db
        .prepare('SELECT id, quantity, ticketsWon, entryNumber, status, drawRank, createdAt FROM entries WHERE eventId = ? AND userId = ?')
        .get(event.id, user.id)
    : null
  res.json({ event: publicEvent(event), myEntry: myEntry || null })
})

function parseCap(value) {
  const pct = Number(value)
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) throw new HttpError(400, 'Resale markup must be a whole number from 0 to 100 (%)')
  return pct
}

/**
 * Organiser creates an event: on-chain createEvent with the face price (₹ → QUAI at INR_PER_QUAI) and the
 * resale markup %. Pass `chainEventId` to link an event that already exists on-chain (e.g. from deploy.js).
 */
router.post('/', requireRole('organiser'), async (req, res) => {
  const b = req.body || {}
  const name = String(b.name || '').trim()
  const date = new Date(b.date)
  const supply = Number(b.supply)
  const resaleCapPct = parseCap(b.resaleCapPct ?? 10)
  if (!name) throw new HttpError(400, 'Event name is required')
  if (Number.isNaN(date.getTime())) throw new HttpError(400, 'Enter a valid event date')
  if (!Number.isInteger(supply) || supply < 1 || supply > 100000) throw new HttpError(400, 'Seats must be 1 to 100,000')

  // Face price: ₹ (preferred) or QUAI.
  let facePriceInr = b.facePriceInr != null && b.facePriceInr !== '' ? Number(b.facePriceInr) : null
  let facePrice
  if (facePriceInr != null) {
    if (!(facePriceInr > 0)) throw new HttpError(400, 'Face price must be more than ₹0')
    const wei = inrToWei(facePriceInr)
    if (wei <= 0n) throw new HttpError(400, 'Face price is too small')
    facePrice = quai.quais.formatQuai(wei)
  } else {
    facePrice = String(b.facePrice ?? '')
    if (!(Number(facePrice) > 0)) throw new HttpError(400, 'Face price is required')
    facePriceInr = null // derived from QUAI when shown
  }

  const lotteryTickets = b.lotteryTickets != null && b.lotteryTickets !== '' ? Number(b.lotteryTickets) : supply
  if (!Number.isInteger(lotteryTickets) || lotteryTickets < 1 || lotteryTickets > supply)
    throw new HttpError(400, 'Tickets in the draw must be between 1 and the number of seats')

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
  // Mirror the on-chain values (a linked event keeps its own cap and price).
  const onChain = await quai.chainEvent(chainEventId)
  const chainCap = Number(onChain.resaleCapPct)
  const chainFace = quai.quais.formatQuai(onChain.facePrice)

  // Commit-reveal: the seed is fixed now; only its hash is public until the draw.
  const seed = crypto.randomBytes(32).toString('hex')
  const seedHash = crypto.createHash('sha256').update(seed).digest('hex')
  const now = new Date()
  const lotteryOpen = b.lotteryOpen ? new Date(b.lotteryOpen) : now
  const lotteryClose = b.lotteryClose ? new Date(b.lotteryClose) : new Date(now.getTime() + 2 * 86400_000)

  const info = db
    .prepare(
      `INSERT INTO events (chainEventId, name, artist, date, venue, city, facePrice, facePriceInr, supply, lotteryTickets,
         resaleCapPct, lotteryOpen, lotteryClose, seedHash, seed, createTx)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      chainEventId,
      name,
      b.artist || null,
      date.toISOString(),
      b.venue || null,
      b.city || null,
      chainFace,
      facePrice === chainFace ? facePriceInr : null,
      supply,
      lotteryTickets,
      chainCap,
      lotteryOpen.toISOString(),
      lotteryClose.toISOString(),
      seedHash,
      seed,
      createTx,
    )
  const event = getEvent(info.lastInsertRowid)
  logActivity({ eventId: event.id, kind: 'event_created', txHash: createTx, detail: `chainEventId ${chainEventId}, resale cap ${chainCap}%` })
  res.status(201).json({ event: publicEvent(event) })
})

/**
 * POST /events/:id/resale-cap {pct}: organiser changes the resale markup. Calls setResaleCap on Quai and waits
 * for confirmation, then saves the % and tx (mirrored to Firestore) and re-checks every listing: those above the
 * new maximum are marked invalid (the contract won't let anyone buy them); ones back under it become valid again.
 */
router.post('/:id/resale-cap', requireRole('organiser'), async (req, res) => {
  const event = requireEvent(req.params.id)
  const pct = parseCap(req.body?.pct)
  const oldPct = event.resaleCapPct

  const { hash } = await quai.setResaleCap(event.chainEventId, pct)
  const updatedAt = new Date().toISOString()
  db.prepare('UPDATE events SET resaleCapPct = ?, resaleCapTx = ?, resaleCapUpdatedAt = ? WHERE id = ?').run(pct, hash, updatedAt, event.id)
  logActivity({ eventId: event.id, kind: 'resale_cap', txHash: hash, detail: `${oldPct}% -> ${pct}%` })

  const updated = getEvent(event.id)
  const max = maxResaleWei(updated)
  const listings = db.prepare("SELECT tokenId, listedPrice FROM tickets WHERE eventId = ? AND status = 'listed'").all(event.id)
  const mark = db.prepare('UPDATE tickets SET listingInvalid = ? WHERE tokenId = ?')
  let invalidated = 0
  let revalidated = 0
  db.transaction(() => {
    for (const t of listings) {
      const above = quai.quais.parseQuai(t.listedPrice) > max
      const before = db.prepare('SELECT listingInvalid FROM tickets WHERE tokenId = ?').get(t.tokenId).listingInvalid
      if (above && !before) invalidated++
      if (!above && before) revalidated++
      mark.run(above ? INVALID_LISTING : null, t.tokenId)
    }
  })()

  res.json({
    event: publicEvent(updated),
    oldPct,
    pct,
    txHash: hash,
    tx: quai.explorerTx(hash),
    listingsInvalidated: invalidated,
    listingsRevalidated: revalidated,
  })
})
