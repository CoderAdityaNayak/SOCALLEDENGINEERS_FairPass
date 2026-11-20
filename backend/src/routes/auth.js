// Mock phone login (OTP printed to the console) + mock KYC.
import crypto from 'node:crypto'
import { Router } from 'express'
import { config } from '../config.js'
import { db, logBlocked } from '../db.js'
import { HttpError, publicUser, requireAuth, signToken } from '../auth.js'
import { createUser, getUser, getUserByPhone, hashId, normalizeIdNumber, normalizePhone } from '../services/users.js'

export const router = Router()

const otps = new Map() // phone -> { code, expires, tries }

router.post('/otp', (req, res) => {
  const phone = normalizePhone(req.body?.phone)
  const code = config.demoOtp || String(crypto.randomInt(100000, 1000000))
  otps.set(phone, { code, expires: Date.now() + 5 * 60_000, tries: 0 })
  console.log(`[OTP] ${phone}: ${code}`)
  res.json({ sent: true, phone, ...(config.demoMode ? { devOtp: code } : {}) })
})

router.post('/verify', (req, res) => {
  const phone = normalizePhone(req.body?.phone)
  const entry = otps.get(phone)
  if (!entry || entry.expires < Date.now()) throw new HttpError(400, 'Code expired. Request a new one.')
  if (++entry.tries > 5) {
    otps.delete(phone)
    throw new HttpError(429, 'Too many wrong codes. Request a new one.')
  }
  if (String(req.body?.otp || '').trim() !== entry.code) throw new HttpError(400, 'Wrong code')
  otps.delete(phone)

  const existing = getUserByPhone(phone) || createUser({ phone })
  db.prepare("UPDATE users SET lastLoginAt = datetime('now') WHERE id = ?").run(existing.id)
  const user = getUser(existing.id)
  res.json({ token: signToken(user), user: publicUser(user), isNew: !user.name })
})

router.post('/kyc', requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim()
  if (name.length < 2) throw new HttpError(400, 'Enter your name as on your ID')
  const idNumber = normalizeIdNumber(req.body?.idNumber)
  const idHash = hashId(idNumber)
  const idType = /^\d{12}$/.test(idNumber) ? 'AADHAAR' : 'PAN'

  const owner = db.prepare('SELECT id FROM users WHERE idHash = ?').get(idHash)
  if (owner && owner.id !== req.user.id) {
    logBlocked({ reason: 'DUPLICATE_ID', ip: req.ip, userId: req.user.id, detail: 'KYC with an ID already used by another account' })
    throw new HttpError(409, 'This ID is already linked to another account', { reason: 'DUPLICATE_ID' })
  }
  if (req.user.idHash && req.user.idHash !== idHash) throw new HttpError(409, 'Your account is already verified with a different ID')

  // Only the keyed hash, the ID type and the last 4 characters are stored; never the full number.
  db.prepare('UPDATE users SET name = ?, idHash = ?, idType = ?, idLast4 = ?, isVerified = 1 WHERE id = ?').run(
    name,
    idHash,
    idType,
    idNumber.slice(-4),
    req.user.id,
  )
  const user = getUser(req.user.id)
  res.json({ user: publicUser(user) })
})

router.get('/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }))
