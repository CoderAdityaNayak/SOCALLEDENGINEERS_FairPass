// Minting tickets with random seats, and reading them back.
import crypto from 'node:crypto'
import { db, logActivity } from '../db.js'
import * as quai from './quai.js'

const BLOCKS = ['A', 'B', 'C', 'D', 'E', 'F']
const MINT_BATCH = 50 // tickets per transaction (the contract allows up to 100)

/** A random free block-row-seat for this event (stored in the DB, shown on the ticket). */
export function assignSeat(eventId) {
  const taken = db.prepare('SELECT 1 FROM tickets WHERE eventId = ? AND seat = ?')
  for (;;) {
    const seat = `${BLOCKS[crypto.randomInt(BLOCKS.length)]}-${crypto.randomInt(1, 26)}-${crypto.randomInt(1, 31)}`
    if (!taken.get(eventId, seat)) return seat
  }
}

/**
 * Mints `quantity` tickets on-chain to the user's wallet (batched into as few transactions as possible)
 * and records each with a random seat. Returns the ticket rows.
 */
export async function mintToUser(event, user, quantity = 1) {
  const tickets = []
  for (let left = quantity; left > 0; left -= MINT_BATCH) {
    const n = Math.min(left, MINT_BATCH)
    const { tokenIds, hash } = await quai.mintTickets(user.walletAddress, event.chainEventId, n)
    const insert = db.prepare('INSERT INTO tickets (tokenId, eventId, ownerUserId, seat, mintTx) VALUES (?, ?, ?, ?, ?)')
    db.transaction(() => {
      for (const tokenId of tokenIds) {
        insert.run(tokenId, event.id, user.id, assignSeat(event.id), hash)
        logActivity({ eventId: event.id, kind: 'minted', tokenId, userId: user.id, txHash: hash })
      }
    })()
    tickets.push(...tokenIds.map(getTicket))
  }
  return tickets
}

export const getTicket = (tokenId) => db.prepare('SELECT * FROM tickets WHERE tokenId = ?').get(tokenId)

/** "B-12-7" -> { block: 'B', row: 12, seatNumber: 7 } */
export function splitSeat(seat) {
  const [block, row, number] = String(seat).split('-')
  return { block, row: Number(row), seatNumber: Number(number) }
}
