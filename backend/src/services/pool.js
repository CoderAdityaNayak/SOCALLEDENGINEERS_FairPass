// Return-to-pool and reassignment to the waitlist.
import { db, logActivity, logHistory } from '../db.js'
import { HttpError } from '../auth.js'
import * as quai from './quai.js'
import { getUser } from './users.js'

/** The next waitlisted entry (by draw rank) that still wants tickets: 'partial' winners first come by rank too. */
function nextWaitlisted(eventId) {
  return (
    db
      .prepare(
        "SELECT * FROM entries WHERE eventId = ? AND status IN ('partial','waitlist') AND ticketsWon < quantity ORDER BY drawRank LIMIT 1",
      )
      .get(eventId) || null
  )
}

/** Status of in-flight reassignments, by tokenId. */
export const reassignments = new Map()

/** Gives a pooled ticket to `user` on-chain (organiser calls reassign). */
export async function reassignTo(ticket, user, { entry = null, kind = 'reassigned' } = {}) {
  const { hash } = await quai.reassign(ticket.tokenId, user.walletAddress)
  db.prepare(
    "UPDATE tickets SET ownerUserId = ?, status = 'active', listedPrice = NULL, listedPriceInr = NULL, listingInvalid = NULL, listingId = NULL, acquiredVia = 'waitlist', acquiredFromUserId = NULL WHERE tokenId = ?",
  ).run(user.id, ticket.tokenId)
  logHistory({ tokenId: ticket.tokenId, eventId: ticket.eventId, kind: 'reassigned', toUserId: user.id, txHash: hash })
  if (entry) {
    // One more ticket for this entry; it's fully served once it has the quantity it asked for.
    db.prepare(
      `UPDATE entries SET ticketsWon = ticketsWon + 1, ticketsMinted = ticketsMinted + 1,
         status = CASE WHEN ticketsWon + 1 >= quantity THEN 'won' ELSE 'partial' END
       WHERE id = ?`,
    ).run(entry.id)
  }
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
    const hash = await reassignTo(ticket, user, { entry })
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
export async function returnTicket(ticket, owner) {
  if (ticket.status === 'used') throw new HttpError(409, 'A used ticket cannot be returned', { reason: 'TICKET_USED' })
  if (ticket.status === 'returned' || !ticket.ownerUserId) throw new HttpError(409, 'This ticket is already in the pool')

  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(ticket.eventId)
  const { hash } = await quai.returnToPool(quai.walletForUser(owner), ticket.tokenId)
  // returnToPool also clears an on-chain listing; close it here too.
  if (ticket.listingId)
    db.prepare("UPDATE listings SET status = 'cancelled', closeTx = ?, closedAt = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'active'").run(hash, ticket.listingId)
  db.prepare(
    "UPDATE tickets SET ownerUserId = NULL, status = 'returned', listedPrice = NULL, listedPriceInr = NULL, listingInvalid = NULL, listingId = NULL WHERE tokenId = ?",
  ).run(ticket.tokenId)
  logHistory({ tokenId: ticket.tokenId, eventId: ticket.eventId, kind: 'returned', fromUserId: owner.id, priceWei: quai.quais.parseQuai(event.facePrice), priceInr: event.facePriceInr, txHash: hash })
  logActivity({ eventId: ticket.eventId, kind: 'returned', tokenId: ticket.tokenId, userId: owner.id, txHash: hash })
  logActivity({ eventId: ticket.eventId, kind: 'refund', tokenId: ticket.tokenId, userId: owner.id, detail: `${event.facePrice} QUAI (mock)` })

  reassignments.set(ticket.tokenId, { state: 'queued' })
  reassignToWaitlist({ ...ticket, ownerUserId: null }).catch((err) => console.error(`[pool] reassign ${ticket.tokenId} failed:`, err.message))
  return { txHash: hash, refund: { amount: event.facePrice, amountInr: event.facePriceInr, currency: 'QUAI', mocked: true } }
}
