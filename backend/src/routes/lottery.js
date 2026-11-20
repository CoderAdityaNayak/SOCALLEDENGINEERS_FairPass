// Lottery entry (anti-bot pipeline), draw, draw proof and stats.
import { Router } from 'express'
import { config } from '../config.js'
import { db, logBlocked } from '../db.js'
import { HttpError, loadUser, requireRole } from '../auth.js'
import * as x402 from '../services/x402.js'
import { overLimit } from '../services/ratelimit.js'
import { drawKey, mintProgress, mintWinners, runDraw, sha256 } from '../services/draw.js'
import { explorerTx } from '../services/quai.js'
import { publicEvent, requireEvent } from './events.js'

export const router = Router()

const DESCRIPTION = 'FairPass lottery entry'
const entryUrl = (eventId) => `${config.publicApiUrl}/events/${eventId}/enter`

/**
 * POST /events/:id/enter  { quantity: 1 | 2 }
 * Checks run cheapest-first, and every rejection is logged with its reason:
 *   lottery open -> logged in (NO_ID) -> ID verified (NOT_VERIFIED) -> one entry per ID per event across
 *   lottery + corporate pools (DUPLICATE_ENTRY) -> IP rate limit (RATE_LIMITED) -> x402 Work proof (INVALID_POW).
 * Without a proof the response is 402 + PAYMENT-REQUIRED (a puzzle bound to this account).
 */
router.post('/:id/enter', async (req, res) => {
  const event = requireEvent(req.params.id)
  const ip = req.ip
  const user = loadUser(req)
  const block = (status, reason, error, detail = null) => {
    logBlocked({ reason, ip, eventId: event.id, userId: user?.id ?? null, detail })
    throw new HttpError(status, error, { reason })
  }

  const ev = publicEvent(event)
  if (ev.lotteryStatus !== 'open') block(409, 'LOTTERY_CLOSED', `The lottery is ${ev.lotteryStatus}`)
  if (!user) block(401, 'NO_ID', 'Log in with your phone to enter')
  if (!user.isVerified || !user.idHash) block(403, 'NOT_VERIFIED', 'Verify your ID to enter')

  const quantity = Number(req.body?.quantity ?? 1)
  if (quantity !== 1 && quantity !== 2) throw new HttpError(400, 'You can request 1 or 2 tickets per ID', { reason: 'BAD_QUANTITY' })

  const already =
    db.prepare('SELECT 1 FROM entries WHERE eventId = ? AND idHash = ?').get(event.id, user.idHash) ||
    db
      .prepare(
        `SELECT 1 FROM corporate_seats s JOIN users u ON u.id = s.userId
         WHERE s.eventId = ? AND u.idHash = ?`,
      )
      .get(event.id, user.idHash)
  if (already) block(409, 'DUPLICATE_ENTRY', 'This ID already has an entry or a seat for this event')

  // DEMO_MODE only: the bot simulator tags itself so a live demo on one laptop doesn't rate-limit the
  // presenter's browser too. Outside demo mode the header is ignored (it could be spoofed).
  const demoClient = config.demoMode ? req.get('x-fairpass-demo-client') || '' : ''
  if (overLimit(`enter:${ip}:${demoClient}`, config.rateLimitPerMinute))
    block(429, 'RATE_LIMITED', 'Too many attempts from your network. Try again in a minute.')

  // Proof of work (x402 Work)
  const url = entryUrl(event.id)
  const paymentSignature = req.get('payment-signature')
  if (!paymentSignature) {
    const c = await x402.challenge({ url, description: DESCRIPTION, userId: user.id, eventId: event.id })
    return res.status(402).set(c.headers).json(c.body)
  }
  const proof = await x402.verify({ url, description: DESCRIPTION, paymentSignature, userId: user.id })
  if (!proof.ok) {
    logBlocked({ reason: proof.reason, ip, eventId: event.id, userId: user.id, detail: proof.detail })
    if (proof.retryable) {
      // A real fan's proof that went stale: hand out a fresh puzzle (standard x402 behaviour).
      const c = await x402.challenge({ url, description: DESCRIPTION, userId: user.id, eventId: event.id, error: proof.detail })
      return res.status(402).set(c.headers).json({ ...c.body, reason: proof.reason })
    }
    // Garbage, replayed or stolen proofs get no new puzzle.
    return res.status(402).json({ error: `Anti-bot check failed: ${proof.detail}`, reason: proof.reason })
  }

  let entryId
  try {
    entryId = db
      .prepare('INSERT INTO entries (userId, eventId, idHash, quantity, powRef) VALUES (?, ?, ?, ?, ?)')
      .run(user.id, event.id, user.idHash, quantity, proof.powRef).lastInsertRowid
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) block(409, 'DUPLICATE_ENTRY', 'This ID already has an entry for this event')
    throw err
  }
  const entryNumber = db.prepare('SELECT COUNT(*) n FROM entries WHERE eventId = ? AND id <= ?').get(event.id, entryId).n
  db.prepare('UPDATE entries SET entryNumber = ? WHERE id = ?').run(entryNumber, entryId)
  res
    .status(201)
    .set(proof.headers)
    .json({
      entry: { id: Number(entryId), entryNumber, quantity, status: 'entered', drawAt: event.lotteryClose },
      proofOfWork: { profile: proof.profile, guesses: Number(proof.amount), receipt: proof.receipt },
    })
})

