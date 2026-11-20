// A ticket with a rotating QR gate pass (new signed code every 30 s).
import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { QRCodeSVG } from 'qrcode.react'
import { api } from '../lib/api.js'
import { dateLong, inr } from '../lib/format.js'
import { Badge, Button, Card, ErrorNote, Spinner, TxLink } from '../components/ui.jsx'
import { LockCountdown } from '../components/Transfer.jsx'
import * as I from '../components/Icons.jsx'

const PERIOD = 30

function Ring({ seconds }) {
  const r = 16
  const c = 2 * Math.PI * r
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true" className="-rotate-90">
      <circle cx="20" cy="20" r={r} stroke="#E5E7EB" strokeWidth="4" fill="none" />
      <circle
        cx="20"
        cy="20"
        r={r}
        stroke="#11140A"
        strokeWidth="4"
        fill="none"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - seconds / PERIOD)}
        style={{ transition: 'stroke-dashoffset 1s linear' }}
      />
    </svg>
  )
}

export default function TicketPage() {
  const { tokenId } = useParams()
  const [ticket, setTicket] = useState(null)
  const [qr, setQr] = useState(null)
  const [left, setLeft] = useState(PERIOD)
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)
  const [sheet, setSheet] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  const loadTicket = useCallback(
    () =>
      api('/me/tickets')
        .then((d) => {
          const t = d.tickets.find((x) => String(x.tokenId) === tokenId)
          if (!t) throw new Error('This ticket is not in your account (it may have been passed on)')
          setTicket(t)
        })
        .catch(setError),
    [tokenId],
  )
  useEffect(() => {
    loadTicket()
  }, [loadTicket])

  async function cancelListing() {
    setCancelling(true)
    setError(null)
    try {
      await api(`/tickets/${tokenId}/cancel-listing`, { method: 'POST' })
      await loadTicket()
    } catch (err) {
      setError(err)
    } finally {
      setCancelling(false)
    }
  }

  const refresh = useCallback(async () => {
    try {
      const r = await api(`/tickets/${tokenId}/qr`, { method: 'POST' })
      setQr(r)
      setLeft(PERIOD)
    } catch (err) {
      setError(err)
    }
  }, [tokenId])

  const active = ticket && ticket.status !== 'used' && ticket.status !== 'returned'
  useEffect(() => {
    if (!active) return
    refresh()
    const t = setInterval(() => {
      setLeft((s) => {
        if (s <= 1) {
          refresh()
          return PERIOD
        }
        return s - 1
      })
    }, 1000)
    return () => clearInterval(t)
  }, [active, refresh])

  if (error && !ticket) return <ErrorNote error={error} />
  if (!ticket)
    return (
      <div className="grid place-items-center py-20 text-muted">
        <Spinner />
      </div>
    )

  return (
    <div className="mx-auto max-w-sm">
      <Link to="/tickets" className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <I.ArrowLeft size={16} /> My tickets
      </Link>

      <article className="overflow-hidden rounded-[22px] bg-white text-[#11140A] shadow-2xl" aria-label={`Ticket ${ticket.tokenId}`}>
        <header className="bg-lime px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest opacity-70">{ticket.event.artist || 'FairPass'}</p>
              <h1 className="font-display text-2xl leading-tight">{ticket.event.name}</h1>
            </div>
            <span className="rounded-full bg-lime-ink px-2.5 py-1 font-mono text-xs text-lime">#{ticket.tokenId}</span>
          </div>
          <p className="mt-2 text-sm font-medium">
            {dateLong(ticket.event.date)}
            {ticket.event.venue && ` · ${ticket.event.venue}`}
          </p>
        </header>

        <div className="relative border-b-2 border-dashed border-gray-200 px-5 py-6">
          {active ? (
            <>
              <div className="mx-auto grid aspect-square w-full max-w-[260px] place-items-center">
                {qr ? (
                  <QRCodeSVG value={qr.qr} size={260} level="M" marginSize={0} className="h-auto w-full" title="Gate pass QR code" />
                ) : (
                  <Spinner size={32} />
                )}
              </div>
              <div className="mt-4 flex items-center justify-center gap-3">
                <Ring seconds={left} />
                <p className="text-sm font-medium" aria-live="polite">
                  New code in {left}s · screenshots won't work
                </p>
              </div>
            </>
          ) : (
            <div className="py-10 text-center">
              <p className="font-display text-3xl">{ticket.status === 'used' ? 'Checked in' : 'Returned'}</p>
              <p className="mt-1 text-sm text-gray-500">{ticket.status === 'used' ? 'This ticket was used at the gate.' : 'This ticket went back to the pool.'}</p>
            </div>
          )}
          <span className="absolute -bottom-3 -left-3 size-6 rounded-full bg-bg" aria-hidden="true" />
          <span className="absolute -bottom-3 -right-3 size-6 rounded-full bg-bg" aria-hidden="true" />
        </div>

        <dl className="grid grid-cols-3 gap-2 px-5 pt-5 text-center">
          {[
            ['Block', ticket.block],
            ['Row', ticket.row],
            ['Seat', ticket.seatNumber],
          ].map(([k, v]) => (
            <div key={k} className="rounded-[12px] bg-gray-100 py-2">
              <dt className="text-xs uppercase tracking-wide text-gray-500">{k}</dt>
              <dd className="font-display text-2xl">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="flex items-center justify-between px-5 py-4 text-sm">
          <div>
            <p className="text-gray-500">Holder</p>
            <p className="font-semibold">{ticket.holderName}</p>
          </div>
          <a href={ticket.explorer} target="_blank" rel="noreferrer" className="flex items-center gap-1 font-semibold text-[#3d4a0a] underline-offset-4 hover:underline">
            <I.Shield size={16} /> Verified on Quai
            <span className="sr-only">: view on Quaiscan (opens in a new tab)</span>
          </a>
        </div>
      </article>

      {active && qr && (
        <button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(qr.qr)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            } catch {}
          }}
          className="mx-auto mt-3 flex items-center gap-1.5 text-xs text-muted hover:text-ink"
        >
          <I.Copy size={14} /> {copied ? 'Copied' : 'Copy code (for the scanner demo)'}
        </button>
      )}

      {error && <ErrorNote error={error} className="mt-4" />}

      {(ticket.acquiredVia === 'gift' || ticket.acquiredVia === 'purchase' || ticket.gifted) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {ticket.acquiredVia === 'gift' && <Badge tone="lime">Gift from {ticket.acquiredFrom}</Badge>}
          {ticket.acquiredVia === 'purchase' && <Badge tone="lime">Bought from {ticket.acquiredFrom}</Badge>}
          {ticket.gifted && <Badge>Gifted ✓ · can't be gifted again</Badge>}
        </div>
      )}

      {ticket.status === 'listed' && (
        <Card className="mt-4">
          <div className="flex items-center justify-between gap-3">
            <Badge tone={ticket.listingInvalid ? 'err' : 'lime'}>
              <I.Tag size={12} /> Listed for {inr(ticket.listedPriceInr)}
              {ticket.listing?.visibility === 'private' ? ' · private' : ''}
            </Badge>
            <Button variant="secondary" className="min-h-10 text-sm" loading={cancelling} onClick={cancelListing}>
              Cancel listing
            </Button>
          </div>
          {ticket.listing?.visibility === 'private' && (
            <p className="mt-3 text-sm text-muted">
              Only {ticket.listing.buyerName} can buy it. Share link: <span className="break-all font-mono text-ink">{ticket.listing.shareUrl}</span>
            </p>
          )}
          {ticket.listingInvalid && (
            <p role="alert" className="mt-3 text-sm text-err-soft">
              Above the new resale cap (max {inr(ticket.maxResalePriceInr)}, +{ticket.resaleCapPct}%): nobody can buy it. Cancel and relist.
            </p>
          )}
          <p className="mt-2 text-xs text-muted">A listed ticket can't be used at the gate. Cancel the listing to go in.</p>
        </Card>
      )}

      {active && ticket.status !== 'listed' && (
        <>
          <Button className="mt-5 w-full" onClick={() => setSheet(true)}>
            Pass it on
          </Button>
          <LockCountdown lockAt={ticket.lockAt} className="mt-2 justify-center" />
        </>
      )}

      <TicketHistory tokenId={ticket.tokenId} />

      {sheet && <PassSheet ticket={ticket} onClose={() => setSheet(false)} />}
    </div>
  )
}

