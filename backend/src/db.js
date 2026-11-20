// SQLite database (better-sqlite3 is synchronous: simple and fast for a single server).
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { config } from './config.js'

const SCHEMA_VERSION = '2' // v2: no corporate tables, any ticket quantity, partial wins, organiser resale cap

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true })
export const db = new Database(config.databasePath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// A database belongs to one contract and one schema version. Data made for an older contract (or schema)
// would point at tokens that don't exist on the current contract, so refuse to start instead of misbehaving.
db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
const meta = (key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value
const hasUsers = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()
if (hasUsers && (meta('schema') !== SCHEMA_VERSION || (meta('contract') && meta('contract') !== config.contract.address))) {
  throw new Error(
    `The database ${config.databasePath} was made for ${meta('contract') ? `contract ${meta('contract')}` : 'an older version of FairPass'}, ` +
      `not the current contract ${config.contract.address}. Start fresh: run "npm run demo" (without --keep), ` +
      `or delete that .db file (and its -wal / -shm files) and restart.`,
  )
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  phone         TEXT NOT NULL UNIQUE,
  name          TEXT,
  idHash        TEXT UNIQUE,                 -- HMAC-SHA256 of the ID number, never the raw ID
  idType        TEXT,                        -- AADHAAR | PAN
  idLast4       TEXT,                        -- last 4 characters only, for a masked display
  walletAddress TEXT NOT NULL,
  encKey        TEXT,                        -- custodial private key, AES-256-GCM encrypted (NULL for the organiser)
  role          TEXT NOT NULL DEFAULT 'fan' CHECK (role IN ('fan','organiser','staff')),
  isVerified    INTEGER NOT NULL DEFAULT 0,
  lastLoginAt   TEXT,
  createdAt     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  chainEventId       INTEGER NOT NULL,
  name               TEXT NOT NULL,
  artist             TEXT,
  date               TEXT NOT NULL,          -- ISO date
  venue              TEXT,
  city               TEXT,
  facePrice          TEXT NOT NULL,          -- QUAI, decimal string (what the contract uses)
  facePriceInr       REAL,                   -- ₹ shown to fans (mock fiat; INR_PER_QUAI converts)
  supply             INTEGER NOT NULL,
  lotteryTickets     INTEGER NOT NULL,       -- tickets offered in this lottery round
  resaleCapPct       INTEGER NOT NULL,       -- organiser-controlled, mirrors the contract
  resaleCapTx        TEXT,                   -- tx of the last setResaleCap
  resaleCapUpdatedAt TEXT,
  lotteryOpen        TEXT NOT NULL,
  lotteryClose       TEXT NOT NULL,
  seedHash           TEXT NOT NULL,          -- sha256(seed), public from the moment the lottery opens
  seed               TEXT NOT NULL,          -- secret until the draw (commit-reveal)
  drawnAt            TEXT,
  createTx           TEXT
);

CREATE TABLE IF NOT EXISTS entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  userId        INTEGER NOT NULL REFERENCES users(id),
  eventId       INTEGER NOT NULL REFERENCES events(id),
  idHash        TEXT NOT NULL,
  quantity      INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),   -- tickets the fan asked for
  ticketsWon    INTEGER NOT NULL DEFAULT 0,                         -- given by the draw or the waitlist
  ticketsMinted INTEGER NOT NULL DEFAULT 0,
  entryNumber   INTEGER,                     -- the fan's lottery number for this event
  powRef        TEXT,                        -- x402 Work job id / receipt reference
  status        TEXT NOT NULL DEFAULT 'entered' CHECK (status IN ('entered','won','partial','waitlist','lost')),
  drawRank      INTEGER,
  drawKey       TEXT,                        -- sha256(seed:entryId), the sort key of the draw
  createdAt     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (eventId, idHash)                   -- one entry per verified person per event
);

CREATE TABLE IF NOT EXISTS pow_challenges (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  jobId    TEXT NOT NULL,                    -- x402 Work job id (the facilitator shares one job between
  userId   INTEGER,                          --   everyone asking in the same few seconds)
  eventId  INTEGER,
  mode     TEXT NOT NULL,                    -- facilitator | local
  solved   INTEGER NOT NULL DEFAULT 0,
  issuedAt INTEGER NOT NULL,                 -- unix ms
  UNIQUE (jobId, userId)
);

CREATE TABLE IF NOT EXISTS tickets (
  tokenId        INTEGER PRIMARY KEY,
  eventId        INTEGER NOT NULL REFERENCES events(id),
  ownerUserId    INTEGER REFERENCES users(id),  -- NULL while in the organiser's pool
  seat           TEXT NOT NULL,                 -- "B-12-7" (block-row-seat)
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','listed','used','returned')),
  listedPrice    TEXT,                          -- QUAI
  listedPriceInr REAL,                          -- ₹
  listingInvalid TEXT,                          -- set when the organiser lowers the cap below the listing
  mintTx         TEXT,
  createdAt      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (eventId, seat)
);

CREATE TABLE IF NOT EXISTS scans (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  tokenId INTEGER,
  staffId INTEGER REFERENCES users(id),
  result  TEXT NOT NULL,
  txHash  TEXT,
  at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS blocked_attempts (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  reason  TEXT NOT NULL,
  ip      TEXT,
  eventId INTEGER,
  userId  INTEGER,
  detail  TEXT,
  at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  eventId INTEGER,
  kind    TEXT NOT NULL,                     -- minted | resold | returned | reassigned | listed | scanned | resale_cap ...
  tokenId INTEGER,
  userId  INTEGER,
  txHash  TEXT,
  detail  TEXT,
  at      TEXT NOT NULL DEFAULT (datetime('now'))
);
`)

db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)").run(SCHEMA_VERSION)
db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('contract', ?)").run(config.contract.address)
// A random id per database. Login tokens carry it, so a token issued by an older (reset) database
// can't log in as whoever now has the same user id.
db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('instance', lower(hex(randomblob(16))))").run()
export const instanceId = meta('instance')

export function logBlocked({ reason, ip, eventId = null, userId = null, detail = null }) {
  db.prepare('INSERT INTO blocked_attempts (reason, ip, eventId, userId, detail) VALUES (?, ?, ?, ?, ?)').run(
    reason,
    ip ?? null,
    eventId,
    userId,
    detail,
  )
}

export function logActivity({ eventId = null, kind, tokenId = null, userId = null, txHash = null, detail = null }) {
  db.prepare('INSERT INTO activity (eventId, kind, tokenId, userId, txHash, detail) VALUES (?, ?, ?, ?, ?, ?)').run(
    eventId,
    kind,
    tokenId,
    userId,
    txHash,
    detail,
  )
}