/** POST /events/:id/draw (organiser): reveal the seed, order entries, then mint to winners in the background. */
router.post('/:id/draw', requireRole('organiser'), (req, res) => {
  const event = requireEvent(req.params.id)
  let result
  try {
    result = runDraw(event)
  } catch (err) {
    throw new HttpError(err.status || 400, err.message)
  }
  const drawn = requireEvent(event.id)
  mintWinners(drawn).catch((err) => console.error('[draw] minting failed:', err))
  res.status(202).json({ draw: result, seed: drawn.seed, seedHash: drawn.seedHash, minting: 'started' })
})

/** POST /events/:id/mint-pending (organiser): retry minting for winners whose tickets failed to mint. */
router.post('/:id/mint-pending', requireRole('organiser'), async (req, res) => {
  const event = requireEvent(req.params.id)
  if (!event.drawnAt) throw new HttpError(409, 'Run the draw first')
  if (mintProgress.get(event.id)?.running) throw new HttpError(409, 'Minting is already running')
  mintWinners(event).catch((err) => console.error('[draw] minting failed:', err))
  res.status(202).json({ minting: 'started' })
})

/** GET /events/:id/draw-proof: everything needed to verify the draw independently. */
router.get('/:id/draw-proof', (req, res) => {
  const event = requireEvent(req.params.id)
  const revealed = !!event.drawnAt
  const entries = db
    .prepare('SELECT id, quantity, status, drawRank, drawKey FROM entries WHERE eventId = ? ORDER BY ' + (revealed ? 'drawRank' : 'id'))
    .all(event.id)
  res.json({
    eventId: event.id,
    seedHash: event.seedHash,
    seed: revealed ? event.seed : null,
    drawnAt: event.drawnAt,
    lotteryTickets: event.lotteryTickets,
    algorithm:
      'Check sha256(seed) == seedHash. For each entry, key = sha256(seed + ":" + entryId) (hex). Sort entries by key ascending. ' +
      'Walk the list giving each entry its quantity while lotteryTickets remain; the rest are waitlisted in that order.',
    verified: revealed ? sha256(event.seed) === event.seedHash && entries.every((e) => e.drawKey === drawKey(event.seed, e.id)) : null,
    orderedEntryIds: entries.map((e) => e.id),
    entries,
  })
})

