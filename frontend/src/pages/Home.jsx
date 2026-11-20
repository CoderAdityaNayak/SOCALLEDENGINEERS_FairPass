// Home: every event as a card. Open lotteries first; tap a card for the event page, or enter straight away.
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { api } from '../lib/api.js'
import { useSession } from '../lib/session.jsx'
import { dateLong, inr } from '../lib/format.js'
import { Badge, ErrorNote, Spinner, useCountdown } from '../components/ui.jsx'
import * as I from '../components/Icons.jsx'

function TimeLeft({ to }) {
  const c = useCountdown(to)
  if (c.done) return <span>closing now</span>
  const pad = (n) => String(n).padStart(2, '0')
  return (
    <span className="tabular-nums">
      {c.d > 0 ? `${c.d}d ` : ''}
      {pad(c.h)}h {pad(c.m)}m {pad(c.s)}s
    </span>
  )
}

const ENTRY_LABEL = { entered: 'Already entered', won: 'You won', partial: 'You won some', waitlist: 'On waitlist', lost: 'Not picked' }

function EventCard({ event, signedIn }) {
  const entry = event.myEntry
  const open = event.lotteryStatus === 'open'
  const enterHref = signedIn ? `/enter/${event.id}` : `/login?next=/enter/${event.id}`
  return (
    <li className="relative flex flex-col rounded-[20px] border border-line bg-card p-5 transition hover:border-muted">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted">{event.artist || 'Live'}</p>
        {entry ? (
          <Badge tone={['won', 'partial'].includes(entry.status) ? 'lime' : 'muted'}>
            <I.Check size={12} /> {ENTRY_LABEL[entry.status] || entry.status}
          </Badge>
        ) : (
          <Badge tone={open ? 'lime' : 'muted'} className="capitalize">
            {open ? 'Lottery open' : event.lotteryStatus}
          </Badge>
        )}
      </div>
      <h2 className="mt-1 text-2xl">
        {/* The title link covers the whole card (stretched), so tapping anywhere opens the event. */}
        <Link to={`/events/${event.id}`} className="after:absolute after:inset-0 after:rounded-[20px] focus-visible:outline-none">
          {event.name}
        </Link>
      </h2>
      <div className="mt-3 space-y-1.5 text-sm text-muted">
        <p className="flex items-center gap-2">
          <I.Clock size={15} /> {dateLong(event.date)}
        </p>
        {(event.venue || event.city) && (
          <p className="flex items-center gap-2">
            <I.Home size={15} /> {[event.venue, event.city].filter(Boolean).join(', ')}
          </p>
        )}
      </div>
      <div className="mt-4 flex items-end justify-between gap-3">
        <div>
          <p className="text-xs text-muted">Face price</p>
          <p className="font-display text-2xl">{inr(event.facePriceInr)}</p>
          <p className="text-xs text-muted">resale max +{event.resaleCapPct}%</p>
        </div>
        {open && (
          <div className="text-right">
            <p className="text-xs text-muted">Lottery closes in</p>
            <p className="font-display text-lg">
              <TimeLeft to={event.lotteryClose} />
            </p>
          </div>
        )}
      </div>
      {open &&
        (entry ? (
          <button
            disabled
            className="relative z-10 mt-4 min-h-12 w-full cursor-not-allowed rounded-[14px] border border-line font-semibold text-muted"
            aria-label={`Already entered ${event.name}`}
          >
            Already entered{entry.entryNumber ? ` · #${entry.entryNumber}` : ''}
          </button>
        ) : (
          <Link
            to={enterHref}
            className="relative z-10 mt-4 flex min-h-12 items-center justify-center gap-2 rounded-[14px] bg-lime font-semibold text-lime-ink hover:brightness-105"
            aria-label={`Enter the lottery for ${event.name}`}
          >
            Enter lottery <I.ArrowRight size={18} />
          </Link>
        ))}
    </li>
  )
}

export default function Home() {
  const { user } = useSession()
  const [events, setEvents] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    const load = () =>
      api('/events')
        .then((r) => setEvents(r.events))
        .catch(setError)
    load()
    const t = setInterval(load, 15000)
    return () => clearInterval(t)
  }, [user])

  if (error) return <ErrorNote error={error} />
  if (!events)
    return (
      <div className="grid place-items-center py-20 text-muted">
        <Spinner />
      </div>
    )

  const open = events.filter((e) => e.lotteryStatus === 'open')
  const others = events.filter((e) => e.lotteryStatus !== 'open')

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-3xl">Events</h1>
      <p className="mt-1 text-muted">Pick an event and enter its lottery. One entry per verified person per event; free to enter, pay only if you win.</p>

      {open.length === 0 ? (
        <p className="mt-8 rounded-[20px] border border-line bg-card p-8 text-center text-muted">No lotteries are open right now.</p>
      ) : (
        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Open lotteries">
          {open.map((e) => (
            <EventCard key={e.id} event={e} signedIn={!!user} />
          ))}
        </ul>
      )}

      {others.length > 0 && (
        <section className="mt-10" aria-labelledby="past-title">
          <h2 id="past-title" className="text-xl">
            Draw done or closed
          </h2>
          <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {others.map((e) => (
              <EventCard key={e.id} event={e} signedIn={!!user} />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
