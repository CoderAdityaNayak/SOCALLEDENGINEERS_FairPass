// "Pass your ticket on": list (public / private), cancel, gift, marketplace, private links, buy (x402 Work),
// ticket history, wallet balance. Return to pool lives in routes/tickets.js (POST /tickets/:id/return).
import { Router } from 'express'
import { config } from '../config.js'
import { db, logActivity, logHistory } from '../db.js'
import { HttpError, loadUser, requireAuth, requireRole, requireVerified } from '../auth.js'
import * as quai from '../services/quai.js'
import * as x402 from '../services/x402.js'
import { overLimit } from '../services/ratelimit.js'
import { getTicket, splitSeat } from '../services/tickets.js'
import { getUser, getUserByPhone, normalizePhone } from '../services/users.js'
import { faceInr, faceWei, formatInr, listingWei, maxResaleInr, maxResaleWei, weiToInr } from '../services/money.js'
import { publicTicket } from './tickets.js'
import { requireEvent } from './events.js'
import { isLocked, lockAt } from '../services/lock.js'

export const router = Router()

export const MAX_GIFTS_PER_EVENT = 2
const PRIORITY_MS = Number(process.env.LISTING_PRIORITY_MINUTES ?? 10) * 60_000

const getEventRow = (id) => db.prepare('SELECT * FROM events WHERE id = ?').get(id)
const getListing = (id) => db.prepare('SELECT * FROM listings WHERE id = ?').get(id)
const now = () => new Date().toISOString()
export const shareUrl = (listing) => `${config.frontendOrigin.replace(/\/$/, '')}/buy/${listing.id}`
const firstName = (u) => (u?.name ? u.name.split(' ')[0] : 'A fan')

// ------------------------------------------------------------------ shared checks

function assertNotLocked(event) {
  if (isLocked(event))
    throw new HttpError(409, 'Transfers are locked: no gifts, listings or purchases in the last 24 hours before the event.', {
      reason: 'TRANSFERS_LOCKED',
      lockAt: lockAt(event),
    })
}

function requireOwnedTicket(req) {
  const ticket = getTicket(Number(req.params.id))
  if (!ticket) throw new HttpError(404, 'Ticket not found')
  if (ticket.ownerUserId !== req.user.id) throw new HttpError(403, 'This is not your ticket')
  return ticket
}

function assertFree(ticket) {
  if (ticket.status === 'used') throw new HttpError(409, 'This ticket has already been used at the gate.', { reason: 'TICKET_USED' })
  if (ticket.status === 'listed')
    throw new HttpError(409, 'This ticket is listed for resale. Cancel the listing first.', { reason: 'TICKET_LISTED' })
  if (ticket.status !== 'active') throw new HttpError(409, 'This ticket cannot be passed on right now.')
}

/** A registered, verified FairPass user by phone (for gifts and private sales). */
function verifiedRecipient(rawPhone, me) {
  let phone
  try {
    phone = normalizePhone(rawPhone)
  } catch {
    throw new HttpError(400, 'Enter your friend’s phone number', { reason: 'BAD_PHONE' })
  }
  const user = getUserByPhone(phone)
  if (!user) throw new HttpError(404, 'No FairPass account uses that phone number. Ask your friend to sign up first.', { reason: 'RECIPIENT_NOT_FOUND' })
  if (!user.isVerified) throw new HttpError(409, `${firstName(user)} hasn’t verified their ID yet. They must verify before receiving a ticket.`, { reason: 'RECIPIENT_NOT_VERIFIED' })
  if (user.id === me.id) throw new HttpError(409, "You can't do this with yourself.", { reason: 'SELF' })
  return user
}

const isWaitlisted = (userId, eventId) =>
  !!db.prepare("SELECT 1 FROM entries WHERE userId = ? AND eventId = ? AND status IN ('waitlist','partial')").get(userId, eventId)

