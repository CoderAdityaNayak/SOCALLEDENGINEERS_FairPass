// Users, phones, ID hashing and custodial wallet creation.
import crypto from 'node:crypto'
import { config } from '../config.js'
import { db } from '../db.js'
import { HttpError } from '../auth.js'
import { createCyprus1Wallet, encryptKey, organiser } from './quai.js'

/** "98765 43210" / "+91 98765-43210" -> "+919876543210". */
export function normalizePhone(raw) {
  const digits = String(raw || '').replace(/[^\d+]/g, '')
  if (/^\+\d{10,15}$/.test(digits)) return digits
  if (/^\d{10}$/.test(digits)) return '+91' + digits
  if (/^91\d{10}$/.test(digits)) return '+' + digits
  throw new HttpError(400, 'Enter a valid phone number')
}

/**
 * Mock KYC: accepts an Aadhaar number (12 digits, not starting with 0/1) or a PAN (ABCDE1234F).
 * Returns the normalised ID. A real system would call an ID-verification provider here.
 */
export function normalizeIdNumber(raw) {
  const id = String(raw || '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
  if (/^[2-9]\d{11}$/.test(id) || /^[A-Z]{5}\d{4}[A-Z]$/.test(id)) return id
  throw new HttpError(400, 'Enter a 12-digit Aadhaar number or a 10-character PAN')
}

/**
 * The stored ID fingerprint. A plain SHA-256 of a 12-digit Aadhaar number could be brute-forced
 * (only 10^12 values), so we use HMAC-SHA256 with a server secret: same ID -> same hash, but the
 * hash is useless without the secret.
 */
export const hashId = (id) => crypto.createHmac('sha256', config.serverSecret).update('id:' + id).digest('hex')

export const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id)
export const getUserByPhone = (phone) => db.prepare('SELECT * FROM users WHERE phone = ?').get(phone)

/** Creates a user with a fresh custodial Cyprus-1 wallet. */
export function createUser({ phone, name = null, role = 'fan' }) {
  const wallet = createCyprus1Wallet()
  const info = db
    .prepare('INSERT INTO users (phone, name, walletAddress, encKey, role) VALUES (?, ?, ?, ?, ?)')
    .run(phone, name, wallet.address, encryptKey(wallet.privateKey), role)
  return getUser(info.lastInsertRowid)
}

/** The organiser account uses the deployer wallet (owner of the contract), not a custodial one. */
export function ensureOrganiser() {
  const existing = db.prepare("SELECT * FROM users WHERE role = 'organiser'").get()
  if (existing) return existing
  const info = db
    .prepare(
      "INSERT INTO users (phone, name, walletAddress, encKey, role, isVerified) VALUES (?, 'FairPass Organiser', ?, NULL, 'organiser', 1)",
    )
    .run(config.organiserPhone, organiser.address)
  return getUser(info.lastInsertRowid)
}
