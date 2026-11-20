// Mirrors the SQLite database into Cloud Firestore.
//
// SQLite stays the source of truth (it enforces the rules: one ID per event, atomic gate check-in).
// Every INSERT / UPDATE / DELETE on every table fires a TEMP trigger that queues the row; a flusher
// writes the queued rows to Firestore in batches about twice a second. TEMP triggers live only on this
// connection, so the .db file never depends on Firebase.
//
// Layout (one fixed place; always an exact copy of the CURRENT database):
//          fairpass/live                                  info: which database, contract, last sync
//          fairpass/live/{table}/{primaryKey}             one doc per row, all columns + readable names
//          fairpass/live/blocked_summary/{eventId}        blocked bot attempts per reason (+ latest 50)
//          fairpass/live/event_stats/{eventId}            per-event totals for the organiser
// Self-healing: on startup and every FIRESTORE_CHECK_SECONDS (60) the mirror compares document counts with
// SQLite; documents deleted in the console are re-uploaded and leftovers from an older database are removed.
// Left out on purpose: users.encKey (custodial wallet keys) and events.seed until the draw has happened
// (revealing it early would let anyone predict the lottery).
import { initializeApp } from 'firebase/app'
import { collection, doc, getCount, getDoc, getDocs, getFirestore, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore/lite'
import { config } from '../config.js'
import { db, instanceId } from '../db.js'
import { faceInr, maxResaleInr, maxResaleWei } from './money.js'
import { quais } from 'quais'

const TABLES = {
  users: 'id',
  events: 'id',
  entries: 'id',
  tickets: 'tokenId',
  scans: 'id',
  blocked_attempts: 'id',
  activity: 'id',
  pow_challenges: 'id',
  listings: 'id',
  ticket_history: 'id',
}
const BOOLEAN_COLUMNS = {
  users: ['isVerified'],
  pow_challenges: ['solved'],
  tickets: ['gifted'],
}
const BATCH_SIZE = 450 // Firestore allows 500 writes per batch

export const mirrorStatus = {
  enabled: false,
  path: 'fairpass/live',
  instanceId,
  written: 0,
  pending: 0,
  failures: 0,
  ok: null, // true after the last write/resync succeeded, false after a failure
  lastError: null,
  lastFlush: null,
  lastCheck: null,
  lastReconcile: null,
}

let fs
const queue = new Map() // key -> { kind: 'row' | 'summary', table, pk }
let timer = null
let flushing = false
let lastLoggedError = 0

const rowStmt = Object.fromEntries(Object.entries(TABLES).map(([t, pk]) => [t, db.prepare(`SELECT * FROM ${t} WHERE ${pk} = ?`)]))

// Lookups that add organiser-readable fields (names, phones, event names) to each document.
const q = {
  user: db.prepare('SELECT id, name, phone, role, idType, idLast4, walletAddress FROM users WHERE id = ?'),
  event: db.prepare('SELECT id, name, artist, date, venue, resaleCapPct FROM events WHERE id = ?'),
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
      return {
        ...d,
        facePriceInr: faceInr(d),
        maxResalePrice: quais.formatQuai(maxResaleWei(d)),
        maxResalePriceInr: maxResaleInr(d),
        inrPerQuai: config.inrPerQuai,
        contract: config.contract.address,
        createTxUrl: txUrl(d.createTx),
        resaleCapTxUrl: txUrl(d.resaleCapTx),
      }
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
        acquiredFromName: get(q.user, d.acquiredFromUserId)?.name ?? null,
        mintTxUrl: txUrl(d.mintTx),
        tokenUrl: `${config.explorer}/token/${config.contract.address}/instance/${d.tokenId}`,
      }
    }
    case 'listings': {
      const t = get(q.ticket, d.tokenId)
      return {
        ...d,
        ...eventName,
        seat: t?.seat ?? null,
        ...person('seller', get(q.user, d.sellerUserId)),
        ...person('buyer', get(q.user, d.buyerUserId)),
        ...person('soldTo', get(q.user, d.soldToUserId)),
        shareUrl: d.visibility === 'private' ? `${config.frontendOrigin.replace(/\/$/, '')}/buy/${d.id}` : null,
        listTxUrl: txUrl(d.listTx),
        closeTxUrl: txUrl(d.closeTx),
      }
    }
    case 'ticket_history':
      return {
        ...d,
        ...eventName,
        ...person('from', get(q.user, d.fromUserId)),
        ...person('to', get(q.user, d.toUserId)),
        txUrl: txUrl(d.txHash),
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
    partialWinners: n("SELECT COUNT(*) n FROM entries WHERE eventId = ? AND status = 'partial'", id),
    ticketsWon: n('SELECT COALESCE(SUM(ticketsWon),0) n FROM entries WHERE eventId = ?', id),
    invalidListings: n("SELECT COUNT(*) n FROM tickets WHERE eventId = ? AND status = 'listed' AND listingInvalid IS NOT NULL", id),
    listedPublic: n("SELECT COUNT(*) n FROM listings WHERE eventId = ? AND status = 'active' AND visibility = 'public'", id),
    listedPrivate: n("SELECT COUNT(*) n FROM listings WHERE eventId = ? AND status = 'active' AND visibility = 'private'", id),
    soldPublic: n("SELECT COUNT(*) n FROM ticket_history WHERE eventId = ? AND kind = 'sale_public'", id),
    soldPrivate: n("SELECT COUNT(*) n FROM ticket_history WHERE eventId = ? AND kind = 'sale_private'", id),
    gifted: n("SELECT COUNT(*) n FROM ticket_history WHERE eventId = ? AND kind = 'gift'", id),
    returnedToPool: n("SELECT COUNT(*) n FROM ticket_history WHERE eventId = ? AND kind = 'returned'", id),
    resaleCapPct: ev?.resaleCapPct ?? null,
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
const EVENT_TABLES = new Set(['entries', 'tickets', 'blocked_attempts', 'activity', 'pow_challenges', 'events', 'listings', 'ticket_history'])

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

const BASE = ['fairpass', 'live']
const base = () => BASE

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
        mirrorStatus.ok = true
      } catch (err) {
        for (const [key, item] of items) if (!queue.has(key)) queue.set(key, item) // retry later
        throw err
      }
    }
  } catch (err) {
    reportError(err, `${queue.size} change(s) will be retried`)
    if (!timer) timer = setTimeout(flush, 5000)
  } finally {
    mirrorStatus.pending = queue.size
    flushing = false
  }
}

