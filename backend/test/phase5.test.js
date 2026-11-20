// Phase 5 integration test: anti-bot entry pipeline, x402 Work (hosted facilitator + local mode),
// commit-reveal draw and parallel minting on Orchard. Uses on-chain event 2 (created by phase4 test).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const dbFile = path.join(os.tmpdir(), `fairpass-test5-${Date.now()}.db`)
process.env.DATABASE_PATH = dbFile
process.env.DEMO_MODE = '1'
process.env.DEMO_FIXED_OTP = ''

const { createApp } = await import('../src/app.js')
const { ensureOrganiser } = await import('../src/services/users.js')
const { db } = await import('../src/db.js')
const { config } = await import('../src/config.js')
const quai = await import('../src/services/quai.js')
const x402 = await import('../src/services/x402.js')
const { payWithWork, decodeHeader, encodeHeader, solveWork } = await import('x402-work-client')

let server, base, eventId
const org = ensureOrganiser()
const fans = {}

async function api(method, url, body, token, headers = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json().catch(() => ({})), headers: res.headers }
}
async function login(phone) {
  const otp = await api('POST', '/auth/otp', { phone })
  return (await api('POST', '/auth/verify', { phone, otp: otp.body.devOtp })).body
}
async function verifiedFan(name, phone) {
  const s = await login(phone)
  const id = String(2 + crypto.randomInt(8)) + String(crypto.randomInt(1e10, 1e11)).slice(0, 11)
  const r = await api('POST', '/auth/kyc', { name, idNumber: id }, s.token)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return { ...s, user: r.body.user }
}
const enterUrl = () => `${base}/events/${eventId}/enter`
const enterWithWork = (token, quantity = 1) =>
  payWithWork(enterUrl(), { quantity }, { headers: { authorization: `Bearer ${token}` }, maxPrice: 1_000_000 })

/** Gets a puzzle for `token` and solves it, without submitting. */
async function solvedSignature(token) {
  const r = await api('POST', `/events/${eventId}/enter`, { quantity: 1 }, token)
  assert.equal(r.status, 402)
  const required = decodeHeader(r.headers.get('payment-required'))
  const offer = required.accepts[0]
  const { solution } = solveWork(offer, { maxHashes: Number(offer.amount) * 12, deadline: Date.now() + 15000 })
  return encodeHeader({ x402Version: 2, resource: required.resource, accepted: offer, payload: { solution } })
}