/** Bottom sheet with the four ways to pass a ticket on. */
function PassSheet({ ticket, onClose }) {
  const locked = ticket.locked || Date.now() >= Date.parse(ticket.lockAt)
  const options = [
    { mode: 'return', icon: I.Undo, title: 'Return to pool', text: `Get ${inr(ticket.facePriceInr)} back. It goes to the next waitlisted fan.`, recommended: true },
    {
      mode: 'gift',
      icon: I.Users,
      title: 'Gift to a friend',
      text: ticket.gifted ? 'Already gifted once: this ticket can’t be gifted again.' : 'Free, to one verified FairPass user. Once per ticket.',
      disabled: ticket.gifted || ticket.giftsLeftThisEvent === 0,
    },
    { mode: 'private', icon: I.Link, title: 'Sell privately', text: `To one person, by phone and share link. Up to ${inr(ticket.maxResalePriceInr)}.` },
    { mode: 'public', icon: I.Tag, title: 'Sell publicly', text: `On the event’s Resale tab. Up to ${inr(ticket.maxResalePriceInr)}.` },
  ]
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 sm:items-center" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pass-title"
        className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-[22px] border border-line bg-card p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:rounded-[22px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="pass-title" className="text-xl">
              Pass it on
            </h2>
            <p className="text-sm text-muted">
              Face {inr(ticket.facePriceInr)} · max resale {inr(ticket.maxResalePriceInr)} (+{ticket.resaleCapPct}%)
            </p>
            <LockCountdown lockAt={ticket.lockAt} className="mt-1" />
          </div>
          <button onClick={onClose} className="grid size-10 place-items-center rounded-[12px] text-muted hover:text-ink" aria-label="Close">
            <I.X size={20} />
          </button>
        </div>
        <ul className="mt-4 space-y-2">
          {options.map((o) => {
            const off = o.disabled || (locked && o.mode !== 'return')
            const inner = (
              <>
                <span className={`grid size-10 shrink-0 place-items-center rounded-[12px] ${o.recommended ? 'bg-lime/15 text-lime' : 'bg-raised text-ink'}`}>
                  <o.icon size={20} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 font-semibold">
                    {o.title} {o.recommended && <Badge tone="lime">Recommended</Badge>}
                  </span>
                  <span className="block text-sm text-muted">{locked && o.mode !== 'return' ? 'Locked in the last 24 h before the show.' : o.text}</span>
                </span>
                {!off && <I.ArrowRight size={18} className="shrink-0 text-muted" />}
              </>
            )
            return (
              <li key={o.mode}>
                {off ? (
                  <div className="flex min-h-16 items-center gap-3 rounded-[16px] border border-line p-3 opacity-50" aria-disabled="true">
                    {inner}
                  </div>
                ) : (
                  <Link
                    to={`/tickets/${ticket.tokenId}/pass/${o.mode}`}
                    className={`flex min-h-16 items-center gap-3 rounded-[16px] border p-3 hover:border-muted ${o.recommended ? 'border-lime/40' : 'border-line'}`}
                  >
                    {inner}
                  </Link>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

const HISTORY_LABEL = {
  minted: 'Won in the draw',
  reassigned: 'From the waitlist',
  gift: 'Gifted',
  sale_public: 'Sold (public)',
  sale_private: 'Sold (private)',
  returned: 'Returned to pool',
}

function TicketHistory({ tokenId }) {
  const [rows, setRows] = useState(null)
  useEffect(() => {
    api(`/tickets/${tokenId}/history`)
      .then((r) => setRows(r.history))
      .catch(() => setRows([]))
  }, [tokenId])
  if (!rows?.length) return null
  return (
    <Card className="mt-6">
      <h2 className="text-lg">Ticket history</h2>
      <ol className="mt-3 space-y-3">
        {rows.map((h, i) => (
          <li key={i} className="flex gap-3 text-sm">
            <span className="mt-1.5 size-2 shrink-0 rounded-full bg-lime" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">
                {HISTORY_LABEL[h.kind] || h.kind}
                {h.kind === 'minted' && h.priceInr != null && ` · face ${inr(h.priceInr)}`}
                {(h.kind === 'sale_public' || h.kind === 'sale_private') && ` · ${inr(h.priceInr)}`}
              </p>
              <p className="text-muted">
                {h.from && `${h.from} → `}
                {h.to || (h.kind === 'returned' ? 'pool' : '')} · {new Date(h.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
              </p>
              {h.tx && <TxLink href={h.tx}>Quaiscan</TxLink>}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  )
}
