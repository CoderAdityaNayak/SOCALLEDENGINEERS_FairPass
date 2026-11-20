// Phase 6 integration test: resale (list/buy with royalty), corporate booking (GSTIN, quota cap,
// employee seats minted after KYC, one ID across pools, swap) on Orchard. Uses on-chain event 2.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const dbFile = path.join(os.tmpdir(), `fairpass-test6-${Date.now()}.db`)
process.env.DATABASE_PATH = dbFile
process.env.DEMO_MODE = '1'
process.env.DEMO_FIXED_OTP = ''

const { createApp } = await import('../src/app.js')
const { ensureOrganiser, getUser } = await import('../src/services/users.js')
const { db } = await import('../src/db.js')
const quai = await import('../src/services/quai.js')
const { mintToUser } = await import('../src/services/tickets.js')
const { isValidGstin } = await import('../src/routes/corporate.js')

let server, base, event, orgToken
const org = ensureOrganiser()
const run = String(Date.now()).slice(-5)
const phone = (n) => `9822${run.slice(-4)}${String(n).padStart(2, '0')}` // 10 digits

async function api(method, url, body, token) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}
async function login(p) {
  const otp = await api('POST', '/auth/otp', { phone: p })
  return (await api('POST', '/auth/verify', { phone: p, otp: otp.body.devOtp })).body
}
const randomId = () => String(2 + crypto.randomInt(8)) + String(crypto.randomInt(1e10, 1e11)).slice(0, 11)
async function verified(name, p) {
  const s = await login(p)
  const r = await api('POST', '/auth/kyc', { name, idNumber: randomId() }, s.token)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return { ...s, user: r.body.user }
}
async function until(fn, what, ms = 300_000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 3000))
  }
}

