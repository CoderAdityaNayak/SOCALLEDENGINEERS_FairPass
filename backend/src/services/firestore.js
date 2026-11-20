// Mirrors the SQLite database into Cloud Firestore.
//
// SQLite stays the source of truth (it enforces the rules: one ID per event, atomic gate check-in).
// Every INSERT / UPDATE / DELETE on every table fires a TEMP trigger that queues the row; a flusher
// writes the queued rows to Firestore in batches about twice a second. TEMP triggers live only on this
// connection, so the .db file never depends on Firebase.
//
// Layout:  fairpass/{databaseInstanceId}                       one doc per database (each demo run is new)
//          fairpass/{instanceId}/{table}/{primaryKey}         one doc per row, all columns
//          fairpass/{instanceId}/blocked_summary/{eventId}    blocked bot attempts per reason (+ latest 50)
//          fairpass/_current                                  { instanceId } of the running database
// Left out on purpose: users.encKey (custodial wallet keys) and events.seed until the draw has happened
// (revealing it early would let anyone predict the lottery).
import { initializeApp } from 'firebase/app'
import { doc, getFirestore, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore/lite'
import { config } from '../config.js'
import { db, instanceId } from '../db.js'

const TABLES = {
  users: 'id',
  events: 'id',
  entries: 'id',
  companies: 'id',
  corporate_seats: 'id',
  tickets: 'tokenId',
  scans: 'id',
  blocked_attempts: 'id',
  activity: 'id',
  pow_challenges: 'id',
}
const BOOLEAN_COLUMNS = {
  users: ['isVerified'],
  companies: ['approved'],
  corporate_seats: ['verified'],
  tickets: ['corporate'],
  pow_challenges: ['solved'],
}
const BATCH_SIZE = 450 // Firestore allows 500 writes per batch

export const mirrorStatus = { enabled: false, instanceId, written: 0, pending: 0, failures: 0, lastError: null, lastFlush: null }

let fs
const queue = new Map() // key -> { kind: 'row' | 'summary', table, pk }
let timer = null
let flushing = false
let lastLoggedError = 0

const rowStmt = Object.fromEntries(Object.entries(TABLES).map(([t, pk]) => [t, db.prepare(`SELECT * FROM ${t} WHERE ${pk} = ?`)]))

// Lookups that add organiser-readable fields (names, phones, event names) to each document.
const q = {
  user: db.prepare('SELECT id, name, phone, role, idType, idLast4, walletAddress FROM users WHERE id = ?'),
  event: db.prepare('SELECT id, name, artist, date, venue FROM events WHERE id = ?'),
  company: db.prepare('SELECT id, name, gstin FROM companies WHERE id = ?'),
  ticket: db.prepare('SELECT tokenId, eventId, seat, ownerUserId FROM tickets WHERE tokenId = ?'),
}
const get = (stmt, id) => (id == null ? undefined : stmt.get(id))

/** "XXXX XXXX 1234" for Aadhaar, "XXXXXX234F" style for PAN. */
export const maskId = (type, last4) =>
  !last4 ? null : type === 'AADHAAR' ? `XXXX XXXX ${last4}` : `XXXXXX${last4}`

function person(prefix, user) {
  if (!user) return {}
  return { [`${prefix}Name`]: user.name ?? null, [`${prefix}Phone`]: user.phone ?? null }
}
function seatParts(seat) {
  if (!seat) return {}
  const [block, row, number] = String(seat).split('-')
  return { block, row: Number(row), seatNumber: Number(number) }
}
const txUrl = (hash) => (hash ? `${config.explorer}/tx/${hash}` : null)

function enrich(table, d) {
  const ev = get(q.event, d.eventId)
  const eventName = ev ? { eventName: ev.name } : {}
  switch (table) {
    case 'users':
      return { ...d, idMasked: maskId(d.idType, d.idLast4), loginMethod: 'phone OTP', walletUrl: `${config.explorer}/address/${d.walletAddress}` }
    case 'events':
      return { ...d, contract: config.contract.address, createTxUrl: txUrl(d.createTx) }
    case 'entries': {
      const u = get(q.user, d.userId)
      return { ...d, ...eventName, ...person('user', u), idType: u?.idType ?? null, idMasked: maskId(u?.idType, u?.idLast4) }
    }
    case 'tickets': {
      const owner = get(q.user, d.ownerUserId)
      return {
        ...d,
        ...eventName,
        ...seatParts(d.seat),
        ...person('owner', owner),
        ownerWallet: owner?.walletAddress ?? null,
        inPool: d.ownerUserId == null,
        mintTxUrl: txUrl(d.mintTx),
        tokenUrl: `${config.explorer}/token/${config.contract.address}/instance/${d.tokenId}`,
      }
    }
    case 'scans': {
      const t = get(q.ticket, d.tokenId)
      const tev = get(q.event, t?.eventId)
      return {
        ...d,
        eventId: t?.eventId ?? null,
        eventName: tev?.name ?? null,
        seat: t?.seat ?? null,
        ...person('holder', get(q.user, t?.ownerUserId)),
        ...person('staff', get(q.user, d.staffId)),
        txUrl: txUrl(d.txHash),
      }
    }
    case 'companies':
      return { ...d, ...eventName, ...person('admin', get(q.user, d.adminUserId)) }
    case 'corporate_seats': {
      const c = get(q.company, d.companyId)
      const t = get(q.ticket, d.tokenId)
      return { ...d, ...eventName, companyName: c?.name ?? null, gstin: c?.gstin ?? null, ...person('employee', get(q.user, d.userId)), seat: t?.seat ?? null }
    }
    case 'activity':
      return { ...d, ...eventName, ...person('user', get(q.user, d.userId)), txUrl: txUrl(d.txHash) }
    case 'pow_challenges':
      return { ...d, ...eventName, ...person('user', get(q.user, d.userId)) }
    case 'blocked_attempts':
      return { ...d, ...eventName, ...person('user', get(q.user, d.userId)) }
    default:
      return d
  }
}

function toDoc(table, row) {
  const d = { ...row }
  if (table === 'users') delete d.encKey
  if (table === 'events' && !d.drawnAt) d.seed = null
  for (const k of BOOLEAN_COLUMNS[table] || []) d[k] = !!d[k]
  const out = enrich(table, d)
  out._syncedAt = serverTimestamp()
  return out
}

/** Everything the organiser wants at a glance, per event. */
function statsDoc(eventId) {
  const id = Number(eventId)
  const ev = get(q.event, id)
  const n = (sql, ...a) => db.prepare(sql).get(...a).n
  const byReason = Object.fromEntries(
    db.prepare('SELECT reason, COUNT(*) n FROM blocked_attempts WHERE eventId = ? GROUP BY reason').all(id).map((r) => [r.reason, r.n]),
  )
  const kinds = Object.fromEntries(
    db.prepare('SELECT kind, COUNT(*) n FROM activity WHERE eventId = ? GROUP BY kind').all(id).map((r) => [r.kind, r.n]),
  )
  return {
    eventId: id,
    eventName: ev?.name ?? null,
    entries: n('SELECT COUNT(*) n FROM entries WHERE eventId = ?', id),
    ticketsRequested: n('SELECT COALESCE(SUM(quantity),0) n FROM entries WHERE eventId = ?', id),
    winners: n("SELECT COUNT(*) n FROM entries WHERE eventId = ? AND status = 'won'", id),
    waitlist: n("SELECT COUNT(*) n FROM entries WHERE eventId = ? AND status = 'waitlist'", id),
    ticketsMinted: n('SELECT COUNT(*) n FROM tickets WHERE eventId = ?', id),
    corporateTickets: n('SELECT COUNT(*) n FROM tickets WHERE eventId = ? AND corporate = 1', id),
    listedForResale: n("SELECT COUNT(*) n FROM tickets WHERE eventId = ? AND status = 'listed'", id),
    checkedIn: n("SELECT COUNT(*) n FROM tickets WHERE eventId = ? AND status = 'used'", id),
    resold: kinds.resold || 0,
    returned: kinds.returned || 0,
    reassigned: kinds.reassigned || 0,
    botAttemptsBlocked: Object.values(byReason).reduce((a, b) => a + b, 0),
    blockedByReason: byReason,
    puzzlesIssued: n('SELECT COUNT(*) n FROM pow_challenges WHERE eventId = ?', id),
    puzzlesSolved: n('SELECT COUNT(*) n FROM pow_challenges WHERE eventId = ? AND solved = 1', id),
    _syncedAt: serverTimestamp(),
  }
}
const EVENT_TABLES = new Set(['entries', 'tickets', 'blocked_attempts', 'activity', 'pow_challenges', 'events'])

function summaryDoc(eventId) {
  const where = eventId === 'global' ? 'eventId IS NULL' : 'eventId = ?'
  const args = eventId === 'global' ? [] : [Number(eventId)]
  const byReason = Object.fromEntries(
    db.prepare(`SELECT reason, COUNT(*) n FROM blocked_attempts WHERE ${where} GROUP BY reason`).all(...args).map((r) => [r.reason, r.n]),
  )
  return {
    eventId: eventId === 'global' ? null : Number(eventId),
    total: Object.values(byReason).reduce((a, b) => a + b, 0),
    byReason,
    latest: db
      .prepare(
        `SELECT b.id, b.reason, b.ip, b.userId, u.name AS userName, u.phone AS userPhone, b.detail, b.at
         FROM blocked_attempts b LEFT JOIN users u ON u.id = b.userId WHERE ${where.replace('eventId', 'b.eventId')}
         ORDER BY b.id DESC LIMIT 50`,
      )
      .all(...args),
    _syncedAt: serverTimestamp(),
  }
}

const base = () => ['fairpass', instanceId]

function enqueue(table, pk, eventId) {
  if (EVENT_TABLES.has(table)) {
    const ev = table === 'events' ? pk : eventId // passed in by the trigger (no queries inside a trigger)
    if (ev != null) queue.set(`stats:${ev}`, { kind: 'stats', table: 'event_stats', pk: String(ev) })
  }
  if (table === 'blocked_attempts' && !config.firestoreMirrorAllBlocked) {
    const id = eventId == null ? 'global' : String(eventId)
    queue.set(`summary:${id}`, { kind: 'summary', table: 'blocked_summary', pk: id })
  } else {
    queue.set(`${table}:${pk}`, { kind: 'row', table, pk })
  }
  mirrorStatus.pending = queue.size
  if (!timer) timer = setTimeout(flush, 500)
}

async function flush() {
  timer = null
  if (flushing) {
    timer = setTimeout(flush, 500)
    return
  }
  flushing = true
  try {
    while (queue.size) {
      const items = [...queue.entries()].slice(0, BATCH_SIZE)
      for (const [key] of items) queue.delete(key)
      const batch = writeBatch(fs)
      for (const [, item] of items) {
        const ref = doc(fs, ...base(), item.table, String(item.pk))
        if (item.kind === 'summary') {
          batch.set(ref, summaryDoc(item.pk))
          continue
        }
        if (item.kind === 'stats') {
          batch.set(ref, statsDoc(item.pk))
          continue
        }
        const row = rowStmt[item.table].get(item.pk)
        if (row) batch.set(ref, toDoc(item.table, row))
        else batch.delete(ref)
      }
      try {
        await batch.commit()
        mirrorStatus.written += items.length
        mirrorStatus.lastFlush = new Date().toISOString()
      } catch (err) {
        for (const [key, item] of items) if (!queue.has(key)) queue.set(key, item) // retry later
        throw err
      }
    }
  } catch (err) {
    mirrorStatus.failures++
    const reason = err.code && err.code !== 'unknown' ? err.code : err.message
    mirrorStatus.lastError = reason
    if (Date.now() - lastLoggedError > 60_000) {
      lastLoggedError = Date.now()
      const hint =
        err.code === 'permission-denied'
          ? ' (Firestore security rules reject the write: test mode may have expired; allow writes to fairpass/** in the Firebase console)'
          : err.code === 'resource-exhausted'
            ? ' (daily free-tier write quota used up; resets at midnight Pacific time)'
            : /fetch failed|TLS|socket|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(String(err.message))
              ? ' (network problem reaching Google: check the internet connection, VPN or antivirus HTTPS scanning)'
              : ''
      console.warn(`[firestore] mirror write failed: ${reason}${hint}. Nothing is lost; ${queue.size} change(s) will be retried.`)
    }
    if (!timer) timer = setTimeout(flush, 5000)
  } finally {
    mirrorStatus.pending = queue.size
    flushing = false
  }
}

/** Starts mirroring if FIREBASE_PROJECT_ID is set. Safe to call once at startup. */
export async function startFirestoreMirror() {
  if (!config.firebase.projectId) return false
  fs = getFirestore(initializeApp(config.firebase, 'fairpass-mirror'))
  mirrorStatus.enabled = true

  db.function('fs_sync', { varargs: true, deterministic: false }, (table, pk, eventId) => {
    enqueue(table, pk, eventId)
    return null
  })
  for (const [table, pk] of Object.entries(TABLES)) {
    const extra = EVENT_TABLES.has(table) && table !== 'events' ? ', ROW.eventId' : ''
    for (const [op, row] of [
      ['INSERT', 'NEW'],
      ['UPDATE', 'NEW'],
      ['DELETE', 'OLD'],
    ]) {
      db.exec(
        `CREATE TEMP TRIGGER IF NOT EXISTS fs_${table}_${op.toLowerCase()} AFTER ${op} ON main.${table}
         BEGIN SELECT fs_sync('${table}', ${row}.${pk}${extra.replace('ROW', row)}); END;`,
      )
    }
  }

  // Backfill: queue every existing row (cheap for a fresh demo database).
  for (const [table, pk] of Object.entries(TABLES)) {
    if (table === 'blocked_attempts' && !config.firestoreMirrorAllBlocked) {
      for (const r of db.prepare('SELECT DISTINCT eventId FROM blocked_attempts').all()) enqueue(table, null, r.eventId)
    } else {
      for (const r of db.prepare(`SELECT ${pk} AS pk FROM ${table}`).all()) enqueue(table, r.pk)
    }
  }
  for (const r of db.prepare('SELECT id FROM events').all()) enqueue('events', r.id)

  const info = {
    instanceId,
    database: config.databasePath.split(/[\\/]/).pop(),
    contract: config.contract.address,
    chainId: config.contract.chainId,
    explorer: config.explorer,
    startedAt: serverTimestamp(),
  }
  try {
    await setDoc(doc(fs, ...base()), info, { merge: true })
    await setDoc(doc(fs, 'fairpass', '_current'), { instanceId, updatedAt: serverTimestamp() })
  } catch (err) {
    mirrorStatus.lastError = err.code || err.message
    console.warn(`[firestore] could not reach project ${config.firebase.projectId}: ${err.code || err.message}`)
  }
  return true
}
