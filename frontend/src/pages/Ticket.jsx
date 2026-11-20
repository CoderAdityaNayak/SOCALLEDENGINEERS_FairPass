// A ticket with a rotating QR gate pass (new signed code every 30 s).
import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { QRCodeSVG } from 'qrcode.react'
import { api } from '../lib/api.js'
import { dateLong } from '../lib/format.js'
import { ErrorNote, Spinner } from '../components/ui.jsx'
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

  useEffect(() => {
    api('/me/tickets')
      .then((d) => {
        const t = d.tickets.find((x) => String(x.tokenId) === tokenId)
        if (!t) throw new Error('This ticket is not in your account')
        setTicket(t)
      })
      .catch(setError)
  }, [tokenId])

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

      {active && ticket.status !== 'listed' && (
        <Link to={`/tickets/${ticket.tokenId}/resale`} className="mt-5 flex min-h-12 items-center justify-center gap-2 rounded-[14px] border border-line font-semibold hover:border-muted">
          Can't go?
        </Link>
      )}
      {ticket.status === 'listed' && (
        <Link to={`/tickets/${ticket.tokenId}/resale`} className="mt-5 flex min-h-12 items-center justify-center rounded-[14px] border border-line font-semibold">
          Listed for {ticket.listedPrice} QUAI · manage
        </Link>
      )}
    </div>
  )
}