/** Can `viewer` buy this listing right now? { ok, reason, message } */
function buyability(listing, event, viewer) {
  if (listing.status !== 'active') return { ok: false, reason: 'LISTING_CLOSED', message: 'Already sold or the listing was cancelled.' }
  if (listing.invalidReason) return { ok: false, reason: 'LISTING_INVALID', message: 'The organiser lowered the resale cap below this price.' }
  if (isLocked(event)) return { ok: false, reason: 'TRANSFERS_LOCKED', message: 'Transfers are locked in the last 24 hours before the event.' }
  if (!viewer) return { ok: false, reason: 'LOGIN', message: 'Log in to buy.' }
  if (!viewer.isVerified) return { ok: false, reason: 'NOT_VERIFIED', message: 'Verify your ID to buy.' }
  if (viewer.id === listing.sellerUserId) return { ok: false, reason: 'OWN_LISTING', message: 'This is your own listing.' }
  if (listing.visibility === 'private' && viewer.id !== listing.buyerUserId)
    return { ok: false, reason: 'NOT_ALLOWED_BUYER', message: 'This private listing is for someone else.' }
  if (listing.visibility === 'public' && Date.now() < Date.parse(listing.openToAllAt) && !isWaitlisted(viewer.id, listing.eventId))
    return { ok: false, reason: 'WAITLIST_PRIORITY', message: 'Waitlisted fans get first pick for 10 minutes.' }
  return { ok: true }
}

export function publicListing(l, viewer) {
  const event = getEventRow(l.eventId)
  const ticket = getTicket(l.tokenId)
  const seller = getUser(l.sellerUserId)
  const buyer = l.buyerUserId ? getUser(l.buyerUserId) : null
  const can = buyability(l, event, viewer)
  const isSeller = viewer?.id === l.sellerUserId
  return {
    id: l.id,
    tokenId: l.tokenId,
    eventId: l.eventId,
    event: { id: event.id, name: event.name, artist: event.artist, date: event.date, venue: event.venue, city: event.city },
    seat: ticket.seat,
    ...splitSeat(ticket.seat),
    visibility: l.visibility,
    price: l.price,
    priceInr: l.priceInr,
    priceWei: l.priceWei,
    faceInr: faceInr(event),
    markupPct: l.markupPct,
    sellerName: firstName(seller),
    sellerVerified: !!seller?.isVerified,
    buyerName: isSeller && buyer ? buyer.name : undefined,
    status: l.status,
    invalidReason: l.invalidReason,
    openToAllAt: l.visibility === 'public' ? l.openToAllAt : null,
    priorityOnly: l.visibility === 'public' && Date.now() < Date.parse(l.openToAllAt),
    canBuy: can.ok,
    cannotBuyReason: can.ok ? null : can.reason,
    cannotBuyMessage: can.ok ? null : can.message,
    shareUrl: isSeller && l.visibility === 'private' ? shareUrl(l) : undefined,
    listTx: l.listTx ? quai.explorerTx(l.listTx) : null,
    closeTx: l.closeTx ? quai.explorerTx(l.closeTx) : null,
    createdAt: l.createdAt,
  }
}

// ------------------------------------------------------------------ helpers for the UI

/** GET /users/lookup?phone=: is this a verified FairPass user? (for gift / private sale). Name only. */
router.get('/users/lookup', requireAuth, (req, res) => {
  const user = verifiedRecipient(req.query.phone, req.user)
  res.json({ name: user.name, verified: true, phone: user.phone })
})

/** GET /me/wallet: the custodial wallet balance. */
router.get('/me/wallet', requireAuth, async (req, res) => {
  const wei = await quai.balanceOf(req.user.walletAddress)
  res.json({
    address: req.user.walletAddress,
    balance: quai.quais.formatQuai(wei),
    balanceInr: weiToInr(wei),
    explorer: quai.explorerAddress(req.user.walletAddress),
  })
})

/** GET /tickets/:id/history: face price, then every gift / sale / return with date and Quaiscan link. */
router.get('/tickets/:id/history', requireAuth, (req, res) => {
  const ticket = getTicket(Number(req.params.id))
  if (!ticket) throw new HttpError(404, 'Ticket not found')
  const rows = db.prepare('SELECT * FROM ticket_history WHERE tokenId = ? ORDER BY id').all(ticket.tokenId)
  res.json({
    tokenId: ticket.tokenId,
    history: rows.map((h) => ({
      kind: h.kind,
      from: h.fromUserId ? firstName(getUser(h.fromUserId)) : null,
      to: h.toUserId ? firstName(getUser(h.toUserId)) : null,
      priceInr: h.priceInr,
      price: h.priceWei ? quai.quais.formatQuai(BigInt(h.priceWei)) : null,
      at: h.at,
      tx: h.txHash ? quai.explorerTx(h.txHash) : null,
    })),
  })
})

// ------------------------------------------------------------------ list / cancel

