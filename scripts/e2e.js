// End-to-end "pass your ticket on" story against a running backend (DEMO_MODE=1) and the real Orchard contract.
// Start the API with QR_MAX_AGE_SECONDS=300 for this script, so the seller's old QR is still "fresh" after the sale
// and the gate rejects it because of the owner check (NOT_OWNER), not just its age.
//   1. public listing -> a non-waitlisted fan is blocked by waitlist priority -> the waitlisted fan buys it ->
//      the seller's old QR is rejected at the gate (NOT_OWNER), the buyer's new QR passes (VALID)
//   2. private sale via share link: invisible to others, bought by the chosen buyer
//   3. gift once -> second gift blocked; gift to yourself blocked
//   4. over-cap listing rejected; organiser lowers the cap -> the existing listing can't be bought
//   5. an event less than 24 h away: gifts and listings are locked
//   node scripts/e2e.js
import { API, api, buyWithWork, enterWithWork, login, must, randomAadhaar, verifyId } from './lib/api.mjs'

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
const reason = (r) => r.data?.reason
const myTickets = async (t) => (await must(api('GET', '/me/tickets', { token: t }), 'my tickets')).tickets

async function fan(n, name) {
  const s = await login(phone(n))
  const k = await verifyId(s.token, name, randomAadhaar())
  expect(k.status === 200, `KYC ${name}`)
  return { ...s, name, phone: phone(n) }
}

