// Phase 6 integration test: resale in ₹ (list / over-cap / buy with royalty) and the organiser-controlled
// resale cap (setResaleCap on Orchard, listings above a lowered cap become invalid and can't be bought).
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
process.env.LISTING_PRIORITY_MINUTES = '0' // no waitlist-only window in this test (e2e covers it)

const { createApp } = await import('../src/app.js')
const { ensureOrganiser, getUser } = await import('../src/services/users.js')
const { db } = await import('../src/db.js')
const quai = await import('../src/services/quai.js')
const { mintToUser } = await import('../src/services/tickets.js')
const { payWithWork } = await import('x402-work-client')

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

before(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}`
  orgToken = (await login(org.phone)).token
  // A fresh on-chain event: face ₹4,500 (0.01 QUAI at the default rate), cap 10%.
  const r = await api('POST', '/events', { name: 'Phase 6 Test', date: '2027-02-01', supply: 20, facePriceInr: 4500, resaleCapPct: 10 }, orgToken)
  assert.equal(r.status, 201, JSON.stringify(r.body))
  event = r.body.event
})
after(() => {
  server.close()
  db.close()
  for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) fs.rmSync(f, { force: true })
  quai.provider.destroy()
})

test('event prices are shown in ₹ and match the on-chain cap', () => {
  assert.equal(event.facePriceInr, 4500)
  assert.equal(event.facePrice, '0.01')
  assert.equal(event.resaleCapPct, 10)
  assert.equal(event.maxResalePriceInr, 4950)
  assert.equal(event.maxResalePrice, '0.011')
})

let seller, buyer, ticket, ticket2
test('resale: over-cap rejected with the ₹ maximum; list at the cap; buyer pays; seller gets price minus 2%', { timeout: 400_000 }, async () => {
  seller = await verified('Seller', phone(1))
  buyer = await verified('Buyer', phone(2))
  ;[ticket, ticket2] = await mintToUser(db.prepare('SELECT * FROM events WHERE id = ?').get(event.id), getUser(seller.user.id), 2)
  assert.ok(ticket2.tokenId === ticket.tokenId + 1, 'two tickets minted in one batch')

  const over = await api('POST', `/tickets/${ticket.tokenId}/list`, { priceInr: 50000 }, seller.token)
  assert.equal(over.status, 422)
  assert.equal(over.body.reason, 'PRICE_ABOVE_CAP')
  assert.equal(over.body.maxPriceInr, 4950)
  assert.match(over.body.error, /₹4,950/)

  const listed = await api('POST', `/tickets/${ticket.tokenId}/list`, { priceInr: 4950, visibility: 'public' }, seller.token)
  assert.equal(listed.status, 201, JSON.stringify(listed.body))
  assert.equal(listed.body.listing.price, '0.011')
  assert.equal(listed.body.listing.priceInr, 4950)
  const market = (await api('GET', `/events/${event.id}/marketplace`)).body
  assert.ok(market.listings.some((l) => l.id === listed.body.listing.id))

  // The buyer pays from their own wallet: no money -> clear error; then fund it (demo seed does the same).
  const broke = await api('POST', `/listings/${listed.body.listing.id}/buy`, {}, buyer.token)
  assert.equal(broke.body.reason, 'NOT_ENOUGH_BALANCE')
  await quai.fund(buyer.user.walletAddress, quai.quais.parseQuai('0.02'))

  const sellerBefore = await quai.provider.getBalance(seller.user.walletAddress)
  const { response } = await payWithWork(`${base}/listings/${listed.body.listing.id}/buy`, {}, {
    headers: { authorization: `Bearer ${buyer.token}` },
    maxPrice: 1_000_000,
  })
  assert.equal(response.status, 201, await response.clone().text())
  assert.equal((await quai.ownerOf(ticket.tokenId)).toLowerCase(), buyer.user.walletAddress.toLowerCase())
  const sellerAfter = await quai.provider.getBalance(seller.user.walletAddress)
  const expected = quai.quais.parseQuai('0.011') - quai.quais.parseQuai('0.011') / 50n
  assert.equal(sellerAfter - sellerBefore, expected)
})

test('organiser-only cap endpoint validates 0-100', async () => {
  assert.equal((await api('POST', `/events/${event.id}/resale-cap`, { pct: 20 }, seller.token)).status, 403)
  assert.equal((await api('POST', `/events/${event.id}/resale-cap`, { pct: 101 }, orgToken)).status, 400)
  assert.equal((await api('POST', `/events/${event.id}/resale-cap`, { pct: -1 }, orgToken)).status, 400)
  assert.equal((await api('POST', `/events/${event.id}/resale-cap`, { pct: 2.5 }, orgToken)).status, 400)
})

test('raise cap to 15% -> list at +12%; lower to 5% -> listing invalid, cannot be bought; raise -> valid again', { timeout: 600_000 }, async () => {
  const up = await api('POST', `/events/${event.id}/resale-cap`, { pct: 15 }, orgToken)
  assert.equal(up.status, 200, JSON.stringify(up.body))
  assert.equal(up.body.event.resaleCapPct, 15)
  assert.equal(up.body.event.maxResalePriceInr, 5175)
  assert.match(up.body.tx, /orchard\.quaiscan\.io\/tx\/0x/)
  assert.equal(Number((await quai.chainEvent(event.chainEventId)).resaleCapPct), 15)

  const above = await api('POST', `/tickets/${ticket2.tokenId}/list`, { priceInr: 5220 }, seller.token) // +16%
  assert.equal(above.body.reason, 'PRICE_ABOVE_CAP')
  const listed = await api('POST', `/tickets/${ticket2.tokenId}/list`, { priceInr: 5040, visibility: 'public' }, seller.token) // +12%
  assert.equal(listed.status, 201, JSON.stringify(listed.body))

  const down = await api('POST', `/events/${event.id}/resale-cap`, { pct: 5 }, orgToken)
  assert.equal(down.status, 200, JSON.stringify(down.body))
  assert.equal(down.body.listingsInvalidated, 1)
  assert.equal(down.body.event.maxResalePriceInr, 4725)
  const mine = (await api('GET', '/me/tickets', null, seller.token)).body.tickets.find((t) => t.tokenId === ticket2.tokenId)
  assert.equal(mine.listingInvalid, 'invalid – above new cap')
  assert.ok(!(await api('GET', `/events/${event.id}/marketplace`)).body.listings.some((l) => l.tokenId === ticket2.tokenId))
  const buy = await api('POST', `/listings/${listed.body.listing.id}/buy`, {}, buyer.token)
  assert.equal(buy.status, 409)
  assert.equal(buy.body.reason, 'LISTING_INVALID')
  const stats = (await api('GET', `/events/${event.id}/stats`)).body
  assert.equal(stats.tickets.invalidListings, 1)

  const back = await api('POST', `/events/${event.id}/resale-cap`, { pct: 15 }, orgToken)
  assert.equal(back.body.listingsRevalidated, 1)
  const again = (await api('GET', '/me/tickets', null, seller.token)).body.tickets.find((t) => t.tokenId === ticket2.tokenId)
  assert.equal(again.listingInvalid, null)
})
