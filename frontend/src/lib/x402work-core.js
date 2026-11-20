// Browser port of the x402 Work SHA-256d solver (quai/sha256d-v1) from x402-work-client 0.4.1,
// which is Node-only. Same byte layout:
//   coinbase = coinbase1 | extraNonce1 | extraNonce2 | coinbase2
//   merkle   = SHA256d(coinbase), then SHA256d(merkle | branch) for each branch
//   header   = version LE | previousBlockHash (each 4-byte word reversed) | merkle | time LE | bits LE | nonce LE
//   score    = SHA256d(header) read little-endian; valid when score <= floor(2^256 / amount) - 1
import { sha256 } from '@noble/hashes/sha2.js'

export const PROFILE = 'quai/sha256d-v1'
const NETWORKS = new Set(['quai:9', 'quai:15000'])

const sha256d = (bytes) => sha256(sha256(bytes))

export function hexToBytes(hex, size) {
  if (typeof hex !== 'string' || !/^(?:[0-9a-f]{2})*$/i.test(hex) || (size !== undefined && hex.length !== size * 2))
    throw new Error('Invalid work job')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export const bytesToHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function uint32(value) {
  const s = String(value)
  if (!/^(?:0x)?[0-9a-f]{1,8}$/i.test(s)) throw new Error('Invalid work job')
  return parseInt(s.replace(/^0x/, ''), 16) >>> 0
}

function writeLE32(buf, offset, n) {
  buf[offset] = n & 0xff
  buf[offset + 1] = (n >>> 8) & 0xff
  buf[offset + 2] = (n >>> 16) & 0xff
  buf[offset + 3] = (n >>> 24) & 0xff
}

/** The 80-byte header for a job and solution { extraNonce2, time, nonce } (hex strings, "0x" optional). */
export function workHeader(w, { extraNonce2, time, nonce }) {
  if (!Array.isArray(w?.merkleBranches) || w.merkleBranches.length > 64) throw new Error('Unsupported work job')
  let merkle = sha256d(
    concat(
      hexToBytes(w.coinbase1),
      hexToBytes(w.extraNonce1),
      hexToBytes(String(extraNonce2).replace(/^0x/, ''), w.extraNonce2Size),
      hexToBytes(w.coinbase2),
    ),
  )
  for (const branch of w.merkleBranches) merkle = sha256d(concat(merkle, hexToBytes(branch, 32)))
  const previous = hexToBytes(w.previousBlockHash, 32)
  for (let i = 0; i < 32; i += 4) previous.subarray(i, i + 4).reverse()
  const header = new Uint8Array(80)
  writeLE32(header, 0, uint32(w.version))
  header.set(previous, 4)
  header.set(merkle, 36)
  writeLE32(header, 68, uint32(time))
  writeLE32(header, 72, uint32(w.bits))
  writeLE32(header, 76, uint32(nonce))
  return header
}

export const workDigest = (header) => sha256d(header)
export const workScore = (digest) => BigInt('0x' + bytesToHex(Uint8Array.from(digest).reverse()))
export const workTarget = (amount) => (1n << 256n) / BigInt(amount) - 1n

/** Picks the SHA-256d offer from a decoded PAYMENT-REQUIRED body. */
export function pickOffer(required, { maxPrice = 1_000_000, now = Date.now() } = {}) {
  if (required?.x402Version !== 2 || !Array.isArray(required.accepts)) throw new Error('Unexpected anti-bot challenge')
  const offer = required.accepts.find(
    (a) => a?.scheme === 'work' && NETWORKS.has(a.network) && a.asset === 'hash' && a.extra?.profile === PROFILE,
  )
  if (!offer) throw new Error('No SHA-256d puzzle offered')
  if (!/^[1-9][0-9]{0,15}$/.test(offer.amount) || Number(offer.amount) > maxPrice) throw new Error('Puzzle is too expensive')
  const job = offer.extra.job
  if (!job?.work || job.expiresAt * 1000 <= now) throw new Error('The puzzle expired; try again')
  return offer
}

/**
 * Searches nonces until the score meets the target. Synchronous: run it in a Web Worker.
 * onProgress(guesses) is called every 4096 guesses. Returns { solution, guesses }.
 */
export function solveWork(offer, { maxHashes, deadline, onProgress = () => {}, extraNonce2 } = {}) {
  const job = offer.extra.job
  const w = job.work
  if (w.extraNonce2Size !== 4) throw new Error('Unsupported work job')
  const en2 = extraNonce2 || '0x' + bytesToHex(crypto.getRandomValues(new Uint8Array(4)))
  const time = '0x' + w.time
  const header = workHeader(w, { extraNonce2: en2, time, nonce: '0x00000000' })
  const target = workTarget(offer.amount)
  const top = Number(target >> 248n) // most guesses fail on the top byte alone
  const end = Math.min(deadline ?? Infinity, (job.refreshAfter ?? job.expiresAt) * 1000, job.expiresAt * 1000)
  const limit = maxHashes ?? Number(offer.amount) * 12
  for (let nonce = 0; nonce < limit; nonce++) {
    writeLE32(header, 76, nonce)
    const digest = sha256d(header)
    if (digest[31] <= top && workScore(digest) <= target) {
      return { solution: { extraNonce2: en2, time, nonce: '0x' + nonce.toString(16).padStart(8, '0') }, guesses: nonce + 1 }
    }
    if ((nonce & 0xfff) === 0xfff) {
      onProgress(nonce + 1)
      if (Date.now() >= end) break
    }
  }
  throw new Error('No answer within the time limit. Nothing was spent; try again for a fresh puzzle.')
}

// base64 <-> JSON for the x402 headers (UTF-8 safe)
export const decodeHeader = (value) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value), (c) => c.charCodeAt(0))))
export const encodeHeader = (value) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