before(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}`
  const orgToken = (await login(org.phone)).token
  const r = await api(
    'POST',
    '/events',
    { name: 'Lottery Test', date: '2027-02-01', supply: 20, facePrice: '0.01', chainEventId: 2, lotteryTickets: 2 },
    orgToken,
  )
  assert.equal(r.status, 201, JSON.stringify(r.body))
  eventId = r.body.event.id
  fans.org = orgToken
  for (const n of [1, 2, 3, 4]) fans[n] = await verifiedFan(`Fan ${n}`, `98111000${n}0`)
})
after(() => {
  server.close()
  db.close()
  for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) fs.rmSync(f, { force: true })
  quai.provider.destroy()
})

test('no account -> 401 NO_ID; unverified -> 403 NOT_VERIFIED; quantity 3 -> 400', async () => {
  assert.equal((await api('POST', `/events/${eventId}/enter`, { quantity: 1 })).body.reason, 'NO_ID')
  const u = await login('9811100099')
  const r = await api('POST', `/events/${eventId}/enter`, { quantity: 1 }, u.token)
  assert.equal(r.status, 403)
  assert.equal(r.body.reason, 'NOT_VERIFIED')
  assert.equal((await api('POST', `/events/${eventId}/enter`, { quantity: 3 }, fans[1].token)).status, 400)
})

test('without a proof the server answers 402 with an x402 Work puzzle', async () => {
  const r = await api('POST', `/events/${eventId}/enter`, { quantity: 1 }, fans[4].token)
  assert.equal(r.status, 402)
  const required = decodeHeader(r.headers.get('payment-required'))
  assert.equal(required.x402Version, 2)
  assert.equal(required.accepts[0].extra.profile, 'quai/sha256d-v1')
  assert.equal(required.accepts[0].amount, String(config.x402Amount))
})

test('fan 1 enters by solving a real puzzle from the hosted facilitator', { timeout: 60_000 }, async () => {
  const { response, payment } = await enterWithWork(fans[1].token)
  const body = await response.json()
  assert.equal(response.status, 201, JSON.stringify(body))
  assert.equal(body.entry.entryNumber, 1)
  assert.ok(payment.guesses > 0)
  assert.ok(response.headers.get('payment-response'))
  console.log(`    solved ${payment.guesses} guesses in ${payment.milliseconds} ms; receipt network ${payment.receipt?.network}`)
})

test('garbage proof -> 402 INVALID_POW with no new puzzle', async () => {
  const fake = Buffer.from(JSON.stringify({ x402Version: 2, accepted: { extra: { job: { id: 'nope' } } } })).toString('base64')
  const r = await api('POST', `/events/${eventId}/enter`, { quantity: 1 }, fans[2].token, { 'payment-signature': fake })
  assert.equal(r.status, 402)
  assert.equal(r.body.reason, 'INVALID_POW')
  assert.equal(r.headers.get('payment-required'), null)
})

test('a proof solved for one account cannot be used by another; and is spent once', { timeout: 60_000 }, async () => {
  const sig = await solvedSignature(fans[2].token)
  const stolen = await api('POST', `/events/${eventId}/enter`, { quantity: 1 }, fans[3].token, { 'payment-signature': sig })
  assert.equal(stolen.body.reason, 'INVALID_POW')
  const own = await api('POST', `/events/${eventId}/enter`, { quantity: 1 }, fans[2].token, { 'payment-signature': sig })
  assert.equal(own.status, 201, JSON.stringify(own.body))
  // Replaying the same proof directly against the verifier: already spent.
  const replay = await x402.verify({ url: 'x', description: 'x', paymentSignature: sig, userId: fans[2].user.id })
  assert.equal(replay.ok, false)
  assert.match(replay.detail, /already used/)
})

test('one entry per ID per event -> DUPLICATE_ENTRY', async () => {
  const r = await api('POST', `/events/${eventId}/enter`, { quantity: 1 }, fans[1].token)
  assert.equal(r.status, 409)
  assert.equal(r.body.reason, 'DUPLICATE_ENTRY')
})

test('two fans entering at the same moment (shared facilitator job) both get in', { timeout: 60_000 }, async () => {
  fans[5] = await verifiedFan('Fan 5', '9811100050')
  fans[6] = await verifiedFan('Fan 6', '9811100060')
  const [a, b] = await Promise.all([enterWithWork(fans[5].token), enterWithWork(fans[6].token)])
  assert.equal(a.response.status, 201)
  assert.equal(b.response.status, 201)
  const jobs = db.prepare('SELECT jobId, userId FROM pow_challenges WHERE userId IN (?, ?)').all(fans[5].user.id, fans[6].user.id)
  assert.equal(jobs.length, 2)
  console.log(`    shared job id: ${jobs[0].jobId === jobs[1].jobId}`)
})

test('local x402 mode (offline fallback) issues and verifies its own puzzles', { timeout: 60_000 }, async () => {
  config.x402Mode = 'local'
  try {
    const { response, payment } = await enterWithWork(fans[3].token)
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    assert.equal(payment.receipt.network, 'quai:15000')
    assert.equal(payment.receipt.verifiedBy, 'fairpass')
  } finally {
    config.x402Mode = 'facilitator'
  }
})

test('commit-reveal draw: 2 winners minted on Orchard in parallel, 3 waitlisted, proof verifies', { timeout: 400_000 }, async () => {
  const before = (await api('GET', `/events/${eventId}/draw-proof`)).body
  assert.equal(before.seed, null) // secret before the draw

  const fanDraw = await api('POST', `/events/${eventId}/draw`, {}, fans[1].token)
  assert.equal(fanDraw.status, 403)

  const t = Date.now()
  const draw = await api('POST', `/events/${eventId}/draw`, {}, fans.org)
  assert.equal(draw.status, 202, JSON.stringify(draw.body))
  assert.deepEqual(
    { winners: draw.body.draw.winners, waitlist: draw.body.draw.waitlist },
    { winners: 2, waitlist: 3 },
  )
  assert.equal((await api('POST', `/events/${eventId}/draw`, {}, fans.org)).status, 409)

  // Anyone can verify: hash of the seed matches the commitment, and the order follows sha256(seed:id).
  const proof = (await api('GET', `/events/${eventId}/draw-proof`)).body
  assert.equal(crypto.createHash('sha256').update(proof.seed).digest('hex'), before.seedHash)
  const recomputed = [...proof.entries]
    .map((e) => ({ id: e.id, k: crypto.createHash('sha256').update(`${proof.seed}:${e.id}`).digest('hex') }))
    .sort((a, b) => (a.k < b.k ? -1 : 1))
    .map((e) => e.id)
  assert.deepEqual(recomputed, proof.orderedEntryIds)
  assert.equal(proof.verified, true)

  let stats
  for (;;) {
    stats = (await api('GET', `/events/${eventId}/stats`)).body
    if (stats.minting && !stats.minting.running) break
    await new Promise((r) => setTimeout(r, 3000))
  }
  console.log(`    minted ${stats.minting.done} tickets in ${((Date.now() - t) / 1000).toFixed(1)}s (failed ${stats.minting.failed})`)
  assert.equal(stats.minting.failed, 0, stats.minting.errors.join('; '))
  assert.equal(stats.tickets.minted, 2)

  const tickets = db.prepare('SELECT t.tokenId, u.walletAddress FROM tickets t JOIN users u ON u.id = t.ownerUserId WHERE t.eventId = ?').all(eventId)
  for (const t of tickets) assert.equal((await quai.ownerOf(t.tokenId)).toLowerCase(), t.walletAddress.toLowerCase())
})

test('per-IP rate limit -> RATE_LIMITED; stats show every blocked reason', async () => {
  // A fresh open event, so the lottery is open again.
  const r = await api('POST', '/events', { name: 'Rate Test', date: '2027-03-01', supply: 20, facePrice: '0.01', chainEventId: 2 }, fans.org)
  const id = r.body.event.id
  config.rateLimitPerMinute = 3
  try {
    const codes = []
    for (let i = 0; i < 5; i++) codes.push((await api('POST', `/events/${id}/enter`, { quantity: 1 }, fans[4].token)).body.reason || 'PUZZLE')
    assert.ok(codes.includes('RATE_LIMITED'), codes.join(','))
  } finally {
    config.rateLimitPerMinute = 30
  }
  const stats = (await api('GET', `/events/${eventId}/stats`)).body
  for (const reason of ['NO_ID', 'NOT_VERIFIED', 'INVALID_POW', 'DUPLICATE_ENTRY']) assert.ok(stats.blocked[reason] > 0, reason)
  assert.ok(stats.latest.length > 0)
})