function reportError(err, retryNote) {
  mirrorStatus.failures++
  mirrorStatus.ok = false
  const reason = err.code && err.code !== 'unknown' ? err.code : err.message
  mirrorStatus.lastError = reason
  if (Date.now() - lastLoggedError < 60_000) return
  lastLoggedError = Date.now()
  const hint =
    err.code === 'permission-denied'
      ? ' (Firestore security rules reject the write: test mode may have expired; allow reads and writes to fairpass/** in the Firebase console)'
      : err.code === 'resource-exhausted'
        ? ' (daily free-tier quota used up; resets at midnight Pacific time)'
        : /fetch failed|TLS|socket|ENOTFOUND|ECONNRESET|ETIMEDOUT|network/i.test(String(err.message))
          ? ' (network problem reaching Google: check the internet connection, VPN or antivirus HTTPS scanning)'
          : ''
  console.warn(`[firestore] ${reason}${hint}. Nothing is lost; ${retryNote}.`)
}

// ------------------------------------------------------------------ reconcile (self-healing)

const rowTables = () => Object.keys(TABLES).filter((t) => t !== 'blocked_attempts' || config.firestoreMirrorAllBlocked)
const allCollections = () => [...rowTables(), 'blocked_summary', 'event_stats']
/** Collections from features that were removed (corporate booking); a full resync deletes them. */
const LEGACY_COLLECTIONS = ['companies', 'corporate_seats']

/** What a collection should contain right now: Map docId -> data builder. */
function desired(collectionName) {
  const want = new Map()
  if (collectionName === 'blocked_summary') {
    for (const r of db.prepare('SELECT DISTINCT eventId FROM blocked_attempts').all()) {
      const id = r.eventId == null ? 'global' : String(r.eventId)
      want.set(id, () => summaryDoc(id))
    }
  } else if (collectionName === 'event_stats') {
    for (const r of db.prepare('SELECT id FROM events').all()) want.set(String(r.id), () => statsDoc(r.id))
  } else {
    const pk = TABLES[collectionName]
    // The builder re-reads the row when the batch is written, so a change made meanwhile isn't overwritten.
    for (const row of db.prepare(`SELECT ${pk} AS pk FROM ${collectionName}`).all())
      want.set(String(row.pk), () => {
        const fresh = rowStmt[collectionName].get(row.pk)
        return fresh ? toDoc(collectionName, fresh) : null
      })
  }
  return want
}

/** Is this document still supposed to exist (checked right before deleting it)? */
function existsNow(collectionName, id) {
  if (collectionName === 'blocked_summary')
    return !!db.prepare(id === 'global' ? 'SELECT 1 FROM blocked_attempts WHERE eventId IS NULL' : 'SELECT 1 FROM blocked_attempts WHERE eventId = ?').get(...(id === 'global' ? [] : [Number(id)]))
  if (collectionName === 'event_stats') return !!db.prepare('SELECT 1 FROM events WHERE id = ?').get(Number(id))
  return /^\d+$/.test(id) && !!rowStmt[collectionName].get(Number(id))
}

const expectedCount = (c) =>
  c === 'blocked_summary'
    ? db.prepare("SELECT COUNT(DISTINCT COALESCE(eventId, 'global')) n FROM blocked_attempts").get().n
    : c === 'event_stats'
      ? db.prepare('SELECT COUNT(*) n FROM events').get().n
      : db.prepare(`SELECT COUNT(*) n FROM ${c}`).get().n

