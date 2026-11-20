// Simulates a scalper bot farm hitting the lottery with 10,000 entry attempts.
//   node scripts/bot-attack.js [eventId]        (backend must run with DEMO_MODE=1)
//
// Waves:
//   A  5,000 entries with no account                         -> NO_ID
//   B  2,000 entries from 20 accounts that skipped ID checks  -> NOT_VERIFIED
//   C  1,000 repeat entries from one verified ID              -> DUPLICATE_ENTRY
//   D  1,998 entries skipping or faking the proof-of-work     -> RATE_LIMITED / INVALID_POW / puzzle never solved
//   +  2 bots that do everything honestly (real ID, real x402 Work) get in, once each.
// Plus 10 accounts trying to reuse a stolen ID at KYC (blocked as DUPLICATE_ID, reported separately).
import crypto from 'node:crypto'
import { API, api, enterWithWork, fmt, login, must, pool, randomAadhaar, verifyId } from './lib/api.mjs'

const CONCURRENCY = 100
const runId = Date.now().toString().slice(-6)
let phoneCounter = 0
const botPhone = () => `+9170${runId}${String(phoneCounter++).padStart(4, '0')}`

function classify(r) {
  if (r.status === 201) return 'ACCEPTED'
  if (r.data?.reason) return r.data.reason
  if (r.status === 402 && r.data?.accepts) return 'NO_POW (puzzle issued, never solved)'
  return `HTTP_${r.status}`
}

async function main() {
  const eventId =
    Number(process.argv[2]) ||
    (await must(api('GET', '/events'), 'list events')).events.find((e) => e.lotteryStatus === 'open')?.id
  if (!eventId) throw new Error('No open lottery event. Create one (or run npm run demo) first.')
  console.log(`\nFairPass bot attack simulation -> ${API}, event ${eventId}\n`)

  const tally = {}
  const record = (wave, results) => {
    const counts = {}
    for (const r of results) {
      const c = classify(r)
      counts[c] = (counts[c] || 0) + 1
      tally[c] = (tally[c] || 0) + 1
    }
    const blocked = results.filter((r) => r.status !== 201).length
    const parts = Object.entries(counts)
      .map(([k, v]) => `${k} ${fmt(v)}`)
      .join(', ')
    console.log(`  ${wave.padEnd(52)} blocked ${fmt(blocked).padStart(5)} / ${fmt(results.length).padStart(5)}   (${parts})`)
    return results
  }
  const enter = (token, extraHeaders) => () =>
    api('POST', `/events/${eventId}/enter`, { token, body: { quantity: 2 }, headers: extraHeaders })
  const t0 = Date.now()

  // A: anonymous
  record('A  5,000 entries with no account', await pool(Array(5000).fill(enter()), CONCURRENCY, (f) => f()))

  // B: accounts without ID verification
  const unverified = await pool(Array.from({ length: 20 }, botPhone), 10, (p) => login(p))
  const bJobs = unverified.flatMap((u) => Array(100).fill(enter(u.token)))
  record('B  2,000 entries from 20 accounts with no verified ID', await pool(bJobs, CONCURRENCY, (f) => f()))

  // Two honest bots: real ID, real proof-of-work. They get in, once.
  const honest = []
  for (let i = 0; i < 2; i++) {
    const s = await login(botPhone())
    const kyc = await verifyId(s.token, `Bot Runner ${i + 1}`, randomAadhaar())
    if (kyc.status !== 200) throw new Error(`KYC failed: ${JSON.stringify(kyc.data)}`)
    const r = await enterWithWork(s.token, eventId, 2)
    honest.push({ ...s, result: r })
  }
  const stolenId = randomAadhaar()

  // C: the first honest bot tries to enter 1,000 more times
  record('C  1,000 repeat entries from an ID that already entered', await pool(Array(1000).fill(enter(honest[0].token)), CONCURRENCY, (f) => f()))

  // D: verified ID, but skips or fakes the proof-of-work
  const d = await login(botPhone())
  await verifyId(d.token, 'Bot Runner 3', stolenId)
  const fakeProof = () =>
    Buffer.from(
      JSON.stringify({ x402Version: 2, accepted: { extra: { job: { id: crypto.randomBytes(8).toString('hex') } } }, payload: { solution: { nonce: '0x00000000' } } }),
    ).toString('base64')
  const dJobs = Array.from({ length: 1998 }, (_, i) => (i % 2 ? enter(d.token, { 'payment-signature': fakeProof() }) : enter(d.token)))
  record('D  1,998 entries skipping or faking the proof-of-work', await pool(dJobs, CONCURRENCY, (f) => f()))

  record('+  2 bots with a real ID that solved a real puzzle', honest.map((h) => h.result))

  // Stolen ID reuse at KYC
  const thieves = await pool(Array.from({ length: 10 }, botPhone), 10, (p) => login(p))
  const kycTries = await pool(thieves, 10, (t) => verifyId(t.token, 'Stolen Identity', stolenId))
  const kycBlocked = kycTries.filter((r) => r.status === 409).length

  const total = Object.values(tally).reduce((a, b) => a + b, 0)
  const accepted = tally.ACCEPTED || 0
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  console.log('\n  ------------------------------------------------------------------')
  console.log(`  ${fmt(total - accepted)} / ${fmt(total)} blocked (${(((total - accepted) / total) * 100).toFixed(2)}%) in ${secs}s`)
  console.log('  Blocked by reason:')
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) if (k !== 'ACCEPTED') console.log(`    ${k.padEnd(40)} ${fmt(v)}`)
  console.log(`  Stolen ID reused at KYC: ${kycBlocked} / ${thieves.length} accounts blocked (DUPLICATE_ID)`)
  if (honest.every((h) => h.result.status === 201)) {
    const p = honest[0].result.payment
    console.log(
      `\n  ${accepted} got through: each used a real verified ID and solved a real x402 Work puzzle` +
        (p ? ` (${fmt(p.guesses)} SHA-256d guesses, ${p.milliseconds} ms)` : '') +
        '.\n  That ID can never enter this event again. A million bots would need a million real IDs.',
    )
  } else {
    console.log('\n  Honest bot entries:', honest.map((h) => `${h.result.status} ${JSON.stringify(h.result.data)}`).join(' | '))
  }
  console.log('  Note: the per-IP rate limit for this machine resets after 60 s.\n')
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})
