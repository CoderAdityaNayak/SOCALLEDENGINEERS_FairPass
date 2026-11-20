// My tickets and lottery entries.
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { api } from '../lib/api.js'
import { dateShort, inr } from '../lib/format.js'
import { Badge, Card, Empty, ErrorNote, PageTitle, Spinner, TxLink } from '../components/ui.jsx'
import * as I from '../components/Icons.jsx'

const STATUS = {
  active: ['lime', 'Ready'],
  listed: ['muted', 'Listed for resale'],
  used: ['muted', 'Used'],
  returned: ['muted', 'Returned'],
}

export default function MyTickets() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    const load = () => api('/me/tickets').then(setData).catch(setError)
    load()
    const t = setInterval(load, 10000) // a waitlisted fan sees a reassigned ticket appear
    return () => clearInterval(t)
  }, [])

  if (error) return <ErrorNote error={error} />
  if (!data)
    return (
      <div className="grid place-items-center py-20 text-muted">
        <Spinner />
      </div>
    )

  return (
    <div className="mx-auto max-w-md">
      <PageTitle sub={<TxLink href={data.wallet}>Your Quai wallet</TxLink>}>My tickets</PageTitle>

      {data.tickets.length === 0 ? (
        <Empty title="No tickets yet">
          {data.entries.some((e) => e.status === 'entered')
            ? "You're in the draw. Tickets appear here if you win."
            : data.entries.some((e) => ['waitlist', 'partial'].includes(e.status))
              ? "You're on the waitlist. If someone returns a ticket, it comes here."
              : 'Enter a lottery to get a chance at tickets.'}
        </Empty>
      ) : (
        <ul className="space-y-3">
          {data.tickets.map((t) => {
            const [tone, label] = t.listingInvalid ? ['err', 'Listing invalid'] : STATUS[t.status] || STATUS.active
            return (
              <li key={t.tokenId}>
                <Link to={`/tickets/${t.tokenId}`} className="block rounded-[20px] border border-line bg-card p-4 hover:border-muted">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-display text-lg">{t.event.name}</p>
                      <p className="text-sm text-muted">
                        {dateShort(t.event.date)} · Block {t.block}, Row {t.row}, Seat {t.seatNumber}
                      </p>
                    </div>
                    <Badge tone={tone}>{label}</Badge>
                  </div>
                  <div className="mt-3 flex items-center justify-between text-sm text-muted">
                    <span>
                      Token #{t.tokenId}
                      {t.status === 'listed' && t.listedPriceInr ? ` · listed at ${inr(t.listedPriceInr)}` : ''}
                    </span>
                    <span className={`flex items-center gap-1 ${t.ownedOnChain ? 'text-lime' : 'text-err-soft'}`}>
                      {t.ownedOnChain ? <I.Check size={14} /> : <I.Alert size={14} />}
                      {t.ownedOnChain ? 'On-chain' : 'Not confirmed'}
                    </span>
                  </div>
                  {t.listingInvalid && (
                    <p role="alert" className="mt-3 flex gap-2 rounded-[12px] border border-err/50 bg-err/10 p-3 text-sm text-err-soft">
                      <I.Alert size={16} className="mt-0.5 shrink-0" />
                      The organiser lowered the resale cap to +{t.resaleCapPct}% (max {inr(t.maxResalePriceInr)}). Your listing at{' '}
                      {inr(t.listedPriceInr)} is invalid and can't be bought. Open the ticket to cancel and relist.
                    </p>
                  )}
                </Link>
              </li>
            )
          })}
        </ul>
      )}

      {data.entries.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-lg">Lottery entries</h2>
          <ul className="space-y-2">
            {data.entries.map((e) => (
              <li key={e.id}>
                <Card className="flex items-center justify-between p-4">
                  <div>
                    <p className="font-semibold">{e.eventName}</p>
                    <p className="text-sm text-muted">
                      {e.entryNumber ? `Entry #${e.entryNumber} · ` : ''}
                      {e.status === 'entered' ? `${e.quantity} ticket${e.quantity > 1 ? 's' : ''} requested` : `${e.ticketsWon} of ${e.quantity} ticket${e.quantity > 1 ? 's' : ''}`}
                      {e.drawRank ? ` · draw rank #${e.drawRank}` : ''}
                    </p>
                  </div>
                  <Badge tone={['won', 'partial'].includes(e.status) ? 'lime' : 'muted'}>
                    {{ entered: 'In the draw', won: 'Won', partial: 'Partly won', waitlist: 'Waitlist', lost: 'Not picked' }[e.status]}
                  </Badge>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
