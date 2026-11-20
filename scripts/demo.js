// npm run demo: starts backend + frontend, seeds a ready-to-present FairPass demo, prints logins.
//
// Seeds (through the real API, so everything is on Quai Orchard):
//   - 3 open lottery events created on-chain (DEMO_EVENTS: different names, dates, ₹ prices and resale %)
//   - organiser, gate staff, 5 verified fans (fans 2-5 entered World Tour with real x402 Work proofs, asking for
//     2, 1, 1 and 1 tickets; two of them also entered Monsoon Sessions; fan 1 is left for the live demo)
// Options: --keep   keep the existing demo database instead of resetting it
//
// Every account logs in with OTP 123456 (DEMO_FIXED_OTP). Ctrl+C stops both servers.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { api, enterWithWork, login, must, randomAadhaar, verifyId } from './lib/api.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const API_PORT = 8080
const WEB_URL = 'http://localhost:5173'
const OTP = '123456'
const DB = path.join(root, 'backend', 'data', 'demo.db')
const keep = process.argv.includes('--keep')

const FAN_FUNDING_QUAI = '0.05'

const DEMO_EVENTS = [
  {
    name: 'World Tour',
    artist: '[Headliner]',
    date: '2027-01-19T19:30:00+05:30',
    venue: 'DY Patil Stadium',
    city: 'Mumbai',
    supply: 100,
    facePriceInr: 4500,
    resaleCapPct: 10,
    lotteryTickets: 4,
    lotteryCloseInDays: 2,
  },
  {
    name: 'Monsoon Sessions',
    artist: 'Indie Collective',
    date: '2026-12-20T18:00:00+05:30',
    venue: 'Shanmukhananda Hall',
    city: 'Mumbai',
    supply: 40,
    facePriceInr: 2500,
    resaleCapPct: 5,
    lotteryTickets: 3,
    lotteryCloseInDays: 1,
  },
  {
    name: 'Coastal Beats',
    artist: 'Sunset DJ Night',
    date: '2027-02-14T20:00:00+05:30',
    venue: 'Vagator Beach Grounds',
    city: 'Goa',
    supply: 80,
    facePriceInr: 6000,
    resaleCapPct: 20,
    lotteryTickets: 5,
    lotteryCloseInDays: 3,
  },
]

const PEOPLE = {
  organiser: { phone: '+919000000001', name: 'FairPass Organiser' },
  staff: { phone: '+919000000002', name: 'Gate Staff (Vikram)' },
  fans: [
    { phone: '+919000000011', name: 'Asha Rao' },
    { phone: '+919000000012', name: 'Ravi Kumar' },
    { phone: '+919000000013', name: 'Meera Iyer' },
    { phone: '+919000000014', name: 'Kabir Shah' },
    { phone: '+919000000015', name: 'Zoya Khan' },
  ],
}

const children = []
function start(name, cmd, args, cwd, env = {}) {
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const prefix = `[${name}]`
  const pipe = (stream, out) =>
    stream.on('data', (d) =>
      String(d)
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((line) => out.write(`${prefix} ${line}\n`)),
    )
  pipe(child.stdout, process.stdout)
  pipe(child.stderr, process.stderr)
  child.on('exit', (code) => {
    if (!stopping) {
      console.error(`${prefix} exited with code ${code}`)
      stop(1)
    }
  })
  children.push(child)
  return child
}

let stopping = false
function stop(code = 0) {
  if (stopping) return
  stopping = true
  for (const c of children) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' })
    else c.kill('SIGTERM')
  }
  process.exit(code)
}
process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))

async function waitFor(url, ms = 30000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`${url} did not come up`)
}

async function portBusy(port) {
  try {
    await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(1000) })
    return true
  } catch {
    return false
  }
}

const loginAs = async (p) => (await login(p.phone)).token
async function verified(p) {
  const token = await loginAs(p)
  const r = await verifyId(token, p.name.replace(/ \(.*\)$/, ''), randomAadhaar())
  if (r.status !== 200) throw new Error(`KYC for ${p.name}: ${JSON.stringify(r.data)}`)
  return token
}