let reconciling = false
const liveRef = () => doc(fs, ...BASE)

/**
 * Makes Firestore match SQLite. mode 'full' rewrites every document (new database, manual resync);
 * mode 'missing' only uploads documents that are absent. Both delete documents SQLite doesn't have.
 */
let currentRun = Promise.resolve()
export async function reconcile(reason, { mode = 'missing', collections = allCollections(), wait = false } = {}) {
  if (!fs) return null
  if (reconciling) {
    if (!wait) return null
    await currentRun.catch(() => {}) // a manual resync waits for the running one, then goes
  }
  const run = reconcileNow(reason, mode, collections)
  currentRun = run
  return run
}

async function reconcileNow(reason, mode, collections) {
  reconciling = true
  const started = Date.now()
  let uploaded = 0
  let removed = 0
  try {
    // Read what Firestore has (all collections in parallel), THEN take SQLite's current state.
    const snapshots = await Promise.all(collections.map((c) => getDocs(collection(fs, ...BASE, c))))
    const ops = []
    collections.forEach((c, i) => {
      const want = desired(c)
      const haveIds = new Set(snapshots[i].docs.map((d) => d.id))
      for (const d of snapshots[i].docs) if (!want.has(d.id)) ops.push({ c, id: d.id, ref: d.ref, build: null })
      for (const [id, build] of want) if (mode === 'full' || !haveIds.has(id)) ops.push({ c, id, ref: doc(fs, ...BASE, c, id), build })
    })
    if (mode === 'full') {
      const legacy = await Promise.all(LEGACY_COLLECTIONS.map((c) => getDocs(collection(fs, ...BASE, c))))
      for (const snap of legacy) for (const d of snap.docs) ops.push({ c: null, id: d.id, ref: d.ref, build: null, legacy: true })
    }
    for (let i = 0; i < ops.length; i += BATCH_SIZE) {
      const batch = writeBatch(fs)
      for (const { c, id, ref, build, legacy } of ops.slice(i, i + BATCH_SIZE)) {
        if (build) {
          const data = build()
          if (!data) continue // row deleted meanwhile; the trigger handles it
          batch.set(ref, data)
          uploaded++
        } else if (legacy || !existsNow(c, id)) {
          batch.delete(ref)
          removed++
        }
      }
      await batch.commit()
    }
    await setDoc(liveRef(), {
      instanceId,
      database: config.databasePath.split(/[\\/]/).pop(),
      contract: config.contract.address,
      chainId: config.contract.chainId,
      explorer: config.explorer,
      contractUrl: `${config.explorer}/address/${config.contract.address}`,
      lastReconcileAt: serverTimestamp(),
      lastReconcileReason: reason,
    })
    mirrorStatus.written += uploaded
    mirrorStatus.lastReconcile = { at: new Date().toISOString(), reason, mode, uploaded, removed, ms: Date.now() - started }
    mirrorStatus.ok = true
    if (uploaded || removed) console.log(`[firestore] resynced (${reason}): ${uploaded} uploaded, ${removed} removed`)
    return mirrorStatus.lastReconcile
  } catch (err) {
    reportError(err, 'the next check will retry the resync')
    return null
  } finally {
    reconciling = false
  }
}

/** Periodic check: is fairpass/live ours, and does every collection have the right number of documents? */
async function check() {
  if (reconciling || flushing || queue.size) return
  mirrorStatus.lastCheck = new Date().toISOString()
  try {
    const live = await getDoc(liveRef())
    if (!live.exists() || live.data().instanceId !== instanceId) {
      await reconcile(live.exists() ? 'Firestore held another database' : 'fairpass/live was missing', { mode: 'full' })
      return
    }
    const cols = allCollections()
    const counts = await Promise.all(cols.map((c) => getCount(collection(fs, ...BASE, c))))
    const off = cols.filter((c, i) => counts[i].data().count !== expectedCount(c))
    if (off.length && !queue.size) await reconcile(`document count differed in ${off.join(', ')}`, { collections: off })
  } catch (err) {
    reportError(err, 'will check again')
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

  // Initial sync: full rewrite if fairpass/live holds another database (e.g. after a demo reset),
  // otherwise only upload what's missing. Runs in the background so the API starts immediately.
  ;(async () => {
    let mode = 'full'
    try {
      const live = await getDoc(liveRef())
      if (live.exists() && live.data().instanceId === instanceId) mode = 'missing'
    } catch {}
    await reconcile('startup', { mode })
  })()
  const every = Math.max(15, Number(process.env.FIRESTORE_CHECK_SECONDS || 60)) * 1000
  setInterval(check, every).unref()
  return true
}

/** Writes one contract event (from the chain listener) to fairpass/live/chain_events/{id}. */
export async function writeChainEvent(id, data) {
  if (!fs) return false
  await setDoc(doc(fs, ...BASE, 'chain_events', id), { ...data, _syncedAt: serverTimestamp() })
  mirrorStatus.written++
  return true
}
