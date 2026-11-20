// Can't go? Return to pool (recommended) or list it yourself under the cap.
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { api } from '../lib/api.js'
import { quai } from '../lib/format.js'
import { Badge, Button, Card, ErrorNote, Spinner, TxLink } from '../components/ui.jsx'
import * as I from '../components/Icons.jsx'

export default function Resale() {
  const { tokenId } = useParams()
  const [ticket, setTicket] = useState(null)
  const [price, setPrice] = useState('')
  const [busy, setBusy] = useState(null) // 'return' | 'list' | 'cancel'
  const [done, setDone] = useState(null)
  const [reassign, setReassign] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    api('/me/tickets')
      .then((d) => {
        const t = d.tickets.find((x) => String(x.tokenId) === tokenId)
        if (!t) throw new Error('This ticket is not in your account')
        setTicket(t)
        setPrice(t.maxResalePrice)
      })
      .catch(setError)
  }, [tokenId])

  // After a return, follow the ticket to the waitlisted fan.
  useEffect(() => {
    if (done?.kind !== 'return') return
    const t = setInterval(async () => {
      const r = await api(`/tickets/${tokenId}/reassignment`).catch(() => null)
      if (r?.reassignment) setReassign(r.reassignment)
      if (['reassigned', 'pooled', 'failed'].includes(r?.reassignment?.state)) clearInterval(t)
    }, 3000)
    return () => clearInterval(t)
  }, [done, tokenId])

  async function act(kind, fn) {
    setBusy(kind)
    setError(null)
    try {
      setDone({ kind, ...(await fn()) })
    } catch (err) {
      setError(err)
    } finally {
      setBusy(null)
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

  const max = Number(ticket.maxResalePrice)
  const value = Number(price)
  const over = price !== '' && value > max
  const invalid = price === '' || !(value > 0)
  const capPct = Math.round((max / Number(ticket.facePrice) - 1) * 100)

  if (done?.kind === 'return')
    return (
      <div className="mx-auto max-w-md text-center">
        <div className="mx-auto mb-4 grid size-20 place-items-center rounded-full bg-lime text-lime-ink animate-pop">
          <I.Check size={40} strokeWidth={3} />
        </div>
        <h1 className="text-3xl">Ticket returned</h1>
        <p className="mt-2 text-muted">
          {done.refund?.amount} QUAI face price refunded to you (mock payment). The ticket goes to the next fan on the waitlist, at face price.
        </p>
        <Card className="mt-6 text-left">
          <p className="flex items-center gap-2 text-sm">
            <I.Check size={16} className="text-lime" /> Returned to the pool on Quai
          </p>
          <TxLink href={done.tx} className="ml-6" />
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
        <Link to="/tickets" className="mt-6 inline-flex min-h-12 items-center rounded-[14px] border border-line px-5 font-semibold">
          My tickets
        </Link>
      </div>
    )

  return (
    <div className="mx-auto max-w-md">
      <Link to={`/tickets/${tokenId}`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <I.ArrowLeft size={16} /> Ticket #{tokenId}
      </Link>
      <h1 className="text-3xl">Can't go?</h1>
      <p className="mt-1 text-muted">Pass it on fairly. Tickets can't move outside FairPass.</p>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <Card className="p-4">
          <p className="text-sm text-muted">You paid</p>
          <p className="mt-1 font-display text-2xl">{quai(ticket.facePrice)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-sm text-muted">Max resale (+{capPct}%)</p>
          <p className="mt-1 font-display text-2xl">{quai(ticket.maxResalePrice)}</p>
        </Card>
      </div>

      <Card className="mt-4 border-lime/40">
        <div className="flex items-start justify-between gap-3">
          <div className="flex gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-lime/15 text-lime">
              <I.Undo size={20} />
            </span>
            <div>
              <p className="font-display text-lg">Return to pool</p>
              <p className="mt-1 text-sm text-muted">Get the full face price back. The ticket goes to the next fan on the waitlist, so no one can buy it to scalp.</p>
            </div>
          </div>
          <Badge tone="lime">Recommended</Badge>
        </div>
        <Button
          className="mt-4 w-full"
          loading={busy === 'return'}
          disabled={!!busy}
          onClick={() => act('return', () => api(`/tickets/${tokenId}/return`, { method: 'POST' }))}
        >
          {busy === 'return' ? 'Returning on Quai (about 30 s)…' : `Return for ${quai(ticket.facePrice)}`}
        </Button>
      </Card>

      {ticket.corporate ? (
        <Card className="mt-4 flex gap-3 text-sm text-muted">
          <I.Building size={20} className="shrink-0" /> Corporate tickets can't be resold, only returned to the pool.
        </Card>
      ) : ticket.status === 'listed' || done?.kind === 'list' ? (
        <Card className="mt-4">
          <p className="font-display text-lg">Listed for {done?.ticket?.listedPrice || ticket.listedPrice} QUAI</p>
          <p className="mt-1 text-sm text-muted">Buyers pay through the contract. You get the price minus a 2% organiser royalty.</p>
          {done?.tx && <TxLink href={done.tx} className="mt-2" />}
          <Button
            variant="secondary"
            className="mt-4 w-full"
            loading={busy === 'cancel'}
            disabled={!!busy}
            onClick={() => act('cancel', () => api(`/tickets/${tokenId}/cancel`, { method: 'POST' }).then(() => setTicket({ ...ticket, status: 'active' })))}
          >
            Cancel listing
          </Button>
        </Card>
      ) : (
        <Card className="mt-4">
          <p className="font-display text-lg">Or list it yourself</p>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (!over && !invalid) act('list', () => api(`/tickets/${tokenId}/list`, { method: 'POST', body: { price } }))
            }}
          >
            <label htmlFor="price" className="mb-1.5 mt-3 block text-sm font-medium text-muted">
              Your price (QUAI)
            </label>
            <input
              id="price"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ''))}
              aria-invalid={over}
              aria-describedby="price-msg"
              className={`min-h-12 w-full rounded-[14px] border bg-bg px-4 font-display text-xl focus:outline-none ${over ? 'border-err-soft text-err-soft' : 'border-line focus:border-lime'}`}
            />
            <p id="price-msg" role={over ? 'alert' : undefined} className={`mt-1.5 text-sm ${over ? 'text-err-soft' : 'text-muted'}`}>
              {over ? 'Above the cap. The FairPass contract will reject this price.' : `Up to ${quai(ticket.maxResalePrice)}`}
            </p>
            <Button type="submit" variant="secondary" className="mt-4 w-full" loading={busy === 'list'} disabled={over || invalid || !!busy}>
              {busy === 'list' ? 'Listing on Quai (about 30 s)…' : 'List for resale'}
            </Button>
          </form>
        </Card>
      )}

      <ErrorNote error={error} className="mt-4" />
    </div>
  )
}
