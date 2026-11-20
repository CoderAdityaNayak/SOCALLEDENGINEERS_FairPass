// JWT auth + role middleware.
import jwt from 'jsonwebtoken'
import { config } from './config.js'
import { db, instanceId } from './db.js'

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

export const signToken = (user) =>
  jwt.sign({ sub: user.id, role: user.role, iid: instanceId }, config.jwtSecret, { expiresIn: '7d' })

/** Reads the Bearer token if present; sets req.user (or leaves it undefined). */
export function loadUser(req) {
  const header = req.get('authorization') || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return null
  try {
    const { sub, iid } = jwt.verify(token, config.jwtSecret)
    if (iid !== instanceId) return null // issued by a different (e.g. reset) database
    return db.prepare('SELECT * FROM users WHERE id = ?').get(sub) || null
  } catch {
    return null
  }
}

export function requireAuth(req, _res, next) {
  req.user = loadUser(req)
  if (!req.user) throw new HttpError(401, 'Log in first')
  next()
}

export const requireRole =
  (...roles) =>
  (req, _res, next) => {
    req.user = req.user || loadUser(req)
    if (!req.user) throw new HttpError(401, 'Log in first')
    if (!roles.includes(req.user.role)) throw new HttpError(403, `Only ${roles.join(' or ')} can do this`)
    next()
  }

export function requireVerified(req, _res, next) {
  if (!req.user?.isVerified) throw new HttpError(403, 'Verify your ID first')
  next()
}

/** What we send to clients about a user (never the key or the ID hash). */
export const publicUser = (u) =>
  u && {
    id: u.id,
    phone: u.phone,
    name: u.name,
    role: u.role,
    isVerified: !!u.isVerified,
    walletAddress: u.walletAddress,
  }