async function main() {
  const health = await must(api('GET', '/health'), 'health')
  console.log(`\nFairPass "pass it on" end-to-end test -> ${API} (contract ${health.contract})\n`)
  const org = (await login(ORGANISER_PHONE)).token
  const staff = await login(phone(1))
  await must(api('POST', '/staff', { token: org, body: { phone: staff.user.phone } }), 'make staff')

  // Two events: a normal one, and one that starts in 2 hours (inside the 24 h transfer lock).
  const [{ event: ev }, { event: soon }] = await Promise.all([
    must(api('POST', '/events', { token: org, body: { name: `Pass-on Night ${run}`, date: '2027-05-01T19:00:00+05:30', supply: 10, facePriceInr: 4500, resaleCapPct: 10, lotteryTickets: 3 } }), 'event'),
    must(
      api('POST', '/events', {
        token: org,
        body: { name: `Tonight ${run}`, date: new Date(Date.now() + 2 * 3600_000).toISOString(), supply: 5, facePriceInr: 4500, resaleCapPct: 10, lotteryTickets: 1, lotteryClose: new Date(Date.now() + 3600_000).toISOString() },
      }),
      'locked event',
    ),
  ])
  ok(`Created "${ev.name}" (chain event ${ev.chainEventId}) and "${soon.name}" starting in 2 h (chain event ${soon.chainEventId})`)

  const seller = await fan(2, 'Asha')
  const waiter = await fan(3, 'Ravi')
  const privateBuyer = await fan(4, 'Meera')
  const friend = await fan(5, 'Kabir')
  const other = await fan(6, 'Zoya')
  await Promise.all(
    [seller, waiter, privateBuyer, friend, other].map((f) => must(api('POST', '/admin/fund', { token: org, body: { phone: f.phone, amountQuai: '0.05' } }), `fund ${f.name}`)),
  )
  ok('5 verified fans, each wallet funded with 0.05 QUAI')

  // Both ask for 3 of the 3 tickets: whoever is drawn first wins all 3, the other is waitlisted.
  for (const f of [seller, waiter]) expect((await enterWithWork(f.token, ev.id, 3)).status === 201, `${f.name} entry`)
  expect((await enterWithWork(seller.token, soon.id, 1)).status === 201, 'entry for the locked event')
  await must(api('POST', `/events/${ev.id}/draw`, { token: org }), 'draw')
  await must(api('POST', `/events/${soon.id}/draw`, { token: org }), 'draw soon')
  for (const id of [ev.id, soon.id])
    await until(async () => {
      const s = (await api('GET', `/events/${id}/stats`)).data
      return s.minting && !s.minting.running ? s : null
    }, 'minting')
  let a = await myTickets(seller.token)
  let b = await myTickets(waiter.token)
  const [winner, waitlisted] = a.filter((t) => t.eventId === ev.id).length === 3 ? [seller, waiter] : [waiter, seller]
  const wins = (winner === seller ? a : b).filter((t) => t.eventId === ev.id)
  expect(wins.length === 3, `winner has 3 tickets (${wins.length})`)
  const [t1, t2, t3] = wins
  ok(`Draw: ${winner.name} won tickets #${t1.tokenId}, #${t2.tokenId}, #${t3.tokenId}; ${waitlisted.name} is waitlisted`)

  // ---- 1. public listing, waitlist priority, buy, gate
  const over = await api('POST', `/tickets/${t1.tokenId}/list`, { token: winner.token, body: { priceInr: 5300, visibility: 'public' } })
  expect(over.status === 422 && reason(over) === 'PRICE_ABOVE_CAP', `over-cap: ${over.status}`)
  ok(`Over-cap listing at ${inr(5300)} rejected: "${over.data.error}"`)
  const pub = await must(api('POST', `/tickets/${t1.tokenId}/list`, { token: winner.token, body: { priceInr: 4950, visibility: 'public' } }), 'list public')
  ok(`${winner.name} listed #${t1.tokenId} publicly at ${inr(4950)} (+10%): ${pub.tx}`)
  const market = (await must(api('GET', `/events/${ev.id}/marketplace`, { token: other.token }), 'market')).listings
  const card = market.find((l) => l.id === pub.listing.id)
  expect(card && card.priorityOnly && !card.canBuy && card.cannotBuyReason === 'WAITLIST_PRIORITY', `priority card ${JSON.stringify(card)}`)
  const early = await api('POST', `/listings/${pub.listing.id}/buy`, { token: other.token })
  expect(reason(early) === 'WAITLIST_PRIORITY', `non-waitlisted buy: ${reason(early)}`)
  ok(`Marketplace: ${other.name} (not waitlisted) sees "waitlist priority" and can't buy for the first 10 minutes`)
  const oldQr = await must(api('POST', `/tickets/${t1.tokenId}/qr`, { token: winner.token }), 'old qr')
  const bought = await buyWithWork(waitlisted.token, pub.listing.id)
  expect(bought.status === 201, `waitlisted buy: ${bought.status} ${JSON.stringify(bought.data)}`)
  ok(`${waitlisted.name} (waitlisted) bought it after an x402 Work puzzle (${bought.payment?.guesses} guesses): ${bought.data.tx}`)
  const gateOld = await must(api('POST', '/gate/verify', { token: staff.token, body: { qr: oldQr.qr } }), 'gate old')
  expect(gateOld.result === 'NOT_OWNER', `old QR: ${gateOld.result}`)
  const sellerQr = await api('POST', `/tickets/${t1.tokenId}/qr`, { token: winner.token })
  expect(sellerQr.status === 403, 'seller can no longer get a QR')
  const newQr = await must(api('POST', `/tickets/${t1.tokenId}/qr`, { token: waitlisted.token }), 'new qr')
  const gateNew = await must(api('POST', '/gate/verify', { token: staff.token, body: { qr: newQr.qr } }), 'gate new')
  expect(gateNew.result === 'VALID', `new QR: ${gateNew.result}`)
  ok(`Gate: ${winner.name}'s old QR -> REJECTED (NOT_OWNER); ${waitlisted.name}'s new QR -> VALID`)
  const label = (await myTickets(waitlisted.token)).find((t) => t.tokenId === t1.tokenId)
  expect(label.acquiredVia === 'purchase' && label.acquiredFrom === winner.name, 'bought-from label')
  ok(`${waitlisted.name}'s ticket reads "Bought from ${label.acquiredFrom}"`)

  // ---- 2. private sale via share link
  const priv = await must(
    api('POST', `/tickets/${t2.tokenId}/list`, { token: winner.token, body: { priceInr: 4725, visibility: 'private', buyerPhone: privateBuyer.phone } }),
    'list private',
  )
  expect(/\/buy\/\d+$/.test(priv.shareUrl), `share link ${priv.shareUrl}`)
  ok(`${winner.name} made a private sale of #${t2.tokenId} for ${privateBuyer.name} at ${inr(4725)}: ${priv.shareUrl}`)
  expect((await api('GET', `/listings/${priv.listing.id}`, { token: other.token })).status === 404, 'others cannot see it')
  expect(!(await api('GET', `/events/${ev.id}/marketplace`)).data.listings.some((l) => l.id === priv.listing.id), 'not in marketplace')
  expect((await api('POST', `/listings/${priv.listing.id}/buy`, { token: other.token })).status === 404, 'others cannot buy it')
  const view = await must(api('GET', `/listings/${priv.listing.id}`, { token: privateBuyer.token }), 'buyer view')
  expect(view.listing.canBuy, 'buyer can buy')
  ok('The link is invisible to anyone else (404) and the listing never appears in the marketplace')
  const pb = await buyWithWork(privateBuyer.token, priv.listing.id)
  expect(pb.status === 201, `private buy: ${pb.status} ${JSON.stringify(pb.data)}`)
  ok(`${privateBuyer.name} opened the link and bought it: ${pb.data.tx}`)

  // ---- 3. gifts
  const self = await api('POST', `/tickets/${t3.tokenId}/gift`, { token: winner.token, body: { phone: winner.phone } })
  expect(reason(self) === 'SELF', `gift to self: ${reason(self)}`)
  const lookup = await must(api('GET', `/users/lookup?phone=${friend.phone}`, { token: winner.token }), 'lookup')
  const gift = await must(api('POST', `/tickets/${t3.tokenId}/gift`, { token: winner.token, body: { phone: friend.phone } }), 'gift')
  ok(`Gift to yourself blocked; ${winner.name} gifted #${t3.tokenId} to ${lookup.name} (verified): ${gift.tx}`)
  const again = await api('POST', `/tickets/${t3.tokenId}/gift`, { token: friend.token, body: { phone: other.phone } })
  expect(reason(again) === 'ALREADY_GIFTED', `second gift: ${reason(again)}`)
  const ft = (await myTickets(friend.token)).find((t) => t.tokenId === t3.tokenId)
  expect(ft.acquiredVia === 'gift' && ft.acquiredFrom === winner.name && ft.gifted, 'gift label')
  ok(`${friend.name}'s ticket reads "Gift from ${ft.acquiredFrom}"; gifting it again -> "${again.data.error}"`)

  // ---- 4. organiser lowers the cap under an existing listing
  const l3 = await must(api('POST', `/tickets/${t3.tokenId}/list`, { token: friend.token, body: { priceInr: 4950, visibility: 'public' } }), 'list t3')
  const down = await must(api('POST', `/events/${ev.id}/resale-cap`, { token: org, body: { pct: 5 } }), 'cap 5')
  expect(down.listingsInvalidated === 1, `invalidated ${down.listingsInvalidated}`)
  const blocked = await api('POST', `/listings/${l3.listing.id}/buy`, { token: waitlisted.token })
  expect(reason(blocked) === 'LISTING_INVALID', `buy after cap lowered: ${reason(blocked)}`)
  ok(`${friend.name} listed at ${inr(4950)}; organiser lowered the cap to +5% (${down.tx}); buying it now -> "${blocked.data.error}"`)

  // ---- 5. 24 h transfer lock
  const lockedTicket = (await myTickets(seller.token)).find((t) => t.eventId === soon.id)
  expect(lockedTicket?.locked, 'ticket for the soon event is locked')
  const lg = await api('POST', `/tickets/${lockedTicket.tokenId}/gift`, { token: seller.token, body: { phone: other.phone } })
  const ll = await api('POST', `/tickets/${lockedTicket.tokenId}/list`, { token: seller.token, body: { priceInr: 4500, visibility: 'public' } })
  expect(reason(lg) === 'TRANSFERS_LOCKED' && reason(ll) === 'TRANSFERS_LOCKED', `lock: ${reason(lg)} / ${reason(ll)}`)
  ok(`Event in 2 h: gift and listing both refused: "${lg.data.error}"`)

  const stats = (await must(api('GET', `/events/${ev.id}/stats`), 'stats')).tickets
  ok(
    `Organiser counts: listed ${stats.listedPublic + stats.listedPrivate}, sold publicly ${stats.soldPublic}, sold privately ${stats.soldPrivate}, gifted ${stats.gifted}, avg markup +${stats.avgMarkupPct}%`,
  )
  console.log(`\n  All ${step} steps passed in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`)
}

main().catch((err) => {
  console.error('\n ', err.message || err)
  process.exit(1)
})
