// Event page: poster, price, lottery countdown, "how this sale is fair", enter button.
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { api } from '../lib/api.js'
import { useSession } from '../lib/session.jsx'
import { dateLong, quai } from '../lib/format.js'
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

const FAIR = [
  { icon: I.Shuffle, title: 'Random draw, not a race', text: 'Everyone who enters before the deadline has the same chance. Being fast (or a bot) gives no edge.' },
  { icon: I.Users, title: '2 tickets per verified ID', text: 'One ID, one entry. Bots would need a real ID for every entry, plus a proof-of-work puzzle.' },
  { icon: I.Percent, title: 'Resale capped at +10%', text: 'Tickets can only be resold through the FairPass contract, never above face price + 10%.' },
]

export default function Home() {
  const { user } = useSession()
  const [state, setState] = useState({ loading: true })

  useEffect(() => {
    let alive = true
    api('/events')
      .then(async ({ events }) => {
        const featured = events.find((e) => e.lotteryStatus === 'open') || events[0]
        const detail = featured ? await api(`/events/${featured.id}`) : null
        if (alive) setState({ loading: false, event: detail?.event, myEntry: detail?.myEntry })
      })
      .catch((error) => alive && setState({ loading: false, error }))
    return () => {
      alive = false
    }
  }, [user])

  if (state.loading)
    return (
      <div className="grid place-items-center py-20 text-muted">
        <Spinner />
      </div>
    )
  if (state.error) return <ErrorNote error={state.error} />
  const { event, myEntry } = state
  if (!event) return <p className="py-20 text-center text-muted">No events yet.</p>

  const open = event.lotteryStatus === 'open'
  const entryHref = user ? `/enter/${event.id}` : `/login?next=/enter/${event.id}`

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <Poster event={event} />

      <div className="grid grid-cols-2 gap-3">
        <Card className="p-4">
          <p className="text-sm text-muted">Face price</p>
          <p className="mt-1 font-display text-2xl">{quai(event.facePrice)}</p>
          <p className="mt-1 text-xs text-muted">Resale max {quai(event.maxResalePrice)}</p>
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
            <p className="text-sm text-muted">Your entry</p>
            <p className="font-display text-xl capitalize">{myEntry.status === 'entered' ? "You're in the draw" : myEntry.status}</p>
            {myEntry.drawRank && <p className="text-sm text-muted">Draw rank #{myEntry.drawRank}</p>}
          </div>
          {myEntry.status === 'won' ? (
            <Link to="/tickets" className="rounded-[14px] bg-lime px-4 py-3 font-semibold text-lime-ink">
              My tickets
            </Link>
          ) : (
            <Badge tone={myEntry.status === 'waitlist' ? 'muted' : 'lime'}>{myEntry.status === 'waitlist' ? 'On waitlist' : 'Entered'}</Badge>
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
          {FAIR.map((f) => (
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
