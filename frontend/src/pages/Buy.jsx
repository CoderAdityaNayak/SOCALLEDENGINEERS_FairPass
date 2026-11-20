// Buy a resale ticket: /buy/:listingId (from the marketplace or a private share link).
// Confirm -> anti-bot puzzle (x402 Work, same as lottery entry) -> "Ticket is yours".
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { api, API_URL, authHeaders } from '../lib/api.js'
import { useSession } from '../lib/session.jsx'
import { payWithWork } from '../lib/x402work.js'
import { dateLong, inr, num, quai } from '../lib/format.js'
import { Badge, Button, Card, ErrorNote, Spinner, TxLink } from '../components/ui.jsx'
import * as I from '../components/Icons.jsx'

export default function Buy() {
  const { listingId } = useParams()
  const { user } = useSession()
  const [listing, setListing] = useState(null)
  const [error, setError] = useState(null)
  const [phase, setPhase] = useState('confirm') // confirm | solving | buying | done
  const [progress, setProgress] = useState({ guesses: 0, expected: 0 })
  const [result, setResult] = useState(null)

  useEffect(() => {
    api(`/listings/${listingId}`)
      .then((r) => setListing(r.listing))
      .catch(setError)
  }, [listingId, user])

  async function buy() {
    setError(null)
    setPhase('solving')
    try {
      const r = await payWithWork(
        `${API_URL}/listings/${listingId}/buy`,
        {},
        {
          headers: authHeaders(),
          onChallenge: (offer) => setProgress({ guesses: 0, expected: Number(offer.amount) }),
          onProgress: (guesses, expected) => {
            setProgress({ guesses, expected })
          },
        },
      )
      if (r.response.status !== 201) {
        const err = new Error(r.data?.error || `Purchase failed (${r.response.status})`)
        err.reason = r.data?.reason
        throw err
      }
      setResult(r.data)
      setPhase('done')
    } catch (err) {
      setError(err)
      setPhase('confirm')
    }
  }

  if (!user)
    return (
      <div className="mx-auto max-w-md">
        <Card className="text-center">
          <p className="font-display text-xl">Log in to see this offer</p>
          <p className="mt-1 text-muted">Use the phone number the seller entered.</p>
          <Link to={`/login?next=/buy/${listingId}`} className="mt-4 inline-flex min-h-12 items-center rounded-[14px] bg-lime px-5 font-semibold text-lime-ink">
            Log in
          </Link>
        </Card>
      </div>
    )
  if (!listing)
    return error ? (
      <div className="mx-auto max-w-md">
        <ErrorNote error={error} />
      </div>
    ) : (
      <div className="grid place-items-center py-20 text-muted">
        <Spinner />
      </div>
    )

  if (phase === 'done')
    return (
      <div className="mx-auto max-w-md text-center">
        <div className="mx-auto mb-4 grid size-20 place-items-center rounded-full bg-lime text-lime-ink animate-pop">
          <I.Check size={40} strokeWidth={3} />
        </div>
        <h1 className="text-3xl">Ticket is yours</h1>
        <p className="mt-2 text-muted">
          {listing.event.name} · Block {listing.block}, Row {listing.row}, Seat {listing.seatNumber}. Bought from {listing.sellerName} for{' '}
          {inr(listing.priceInr)}.
        </p>
        <Card className="mt-6 text-left">
          <p className="flex items-center gap-2 text-sm">
            <I.Check size={16} className="text-lime" /> Paid and transferred on Quai. The seller's QR code no longer works.
          </p>
          <TxLink href={result.tx} className="ml-6 mt-1" />
        </Card>
        <Link
          to={`/tickets/${listing.tokenId}`}
          className="mt-6 inline-flex min-h-12 items-center gap-2 rounded-[14px] bg-lime px-5 font-semibold text-lime-ink"
        >
          Show my ticket <I.ArrowRight size={18} />
        </Link>
      </div>
    )

  const pct = progress.expected ? Math.min(95, (progress.guesses / progress.expected) * 100) : 5
  return (
    <div className="mx-auto max-w-md">
      <Link to={`/events/${listing.eventId}`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <I.ArrowLeft size={16} /> {listing.event.name}
      </Link>
      <h1 className="text-3xl">{listing.visibility === 'private' ? 'A ticket for you' : 'Buy resale ticket'}</h1>
      {listing.visibility === 'private' && (
        <p className="mt-1 text-muted">{listing.sellerName} is offering this ticket to you only.</p>
      )}

      <Card className="mt-5">
        <p className="text-sm text-muted">{listing.event.artist}</p>
        <p className="font-display text-2xl">{listing.event.name}</p>
        <p className="text-sm text-muted">
          {dateLong(listing.event.date)}
          {listing.event.venue ? ` · ${listing.event.venue}` : ''}
        </p>
        <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
          {[
            ['Block', listing.block],
            ['Row', listing.row],
            ['Seat', listing.seatNumber],
          ].map(([k, v]) => (
            <div key={k} className="rounded-[12px] bg-bg py-2">
              <dt className="text-xs uppercase text-muted">{k}</dt>
              <dd className="font-display text-xl">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-4 flex items-end justify-between">
          <div>
            <p className="font-display text-3xl">{inr(listing.priceInr)}</p>
            <p className="text-xs text-muted">
              {quai(listing.price)} · face {inr(listing.faceInr)} · +{listing.markupPct}% over face
            </p>
          </div>
          <Badge tone="lime">
            <I.Shield size={12} /> Verified fan
          </Badge>
        </div>
      </Card>

      {phase === 'solving' && (
        <Card className="mt-4">
          <p className="flex items-center gap-2 font-semibold">
            <Spinner size={16} /> Solving anti-bot puzzle…
          </p>
          <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-bg" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Puzzle progress">
            <div className="h-full rounded-full bg-lime transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-1.5 text-xs text-muted">
            {progress.expected ? `${num(progress.guesses)} SHA-256 guesses (about ${num(progress.expected)} expected), then paying on Quai (about 30 s)` : 'Fetching a puzzle…'}
          </p>
        </Card>
      )}

      <ErrorNote error={error} className="mt-4" />

      {phase === 'confirm' &&
        (listing.canBuy ? (
          <Button className="mt-5 w-full" onClick={buy}>
            Buy for {inr(listing.priceInr)}
          </Button>
        ) : (
          <Card className="mt-5 text-sm text-muted">{listing.cannotBuyMessage}</Card>
        ))}
      <p className="mt-3 text-center text-xs text-muted">
        Paid from your FairPass wallet. Resale is capped by the organiser; the seller can't charge more.
      </p>
    </div>
  )
}
