// Pass your ticket on: /tickets/:tokenId/pass/:mode  (mode = return | gift | private | public)
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { api } from '../lib/api.js'
import { inr } from '../lib/format.js'
import { useLiveEvent } from '../lib/liveEvent.js'
import { Badge, Button, Card, ErrorNote, Spinner, TxLink } from '../components/ui.jsx'
import { LockCountdown, PriceInput, priceValid, RecipientLookup } from '../components/Transfer.jsx'
import * as I from '../components/Icons.jsx'

const TITLES = { return: 'Return to pool', gift: 'Gift to a friend', private: 'Sell privately', public: 'Sell publicly' }

function Done({ icon = I.Check, title, children }) {
  const Icon = icon
  return (
    <div className="text-center">
      <div className="mx-auto mb-4 grid size-20 place-items-center rounded-full bg-lime text-lime-ink animate-pop">
        <Icon size={40} strokeWidth={3} />
      </div>
      <h1 className="text-3xl">{title}</h1>
      <div className="mt-4 space-y-3 text-left">{children}</div>
    </div>
  )
}

export default function PassOn() {
  const { tokenId, mode } = useParams()
  const [ticket, setTicket] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [recipient, setRecipient] = useState(null)
  const [price, setPrice] = useState('')
  const [copied, setCopied] = useState(false)
  const [reassign, setReassign] = useState(null)
  const live = useLiveEvent(ticket?.eventId)

  useEffect(() => {
    api('/me/tickets')
      .then((d) => {
        const t = d.tickets.find((x) => String(x.tokenId) === tokenId)
        if (!t) throw new Error('This ticket is not in your account')
        setTicket(t)
        setPrice(String(t.maxResalePriceInr))
      })
      .catch(setError)
  }, [tokenId])

  // After a return, follow the ticket to the waitlisted fan.
  useEffect(() => {
    if (mode !== 'return' || !result) return
    const t = setInterval(async () => {
      const r = await api(`/tickets/${tokenId}/reassignment`).catch(() => null)
      if (r?.reassignment) setReassign(r.reassignment)
      if (['reassigned', 'pooled', 'failed'].includes(r?.reassignment?.state)) clearInterval(t)
    }, 3000)
    return () => clearInterval(t)
  }, [mode, result, tokenId])

  async function act(fn) {
    setBusy(true)
    setError(null)
    try {
      setResult(await fn())
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  if (!ticket)
    return error ? (
      <ErrorNote error={error} />
    ) : (
      <div className="grid place-items-center py-20 text-muted">
        <Spinner />
      </div>
    )

  // The CURRENT cap, live from Firestore when available.
  const ev = live.event
  const capPct = ev?.resaleCapPct ?? ticket.resaleCapPct
  const maxInr = ev?.maxResalePriceInr ?? ticket.maxResalePriceInr
  const faceInr = ev?.facePriceInr ?? ticket.facePriceInr
  const locked = ticket.locked || Date.now() >= Date.parse(ticket.lockAt)
  const back = (
    <Link to={`/tickets/${tokenId}`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
      <I.ArrowLeft size={16} /> Ticket #{tokenId}
    </Link>
  )

  // ---------------------------------------------------------------- results
  if (result && mode === 'gift')
    return (
      <div className="mx-auto max-w-md">
        <Done title="Gift sent" icon={I.Check}>
          <Card>
            <p>
              Ticket #{tokenId} now belongs to <span className="font-semibold">{result.to.name}</span>. Their name goes on the ticket, and your QR code
              no longer works.
            </p>
            <TxLink href={result.tx} className="mt-2" />
          </Card>
          <Link to="/tickets" className="flex min-h-12 items-center justify-center rounded-[14px] border border-line font-semibold">
            My tickets
          </Link>
        </Done>
      </div>
    )
  if (result && mode === 'private')
    return (
      <div className="mx-auto max-w-md">
        <Done title="Private sale ready" icon={I.Link}>
          <Card>
            <p>
              Only <span className="font-semibold">{recipient?.name}</span> can buy this ticket, for {inr(result.listing.priceInr)}. Send them this link:
            </p>
            <div className="mt-3 flex gap-2">
              <input readOnly value={result.shareUrl} aria-label="Share link" className="min-h-11 w-full rounded-[12px] border border-line bg-bg px-3 font-mono text-sm" />
              <Button
                variant="secondary"
                className="min-h-11"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(result.shareUrl)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1500)
                  } catch {}
                }}
              >
                <I.Copy size={16} /> {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <TxLink href={result.tx} className="mt-3">
              Listing on Quaiscan
            </TxLink>
          </Card>
          <Link to={`/tickets/${tokenId}`} className="flex min-h-12 items-center justify-center rounded-[14px] border border-line font-semibold">
            Back to ticket
          </Link>
        </Done>
      </div>
    )
  if (result && mode === 'public')
    return (
      <div className="mx-auto max-w-md">
        <Done title={`Listed for ${inr(result.listing.priceInr)}`} icon={I.Tag}>
          <Card>
            <p>Your ticket is on the event's Resale tab. Waitlisted fans get first pick for 10 minutes, then everyone can buy it.</p>
            <TxLink href={result.tx} className="mt-2">
              Listing on Quaiscan
            </TxLink>
          </Card>
          <Link to={`/tickets/${tokenId}`} className="flex min-h-12 items-center justify-center rounded-[14px] border border-line font-semibold">
            Back to ticket
          </Link>
        </Done>
      </div>
    )
  if (result && mode === 'return')
    return (
      <div className="mx-auto max-w-md">
        <Done title="Ticket returned">
          <p className="text-center text-muted">{inr(faceInr)} face price refunded to you (mock payment).</p>
          <Card>
            <p className="flex items-center gap-2 text-sm">
              <I.Check size={16} className="text-lime" /> Returned to the pool on Quai
            </p>
            <TxLink href={result.tx} className="ml-6" />
            <p className="mt-3 flex items-center gap-2 text-sm">
              {reassign?.state === 'reassigned' ? <I.Check size={16} className="text-lime" /> : <Spinner size={16} />}
              {reassign?.state === 'reassigned'
                ? `Given to the waitlisted fan with draw rank #${reassign.drawRank}`
                : reassign?.state === 'pooled'
                  ? 'No one is waiting; the ticket stays in the pool'
                  : 'Passing it to the next fan on the waitlist…'}
            </p>
            {reassign?.tx && <TxLink href={reassign.tx} className="ml-6" />}
          </Card>
          <Link to="/tickets" className="flex min-h-12 items-center justify-center rounded-[14px] border border-line font-semibold">
            My tickets
          </Link>
        </Done>
      </div>
    )

  // ---------------------------------------------------------------- forms
  const priceBlock = (
    <div className="grid grid-cols-2 gap-3">
      <Card className="p-4">
        <p className="text-sm text-muted">Face price</p>
        <p className="mt-1 font-display text-2xl">{inr(faceInr)}</p>
      </Card>
      <Card className="p-4" aria-live="polite">
        <p className="text-sm text-muted">Max resale (+{capPct}%)</p>
        <p className="mt-1 font-display text-2xl">{inr(maxInr)}</p>
      </Card>
    </div>
  )

  return (
    <div className="mx-auto max-w-md">
      {back}
      <h1 className="text-3xl">{TITLES[mode] || 'Pass it on'}</h1>
      <p className="mt-1 text-muted">
        {ticket.event.name} · Block {ticket.block}, Row {ticket.row}, Seat {ticket.seatNumber}
      </p>
      <LockCountdown lockAt={ticket.lockAt} className="mt-2" />

      <div className="mt-5 space-y-4">
        {locked && mode !== 'return' && (
          <Card className="border-err/50 bg-err/10 text-sm text-err-soft">Transfers are locked in the last 24 hours before the show.</Card>
        )}

        {mode === 'return' && (
          <>
            {priceBlock}
            <Card className="border-lime/40">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm text-muted">
                  Get the full face price back. The ticket goes to the next fan on the waitlist, so nobody can buy it to scalp.
                </p>
                <Badge tone="lime">Recommended</Badge>
              </div>
              <Button className="mt-4 w-full" loading={busy} onClick={() => act(() => api(`/tickets/${tokenId}/return`, { method: 'POST' }))}>
                {busy ? 'Returning on Quai (about 30 s)…' : `Return for ${inr(faceInr)}`}
              </Button>
            </Card>
          </>
        )}

        {mode === 'gift' && (
          <Card>
            <p className="mb-4 flex gap-2 rounded-[12px] bg-raised p-3 text-sm text-muted">
              <I.Info size={16} className="mt-0.5 shrink-0" />
              Each ticket can be gifted once. Their name goes on the ticket. You can gift up to 2 tickets per event
              {ticket.giftsLeftThisEvent != null ? ` (${ticket.giftsLeftThisEvent} left)` : ''}.
            </p>
            {ticket.gifted ? (
              <p className="text-err-soft">This ticket was already gifted once, so it can't be gifted again.</p>
            ) : (
              <>
                <RecipientLookup onFound={setRecipient} />
                <Button
                  className="mt-4 w-full"
                  loading={busy}
                  disabled={!recipient || locked || ticket.giftsLeftThisEvent === 0}
                  onClick={() => act(() => api(`/tickets/${tokenId}/gift`, { method: 'POST', body: { phone: recipient.phone } }))}
                >
                  {busy ? 'Sending on Quai (about 30 s)…' : recipient ? `Gift to ${recipient.name.split(' ')[0]}` : 'Find your friend first'}
                </Button>
              </>
            )}
          </Card>
        )}

        {(mode === 'private' || mode === 'public') && (
          <>
            {priceBlock}
            <Card className="space-y-4">
              {mode === 'private' && <RecipientLookup label="Buyer's phone number" onFound={setRecipient} />}
              <PriceInput value={price} onChange={setPrice} maxInr={maxInr} capPct={capPct} />
              <Button
                className="w-full"
                loading={busy}
                disabled={!priceValid(price, maxInr) || locked || (mode === 'private' && !recipient)}
                onClick={() =>
                  act(() =>
                    api(`/tickets/${tokenId}/list`, {
                      method: 'POST',
                      body: { priceInr: Number(price), visibility: mode, buyerPhone: mode === 'private' ? recipient.phone : undefined },
                    }),
                  )
                }
              >
                {busy ? 'Listing on Quai (about 30 s)…' : mode === 'private' ? 'Create private sale link' : `List for ${inr(Number(price) || 0)}`}
              </Button>
              <p className="text-xs text-muted">
                {mode === 'private'
                  ? 'Only this person can buy it. They must be verified and solve a quick anti-bot puzzle. You get the price minus a 2% organiser royalty.'
                  : 'Listed on the event’s Resale tab. Waitlisted fans get first pick for 10 minutes. You get the price minus a 2% organiser royalty.'}
              </p>
            </Card>
          </>
        )}

        <ErrorNote error={error} />
      </div>
    </div>
  )
}
