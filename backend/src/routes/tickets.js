// My tickets, rotating QR, resale (list / cancel / buy) and return-to-pool.
import { Router } from 'express'
import { db, logActivity } from '../db.js'
import { HttpError, requireAuth, requireVerified } from '../auth.js'
import * as quai from '../services/quai.js'
import { getTicket, splitSeat } from '../services/tickets.js'
import { gatePassMessage } from '../services/gatepass.js'
import { reassignments, returnTicket } from '../services/pool.js'
import { getUser } from '../services/users.js'
import { faceInr, formatInr, inrToWei, maxResaleInr, maxResaleWei, weiToInr } from '../services/money.js'

export const router = Router()

const getEventRow = (id) => db.prepare('SELECT * FROM events WHERE id = ?').get(id)

export function publicTicket(t, { withChain } = {}) {
  const event = getEventRow(t.eventId)
  const owner = t.ownerUserId ? getUser(t.ownerUserId) : null
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
    listedPrice: t.listedPrice,
    listedPriceInr: t.listedPriceInr,
    listingInvalid: t.listingInvalid, // "invalid – above new cap" after the organiser lowered the cap
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
      return publicTicket(t, { withChain: { onChainOwner, ownedOnChain } })
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
 */
router.post('/tickets/:id/qr', requireAuth, async (req, res) => {
  const ticket = requireOwnedTicket(req)
  if (ticket.status === 'used') throw new HttpError(409, 'This ticket has already been used', { reason: 'ALREADY_USED' })
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = await quai.walletForUser(req.user).signMessage(gatePassMessage(ticket.tokenId, timestamp))
  const payload = { tokenId: ticket.tokenId, timestamp, signature }
  res.json({ qr: JSON.stringify(payload), payload, refreshInSeconds: 30 })
})

/** GET /resale?eventId=: tickets listed for resale (listings above the current cap are hidden). */
router.get('/resale', (req, res) => {
  const eventId = Number(req.query.eventId) || null
  const rows = db
    .prepare(`SELECT * FROM tickets WHERE status = 'listed' AND listingInvalid IS NULL ${eventId ? 'AND eventId = ?' : ''} ORDER BY tokenId`)
    .all(...(eventId ? [eventId] : []))
  res.json({ listings: rows.map((t) => publicTicket(t)) })
})

/**
 * POST /tickets/:id/list {priceInr}  (or {price} in QUAI)
 * Capped at face + the event's CURRENT resale % (the backend checks it here and the contract enforces it).
 */
router.post('/tickets/:id/list', requireAuth, async (req, res) => {
  const ticket = requireOwnedTicket(req)
  const event = getEventRow(ticket.eventId)
  if (ticket.status === 'used') throw new HttpError(409, 'A used ticket cannot be resold', { reason: 'TICKET_USED' })
  if (ticket.status === 'listed') throw new HttpError(409, 'Already listed. Cancel the listing first.')

  let priceWei
  try {
    if (req.body?.priceInr != null && req.body.priceInr !== '') priceWei = inrToWei(req.body.priceInr)
    else priceWei = quai.quais.parseQuai(String(req.body?.price ?? ''))
  } catch {
    throw new HttpError(400, 'Enter a price in ₹, e.g. 4950')
  }
  if (!(priceWei > 0n)) throw new HttpError(400, 'Price must be more than ₹0')
  const cap = maxResaleWei(event)
  if (priceWei > cap) {
    throw new HttpError(
      422,
      `Above the cap. The most you can ask is ${formatInr(weiToInr(cap))} (face price + ${event.resaleCapPct}%). The FairPass contract would reject this price.`,
      { reason: 'PRICE_ABOVE_CAP', maxPrice: quai.quais.formatQuai(cap), maxPriceInr: weiToInr(cap), resaleCapPct: event.resaleCapPct },
    )
  }

  const { hash } = await quai.listForResale(quai.walletForUser(req.user), ticket.tokenId, priceWei)
  const price = quai.quais.formatQuai(priceWei)
  db.prepare("UPDATE tickets SET status = 'listed', listedPrice = ?, listedPriceInr = ?, listingInvalid = NULL WHERE tokenId = ?").run(
    price,
    weiToInr(priceWei),
    ticket.tokenId,
  )
  logActivity({ eventId: ticket.eventId, kind: 'listed', tokenId: ticket.tokenId, userId: req.user.id, txHash: hash, detail: `${price} QUAI` })
  res.json({ ticket: publicTicket(getTicket(ticket.tokenId)), txHash: hash, tx: quai.explorerTx(hash) })
})

router.post('/tickets/:id/cancel', requireAuth, async (req, res) => {
  const ticket = requireOwnedTicket(req)
  if (ticket.status !== 'listed') throw new HttpError(409, 'This ticket is not listed')
  const { hash } = await quai.cancelListing(quai.walletForUser(req.user), ticket.tokenId)
  db.prepare("UPDATE tickets SET status = 'active', listedPrice = NULL, listedPriceInr = NULL, listingInvalid = NULL WHERE tokenId = ?").run(
    ticket.tokenId,
  )
  logActivity({ eventId: ticket.eventId, kind: 'unlisted', tokenId: ticket.tokenId, userId: req.user.id, txHash: hash })
  res.json({ ticket: publicTicket(getTicket(ticket.tokenId)), txHash: hash })
})

/** POST /tickets/:id/buy: buy a listed ticket at its listed price (payment mocked: the organiser funds the buyer's wallet). */
router.post('/tickets/:id/buy', requireAuth, requireVerified, async (req, res) => {
  const ticket = getTicket(Number(req.params.id))
  if (!ticket || ticket.status !== 'listed') throw new HttpError(404, 'This ticket is not for sale')
  if (ticket.ownerUserId === req.user.id) throw new HttpError(409, 'You already own this ticket')
  if (ticket.listingInvalid)
    throw new HttpError(409, 'This listing is above the current resale cap and cannot be bought', { reason: 'LISTING_INVALID' })

  const priceWei = await quai.listedPrice(ticket.tokenId)
  if (priceWei === 0n) throw new HttpError(409, 'The listing is no longer active on-chain')
  const seller = getUser(ticket.ownerUserId)
  const { hash } = await quai.buyResale(quai.walletForUser(req.user), ticket.tokenId, priceWei)
  db.prepare(
    "UPDATE tickets SET ownerUserId = ?, status = 'active', listedPrice = NULL, listedPriceInr = NULL, listingInvalid = NULL WHERE tokenId = ?",
  ).run(req.user.id, ticket.tokenId)
  logActivity({
    eventId: ticket.eventId,
    kind: 'resold',
    tokenId: ticket.tokenId,
    userId: req.user.id,
    txHash: hash,
    detail: `${quai.quais.formatQuai(priceWei)} QUAI from user ${seller?.id}`,
  })
  res.json({ ticket: publicTicket(getTicket(ticket.tokenId)), txHash: hash, tx: quai.explorerTx(hash) })
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
