// Corporate booking: a verified company books seats, each tied to one verified employee.
import { Router } from 'express'
import { db, logBlocked } from '../db.js'
import { HttpError, requireAuth, requireRole, requireVerified } from '../auth.js'
import * as quai from '../services/quai.js'
import { getTicket, mintToUser } from '../services/tickets.js'
import { reassignTo, returnTicket } from '../services/pool.js'
import { getUser, getUserByPhone, normalizePhone } from '../services/users.js'
import { registerOnUserVerified } from '../services/hooks.js'
import { corporateCap, requireEvent } from './events.js'

export const router = Router()

// ------------------------------------------------------------------ GSTIN (mock verification)

const GST_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** GSTIN: 2-digit state + PAN + entity number + 'Z' + mod-36 check character. */
export function isValidGstin(raw) {
  const g = String(raw || '').toUpperCase()
  if (!/^(0[1-9]|[1-2]\d|3[0-8])[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) return false
  let sum = 0
  for (let i = 0; i < 14; i++) {
    const product = GST_CHARS.indexOf(g[i]) * (i % 2 === 0 ? 1 : 2)
    sum += Math.floor(product / 36) + (product % 36)
  }
  return GST_CHARS[(36 - (sum % 36)) % 36] === g[14]
}

// ------------------------------------------------------------------ helpers

const getCompany = (id) => db.prepare('SELECT * FROM companies WHERE id = ?').get(id)
const getSeat = (id) => db.prepare('SELECT * FROM corporate_seats WHERE id = ?').get(id)
const setSeat = (id, fields) => {
  const keys = Object.keys(fields)
  db.prepare(`UPDATE corporate_seats SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id })
}

function requireCompanyAdmin(req, companyId) {
  const company = getCompany(Number(companyId))
  if (!company) throw new HttpError(404, 'Company not found')
  if (company.adminUserId !== req.user.id) throw new HttpError(403, 'Only the company admin can do this')
  return company
}

/** One ID once per event across ALL pools (lottery entries + corporate seats). */
function idAlreadyUsed(user, eventId, exceptSeatId = null) {
  return !!(
    db.prepare('SELECT 1 FROM entries WHERE eventId = ? AND idHash = ?').get(eventId, user.idHash) ||
    db
      .prepare(
        `SELECT 1 FROM corporate_seats s JOIN users u ON u.id = s.userId
         WHERE s.eventId = ? AND u.idHash = ? AND s.id IS NOT ?`,
      )
      .get(eventId, user.idHash, exceptSeatId)
  )
}

const minting = new Set()

/** Links a seat to its employee once they are verified, and mints a corporate ticket to them. */
export async function processSeat(seatId) {
  const seat = getSeat(seatId)
  if (!seat || seat.tokenId || minting.has(seatId)) return
  const user = seat.userId ? getUser(seat.userId) : getUserByPhone(seat.phone)
  if (!user || !user.isVerified) {
    setSeat(seatId, { note: 'Waiting for the employee to verify their ID' })
    return
  }
  if (idAlreadyUsed(user, seat.eventId, seatId)) {
    setSeat(seatId, { userId: null, note: 'This ID already has an entry or a seat for this event' })
    logBlocked({ reason: 'DUPLICATE_ENTRY', eventId: seat.eventId, userId: user.id, detail: `corporate seat ${seatId}` })
    return
  }
  minting.add(seatId)
  setSeat(seatId, { userId: user.id, note: 'Minting ticket on Quai' })
  try {
    const event = requireEvent(seat.eventId)
    const ticket = await mintToUser(event, user, { corporate: true })
    setSeat(seatId, { tokenId: ticket.tokenId, verified: 1, note: null })
  } catch (err) {
    setSeat(seatId, { note: `Mint failed: ${err.message}` })
    throw err
  } finally {
    minting.delete(seatId)
  }
}

// When an invited employee finishes KYC, mint their seat.
registerOnUserVerified(async (user) => {
  const seats = db.prepare('SELECT id FROM corporate_seats WHERE phone = ? AND tokenId IS NULL').all(user.phone)
  await Promise.all(seats.map((s) => processSeat(s.id)))
})

function publicSeat(s) {
  const user = s.userId ? getUser(s.userId) : getUserByPhone(s.phone)
  const ticket = s.tokenId ? getTicket(s.tokenId) : null
  return {
    id: s.id,
    phone: s.phone,
    employeeName: user?.name || null,
    employeeVerified: !!user?.isVerified,
    tokenId: s.tokenId,
    seat: ticket?.seat || null,
    ticketStatus: ticket?.status || null,
    verified: !!s.verified,
    swapsLeft: s.swapsLeft,
    note: s.note,
    explorer: s.tokenId ? quai.explorerToken(s.tokenId) : null,
  }
}

function publicCompany(c) {
  const seats = db.prepare('SELECT * FROM corporate_seats WHERE companyId = ? ORDER BY id').all(c.id)
  const event = c.eventId ? requireEvent(c.eventId) : null
  return {
    id: c.id,
    name: c.name,
    gstin: c.gstin,
    approved: !!c.approved,
    seatQuota: c.seatQuota,
    eventId: c.eventId,
    eventName: event?.name || null,
    admin: getUser(c.adminUserId)?.name || null,
    seats: seats.map(publicSeat),
    seatsMinted: seats.filter((s) => s.tokenId).length,
    createdAt: c.createdAt,
  }
}

// ------------------------------------------------------------------ routes

/** POST /corporate/apply {name, gstin, eventId}: a verified user applies for their company. */
router.post('/apply', requireAuth, requireVerified, (req, res) => {
  const name = String(req.body?.name || '').trim()
  const gstin = String(req.body?.gstin || '')
    .toUpperCase()
    .replace(/\s/g, '')
  const event = requireEvent(req.body?.eventId)
  if (name.length < 2) throw new HttpError(400, 'Enter the company name')
  if (!isValidGstin(gstin)) throw new HttpError(400, 'That GSTIN is not valid (check the 15 characters)', { reason: 'BAD_GSTIN' })
  if (db.prepare('SELECT 1 FROM companies WHERE gstin = ?').get(gstin)) throw new HttpError(409, 'This GSTIN has already applied')

  const id = db.prepare('INSERT INTO companies (name, gstin, adminUserId, eventId) VALUES (?, ?, ?, ?)').run(name, gstin, req.user.id, event.id)
    .lastInsertRowid
  if (req.user.role === 'fan') db.prepare("UPDATE users SET role = 'company_admin' WHERE id = ?").run(req.user.id)
  res.status(201).json({ company: publicCompany(getCompany(id)) })
})

/** GET /corporate: all requests (organiser). */
router.get('/', requireRole('organiser'), (_req, res) => {
  res.json({ companies: db.prepare('SELECT * FROM companies ORDER BY id DESC').all().map(publicCompany) })
})

/** GET /corporate/mine: the company admin's companies and seats. */
router.get('/mine', requireAuth, (req, res) => {
  res.json({ companies: db.prepare('SELECT * FROM companies WHERE adminUserId = ? ORDER BY id DESC').all(req.user.id).map(publicCompany) })
})

/** POST /corporate/:id/approve {seatQuota}: organiser approves; the corporate pool is max 5% of supply. */
router.post('/:id/approve', requireRole('organiser'), (req, res) => {
  const company = getCompany(Number(req.params.id))
  if (!company) throw new HttpError(404, 'Company not found')
  const event = requireEvent(company.eventId)
  const quota = Number(req.body?.seatQuota)
  const used = db.prepare('SELECT COALESCE(SUM(seatQuota),0) n FROM companies WHERE eventId = ? AND approved = 1 AND id != ?').get(event.id, company.id).n
  const remaining = corporateCap(event) - used
  if (!Number.isInteger(quota) || quota < 1) throw new HttpError(400, 'seatQuota must be at least 1')
  if (quota > remaining)
    throw new HttpError(409, `The corporate pool is capped at 5% of supply (${corporateCap(event)} seats); ${remaining} left`, {
      reason: 'CORPORATE_CAP',
    })
  db.prepare('UPDATE companies SET approved = 1, seatQuota = ? WHERE id = ?').run(quota, company.id)
  res.json({ company: publicCompany(getCompany(company.id)) })
})

/** POST /corporate/:id/seats {phones[]}: invite employees; each gets a seat once they verify their ID. */
router.post('/:id/seats', requireAuth, (req, res) => {
  const company = requireCompanyAdmin(req, req.params.id)
  if (!company.approved) throw new HttpError(409, 'Wait for the organiser to approve your company')
  const phones = [...new Set((Array.isArray(req.body?.phones) ? req.body.phones : []).map(normalizePhone))]
  if (!phones.length) throw new HttpError(400, 'Add at least one employee phone number')
  const existing = db.prepare('SELECT phone FROM corporate_seats WHERE companyId = ?').all(company.id).map((s) => s.phone)
  const fresh = phones.filter((p) => !existing.includes(p))
  if (existing.length + fresh.length > company.seatQuota)
    throw new HttpError(409, `Your quota is ${company.seatQuota} seats (${company.seatQuota - existing.length} left)`, { reason: 'QUOTA' })

  const insert = db.prepare('INSERT INTO corporate_seats (companyId, eventId, phone) VALUES (?, ?, ?)')
  const ids = fresh.map((p) => insert.run(company.id, company.eventId, p).lastInsertRowid)
  for (const id of ids) processSeat(Number(id)).catch((err) => console.error(`[corporate] seat ${id}:`, err.message))
  res.status(201).json({ company: publicCompany(getCompany(company.id)) })
})

/** POST /corporate/seats/:id/swap {newPhone}: move a seat to another verified employee (2 swaps per seat). */
router.post('/seats/:id/swap', requireAuth, async (req, res) => {
  const seat = getSeat(Number(req.params.id))
  if (!seat) throw new HttpError(404, 'Seat not found')
  const company = requireCompanyAdmin(req, seat.companyId)
  if (seat.swapsLeft <= 0) throw new HttpError(409, 'No swaps left for this seat', { reason: 'NO_SWAPS_LEFT' })
  const newPhone = normalizePhone(req.body?.newPhone)
  if (newPhone === seat.phone) throw new HttpError(400, 'That is the same employee')
  const newUser = getUserByPhone(newPhone)
  if (!newUser?.isVerified) throw new HttpError(409, 'Ask that employee to log in and verify their ID first', { reason: 'NOT_VERIFIED' })
  if (idAlreadyUsed(newUser, seat.eventId, seat.id))
    throw new HttpError(409, 'That ID already has an entry or a seat for this event', { reason: 'DUPLICATE_ENTRY' })

  const ticket = seat.tokenId ? getTicket(seat.tokenId) : null
  if (ticket?.status === 'used') throw new HttpError(409, 'This seat was already used at the gate')
  setSeat(seat.id, { phone: newPhone, userId: newUser.id, swapsLeft: seat.swapsLeft - 1, note: ticket ? 'Swapping on Quai' : null })

  if (!ticket) {
    processSeat(seat.id).catch((err) => console.error(`[corporate] seat ${seat.id}:`, err.message))
  } else {
    // Old employee's ticket goes back to the pool, then straight to the new employee.
    const oldUser = getUser(ticket.ownerUserId)
    ;(async () => {
      await returnTicket(ticket, oldUser, { reassign: false, refund: false })
      await reassignTo(getTicket(ticket.tokenId), newUser, { kind: 'swapped' })
      setSeat(seat.id, { note: null })
    })().catch((err) => {
      setSeat(seat.id, { note: `Swap failed: ${err.message}` })
      console.error(`[corporate] swap seat ${seat.id}:`, err.message)
    })
  }
  res.status(202).json({ company: publicCompany(getCompany(company.id)) })
})
