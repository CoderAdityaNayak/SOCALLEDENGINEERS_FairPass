// npm run demo: starts backend + frontend, seeds a ready-to-present FairPass demo, prints logins.
//
// Seeds (through the real API, so everything is on Quai Orchard):
//   - an open lottery event created on-chain (3 lottery tickets, 5% corporate pool)
//   - organiser, gate staff, 5 verified fans (fans 2-5 already entered with real x402 Work proofs;
//     fan 1 is left for the live demo), 1 approved company with 5 verified employees (not yet invited,
//     so the presenter books the 5 seats live)
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
  companyAdmin: { phone: '+919000000020', name: 'Priya Nair (HR, Acme)' },
  employees: [
    { phone: '+919000000021', name: 'Arjun Mehta' },
    { phone: '+919000000022', name: 'Divya Menon' },
    { phone: '+919000000023', name: 'Rohan Das' },
    { phone: '+919000000024', name: 'Sneha Pillai' },
    { phone: '+919000000025', name: 'Nikhil Joshi' },
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
    return existing[0]
  }

  step('Creating "[Headliner] World Tour" on Quai Orchard (about 20 s)...')
  const close = new Date(Date.now() + 2 * 86400_000)
  const { event } = await must(
    api('POST', '/events', {
      token: org,
      body: {
        name: 'World Tour',
        artist: '[Headliner]',
        date: '2027-01-19T19:30:00+05:30',
        venue: 'DY Patil Stadium',
        city: 'Mumbai',
        supply: 100,
        facePrice: '0.01',
        resaleCapPct: 10,
        lotteryTickets: 3,
        lotteryClose: close.toISOString(),
      },
    }),
    'create event',
  )
  step(`Event ${event.id} on-chain (chain event ${event.chainEventId}): ${event.createTx}`)

  await loginAs(PEOPLE.staff)
  await must(api('POST', '/staff', { token: org, body: { phone: PEOPLE.staff.phone } }), 'make staff')
  step('Gate staff account ready')

  const fanTokens = []
  for (const f of PEOPLE.fans) fanTokens.push(await verified(f))
  step('5 fans verified')
  for (let i = 1; i < PEOPLE.fans.length; i++) {
    const r = await enterWithWork(fanTokens[i], event.id, 1)
    if (r.status !== 201) throw new Error(`${PEOPLE.fans[i].name} entry: ${JSON.stringify(r.data)}`)
  }
  step(`Fans 2-5 entered the lottery with real x402 Work proofs (fan 1, ${PEOPLE.fans[0].name}, is yours to enter live)`)

  const admin = await verified(PEOPLE.companyAdmin)
  const { company } = await must(
    api('POST', '/corporate/apply', { token: admin, body: { name: 'Acme Technologies Pvt Ltd', gstin: '27AAPFU0939F1ZV', eventId: event.id } }),
    'apply',
  )
  await must(api('POST', `/corporate/${company.id}/approve`, { token: org, body: { seatQuota: 5 } }), 'approve')
  for (const e of PEOPLE.employees) await verified(e)
  step('Acme Technologies approved for 5 seats; its 5 employees have verified IDs (invite them live)')
  return event
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
  const event = await seed()

  // Run Vite's CLI with node directly (no shell needed on Windows).
  const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
  start('web', process.execPath, [viteBin, '--port', '5173', '--strictPort'], path.join(root, 'frontend'))
  await waitFor(WEB_URL, 60000)

  const rows = [
    ['Organiser (dashboard)', PEOPLE.organiser],
    ['Gate staff (scanner)', PEOPLE.staff],
    ...PEOPLE.fans.map((f, i) => [i === 0 ? 'Fan 1 (enter live)' : `Fan ${i + 1} (entered)`, f]),
    ['Company admin', PEOPLE.companyAdmin],
    ...PEOPLE.employees.map((e, i) => [`Employee ${i + 1}`, e]),
  ]
  console.log(`\n================  FairPass demo is running  ================`)
  console.log(`  App:        ${WEB_URL}`)
  console.log(`  API:        http://localhost:${API_PORT}`)
  console.log(`  Event:      ${event.name} (id ${event.id}), lottery open, 3 lottery tickets`)
  console.log(`  OTP for every account: ${OTP}\n`)
  console.log('  Role                       Phone            Name')
  for (const [role, p] of rows) console.log(`  ${role.padEnd(26)} ${p.phone.slice(3).padEnd(16)} ${p.name}`)
  console.log(`\n  Employee phones to paste in the company page:`)
  console.log(`  ${PEOPLE.employees.map((e) => e.phone.slice(3)).join(', ')}`)
  console.log(`\n  Bot attack (in another terminal):  npm run bot-attack`)
  console.log('  Ctrl+C stops everything.')
  console.log('=============================================================\n')
}

main().catch((err) => {
  console.error('\nDemo failed:', err.message)
  stop(1)
})
