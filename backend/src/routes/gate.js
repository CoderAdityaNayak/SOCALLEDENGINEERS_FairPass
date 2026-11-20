// Gate scanner: verifies a QR gate pass and checks the ticket in on-chain.
import { Router } from 'express'
import { config } from '../config.js'
import { db, logActivity } from '../db.js'
import { HttpError, requireRole } from '../auth.js'
import * as quai from '../services/quai.js'
import { getTicket, splitSeat } from '../services/tickets.js'
import { gatePassMessage } from '../services/gatepass.js'
import { getUser, getUserByPhone, normalizePhone } from '../services/users.js'

export const router = Router()

const CLOCK_SKEW_SECONDS = 5

function parseQr(raw) {
  try {
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw
    const tokenId = Number(p?.tokenId)
    const timestamp = Number(p?.timestamp)
    if (!Number.isSafeInteger(tokenId) || tokenId < 1 || !Number.isSafeInteger(timestamp) || typeof p.signature !== 'string')
      return null
    return { tokenId, timestamp, signature: p.signature }
  } catch {
    return null
  }
}

/**
 * POST /gate/verify {qr}: (staff or organiser)
 *   EXPIRED       QR older than 30 s (a screenshot or a forwarded image)
 *   NOT_ON_CHAIN  token was never minted by the FairPass contract (a fake ticket)
 *   NOT_OWNER     the QR was not signed by the wallet that owns the token on-chain
 *   ALREADY_USED  the ticket was already checked in
 *   VALID         all checks passed -> markUsed on-chain
 * Every check is reported so the scanner can show a pass/fail table.
 */
router.post('/gate/verify', requireRole('staff', 'organiser'), async (req, res) => {
  const qr = parseQr(req.body?.qr)
  const log = (result, tokenId = null, txHash = null) =>
    db.prepare('INSERT INTO scans (tokenId, staffId, result, txHash) VALUES (?, ?, ?, ?)').run(tokenId, req.user.id, result, txHash)

  if (!qr) {
    log('MALFORMED')
    return res.json({ result: 'MALFORMED', valid: false, message: 'This is not a FairPass QR code', checks: [] })
  }
  const now = Math.floor(Date.now() / 1000)
  const age = now - qr.timestamp
  const checks = []
  const check = (id, label, pass, detail) => checks.push({ id, label, pass, detail })

  // 1. Fresh
  const fresh = age <= config.qrMaxAgeSeconds && age >= -CLOCK_SKEW_SECONDS
  check('fresh', `QR is fresh (< ${config.qrMaxAgeSeconds}s)`, fresh, age >= 0 ? `${age}s old` : 'timestamp is in the future')

  // 2. Minted by the contract
  const owner = await quai.ownerOf(qr.tokenId)
  check('onChain', 'Ticket exists on Quai', !!owner, owner ? `token #${qr.tokenId}` : `token #${qr.tokenId} was never minted`)

  // 3. Signed by the on-chain owner
  let signer = null
  try {
    signer = quai.quais.verifyMessage(gatePassMessage(qr.tokenId, qr.timestamp), qr.signature)
  } catch {}
  const isOwner = !!owner && !!signer && signer.toLowerCase() === owner.toLowerCase()
  check('owner', 'Signed by the ticket owner', owner ? isOwner : null, owner ? (isOwner ? 'signature matches ownerOf' : 'signer is not the owner') : 'skipped')

  // 4. Not used (on-chain flag, or already checked in here and still confirming)
  const ticket = getTicket(qr.tokenId)
  const usedOnChain = owner ? await quai.isUsed(qr.tokenId) : false
  const unused = !usedOnChain && ticket?.status !== 'used'
  check('unused', 'Not used yet', owner ? unused : null, owner ? (unused ? 'first scan' : 'already checked in') : 'skipped')

  const result = !fresh ? 'EXPIRED' : !owner ? 'NOT_ON_CHAIN' : !isOwner ? 'NOT_OWNER' : !unused ? 'ALREADY_USED' : 'VALID'
  const holder = ticket?.ownerUserId ? getUser(ticket.ownerUserId) : null
  const base = {
    result,
    valid: result === 'VALID',
    tokenId: qr.tokenId,
    checks,
    holderName: holder?.name || null,
    seat: ticket ? { label: ticket.seat, ...splitSeat(ticket.seat) } : null,
    eventId: ticket?.eventId ?? null,
  }
  if (result !== 'VALID') {
    log(result, qr.tokenId)
    return res.json(base)
  }

  // Lock in the DB first (synchronous, so two scanners can't both pass), then mark used on-chain.
  const locked = db.prepare("UPDATE tickets SET status = 'used', listedPrice = NULL WHERE tokenId = ? AND status != 'used'").run(qr.tokenId)
  if (ticket && locked.changes === 0) {
    log('ALREADY_USED', qr.tokenId)
    return res.json({ ...base, result: 'ALREADY_USED', valid: false })
  }
  let sent
  try {
    sent = await quai.markUsedFast(qr.tokenId)
  } catch (err) {
    if (ticket) db.prepare('UPDATE tickets SET status = ? WHERE tokenId = ?').run(ticket.status, qr.tokenId)
    if (err.reason === 'TicketAlreadyUsed') {
      log('ALREADY_USED', qr.tokenId)
      return res.json({ ...base, result: 'ALREADY_USED', valid: false })
    }
    throw err
  }
  log('VALID', qr.tokenId, sent.hash)
  logActivity({ eventId: ticket?.eventId, kind: 'scanned', tokenId: qr.tokenId, userId: ticket?.ownerUserId, txHash: sent.hash })
  sent.confirmed.catch((err) => console.error(`[gate] markUsed ${qr.tokenId} failed to confirm:`, err.message))
  res.json({ ...base, markedUsed: { txHash: sent.hash, tx: quai.explorerTx(sent.hash), status: 'broadcast' } })
})

/** GET /gate/scans: recent scans (staff dashboard). */
router.get('/gate/scans', requireRole('staff', 'organiser'), (_req, res) => {
  res.json({ scans: db.prepare('SELECT * FROM scans ORDER BY id DESC LIMIT 50').all() })
})

/** POST /staff {phone}: organiser makes a user gate staff. */
router.post('/staff', requireRole('organiser'), (req, res) => {
  const user = getUserByPhone(normalizePhone(req.body?.phone))
  if (!user) throw new HttpError(404, 'That phone has not logged in yet')
  if (user.role === 'organiser') throw new HttpError(409, 'The organiser is already allowed to scan')
  db.prepare("UPDATE users SET role = 'staff' WHERE id = ?").run(user.id)
  res.json({ ok: true })
})
