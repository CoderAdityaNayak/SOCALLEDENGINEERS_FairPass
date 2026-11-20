// End-to-end story against a running backend (DEMO_MODE=1) and the real Orchard contract:
//   fan wins -> gets QR -> gate VALID -> rescan ALREADY_USED -> old QR after 31 s EXPIRED ->
//   fake token NOT_ON_CHAIN -> QR signed by someone else NOT_OWNER -> over-cap listing rejected ->
//   return to pool -> the waitlisted fan receives it.
//   node scripts/e2e.js
import crypto from 'node:crypto'
import { quais } from 'quais'
import { API, api, enterWithWork, login, must, randomAadhaar, verifyId } from './lib/api.mjs'

const ORGANISER_PHONE = process.env.ORGANISER_PHONE || '+919000000001'
const run = String(Date.now()).slice(-4)
const phone = (n) => `97${run}${String(n).padStart(4, '0')}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
let step = 0

function ok(msg) {
  console.log(`  ${String(++step).padStart(2)}. ${msg}  [${((Date.now() - t0) / 1000).toFixed(0)}s]`)
}
function expect(cond, msg) {
  if (!cond) throw new Error(`FAILED: ${msg}`)
}
async function until(fn, what, ms = 300_000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(3000)
  }
}

async function main() {
  const health = await must(api('GET', '/health'), 'health')
  console.log(`\nFairPass end-to-end test -> ${API} (contract ${health.contract})\n`)

  const org = await login(ORGANISER_PHONE)
  const created = await must(
    api('POST', '/events', {
      token: org.token,
      body: { name: `E2E Night ${run}`, artist: 'E2E Band', date: '2027-04-01', venue: 'Test Arena', city: 'Mumbai', supply: 10, facePrice: '0.01', lotteryTickets: 2 },
    }),
    'create event',
  )
  const eventId = created.event.id
  ok(`Organiser created event ${eventId} on Quai (chain event ${created.event.chainEventId}): ${created.event.createTx}`)

  const staff = await login(phone(1))
  await must(api('POST', '/staff', { token: org.token, body: { phone: staff.user.phone } }), 'make staff')
  ok('Gate staff account created')

  const fans = []
  for (const [i, name] of [
    [2, 'Asha'],
    [3, 'Ravi'],
  ]) {
    const s = await login(phone(i))
    const k = await verifyId(s.token, name, randomAadhaar())
    expect(k.status === 200, `KYC for ${name}`)
    const r = await enterWithWork(s.token, eventId, 2)
    expect(r.status === 201, `${name} entry: ${JSON.stringify(r.data)}`)
    fans.push({ ...s, name, entry: r.data.entry })
    ok(`${name} verified ID and entered (x402 Work: ${r.payment?.guesses} guesses in ${r.payment?.milliseconds} ms), entry #${r.data.entry.entryNumber}`)
  }

  const draw = await must(api('POST', `/events/${eventId}/draw`, { token: org.token }), 'draw')
  expect(draw.draw.winners === 1 && draw.draw.waitlist === 1, `expected 1 winner + 1 waitlist, got ${JSON.stringify(draw.draw)}`)
  const proof = await must(api('GET', `/events/${eventId}/draw-proof`), 'draw proof')
  expect(proof.verified === true, 'draw proof verifies')
  ok(`Draw: seed revealed, sha256(seed) matches the commitment ${proof.seedHash.slice(0, 12)}...; 1 winner (2 tickets), 1 waitlisted`)

  const stats = await until(async () => {
    const s = (await api('GET', `/events/${eventId}/stats`)).data
    return s.minting && !s.minting.running ? s : null
  }, 'minting')
  expect(stats.minting.failed === 0, `minting errors: ${stats.minting.errors}`)
  const tickets = {}
  for (const f of fans) tickets[f.name] = (await must(api('GET', '/me/tickets', { token: f.token }), 'my tickets')).tickets
  const winner = fans.find((f) => tickets[f.name].length === 2)
  const waitlisted = fans.find((f) => f !== winner)
  expect(winner && tickets[waitlisted.name].length === 0, 'one fan has 2 tickets, the other none')
  const [t1, t2] = tickets[winner.name]
  expect(t1.ownedOnChain && t2.ownedOnChain, 'tickets owned on-chain')
  ok(`${winner.name} won: tokens #${t1.tokenId} (${t1.seat}) and #${t2.tokenId} minted on Quai: ${t1.mintTx}`)

  // Gate
  const qr1 = await must(api('POST', `/tickets/${t1.tokenId}/qr`, { token: winner.token }), 'qr')
  const qrIssuedAt = Date.now()
  const valid = await must(api('POST', '/gate/verify', { token: staff.token, body: { qr: qr1.qr } }), 'gate')
  expect(valid.result === 'VALID', `expected VALID, got ${valid.result}`)
  ok(`Gate: VALID for ${valid.holderName}, seat ${valid.seat.label}; checks ${valid.checks.map((c) => c.id + '=' + c.pass).join(', ')}; markUsed ${valid.markedUsed.tx}`)

  const again = await must(api('POST', '/gate/verify', { token: staff.token, body: { qr: qr1.qr } }), 'rescan')
  expect(again.result === 'ALREADY_USED', `expected ALREADY_USED, got ${again.result}`)
  ok('Gate: rescan of the same QR -> ALREADY_USED')

  const fakeWallet = new quais.Wallet('0x' + crypto.randomBytes(32).toString('hex'))
  const ts = Math.floor(Date.now() / 1000)
  const msg = (tokenId, t) => `FairPass gate pass\ncontract: ${health.contract}\nchain: ${health.chainId}\ntoken: ${tokenId}\ntime: ${t}`
  const fake = { tokenId: 999999, timestamp: ts, signature: await fakeWallet.signMessage(msg(999999, ts)) }
  const fakeRes = await must(api('POST', '/gate/verify', { token: staff.token, body: { qr: JSON.stringify(fake) } }), 'fake')
  expect(fakeRes.result === 'NOT_ON_CHAIN', `expected NOT_ON_CHAIN, got ${fakeRes.result}`)
  ok('Gate: fake ticket #999999 -> NOT_ON_CHAIN')

  const forged = { tokenId: t2.tokenId, timestamp: ts, signature: await fakeWallet.signMessage(msg(t2.tokenId, ts)) }
  const forgedRes = await must(api('POST', '/gate/verify', { token: staff.token, body: { qr: JSON.stringify(forged) } }), 'forged')
  expect(forgedRes.result === 'NOT_OWNER', `expected NOT_OWNER, got ${forgedRes.result}`)
  ok(`Gate: real token #${t2.tokenId} with a QR signed by someone else -> NOT_OWNER`)

  // Resale cap (backend check, instant) before waiting for the QR to expire
  const over = await api('POST', `/tickets/${t2.tokenId}/list`, { token: winner.token, body: { price: '3' } })
  expect(over.status === 422 && over.data.reason === 'PRICE_ABOVE_CAP', `over-cap listing: ${over.status} ${JSON.stringify(over.data)}`)
  ok(`Listing #${t2.tokenId} for 3 QUAI -> rejected: "${over.data.error}"`)

  const wait = 31_000 - (Date.now() - qrIssuedAt)
  if (wait > 0) await sleep(wait)
  const expired = await must(api('POST', '/gate/verify', { token: staff.token, body: { qr: qr1.qr } }), 'expired')
  expect(expired.result === 'EXPIRED', `expected EXPIRED, got ${expired.result}`)
  ok('Gate: the first QR 31 s later (a screenshot) -> EXPIRED')

  // Return to pool -> waitlisted fan
  const ret = await must(api('POST', `/tickets/${t2.tokenId}/return`, { token: winner.token }), 'return')
  ok(`${winner.name} returned #${t2.tokenId}: refund ${ret.refund.amount} QUAI (mock), returnToPool ${ret.tx}`)
  const got = await until(async () => {
    const r = (await api('GET', '/me/tickets', { token: waitlisted.token })).data
    return r.tickets.find((t) => t.tokenId === t2.tokenId && t.ownedOnChain)
  }, 'reassignment to the waitlisted fan')
  const re = (await api('GET', `/tickets/${t2.tokenId}/reassignment`)).data.reassignment
  ok(`Waitlisted ${waitlisted.name} (draw rank ${re.drawRank}) now owns #${got.tokenId} on Quai: ${re.tx}`)

  console.log(`\n  All ${step} steps passed in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`)
}

main().catch((err) => {
  console.error('\n ', err.message || err)
  process.exit(1)
})
