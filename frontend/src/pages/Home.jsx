// Event page: poster, price, lottery countdown, "how this sale is fair" (live resale cap), enter button.
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { api } from '../lib/api.js'
import { useSession } from '../lib/session.jsx'
import { dateLong, inr } from '../lib/format.js'
import { useLiveEvent } from '../lib/liveEvent.js'
import { Badge, Card, Countdown, ErrorNote, Spinner, TxLink } from '../components/ui.jsx'
import * as I from '../components/Icons.jsx'

function Poster({ event }) {
  return (
    <div className="relative overflow-hidden rounded-[22px] bg-lime p-6 text-lime-ink">
      <svg className="absolute -right-10 -top-10 opacity-15" width="220" height="220" viewBox="0 0 220 220" aria-hidden="true">
        <circle cx="110" cy="110" r="100" stroke="currentColor" strokeWidth="2" fill="none" />
        <circle cx="110" cy="110" r="70" stroke="currentColor" strokeWidth="2" fill="none" />
        <circle cx="110" cy="110" r="40" stroke="currentColor" strokeWidth="2" fill="none" />
      </svg>
      <p className="text-sm font-semibold uppercase tracking-widest opacity-70">{event.artist || 'Live'}</p>
      <h1 className="mt-2 font-display text-4xl leading-none sm:text-5xl">{event.name}</h1>
      <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm font-medium">
        <span className="flex items-center gap-1.5">
          <I.Clock size={16} /> {dateLong(event.date)}
        </span>
        {(event.venue || event.city) && (
          <span className="flex items-center gap-1.5">
            <I.Home size={16} /> {[event.venue, event.city].filter(Boolean).join(', ')}
          </span>
        )}
      </div>
    </div>
  )
}

const ENTRY_TEXT = { entered: "You're in the draw", won: 'You won', partial: 'You won some tickets', waitlist: 'On the waitlist', lost: 'Not picked' }

export default function Home() {
  const { user } = useSession()
  const [featuredId, setFeaturedId] = useState(null)
  const [listError, setListError] = useState(null)

  useEffect(() => {
    api('/events')
      .then(({ events }) => setFeaturedId((events.find((e) => e.lotteryStatus === 'open') || events[0])?.id ?? 0))
      .catch(setListError)
  }, [])

  const { event, myEntry, error } = useLiveEvent(featuredId || null, { withEntry: !!user })

  if (listError || error) return <ErrorNote error={listError || error} />
  if (featuredId === 0) return <p className="py-20 text-center text-muted">No events yet.</p>
  if (!event)
    return (
      <div className="grid place-items-center py-20 text-muted">
        <Spinner />
      </div>
    )

  const open = event.lotteryStatus === 'open'
  const entryHref = user ? `/enter/${event.id}` : `/login?next=/enter/${event.id}`
  const fair = [
    { icon: I.Shuffle, title: 'Random draw, not a race', text: 'Everyone who enters before the deadline has the same chance. Being fast (or a bot) gives no edge.' },
    {
      icon: I.Users,
      title: 'One entry per verified person',
      text: 'Choose how many tickets you want, but each verified ID can enter only once, and every entry solves an anti-bot puzzle.',
    },
    {
      icon: I.Percent,
      title: `Resale capped at face + ${event.resaleCapPct}%`,
      text: `Tickets can only be resold through the FairPass contract, never above ${inr(event.maxResalePriceInr)}. The organiser sets this limit on-chain.`,
    },
  ]

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <Poster event={event} />

      <div className="grid grid-cols-2 gap-3">
        <Card className="p-4">
          <p className="text-sm text-muted">Face price</p>
          <p className="mt-1 font-display text-2xl">{inr(event.facePriceInr)}</p>
          <p className="mt-1 text-xs text-muted" aria-live="polite">
            Resale max {inr(event.maxResalePriceInr)} (+{event.resaleCapPct}%)
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-sm text-muted">Lottery</p>
          <p className="mt-1 font-display text-2xl capitalize">{event.lotteryStatus}</p>
          <p className="mt-1 text-xs text-muted">
            {event.entries} entries · {event.lotteryTickets} tickets
          </p>
        </Card>
      </div>

      {open && (
        <Card className="p-4">
          <p className="mb-3 flex items-center gap-2 text-sm text-muted">
            <I.Clock size={16} /> Lottery closes in
          </p>
          <Countdown to={event.lotteryClose} />
        </Card>
      )}

      {myEntry ? (
        <Card className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm text-muted">Your entry{myEntry.entryNumber ? ` #${myEntry.entryNumber}` : ''}</p>
            <p className="font-display text-xl">{ENTRY_TEXT[myEntry.status] || myEntry.status}</p>
            <p className="text-sm text-muted">
              {myEntry.status === 'entered'
                ? `${myEntry.quantity} ticket${myEntry.quantity > 1 ? 's' : ''} requested`
                : `${myEntry.ticketsWon} of ${myEntry.quantity} ticket${myEntry.quantity > 1 ? 's' : ''}`}
              {myEntry.drawRank ? ` · draw rank #${myEntry.drawRank}` : ''}
            </p>
          </div>
          {['won', 'partial'].includes(myEntry.status) ? (
            <Link to="/tickets" className="rounded-[14px] bg-lime px-4 py-3 font-semibold text-lime-ink">
              My tickets
            </Link>
          ) : (
            <Badge tone={myEntry.status === 'waitlist' ? 'muted' : 'lime'}>{myEntry.status === 'waitlist' ? 'Waitlist' : 'Entered'}</Badge>
          )}
        </Card>
      ) : (
        open && (
          <div>
            <Link to={entryHref} className="flex min-h-14 w-full items-center justify-center gap-2 rounded-[16px] bg-lime text-lg font-semibold text-lime-ink hover:brightness-105">
              Enter lottery <I.ArrowRight size={20} />
            </Link>
            <p className="mt-2 text-center text-sm text-muted">Free to enter · pay only if you win</p>
          </div>
        )
      )}

      <section aria-labelledby="fair-title" className="pt-4">
        <h2 id="fair-title" className="mb-3 text-xl">
          How this sale is fair
        </h2>
        <div className="space-y-3">
          {fair.map((f) => (
            <Card key={f.title} className="flex gap-4 p-4">
              <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-lime/15 text-lime">
                <f.icon size={20} />
              </span>
              <div>
                <p className="font-semibold">{f.title}</p>
                <p className="mt-0.5 text-sm text-muted">{f.text}</p>
              </div>
            </Card>
          ))}
        </div>
      </section>

      <Card className="p-4 text-sm text-muted">
        <p className="flex items-center gap-2">
          <I.Shield size={16} className="text-lime" /> Tickets are NFTs on Quai Network. A ticket that isn't on-chain is fake.
        </p>
        <p className="mt-2 break-all text-xs">
          Draw commitment sha256(seed): <span className="font-mono text-ink">{event.seedHash}</span>
        </p>
        <TxLink href={event.contract} className="mt-2">
          FairPass contract on Quaiscan
        </TxLink>
      </Card>
    </div>
  )
}
