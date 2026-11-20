// x402 Work: every lottery entry must carry a proof-of-work.
//
// Mode 'facilitator' (default): puzzles come from the hosted x402 Work facilitator (quai/sha256d-v1 jobs
// built from live Quai mining work; good answers are submitted as real shares to REWARD_ADDRESS).
// Mode 'local': FairPass issues the same kind of SHA-256d job itself (network quai:15000), for offline
// demos. If the facilitator is down when a puzzle is needed, we fall back to local automatically.
//
// Either way we verify every proof ourselves first (the package exports the exact header/digest/target
// math), bind each puzzle to the account that asked for it, and spend it once. Garbage or replayed
// proofs never reach the facilitator.
import crypto from 'node:crypto'
import {
  workSeller,
  WorkSellerError,
  workHeader,
  workDigest,
  workScore,
  workTarget,
  decodeHeader,
  encodeHeader,
} from 'x402-work-client'
import { config } from '../config.js'
import { db } from '../db.js'
import { isCyprus1 } from './quai.js'

const PROFILE = 'quai/sha256d-v1'
const LOCAL_TTL_SECONDS = 30

if (!config.rewardAddress || !isCyprus1(config.rewardAddress)) {
  throw new Error('REWARD_ADDRESS in backend/.env must be a Cyprus-1 Quai address')
}
const seller = workSeller({ payTo: config.rewardAddress, amount: config.x402Amount, profile: PROFILE })

/**
 * Puzzles we handed out and that are not yet spent, keyed by `${jobId}:${userId}`.
 * The facilitator gives the SAME job to everyone who asks within a few seconds (fans compete with
 * different solutions, and each solution can be settled once), so the key must include the account.
 * -> { userId, eventId, accepted, mode, expiresAt }
 */
const issued = new Map()
const spent = new Map() // same key -> expiresAt, so a replay is reported as "already used"
const issuedKey = (jobId, userId) => `${jobId}:${userId}`
setInterval(() => {
  const now = Date.now() / 1000
  for (const [id, job] of issued) if (job.expiresAt + 60 < now) issued.delete(id)
  for (const [id, expiresAt] of spent) if (expiresAt + 300 < now) spent.delete(id)
}, 30_000).unref()

const recordChallenge = db.prepare(
  'INSERT OR IGNORE INTO pow_challenges (jobId, userId, eventId, mode, issuedAt) VALUES (?, ?, ?, ?, ?)',
)
const markSolved = db.prepare('UPDATE pow_challenges SET solved = 1 WHERE jobId = ? AND userId IS ?')

const randHex = (bytes) => crypto.randomBytes(bytes).toString('hex')

/** A FairPass-issued SHA-256d job with the same shape as the facilitator's. */
function localOffer(resource) {
  const now = Math.floor(Date.now() / 1000)
  const accepted = {
    scheme: 'work',
    network: 'quai:15000',
    asset: 'hash',
    amount: String(config.x402Amount),
    payTo: config.rewardAddress,
    maxTimeoutSeconds: LOCAL_TTL_SECONDS,
    extra: {
      name: 'x402-work',
      version: '1',
      profile: PROFILE,
      job: {
        id: 'fairpass_' + randHex(12),
        expiresAt: now + LOCAL_TTL_SECONDS,
        refreshAfter: now + LOCAL_TTL_SECONDS - 3,
        work: {
          version: '20000000',
          previousBlockHash: randHex(32),
          coinbase1: '01000000010000000000000000' + randHex(8),
          coinbase2: 'ffffffff' + randHex(8),
          extraNonce1: randHex(4),
          extraNonce2Size: 4,
          merkleBranches: [randHex(32)],
          bits: '1d00ffff',
          time: now.toString(16).padStart(8, '0'),
        },
      },
    },
  }
  return { x402Version: 2, resource, accepts: [accepted] }
}

/**
 * A fresh puzzle (HTTP 402). Returns { status: 402, headers, body, mode }.
 * Throws WorkSellerError only if both the facilitator and the local fallback are unusable (never, in practice).
 */
