// Minting tickets with a random seat, and reading them back.
import crypto from 'node:crypto'
import { db, logActivity } from '../db.js'
import * as quai from './quai.js'

const BLOCKS = ['A', 'B', 'C', 'D', 'E', 'F']

/** A random free block-row-seat for this event (stored in the DB, shown on the ticket). */
export function assignSeat(eventId) {
  const taken = db.prepare('SELECT 1 FROM tickets WHERE eventId = ? AND seat = ?')
  for (;;) {
    const seat = `${BLOCKS[crypto.randomInt(BLOCKS.length)]}-${crypto.randomInt(1, 26)}-${crypto.randomInt(1, 31)}`
    if (!taken.get(eventId, seat)) return seat
  }
}

/** Mints a ticket on-chain to the user's wallet and records it with a random seat. */
export async function mintToUser(event, user, { corporate = false } = {}) {
  const { tokenId, hash } = await quai.mintTicket(user.walletAddress, event.chainEventId, corporate)
  const seat = assignSeat(event.id)
  db.prepare('INSERT INTO tickets (tokenId, eventId, ownerUserId, seat, corporate, mintTx) VALUES (?, ?, ?, ?, ?, ?)').run(
    tokenId,
    event.id,
    user.id,
    seat,
    corporate ? 1 : 0,
    hash,
  )
  logActivity({ eventId: event.id, kind: 'minted', tokenId, userId: user.id, txHash: hash, detail: corporate ? 'corporate' : null })
  return getTicket(tokenId)
}

export const getTicket = (tokenId) => db.prepare('SELECT * FROM tickets WHERE tokenId = ?').get(tokenId)

/** "B-12-7" -> { block: 'B', row: 12, seatNumber: 7 } */
export function splitSeat(seat) {
  const [block, row, number] = String(seat).split('-')
  return { block, row: Number(row), seatNumber: Number(number) }
}