/**
 * POST /tickets/:id/list {priceInr | price, visibility: 'public'|'private', buyerPhone?}
 * Capped at face + the event's current resale %. Private: only the buyer (by phone) can buy, via a share link.
 */
router.post('/tickets/:id/list', requireAuth, requireVerified, async (req, res) => {
  const ticket = requireOwnedTicket(req)
  const event = getEventRow(ticket.eventId)
  assertFree(ticket)
  assertNotLocked(event)
  const visibility = req.body?.visibility === 'private' ? 'private' : 'public'

  let priceWei
  try {
    if (req.body?.priceInr != null && req.body.priceInr !== '') priceWei = listingWei(req.body.priceInr, event)
    else priceWei = quai.quais.parseQuai(String(req.body?.price ?? ''))
  } catch {
    throw new HttpError(400, 'Enter a price in ₹, e.g. 4950')
  }
  if (!(priceWei > 0n)) throw new HttpError(400, 'Price must be more than ₹0')
  const cap = maxResaleWei(event)
  if (priceWei > cap)
    throw new HttpError(
      422,
      `Above the cap. The most you can ask is ${formatInr(maxResaleInr(event))} (face price + ${event.resaleCapPct}%). The FairPass contract would reject this price.`,
      { reason: 'PRICE_ABOVE_CAP', maxPrice: quai.quais.formatQuai(cap), maxPriceInr: maxResaleInr(event), resaleCapPct: event.resaleCapPct },
    )

  const buyer = visibility === 'private' ? verifiedRecipient(req.body?.buyerPhone, req.user) : null
  const { hash } = await quai.listForResale(quai.walletForUser(req.user), ticket.tokenId, priceWei, buyer ? buyer.walletAddress : quai.ZERO_ADDRESS)

  const priceInr = priceWei === cap ? maxResaleInr(event) : weiToInr(priceWei)
  const markupPct = Math.round((Number((priceWei * 10000n) / faceWei(event)) / 100 - 100) * 100) / 100
  const listingId = db
    .prepare(
      `INSERT INTO listings (tokenId, eventId, sellerUserId, visibility, buyerUserId, priceWei, price, priceInr, markupPct, openToAllAt, listTx)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ticket.tokenId,
      event.id,
      req.user.id,
      visibility,
      buyer?.id ?? null,
      String(priceWei),
      quai.quais.formatQuai(priceWei),
      priceInr,
      markupPct,
      new Date(Date.now() + (visibility === 'public' ? PRIORITY_MS : 0)).toISOString(),
      hash,
    ).lastInsertRowid
  db.prepare("UPDATE tickets SET status = 'listed', listedPrice = ?, listedPriceInr = ?, listingInvalid = NULL, listingId = ? WHERE tokenId = ?").run(
    quai.quais.formatQuai(priceWei),
    priceInr,
    listingId,
    ticket.tokenId,
  )
  logActivity({ eventId: event.id, kind: visibility === 'private' ? 'listed_private' : 'listed', tokenId: ticket.tokenId, userId: req.user.id, txHash: hash })
  const listing = getListing(listingId)
  res.status(201).json({ listing: publicListing(listing, req.user), shareUrl: visibility === 'private' ? shareUrl(listing) : null, tx: quai.explorerTx(hash) })
})

async function cancelListing(req, res) {
  const ticket = requireOwnedTicket(req)
  if (ticket.status !== 'listed') throw new HttpError(409, 'This ticket is not listed')
  const { hash } = await quai.cancelListing(quai.walletForUser(req.user), ticket.tokenId)
  db.prepare("UPDATE listings SET status = 'cancelled', closeTx = ?, closedAt = ? WHERE id = ? AND status = 'active'").run(hash, now(), ticket.listingId)
  db.prepare("UPDATE tickets SET status = 'active', listedPrice = NULL, listedPriceInr = NULL, listingInvalid = NULL, listingId = NULL WHERE tokenId = ?").run(
    ticket.tokenId,
  )
  logActivity({ eventId: ticket.eventId, kind: 'unlisted', tokenId: ticket.tokenId, userId: req.user.id, txHash: hash })
  res.json({ ticket: publicTicket(getTicket(ticket.tokenId), { viewer: req.user }), tx: quai.explorerTx(hash) })
}
router.post('/tickets/:id/cancel-listing', requireAuth, cancelListing)
router.post('/tickets/:id/cancel', requireAuth, cancelListing)

// ------------------------------------------------------------------ gift

/** POST /tickets/:id/gift {phone}: free, once per ticket, to a verified user; max 2 gifts per user per event. */
router.post('/tickets/:id/gift', requireAuth, requireVerified, async (req, res) => {
  const ticket = requireOwnedTicket(req)
  const event = getEventRow(ticket.eventId)
  assertFree(ticket)
  if (ticket.gifted) throw new HttpError(409, 'This ticket was already gifted once and cannot be gifted again.', { reason: 'ALREADY_GIFTED' })
  assertNotLocked(event)
  const to = verifiedRecipient(req.body?.phone, req.user)
  const given = db.prepare("SELECT COUNT(*) n FROM ticket_history WHERE kind = 'gift' AND fromUserId = ? AND eventId = ?").get(req.user.id, event.id).n
  if (given >= MAX_GIFTS_PER_EVENT)
    throw new HttpError(409, `You can gift at most ${MAX_GIFTS_PER_EVENT} tickets per event.`, { reason: 'GIFT_LIMIT' })

  const { hash } = await quai.giftTicket(quai.walletForUser(req.user), ticket.tokenId, to.walletAddress)
  db.prepare("UPDATE tickets SET ownerUserId = ?, gifted = 1, acquiredVia = 'gift', acquiredFromUserId = ? WHERE tokenId = ?").run(
    to.id,
    req.user.id,
    ticket.tokenId,
  )
  logHistory({ tokenId: ticket.tokenId, eventId: event.id, kind: 'gift', fromUserId: req.user.id, toUserId: to.id, priceWei: 0n, priceInr: 0, txHash: hash })
  logActivity({ eventId: event.id, kind: 'gifted', tokenId: ticket.tokenId, userId: req.user.id, txHash: hash, detail: `to user ${to.id}` })
  res.json({ ok: true, to: { name: to.name }, tokenId: ticket.tokenId, txHash: hash, tx: quai.explorerTx(hash) })
})

// ------------------------------------------------------------------ marketplace + private links

/** GET /events/:id/marketplace: public listings, cheapest first, with what the current user may do. */
router.get('/events/:id/marketplace', (req, res) => {
  const event = requireEvent(req.params.id)
  const viewer = loadUser(req)
  const rows = db
    .prepare("SELECT * FROM listings WHERE eventId = ? AND visibility = 'public' AND status = 'active' AND invalidReason IS NULL ORDER BY CAST(priceWei AS REAL), id")
    .all(event.id)
  res.json({
    eventId: event.id,
    locked: isLocked(event),
    lockAt: lockAt(event),
    viewerWaitlisted: viewer ? isWaitlisted(viewer.id, event.id) : false,
    listings: rows.map((l) => publicListing(l, viewer)),
  })
})

/** GET /listings/:id: a private listing is only visible to its buyer (and seller); public ones to everyone. */
router.get('/listings/:id', (req, res) => {
  const l = getListing(Number(req.params.id))
  const viewer = loadUser(req)
  if (!l) throw new HttpError(404, 'Listing not found')
  if (l.visibility === 'private') {
    if (!viewer) throw new HttpError(401, 'Log in with the phone number the seller entered to see this offer', { reason: 'LOGIN' })
    if (viewer.id !== l.buyerUserId && viewer.id !== l.sellerUserId) throw new HttpError(404, 'Listing not found')
  }
  res.json({ listing: publicListing(l, viewer) })
})

const buying = new Set() // listing ids with a purchase in progress

/**
 * POST /listings/:id/buy: verified user + x402 Work puzzle (same as lottery entry), then buyResale from the
 * buyer's own custodial wallet (the organiser only tops up gas).
 */
router.post('/listings/:id/buy', async (req, res) => {
  const l = getListing(Number(req.params.id))
  const viewer = loadUser(req)
  if (!l || (l.visibility === 'private' && viewer && viewer.id !== l.buyerUserId && viewer.id !== l.sellerUserId))
    throw new HttpError(404, 'Listing not found')
  if (!viewer) throw new HttpError(401, 'Log in to buy', { reason: 'LOGIN' })
  const event = getEventRow(l.eventId)
  const can = buyability(l, event, viewer)
  if (!can.ok) throw new HttpError(can.reason === 'NOT_VERIFIED' ? 403 : 409, can.message, { reason: can.reason })

  const priceWei = BigInt(l.priceWei)
  const balance = await quai.balanceOf(viewer.walletAddress)
  if (balance < priceWei)
    throw new HttpError(
      409,
      `Not enough balance: your wallet has ${quai.quais.formatQuai(balance)} QUAI, this ticket costs ${l.price} QUAI.`,
      { reason: 'NOT_ENOUGH_BALANCE', balance: quai.quais.formatQuai(balance), price: l.price },
    )

  // Anti-bot: same pipeline as lottery entry (rate limit, then a proof-of-work bound to this account).
  if (overLimit(`buy:${req.ip}`, config.rateLimitPerMinute)) throw new HttpError(429, 'Too many attempts. Try again in a minute.', { reason: 'RATE_LIMITED' })
  const url = `${config.publicApiUrl}/listings/${l.id}/buy`
  const description = 'FairPass resale purchase'
  const paymentSignature = req.get('payment-signature')
  if (!paymentSignature) {
    const c = await x402.challenge({ url, description, userId: viewer.id, eventId: event.id })
    return res.status(402).set(c.headers).json(c.body)
  }
  const proof = await x402.verify({ url, description, paymentSignature, userId: viewer.id })
  if (!proof.ok) {
    if (proof.retryable) {
      const c = await x402.challenge({ url, description, userId: viewer.id, eventId: event.id, error: proof.detail })
      return res.status(402).set(c.headers).json({ ...c.body, reason: proof.reason })
    }
    return res.status(402).json({ error: `Anti-bot check failed: ${proof.detail}`, reason: proof.reason })
  }

  if (buying.has(l.id)) throw new HttpError(409, 'Someone is buying this ticket right now.', { reason: 'LISTING_CLOSED' })
  buying.add(l.id)
  try {
    const seller = getUser(l.sellerUserId)
    const { hash } = await quai.buyResale(quai.walletForUser(viewer), l.tokenId, priceWei)
    const kind = l.visibility === 'private' ? 'sale_private' : 'sale_public'
    db.transaction(() => {
      db.prepare("UPDATE listings SET status = 'sold', soldToUserId = ?, closeTx = ?, closedAt = ? WHERE id = ?").run(viewer.id, hash, now(), l.id)
      db.prepare(
        `UPDATE tickets SET ownerUserId = ?, status = 'active', listedPrice = NULL, listedPriceInr = NULL, listingInvalid = NULL,
           listingId = NULL, acquiredVia = 'purchase', acquiredFromUserId = ? WHERE tokenId = ?`,
      ).run(viewer.id, seller.id, l.tokenId)
      logHistory({ tokenId: l.tokenId, eventId: l.eventId, kind, fromUserId: seller.id, toUserId: viewer.id, priceWei, priceInr: l.priceInr, txHash: hash })
      logActivity({ eventId: l.eventId, kind: 'resold', tokenId: l.tokenId, userId: viewer.id, txHash: hash, detail: `${l.price} QUAI ${l.visibility}` })
    })()
    res
      .status(201)
      .set(proof.headers)
      .json({
        ok: true,
        ticket: publicTicket(getTicket(l.tokenId), { viewer }),
        listing: publicListing(getListing(l.id), viewer),
        txHash: hash,
        tx: quai.explorerTx(hash),
        proofOfWork: { guesses: Number(proof.amount), receipt: proof.receipt },
      })
  } finally {
    buying.delete(l.id)
  }
})

// ------------------------------------------------------------------ demo helper

/** POST /admin/fund {phone, amountQuai}: organiser sends test QUAI to a fan's wallet (DEMO_MODE only). */
router.post('/admin/fund', requireRole('organiser'), async (req, res) => {
  if (!config.demoMode) throw new HttpError(404, 'Not found')
  const user = getUserByPhone(normalizePhone(req.body?.phone))
  if (!user) throw new HttpError(404, 'No user with that phone')
  const amount = quai.quais.parseQuai(String(req.body?.amountQuai ?? '0.05'))
  if (amount <= 0n || amount > quai.quais.parseQuai('1')) throw new HttpError(400, 'amountQuai must be between 0 and 1')
  const hash = await quai.fund(user.walletAddress, amount)
  res.json({ ok: true, txHash: hash, tx: quai.explorerTx(hash), balance: quai.quais.formatQuai(await quai.balanceOf(user.walletAddress)) })
})