/** GET /events/:id/stats: numbers for the organiser dashboard. */
router.get('/:id/stats', (req, res) => {
  const event = requireEvent(req.params.id)
  const id = event.id
  const one = (sql, ...args) => db.prepare(sql).get(...args)
  const blockedRows = db
    .prepare(
      `SELECT reason, COUNT(*) n FROM blocked_attempts
       WHERE eventId = ? OR (eventId IS NULL AND reason = 'DUPLICATE_ID') GROUP BY reason ORDER BY n DESC`,
    )
    .all(id)
  // Puzzles handed out but never solved (older than a minute) = requests that never paid the work.
  const unsolved = one('SELECT COUNT(*) n FROM pow_challenges WHERE eventId = ? AND solved = 0 AND issuedAt < ?', id, Date.now() - 60_000).n
  const blocked = Object.fromEntries(blockedRows.map((r) => [r.reason, r.n]))
  if (unsolved) blocked.NO_POW_SUBMITTED = unsolved
  const activity = (kind) => one('SELECT COUNT(*) n FROM activity WHERE eventId = ? AND kind = ?', id, kind).n

  const latest = db
    .prepare(
      `SELECT * FROM (
         SELECT 'blocked' AS kind, b.reason AS result, b.ip, b.at, b.detail, u.phone FROM blocked_attempts b
           LEFT JOIN users u ON u.id = b.userId WHERE b.eventId = @id
         UNION ALL
         SELECT 'entered' AS kind, 'ENTERED' AS result, NULL, e.createdAt, 'x402 Work proof accepted', u.phone FROM entries e
           JOIN users u ON u.id = e.userId WHERE e.eventId = @id
       ) ORDER BY at DESC LIMIT 20`,
    )
    .all({ id })
    .map((r) => ({ ...r, phone: r.phone ? r.phone.slice(0, -4).replace(/\d/g, '•') + r.phone.slice(-4) : null }))

  const progress = mintProgress.get(id)
  res.json({
    event: publicEvent(event),
    entries: {
      total: one('SELECT COUNT(*) n FROM entries WHERE eventId = ?', id).n,
      ticketsRequested: one('SELECT COALESCE(SUM(quantity),0) n FROM entries WHERE eventId = ?', id).n,
      won: one("SELECT COUNT(*) n FROM entries WHERE eventId = ? AND status = 'won'", id).n,
      waitlist: one("SELECT COUNT(*) n FROM entries WHERE eventId = ? AND status = 'waitlist'", id).n,
    },
    blocked,
    blockedTotal: Object.values(blocked).reduce((a, b) => a + b, 0),
    pow: {
      issued: one('SELECT COUNT(*) n FROM pow_challenges WHERE eventId = ?', id).n,
      solved: one('SELECT COUNT(*) n FROM pow_challenges WHERE eventId = ? AND solved = 1', id).n,
      guessesPerPuzzle: config.x402Amount,
    },
    tickets: {
      minted: activity('minted'),
      forSale: one("SELECT COUNT(*) n FROM tickets WHERE eventId = ? AND status = 'listed'", id).n,
      resold: activity('resold'),
      returned: activity('returned'),
      reassigned: activity('reassigned'),
      scanned: one("SELECT COUNT(*) n FROM scans s JOIN tickets t ON t.tokenId = s.tokenId WHERE t.eventId = ? AND s.result = 'VALID'", id).n,
      corporate: one('SELECT COUNT(*) n FROM tickets WHERE eventId = ? AND corporate = 1', id).n,
    },
    scans: Object.fromEntries(
      db
        .prepare('SELECT s.result, COUNT(*) n FROM scans s LEFT JOIN tickets t ON t.tokenId = s.tokenId WHERE t.eventId = ? OR t.eventId IS NULL GROUP BY s.result')
        .all(id)
        .map((r) => [r.result, r.n]),
    ),
    minting: progress ? { ...progress, errors: progress.errors.slice(-5) } : null,
    latest,
    recentTx: db
      .prepare("SELECT kind, tokenId, txHash, at FROM activity WHERE eventId = ? AND txHash IS NOT NULL ORDER BY id DESC LIMIT 10")
      .all(id)
      .map((a) => ({ ...a, url: explorerTx(a.txHash) })),
  })
})
