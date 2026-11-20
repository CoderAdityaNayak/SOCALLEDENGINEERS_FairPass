// Phase 4 integration test: real Express app + real Orchard contract, throwaway SQLite DB.
// Run: npm test -w backend   (sends a few Orchard transactions from the organiser wallet)
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const dbFile = path.join(os.tmpdir(), `fairpass-test-${Date.now()}.db`)
process.env.DATABASE_PATH = dbFile
process.env.DEMO_MODE = '1'
process.env.DEMO_FIXED_OTP = ''

const { createApp } = await import('../src/app.js')
const { ensureOrganiser, getUserByPhone } = await import('../src/services/users.js')
const { db } = await import('../src/db.js')
const quai = await import('../src/services/quai.js')
const { mintToUser } = await import('../src/services/tickets.js')

let server, base
const org = ensureOrganiser()

async function api(method, url, body, token) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

async function login(phone) {
  const otp = await api('POST', '/auth/otp', { phone })
  assert.equal(otp.status, 200)
  const v = await api('POST', '/auth/verify', { phone, otp: otp.body.devOtp })
  assert.equal(v.status, 200, JSON.stringify(v.body))
  return v.body
}

before(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => {
  server.close()
  db.close()
  for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) fs.rmSync(f, { force: true })
  quai.provider.destroy()
})

test('health', async () => {
  const r = await api('GET', '/health')
  assert.equal(r.body.contract, quai.contract.target)
})

test('OTP login creates a user with a custodial Cyprus-1 wallet', async () => {
  const wrong = await api('POST', '/auth/otp', { phone: '9876500001' })
  assert.equal((await api('POST', '/auth/verify', { phone: '9876500001', otp: '000000' })).status, 400)
  const { user, token } = await login('98765 00001')
  assert.ok(token)
  assert.equal(user.phone, '+919876500001')
  assert.ok(quai.isCyprus1(user.walletAddress), user.walletAddress)
  assert.equal(user.isVerified, false)
  assert.ok(wrong.body.devOtp)
})

test('KYC: invalid ID rejected, duplicate ID -> 409 and logged, raw ID never stored', async () => {
  const a = await login('9876500002')
  const b = await login('9876500003')
  assert.equal((await api('POST', '/auth/kyc', { name: 'Asha', idNumber: '1234' }, a.token)).status, 400)
  const ok = await api('POST', '/auth/kyc', { name: 'Asha Rao', idNumber: '2345 6789 0123' }, a.token)
  assert.equal(ok.status, 200)
  assert.equal(ok.body.user.isVerified, true)

  const dup = await api('POST', '/auth/kyc', { name: 'Bot', idNumber: '234567890123' }, b.token)
  assert.equal(dup.status, 409)
  assert.equal(dup.body.reason, 'DUPLICATE_ID')
  assert.equal(db.prepare("SELECT COUNT(*) n FROM blocked_attempts WHERE reason = 'DUPLICATE_ID'").get().n, 1)

  const row = db.prepare('SELECT idHash FROM users WHERE phone = ?').get('+919876500002')
  assert.match(row.idHash, /^[0-9a-f]{64}$/)
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM users').all()).includes('234567890123'))
})

test('roles: a fan cannot create events', async () => {
  const fan = await login('9876500004')
  const r = await api('POST', '/events', { name: 'x', date: '2027-01-01', supply: 10, facePrice: '0.01' }, fan.token)
  assert.equal(r.status, 403)
})

let orgToken, linkedEvent
test('organiser links the deployed on-chain event (no transaction)', async () => {
  orgToken = (await login(org.phone)).token
  const r = await api(
    'POST',
    '/events',
    { name: '[Headliner] World Tour', date: '2027-01-19', supply: 100, facePrice: '0.01', chainEventId: 1, venue: 'DY Patil Stadium', city: 'Mumbai' },
    orgToken,
  )
  assert.equal(r.status, 201, JSON.stringify(r.body))
  linkedEvent = r.body.event
  assert.equal(linkedEvent.chainEventId, 1)
  assert.equal(linkedEvent.seed, null) // secret until the draw
  assert.match(linkedEvent.seedHash, /^[0-9a-f]{64}$/)
  assert.equal(linkedEvent.lotteryStatus, 'open')
  const list = await api('GET', '/events')
  assert.equal(list.body.events.length, 1)
})

test('organiser creates a new event on Orchard (createEvent tx)', { timeout: 180_000 }, async () => {
  const t = Date.now()
  const r = await api('POST', '/events', { name: 'Test Night', date: '2027-02-01', supply: 20, facePrice: '0.01' }, orgToken)
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.ok(r.body.event.chainEventId > 1)
  assert.match(r.body.event.createTx, /orchard\.quaiscan\.io\/tx\/0x/)
  console.log(`    createEvent took ${((Date.now() - t) / 1000).toFixed(1)}s -> chain event ${r.body.event.chainEventId}`)
})

test('chain: mint to a custodial wallet, sponsor gas, over-cap listing reverts with PriceAboveCap', { timeout: 300_000 }, async () => {
  const fan = getUserByPhone('+919876500002')
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(linkedEvent.id)
  let t = Date.now()
  const ticket = await mintToUser(event, fan)
  console.log(`    mint took ${((Date.now() - t) / 1000).toFixed(1)}s -> token ${ticket.tokenId}, seat ${ticket.seat}`)
  assert.equal((await quai.ownerOf(ticket.tokenId)).toLowerCase(), fan.walletAddress.toLowerCase())
  assert.equal(await quai.ownerOf(999999), null)

  const wallet = quai.walletForUser(fan)
  t = Date.now()
  await assert.rejects(
    () => quai.listForResale(wallet, ticket.tokenId, quai.quais.parseQuai('3')),
    (err) => {
      assert.equal(err.reason, 'PriceAboveCap', err.message)
      return true
    },
  )
  console.log(`    sponsor + rejected listing took ${((Date.now() - t) / 1000).toFixed(1)}s`)
  const bal = await quai.provider.getBalance(fan.walletAddress)
  assert.ok(bal > 0n, 'custodial wallet was topped up for gas')
})
