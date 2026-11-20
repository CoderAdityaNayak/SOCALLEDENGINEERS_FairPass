// SQLite database (better-sqlite3 is synchronous: simple and fast for a single server).
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { config } from './config.js'

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true })
export const db = new Database(config.databasePath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  phone         TEXT NOT NULL UNIQUE,
  name          TEXT,
  idHash        TEXT UNIQUE,                 -- HMAC-SHA256 of the ID number, never the raw ID
  walletAddress TEXT NOT NULL,
  encKey        TEXT,                        -- custodial private key, AES-256-GCM encrypted (NULL for the organiser)
  role          TEXT NOT NULL DEFAULT 'fan' CHECK (role IN ('fan','organiser','staff','company_admin')),
  isVerified    INTEGER NOT NULL DEFAULT 0,
  createdAt     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  chainEventId   INTEGER NOT NULL,
  name           TEXT NOT NULL,
  artist         TEXT,
  date           TEXT NOT NULL,              -- ISO date
  venue          TEXT,
  city           TEXT,
  facePrice      TEXT NOT NULL,              -- QUAI, decimal string
  supply         INTEGER NOT NULL,
  lotteryTickets INTEGER NOT NULL,           -- tickets offered in this lottery round
  resaleCapPct   INTEGER NOT NULL,
  lotteryOpen    TEXT NOT NULL,
  lotteryClose   TEXT NOT NULL,
  seedHash       TEXT NOT NULL,              -- sha256(seed), public from the moment the lottery opens
  seed           TEXT NOT NULL,              -- secret until the draw (commit-reveal)
  drawnAt        TEXT,
  createTx       TEXT
);

CREATE TABLE IF NOT EXISTS entries (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  userId    INTEGER NOT NULL REFERENCES users(id),
  eventId   INTEGER NOT NULL REFERENCES events(id),
  idHash    TEXT NOT NULL,
  quantity  INTEGER NOT NULL DEFAULT 1 CHECK (quantity IN (1,2)),
  powRef    TEXT,                            -- x402 Work job id / receipt reference
  status    TEXT NOT NULL DEFAULT 'entered' CHECK (status IN ('entered','won','waitlist','lost')),
  drawRank  INTEGER,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (eventId, idHash)
);

CREATE TABLE IF NOT EXISTS companies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  gstin       TEXT NOT NULL UNIQUE,
  adminUserId INTEGER NOT NULL REFERENCES users(id),
  approved    INTEGER NOT NULL DEFAULT 0,
  seatQuota   INTEGER NOT NULL DEFAULT 0,
  eventId     INTEGER REFERENCES events(id),
  createdAt   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS corporate_seats (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  companyId INTEGER NOT NULL REFERENCES companies(id),
  eventId   INTEGER NOT NULL REFERENCES events(id),
  phone     TEXT NOT NULL,                   -- invited employee
  userId    INTEGER REFERENCES users(id),    -- set once the employee logs in
  tokenId   INTEGER,
  swapsLeft INTEGER NOT NULL DEFAULT 2,
  verified  INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tickets (
  tokenId     INTEGER PRIMARY KEY,
  eventId     INTEGER NOT NULL REFERENCES events(id),
  ownerUserId INTEGER REFERENCES users(id),  -- NULL while in the organiser's pool
  seat        TEXT NOT NULL,                 -- "B-12-7" (block-row-seat)
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','listed','used','returned')),
  corporate   INTEGER NOT NULL DEFAULT 0,
  listedPrice TEXT,
  mintTx      TEXT,
  createdAt   TEXT NOT NULL DEFAULT (datetime('now')),
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
  kind    TEXT NOT NULL,                     -- minted | resold | returned | reassigned | listed | scanned ...
  tokenId INTEGER,
  userId  INTEGER,
  txHash  TEXT,
  detail  TEXT,
  at      TEXT NOT NULL DEFAULT (datetime('now'))
);
`)

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
