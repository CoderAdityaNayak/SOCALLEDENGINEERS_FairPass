// Return-to-pool and reassignment to the waitlist.
import { db, logActivity } from '../db.js'
import { HttpError } from '../auth.js'
import * as quai from './quai.js'
import { getUser } from './users.js'

const MAX_TICKETS_PER_ID = 2

/** Tickets a user's ID currently holds for an event (lottery + corporate + resale). */
export const ticketsHeld = (userId, eventId) =>
  db.prepare("SELECT COUNT(*) n FROM tickets WHERE ownerUserId = ? AND eventId = ? AND status != 'returned'").get(userId, eventId).n

export function assertCanHoldMore(user, eventId) {
  if (ticketsHeld(user.id, eventId) >= MAX_TICKETS_PER_ID)
    throw new HttpError(409, `One ID can hold at most ${MAX_TICKETS_PER_ID} tickets per event`, { reason: 'ID_LIMIT' })
}

/** The next waitlisted fan (by draw rank) who can still hold a ticket. */
function nextWaitlisted(eventId) {
  const rows = db.prepare("SELECT * FROM entries WHERE eventId = ? AND status = 'waitlist' ORDER BY drawRank").all(eventId)
  return rows.find((e) => ticketsHeld(e.userId, eventId) < MAX_TICKETS_PER_ID) || null
}

/** Status of in-flight reassignments, by tokenId. */
export const reassignments = new Map()

/** Gives a pooled ticket to `user` on-chain (organiser calls reassign). */
export async function reassignTo(ticket, user, { entryId = null, kind = 'reassigned' } = {}) {
  const { hash } = await quai.reassign(ticket.tokenId, user.walletAddress)
  db.prepare("UPDATE tickets SET ownerUserId = ?, status = 'active', listedPrice = NULL WHERE tokenId = ?").run(user.id, ticket.tokenId)
  if (entryId) db.prepare("UPDATE entries SET status = 'won', ticketsMinted = ticketsMinted + 1 WHERE id = ?").run(entryId)
  logActivity({ eventId: ticket.eventId, kind, tokenId: ticket.tokenId, userId: user.id, txHash: hash })
  return hash
}

/** Reassigns a pooled ticket to the next waitlisted fan, if any. */
export async function reassignToWaitlist(ticket) {
  const entry = nextWaitlisted(ticket.eventId)
  if (!entry) {
    reassignments.set(ticket.tokenId, { state: 'pooled', note: 'No one on the waitlist; the ticket stays in the pool' })
    return null
  }
  const user = getUser(entry.userId)
  reassignments.set(ticket.tokenId, { state: 'reassigning', toEntry: entry.id, drawRank: entry.drawRank })
  try {
    const hash = await reassignTo(ticket, user, { entryId: entry.id })
    reassignments.set(ticket.tokenId, { state: 'reassigned', toEntry: entry.id, drawRank: entry.drawRank, txHash: hash })
    return { entry, user, hash }
  } catch (err) {
    reassignments.set(ticket.tokenId, { state: 'failed', error: err.message })
    throw err
  }
}

/**
 * Seller hands the ticket back: returnToPool on-chain from their custodial wallet, mock refund of
 * the face price, then (in the background) reassignment to the next waitlisted fan.
 */
export async function returnTicket(ticket, owner, { reassign = true, refund = true } = {}) {
  if (ticket.status === 'used') throw new HttpError(409, 'A used ticket cannot be returned', { reason: 'TICKET_USED' })
  if (ticket.status === 'returned' || !ticket.ownerUserId) throw new HttpError(409, 'This ticket is already in the pool')

  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(ticket.eventId)
  const { hash } = await quai.returnToPool(quai.walletForUser(owner), ticket.tokenId)
  db.prepare("UPDATE tickets SET ownerUserId = NULL, status = 'returned', listedPrice = NULL WHERE tokenId = ?").run(ticket.tokenId)
  logActivity({ eventId: ticket.eventId, kind: 'returned', tokenId: ticket.tokenId, userId: owner.id, txHash: hash })
  if (refund)
    logActivity({ eventId: ticket.eventId, kind: 'refund', tokenId: ticket.tokenId, userId: owner.id, detail: `${event.facePrice} QUAI (mock)` })

  if (reassign) {
    reassignments.set(ticket.tokenId, { state: 'queued' })
    reassignToWaitlist({ ...ticket, ownerUserId: null }).catch((err) => console.error(`[pool] reassign ${ticket.tokenId} failed:`, err.message))
  }
  return { txHash: hash, refund: refund ? { amount: event.facePrice, currency: 'QUAI', mocked: true } : null }
}
