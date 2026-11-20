// End-to-end story against a running backend (DEMO_MODE=1) and the real Orchard contract:
//   two fans each ask for 3 tickets, 4 in the draw -> one wins 3, the other gets 1 (partial, 2 waiting) ->
//   gate VALID -> rescan ALREADY_USED -> fake token NOT_ON_CHAIN -> forged signer NOT_OWNER ->
//   organiser raises resale cap to 15% -> listing at +16% rejected, +12% listed -> organiser lowers cap to 5% ->
//   that listing is invalid and can't be bought -> old QR after 31 s EXPIRED ->
//   winner returns a ticket -> it goes to the partially served fan.
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
const inr = (n) => `₹${Number(n).toLocaleString('en-IN')}`

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
      body: {
        name: `E2E Night ${run}`,
        artist: 'E2E Band',
        date: '2027-04-01',
        venue: 'Test Arena',
        city: 'Mumbai',
        supply: 10,
        facePriceInr: 4500,
        resaleCapPct: 10,
        lotteryTickets: 4,
      },
    }),
    'create event',
  )
  const ev = created.event
  expect(ev.facePriceInr === 4500 && ev.maxResalePriceInr === 4950, `prices ${ev.facePriceInr} / ${ev.maxResalePriceInr}`)
  ok(`Organiser created event ${ev.id} on Quai (chain event ${ev.chainEventId}), face ${inr(4500)}, cap +10%: ${ev.createTx}`)

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
    const r = await enterWithWork(s.token, ev.id, 3)
    expect(r.status === 201 && r.data.entry.quantity === 3, `${name} entry: ${JSON.stringify(r.data)}`)
    fans.push({ ...s, name })
    ok(`${name} entered for 3 tickets (x402 Work: ${r.payment?.guesses} guesses in ${r.payment?.milliseconds} ms), entry #${r.data.entry.entryNumber}`)
  }
  const again = await api('POST', `/events/${ev.id}/enter`, { token: fans[0].token, body: { quantity: 1 } })
  expect(again.data.reason === 'DUPLICATE_ENTRY', 'second entry blocked')
  ok('Same person entering again -> DUPLICATE_ENTRY (one entry per verified person)')

  const draw = await must(api('POST', `/events/${ev.id}/draw`, { token: org.token }), 'draw')
  expect(draw.draw.winners === 1 && draw.draw.partial === 1 && draw.draw.ticketsAllocated === 4, `draw ${JSON.stringify(draw.draw)}`)
  const proof = await must(api('GET', `/events/${ev.id}/draw-proof`), 'draw proof')
  expect(proof.verified === true, 'draw proof verifies')
  ok('Draw: seed revealed and verified; first in draw order won 3, second got the last 1 (partial, 2 waiting)')

  const stats = await until(async () => {
    const s = (await api('GET', `/events/${ev.id}/stats`)).data
    return s.minting && !s.minting.running ? s : null
  }, 'minting')
  expect(stats.minting.failed === 0, `minting errors: ${stats.minting.errors}`)
  const tickets = {}
  for (const f of fans) tickets[f.name] = (await must(api('GET', '/me/tickets', { token: f.token }), 'my tickets')).tickets
  const winner = fans.find((f) => tickets[f.name].length === 3)
  const partial = fans.find((f) => f !== winner)
  expect(winner && tickets[partial.name].length === 1, 'one fan has 3 tickets, the other 1')
  const [t1, t2, t3] = tickets[winner.name]
  expect([t1, t2, t3].every((t) => t.ownedOnChain), 'tickets owned on-chain')
  ok(`${winner.name} got tokens #${t1.tokenId}-#${t3.tokenId} in one mint transaction; ${partial.name} got #${tickets[partial.name][0].tokenId}: ${t1.mintTx}`)

  // Gate
  const qr1 = await must(api('POST', `/tickets/${t1.tokenId}/qr`, { token: winner.token }), 'qr')
  const qrIssuedAt = Date.now()
  const valid = await must(api('POST', '/gate/verify', { token: staff.token, body: { qr: qr1.qr } }), 'gate')
  expect(valid.result === 'VALID', `expected VALID, got ${valid.result}`)
  ok(`Gate: VALID for ${valid.holderName}, seat ${valid.seat.label}; markUsed ${valid.markedUsed.tx}`)
  const rescan = await must(api('POST', '/gate/verify', { token: staff.token, body: { qr: qr1.qr } }), 'rescan')
  expect(rescan.result === 'ALREADY_USED', `expected ALREADY_USED, got ${rescan.result}`)
  ok('Gate: rescan of the same QR -> ALREADY_USED')

  const fakeWallet = new quais.Wallet('0x' + crypto.randomBytes(32).toString('hex'))
  const ts = Math.floor(Date.now() / 1000)
  const msg = (tokenId, t) => `FairPass gate pass\ncontract: ${health.contract}\nchain: ${health.chainId}\ntoken: ${tokenId}\ntime: ${t}`
  const fake = { tokenId: 999999, timestamp: ts, signature: await fakeWallet.signMessage(msg(999999, ts)) }
  expect((await must(api('POST', '/gate/verify', { token: staff.token, body: { qr: JSON.stringify(fake) } }), 'fake')).result === 'NOT_ON_CHAIN', 'fake')
  ok('Gate: fake ticket #999999 -> NOT_ON_CHAIN')
  const forged = { tokenId: t2.tokenId, timestamp: ts, signature: await fakeWallet.signMessage(msg(t2.tokenId, ts)) }
  expect((await must(api('POST', '/gate/verify', { token: staff.token, body: { qr: JSON.stringify(forged) } }), 'forged')).result === 'NOT_OWNER', 'forged')
  ok(`Gate: real token #${t2.tokenId} with a QR signed by someone else -> NOT_OWNER`)

  // Organiser-controlled resale cap
  const up = await must(api('POST', `/events/${ev.id}/resale-cap`, { token: org.token, body: { pct: 15 } }), 'cap 15')
  expect(up.event.resaleCapPct === 15 && up.event.maxResalePriceInr === 5175, `cap 15: ${JSON.stringify(up.event)}`)
  ok(`Organiser set resale cap to +15% (max ${inr(5175)}) on Quai: ${up.tx}`)
  const tooHigh = await api('POST', `/tickets/${t2.tokenId}/list`, { token: winner.token, body: { priceInr: 5220 } })
  expect(tooHigh.status === 422 && tooHigh.data.reason === 'PRICE_ABOVE_CAP', `+16%: ${tooHigh.status}`)
  ok(`Listing #${t2.tokenId} at ${inr(5220)} (+16%) -> rejected: "${tooHigh.data.error}"`)
  const listed = await must(api('POST', `/tickets/${t2.tokenId}/list`, { token: winner.token, body: { priceInr: 5040 } }), 'list +12%')
  ok(`Listed #${t2.tokenId} at ${inr(5040)} (+12%): ${listed.tx}`)

  const down = await must(api('POST', `/events/${ev.id}/resale-cap`, { token: org.token, body: { pct: 5 } }), 'cap 5')
  expect(down.listingsInvalidated === 1, `invalidated ${down.listingsInvalidated}`)
  ok(`Organiser lowered the cap to +5% (max ${inr(4725)}): 1 listing invalidated: ${down.tx}`)
  const sellerView = (await must(api('GET', '/me/tickets', { token: winner.token }), 'seller')).tickets.find((t) => t.tokenId === t2.tokenId)
  expect(sellerView.listingInvalid === 'invalid – above new cap', 'seller sees the invalid listing')
  const buy = await api('POST', `/tickets/${t2.tokenId}/buy`, { token: partial.token })
  expect(buy.status === 409 && buy.data.reason === 'LISTING_INVALID', `buy invalid: ${buy.status}`)
  ok(`Seller sees "${sellerView.listingInvalid}"; buying it -> refused (LISTING_INVALID)`)

  const wait = 31_000 - (Date.now() - qrIssuedAt)
  if (wait > 0) await sleep(wait)
  const expired = await must(api('POST', '/gate/verify', { token: staff.token, body: { qr: qr1.qr } }), 'expired')
  expect(expired.result === 'EXPIRED', `expected EXPIRED, got ${expired.result}`)
  ok('Gate: the first QR 31 s later (a screenshot) -> EXPIRED')

  // Return to pool -> the partially served fan
  const ret = await must(api('POST', `/tickets/${t3.tokenId}/return`, { token: winner.token }), 'return')
  ok(`${winner.name} returned #${t3.tokenId} (refund ${inr(ret.refund.amountInr)} mock): ${ret.tx}`)
  const got = await until(async () => {
    const r = (await api('GET', '/me/tickets', { token: partial.token })).data
    return r.tickets.find((t) => t.tokenId === t3.tokenId && t.ownedOnChain) ? r : null
  }, 'reassignment to the waiting fan')
  const entry = got.entries.find((e) => e.eventId === ev.id)
  const re = (await api('GET', `/tickets/${t3.tokenId}/reassignment`)).data.reassignment
  ok(`${partial.name} (still waiting for 2) now owns #${t3.tokenId}: ${entry.ticketsWon} of ${entry.quantity} tickets: ${re.tx}`)

  console.log(`\n  All ${step} steps passed in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`)
}

main().catch((err) => {
  console.error('\n ', err.message || err)
  process.exit(1)
})