before(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}`
  orgToken = (await login(org.phone)).token
  const r = await api('POST', '/events', { name: 'Phase 6 Test', date: '2027-02-01', supply: 20, facePrice: '0.01', chainEventId: 2 }, orgToken)
  event = r.body.event
})
after(() => {
  server.close()
  db.close()
  for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) fs.rmSync(f, { force: true })
  quai.provider.destroy()
})

test('GSTIN check: format + checksum', () => {
  assert.equal(isValidGstin('27AAPFU0939F1ZV'), true)
  assert.equal(isValidGstin('27AAPFU0939F1ZX'), false) // wrong check character
  assert.equal(isValidGstin('99AAPFU0939F1ZV'), false) // bad state code
  assert.equal(isValidGstin('hello'), false)
})

test('resale: over-cap rejected by backend; list at cap, buyer pays, seller gets price minus 2% royalty', { timeout: 400_000 }, async () => {
  const seller = await verified('Seller', phone(1))
  const buyer = await verified('Buyer', phone(2))
  const ticket = await mintToUser(db.prepare('SELECT * FROM events WHERE id = ?').get(event.id), getUser(seller.user.id))

  const over = await api('POST', `/tickets/${ticket.tokenId}/list`, { price: '3' }, seller.token)
  assert.equal(over.status, 422)
  assert.equal(over.body.reason, 'PRICE_ABOVE_CAP')
  assert.equal(over.body.maxPrice, '0.011')

  const listed = await api('POST', `/tickets/${ticket.tokenId}/list`, { price: '0.011' }, seller.token)
  assert.equal(listed.status, 200, JSON.stringify(listed.body))
  assert.equal(listed.body.ticket.status, 'listed')
  const market = await api('GET', `/resale?eventId=${event.id}`)
  assert.ok(market.body.listings.some((l) => l.tokenId === ticket.tokenId))

  const sellerBefore = await quai.provider.getBalance(seller.user.walletAddress)
  const bought = await api('POST', `/tickets/${ticket.tokenId}/buy`, {}, buyer.token)
  assert.equal(bought.status, 200, JSON.stringify(bought.body))
  assert.equal((await quai.ownerOf(ticket.tokenId)).toLowerCase(), buyer.user.walletAddress.toLowerCase())
  const sellerAfter = await quai.provider.getBalance(seller.user.walletAddress)
  const expected = quai.quais.parseQuai('0.011') - quai.quais.parseQuai('0.011') / 50n
  assert.equal(sellerAfter - sellerBefore, expected)
  const mine = await api('GET', '/me/tickets', null, buyer.token)
  assert.equal(mine.body.tickets[0].ownedOnChain, true)
})

let company, admin, emp1, emp2, emp3
test('corporate: apply, quota capped at 5%, invite, seats minted after KYC, one ID across pools', { timeout: 400_000 }, async () => {
  admin = await verified('HR Admin', phone(10))
  assert.equal((await api('POST', '/corporate/apply', { name: 'Acme', gstin: '27AAPFU0939F1ZX', eventId: event.id }, admin.token)).status, 400)
  const applied = await api('POST', '/corporate/apply', { name: 'Acme Pvt Ltd', gstin: '27AAPFU0939F1ZV', eventId: event.id }, admin.token)
  assert.equal(applied.status, 201, JSON.stringify(applied.body))
  company = applied.body.company

  // supply 20 -> corporate cap 1 seat (5%)
  const tooMany = await api('POST', `/corporate/${company.id}/approve`, { seatQuota: 2 }, orgToken)
  assert.equal(tooMany.body.reason, 'CORPORATE_CAP')
  assert.equal((await api('POST', `/corporate/${company.id}/approve`, { seatQuota: 1 }, admin.token)).status, 403)
  // Use a bigger pool for the rest of the test.
  db.prepare('UPDATE events SET supply = 100 WHERE id = ?').run(event.id)
  assert.equal((await api('POST', `/corporate/${company.id}/approve`, { seatQuota: 3 }, orgToken)).status, 200)

  emp1 = await verified('Employee One', phone(11)) // verified before the invite
  emp3 = await verified('Employee Three', phone(13))
  // emp3 already has a lottery entry -> can't also get a corporate seat
  db.prepare('INSERT INTO entries (userId, eventId, idHash, quantity) VALUES (?, ?, (SELECT idHash FROM users WHERE id = ?), 1)').run(
    emp3.user.id,
    event.id,
    emp3.user.id,
  )
  const invited = await api('POST', `/corporate/${company.id}/seats`, { phones: [phone(11), phone(12), phone(13)] }, admin.token)
  assert.equal(invited.status, 201, JSON.stringify(invited.body))
  assert.equal((await api('POST', `/corporate/${company.id}/seats`, { phones: [phone(14)] }, admin.token)).body.reason, 'QUOTA')

  emp2 = await verified('Employee Two', phone(12)) // verifies after the invite -> hook mints
  const done = await until(async () => {
    const c = (await api('GET', '/corporate/mine', null, admin.token)).body.companies[0]
    return c.seatsMinted === 2 && !c.seats.some((s) => s.note === 'Minting ticket on Quai') ? c : null
  }, 'corporate seats to mint')
  const byPhone = Object.fromEntries(done.seats.map((s) => [s.phone, s]))
  assert.ok(byPhone['+91' + phone(11)].tokenId)
  assert.ok(byPhone['+91' + phone(12)].tokenId)
  assert.equal(byPhone['+91' + phone(13)].tokenId, null)
  assert.match(byPhone['+91' + phone(13)].note, /already has an entry/)
  company = done

  const t1 = byPhone['+91' + phone(11)].tokenId
  assert.equal(await quai.contract.isCorporate(t1), true)
  const list = await api('POST', `/tickets/${t1}/list`, { price: '0.01' }, emp1.token)
  assert.equal(list.body.reason, 'CORPORATE_TICKET')
})

test('corporate: swap a seat to another verified employee moves the ticket on-chain', { timeout: 400_000 }, async () => {
  const seat = company.seats.find((s) => s.phone === '+91' + phone(11))
  const newEmp = await verified('Employee Four', phone(15))
  assert.equal((await api('POST', `/corporate/seats/${seat.id}/swap`, { newPhone: phone(99) }, admin.token)).body.reason, 'NOT_VERIFIED')
  const r = await api('POST', `/corporate/seats/${seat.id}/swap`, { newPhone: phone(15) }, admin.token)
  assert.equal(r.status, 202, JSON.stringify(r.body))
  await until(async () => {
    const c = (await api('GET', '/corporate/mine', null, admin.token)).body.companies[0]
    const s = c.seats.find((x) => x.id === seat.id)
    if (s.note?.startsWith('Swap failed')) throw new Error(s.note)
    return s.note === null && s.phone === '+91' + phone(15) ? s : null
  }, 'swap')
  assert.equal((await quai.ownerOf(seat.tokenId)).toLowerCase(), newEmp.user.walletAddress.toLowerCase())
  const c = (await api('GET', '/corporate/mine', null, admin.token)).body.companies[0]
  assert.equal(c.seats.find((x) => x.id === seat.id).swapsLeft, 1)
  assert.equal(await quai.contract.isCorporate(seat.tokenId), true)
})
