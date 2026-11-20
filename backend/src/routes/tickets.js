// My tickets, rotating QR gate pass, return-to-pool. (Listing, gifting and buying live in routes/market.js.)
import { Router } from 'express'
import { config } from '../config.js'
import { db } from '../db.js'
import { HttpError, requireAuth } from '../auth.js'
import * as quai from '../services/quai.js'
import { getTicket, splitSeat } from '../services/tickets.js'
import { gatePassMessage } from '../services/gatepass.js'
import { reassignments, returnTicket } from '../services/pool.js'
import { getUser } from '../services/users.js'
import { faceInr, maxResaleInr, maxResaleWei } from '../services/money.js'
import { isLocked, lockAt } from '../services/lock.js'

export const router = Router()

const getEventRow = (id) => db.prepare('SELECT * FROM events WHERE id = ?').get(id)
const firstName = (u) => (u?.name ? u.name.split(' ')[0] : null)
const MAX_GIFTS_PER_EVENT = 2

export function publicTicket(t, { withChain, viewer } = {}) {
  const event = getEventRow(t.eventId)
  const owner = t.ownerUserId ? getUser(t.ownerUserId) : null
  const from = t.acquiredFromUserId ? getUser(t.acquiredFromUserId) : null
  const listing = t.listingId ? db.prepare('SELECT * FROM listings WHERE id = ?').get(t.listingId) : null
  const buyer = listing?.buyerUserId ? getUser(listing.buyerUserId) : null
  const giftsGiven =
    viewer && viewer.id === t.ownerUserId
      ? db.prepare("SELECT COUNT(*) n FROM ticket_history WHERE kind = 'gift' AND fromUserId = ? AND eventId = ?").get(viewer.id, t.eventId).n
      : null
  return {
    tokenId: t.tokenId,
    eventId: t.eventId,
    event: event && { id: event.id, name: event.name, artist: event.artist, date: event.date, venue: event.venue, city: event.city },
    seat: t.seat,
    ...splitSeat(t.seat),
    status: t.status,
    holderName: owner?.name || null,
    facePrice: event.facePrice,
    facePriceInr: faceInr(event),
    resaleCapPct: event.resaleCapPct,
    maxResalePrice: quai.quais.formatQuai(maxResaleWei(event)),
    maxResalePriceInr: maxResaleInr(event),
    // How the holder got it: "Gift from Asha" / "Bought from Ravi"
    acquiredVia: t.acquiredVia,
    acquiredFrom: firstName(from),
    gifted: !!t.gifted, // already gifted once: can't be gifted again
    giftsLeftThisEvent: giftsGiven == null ? null : Math.max(0, MAX_GIFTS_PER_EVENT - giftsGiven),
    listing: listing && {
      id: listing.id,
      visibility: listing.visibility,
      priceInr: listing.priceInr,
      price: listing.price,
      buyerName: buyer?.name || null,
      shareUrl: listing.visibility === 'private' ? `${config.frontendOrigin.replace(/\/$/, '')}/buy/${listing.id}` : null,
      openToAllAt: listing.visibility === 'public' ? listing.openToAllAt : null,
      tx: listing.listTx ? quai.explorerTx(listing.listTx) : null,
    },
    listedPrice: t.listedPrice,
    listedPriceInr: t.listedPriceInr,
    listingInvalid: t.listingInvalid, // "invalid – above new cap" after the organiser lowered the cap
    lockAt: lockAt(event),
    locked: isLocked(event),
    explorer: quai.explorerToken(t.tokenId),
    mintTx: t.mintTx ? quai.explorerTx(t.mintTx) : null,
    contract: quai.contract.target,
    ...(withChain || {}),
  }
}

function requireOwnedTicket(req) {
  const ticket = getTicket(Number(req.params.id))
  if (!ticket) throw new HttpError(404, 'Ticket not found')
  if (ticket.ownerUserId !== req.user.id) throw new HttpError(403, 'This is not your ticket')
  return ticket
}

/** GET /me/tickets: my tickets, each checked against ownerOf on-chain. */
router.get('/me/tickets', requireAuth, async (req, res) => {
  const rows = db.prepare('SELECT * FROM tickets WHERE ownerUserId = ? ORDER BY tokenId').all(req.user.id)
  const tickets = await Promise.all(
    rows.map(async (t) => {
      let onChainOwner = null
      try {
        onChainOwner = await quai.ownerOf(t.tokenId)
      } catch {}
      const ownedOnChain = !!onChainOwner && onChainOwner.toLowerCase() === req.user.walletAddress.toLowerCase()
      return publicTicket(t, { withChain: { onChainOwner, ownedOnChain }, viewer: req.user })
    }),
  )
  const entries = db
    .prepare(
      `SELECT e.id, e.eventId, e.quantity, e.ticketsWon, e.entryNumber, e.status, e.drawRank, e.createdAt, ev.name AS eventName
       FROM entries e JOIN events ev ON ev.id = e.eventId WHERE e.userId = ? ORDER BY e.id DESC`,
    )
    .all(req.user.id)
  res.json({ tickets, entries, walletAddress: req.user.walletAddress, wallet: quai.explorerAddress(req.user.walletAddress) })
})

/**
 * POST /tickets/:id/qr: a gate pass {tokenId, timestamp, signature}, personal-signed by the owner's
 * custodial key. The app asks for a new one every 30 s, so a screenshot is useless soon after.
 * After any transfer the old owner can't get a pass, and old passes fail (signer != ownerOf).
 */
router.post('/tickets/:id/qr', requireAuth, async (req, res) => {
  const ticket = requireOwnedTicket(req)
  if (ticket.status === 'used') throw new HttpError(409, 'This ticket has already been used', { reason: 'ALREADY_USED' })
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = await quai.walletForUser(req.user).signMessage(gatePassMessage(ticket.tokenId, timestamp))
  const payload = { tokenId: ticket.tokenId, timestamp, signature }
  res.json({ qr: JSON.stringify(payload), payload, refreshInSeconds: 30 })
})

/** POST /tickets/:id/return: give it back for the face price; it goes to the next waitlisted fan. */
router.post('/tickets/:id/return', requireAuth, async (req, res) => {
  const ticket = requireOwnedTicket(req)
  const result = await returnTicket(ticket, req.user)
  res.json({ ...result, tx: quai.explorerTx(result.txHash), reassignment: 'started' })
})

/** GET /tickets/:id/reassignment: where a returned ticket went. */
router.get('/tickets/:id/reassignment', (req, res) => {
  const tokenId = Number(req.params.id)
  const r = reassignments.get(tokenId) || null
  res.json({ tokenId, reassignment: r && { ...r, tx: r.txHash ? quai.explorerTx(r.txHash) : null } })
})
