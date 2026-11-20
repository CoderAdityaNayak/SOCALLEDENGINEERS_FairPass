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

function toDoc(table, row) {
  const d = { ...row }
  if (table === 'users') delete d.encKey
  if (table === 'events' && !d.drawnAt) d.seed = null
  for (const k of BOOLEAN_COLUMNS[table] || []) d[k] = !!d[k]
  d._syncedAt = serverTimestamp()
  return d
}

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
    latest: db.prepare(`SELECT id, reason, ip, userId, detail, at FROM blocked_attempts WHERE ${where} ORDER BY id DESC LIMIT 50`).all(...args),
    _syncedAt: serverTimestamp(),
  }
}

const base = () => ['fairpass', instanceId]

function enqueue(table, pk, eventId) {
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
    mirrorStatus.lastError = err.code || err.message
    if (Date.now() - lastLoggedError > 60_000) {
      lastLoggedError = Date.now()
      const hint =
        err.code === 'permission-denied'
          ? ' (Firestore security rules reject the write: test mode may have expired; allow writes to fairpass/** in the Firebase console)'
          : err.code === 'resource-exhausted'
            ? ' (daily free-tier write quota used up; resets at midnight Pacific time)'
            : ''
      console.warn(`[firestore] mirror write failed: ${err.code || err.message}${hint}. Will retry.`)
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
    const extra = table === 'blocked_attempts' ? ', ROW.eventId' : ''
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
