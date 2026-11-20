// An event's public resale listings, cheapest first, live (re-fetched whenever Firestore sees a change).
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { api } from '../lib/api.js'
import { inr, quai } from '../lib/format.js'
import { useListingsTick } from '../lib/liveEvent.js'
import { Badge, Card, ErrorNote, Spinner, useCountdown } from './ui.jsx'
import * as I from './Icons.jsx'

function OpensIn({ at }) {
  const c = useCountdown(at)
  return (
    <span className="tabular-nums">
      {c.m}:{String(c.s).padStart(2, '0')}
    </span>
  )
}

export default function Marketplace({ eventId }) {
  const tick = useListingsTick(eventId)
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    api(`/events/${eventId}/marketplace`)
      .then(setData)
      .catch(setError)
  }, [eventId, tick])
  // Re-check once a second while any listing is still waitlist-only, so it opens up on time.
  useEffect(() => {
    if (!data?.listings.some((l) => l.priorityOnly)) return
    const next = Math.min(...data.listings.filter((l) => l.priorityOnly).map((l) => Date.parse(l.openToAllAt)))
    const t = setTimeout(() => api(`/events/${eventId}/marketplace`).then(setData).catch(() => {}), Math.max(1000, next - Date.now() + 500))
    return () => clearTimeout(t)
  }, [data, eventId])

  if (error) return <ErrorNote error={error} />
  if (!data)
    return (
      <div className="grid place-items-center py-10 text-muted">
        <Spinner />
      </div>
    )

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Resale tickets, capped by the organiser. Waitlisted fans get first pick for 10 minutes on each new listing.
        {data.viewerWaitlisted && <span className="text-lime"> You're on the waitlist: you can buy right away.</span>}
      </p>
      {data.locked && <Card className="border-err/50 bg-err/10 text-sm text-err-soft">Transfers are locked in the last 24 hours before the show.</Card>}
      {data.listings.length === 0 ? (
        <Card className="py-8 text-center text-muted">No tickets for resale right now. Listings appear here live.</Card>
      ) : (
        <ul className="space-y-3" aria-live="polite">
          {data.listings.map((l) => (
            <li key={l.id}>
              <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div>
                  <p className="font-display text-2xl">{inr(l.priceInr)}</p>
                  <p className="text-xs text-muted">
                    {quai(l.price)} · +{l.markupPct}% over face
                  </p>
                  <p className="mt-1 text-sm">
                    Block {l.block}, Row {l.row}, Seat {l.seatNumber}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <Badge tone="lime">
                      <I.Shield size={12} /> Verified fan
                    </Badge>
                    {l.priorityOnly && (
                      <Badge>
                        Waitlist priority — open to all in <OpensIn at={l.openToAllAt} />
                      </Badge>
                    )}
                  </div>
                </div>
                {l.canBuy ? (
                  <Link to={`/buy/${l.id}`} className="inline-flex min-h-12 items-center gap-2 rounded-[14px] bg-lime px-5 font-semibold text-lime-ink">
                    Buy <I.ArrowRight size={18} />
                  </Link>
                ) : (
                  <span className="max-w-[12rem] text-right text-xs text-muted">{l.cannotBuyMessage}</span>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