export async function challenge({ url, description, userId, eventId, error }) {
  const resource = { url, description }
  let body
  let mode = config.x402Mode === 'local' ? 'local' : 'facilitator'
  if (mode === 'facilitator') {
    try {
      const r = await seller.charge({ url, description })
      body = r.body
    } catch (err) {
      if (!(err instanceof WorkSellerError)) throw err
      console.warn(`[x402] facilitator unavailable (${err.code}: ${err.message}); issuing a local puzzle`)
      mode = 'local'
    }
  }
  if (mode === 'local') body = localOffer(resource)
  if (error) body = { ...body, error }

  for (const accepted of body.accepts || []) {
    const job = accepted?.extra?.job
    if (accepted?.scheme !== 'work' || !job?.id) continue
    issued.set(issuedKey(job.id, userId), { userId, eventId, accepted, mode, expiresAt: job.expiresAt })
    recordChallenge.run(job.id, userId ?? null, eventId ?? null, mode, Date.now())
  }
  return { status: 402, headers: { 'payment-required': encodeHeader(body) }, body, mode }
}

const reject = (detail, retryable = false) => ({ ok: false, reason: 'INVALID_POW', detail, retryable })

/**
 * Checks a PAYMENT-SIGNATURE header.
 * Returns { ok: true, receipt, headers, powRef } or { ok: false, reason, detail, retryable }.
 */
export async function verify({ url, description, paymentSignature, userId }) {
  let payment
  try {
    payment = decodeHeader(paymentSignature)
  } catch {
    return reject('unreadable payment-signature')
  }
  const accepted = payment?.accepted
  const jobId = accepted?.extra?.job?.id
  const key = issuedKey(jobId, userId)
  const job = typeof jobId === 'string' ? issued.get(key) : undefined
  if (payment?.x402Version !== 2 || !job) {
    if (spent.has(key)) return reject('puzzle already used')
    const issuedToOthers = typeof jobId === 'string' && [...issued.keys()].some((k) => k.startsWith(jobId + ':'))
    return reject(issuedToOthers ? 'puzzle was issued to another account' : 'unknown, expired or already used puzzle')
  }
  if (JSON.stringify(job.accepted) !== JSON.stringify(accepted)) return reject('puzzle terms were modified')
  if (job.expiresAt * 1000 < Date.now()) {
    issued.delete(key)
    return reject('puzzle expired; solve a new one', true)
  }

  // Our own check of the work: rebuild the 80-byte header and compare its SHA-256d score with the target.
  const work = accepted.extra.job.work
  const solution = payment?.payload?.solution
  let meetsTarget = false
  try {
    if (solution?.time !== '0x' + work.time) throw new Error('time must match the job')
    const digest = workDigest(PROFILE, workHeader(work, solution))
    meetsTarget = workScore(digest) <= workTarget(accepted.amount)
  } catch {
    return reject('malformed solution')
  }
  if (!meetsTarget) return reject('proof does not meet the target')
  issued.delete(key) // spend once (the facilitator also refuses a solution it has already settled)
  spent.set(key, job.expiresAt)

  let receipt
  if (job.mode === 'facilitator') {
    try {
      const r = await seller.charge({ url, description, paymentSignature })
      if (!r.paid) return reject(`facilitator rejected the proof: ${r.body?.error || 'unknown'}`, true)
      receipt = r.receipt
    } catch (err) {
      if (!(err instanceof WorkSellerError)) throw err
      // We already verified the work locally, so a facilitator outage doesn't block a real fan.
      console.warn(`[x402] settle unavailable (${err.code}); accepting locally verified proof ${jobId}`)
      receipt = { success: true, network: accepted.network, transaction: null, verifiedBy: 'fairpass' }
    }
  } else {
    receipt = { success: true, network: accepted.network, transaction: null, verifiedBy: 'fairpass' }
  }
  markSolved.run(jobId, userId)
  return {
    ok: true,
    receipt,
    headers: { 'payment-response': encodeHeader(receipt) },
    powRef: receipt.transaction || jobId,
    profile: PROFILE,
    amount: accepted.amount,
  }
}