async function seed() {
  const step = (s) => console.log(`  - ${s}`)
  const org = await loginAs(PEOPLE.organiser)

  const existing = (await must(api('GET', '/events'), 'events')).events
  if (existing.length) {
    step(`Keeping existing data (${existing.length} event(s))`)
    return existing
  }

  // Three events, created on Quai at the same time (one createEvent transaction each).
  const days = (n) => new Date(Date.now() + n * 86400_000).toISOString()
  step(`Creating ${DEMO_EVENTS.length} events on Quai Orchard (about 30 s)...`)
  const events = await Promise.all(
    DEMO_EVENTS.map(async (e) => {
      const { lotteryCloseInDays, ...body } = e
      const r = await must(api('POST', '/events', { token: org, body: { ...body, lotteryClose: days(lotteryCloseInDays) } }), `create ${e.name}`)
      return r.event
    }),
  )
  events.sort((a, b) => a.id - b.id)
  for (const ev of events)
    step(`${ev.name}: event ${ev.id}, chain event ${ev.chainEventId}, ₹${ev.facePriceInr}, resale +${ev.resaleCapPct}%: ${ev.createTx}`)
  const byName = Object.fromEntries(events.map((e) => [e.name, e]))

  await loginAs(PEOPLE.staff)
  await must(api('POST', '/staff', { token: org, body: { phone: PEOPLE.staff.phone } }), 'make staff')
  step('Gate staff account ready')

  const fanTokens = []
  for (const f of PEOPLE.fans) fanTokens.push(await verified(f))
  step('5 fans verified')
  // Buyers pay resale tickets from their own custodial wallet, so give each fan some test QUAI.
  await Promise.all(PEOPLE.fans.map((f) => must(api('POST', '/admin/fund', { token: org, body: { phone: f.phone, amountQuai: FAN_FUNDING_QUAI } }), `fund ${f.name}`)))
  step(`Each fan's wallet funded with ${FAN_FUNDING_QUAI} QUAI test money (about 4 resale tickets at demo prices)`)
  // [fan index, event name, quantity]: fans 2-5 in World Tour, two of them also in Monsoon Sessions. Fan 1 enters live.
  const plan = [
    [1, 'World Tour', 2],
    [2, 'World Tour', 1],
    [3, 'World Tour', 1],
    [4, 'World Tour', 1],
    [1, 'Monsoon Sessions', 1],
    [2, 'Monsoon Sessions', 3],
  ]
  for (const [i, name, quantity] of plan) {
    const r = await enterWithWork(fanTokens[i], byName[name].id, quantity)
    if (r.status !== 201) throw new Error(`${PEOPLE.fans[i].name} entry for ${name}: ${JSON.stringify(r.data)}`)
  }
  step(`Entries with real x402 Work proofs: fans 2-5 in World Tour (2, 1, 1, 1 tickets), Ravi and Meera also in Monsoon Sessions (fan 1, ${PEOPLE.fans[0].name}, is yours to enter live)`)
  return events
}

async function main() {
  console.log('\nFairPass demo\n')
  if (await portBusy(API_PORT)) throw new Error(`Something is already running on port ${API_PORT}. Stop it first.`)
  if (!keep) for (const f of [DB, DB + '-wal', DB + '-shm']) fs.rmSync(f, { force: true })

  start('api', process.execPath, ['src/index.js'], path.join(root, 'backend'), {
    PORT: String(API_PORT),
    DATABASE_PATH: './data/demo.db',
    DEMO_MODE: '1',
    DEMO_FIXED_OTP: OTP,
  })
  await waitFor(`http://localhost:${API_PORT}/health`)
  console.log('\nSeeding demo data:')
  const events = await seed()

  // Run Vite's CLI with node directly (no shell needed on Windows).
  const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
  start('web', process.execPath, [viteBin, '--port', '5173', '--strictPort'], path.join(root, 'frontend'))
  await waitFor(WEB_URL, 60000)

  const rows = [
    ['Organiser (dashboard)', PEOPLE.organiser],
    ['Gate staff (scanner)', PEOPLE.staff],
    ...PEOPLE.fans.map((f, i) => [i === 0 ? 'Fan 1 (enter live)' : `Fan ${i + 1} (entered)`, f]),
  ]
  console.log(`\n================  FairPass demo is running  ================`)
  console.log(`  App:        ${WEB_URL}`)
  console.log(`  API:        http://localhost:${API_PORT}`)
  for (const e of events)
    console.log(`  Event ${e.id}:    ${e.name}, ₹${e.facePriceInr}, resale +${e.resaleCapPct}%, ${e.lotteryTickets} tickets in the draw`)
  console.log(`  OTP for every account: ${OTP}\n`)
  console.log('  Role                       Phone            Name')
  for (const [role, p] of rows) console.log(`  ${role.padEnd(26)} ${p.phone.slice(3).padEnd(16)} ${p.name}`)
  console.log(`\n  Bot attack (in another terminal):  npm run bot-attack`)
  console.log('  Ctrl+C stops everything.')
  console.log('=============================================================\n')
}

main().catch((err) => {
  console.error('\nDemo failed:', err.message)
  stop(1)
})
