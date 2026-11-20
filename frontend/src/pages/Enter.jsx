// Enter the lottery: live checklist + real x402 Work puzzle solved in a Web Worker.
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { api, API_URL, authHeaders } from '../lib/api.js'
import { useSession } from '../lib/session.jsx'
import { payWithWork } from '../lib/x402work.js'
import { num, timeShort } from '../lib/format.js'
import { Button, Card, ErrorNote, Spinner } from '../components/ui.jsx'
import * as I from '../components/Icons.jsx'

function Step({ state, title, children }) {
  const icon =
    state === 'done' ? (
      <span className="grid size-8 place-items-center rounded-full bg-lime text-lime-ink">
        <I.Check size={18} strokeWidth={3} />
      </span>
    ) : state === 'active' ? (
      <span className="grid size-8 place-items-center rounded-full border-2 border-lime text-lime">
        <Spinner size={16} />
      </span>
    ) : state === 'error' ? (
      <span className="grid size-8 place-items-center rounded-full bg-err text-white">
        <I.X size={18} strokeWidth={3} />
      </span>
    ) : (
      <span className="block size-8 rounded-full border-2 border-line" />
    )
  return (
    <li className="flex gap-4 py-3">
      <span className="shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className={`font-semibold ${state === 'pending' ? 'text-muted' : ''}`}>{title}</p>
        {children}
      </div>
    </li>
  )
}

export default function Enter() {
  const { eventId } = useParams()
  const { user } = useSession()
  const [event, setEvent] = useState(null)
  const [quantity, setQuantity] = useState(1)
  const [phase, setPhase] = useState('ready') // ready | solving | sending | done | error
  const [progress, setProgress] = useState({ guesses: 0, expected: 0 })
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    api(`/events/${eventId}`)
      .then((r) => {
        setEvent(r.event)
        if (r.myEntry) {
          setResult({ entry: { ...r.myEntry, entryNumber: null }, existing: true })
          setPhase('done')
        }
      })
      .catch(setError)
  }, [eventId])

  async function start() {
    setPhase('solving')
    setError(null)
    setProgress({ guesses: 0, expected: 0 })
    try {
      const r = await payWithWork(
        `${API_URL}/events/${eventId}/enter`,
        { quantity },
        {
          headers: authHeaders(),
          onChallenge: (offer) => setProgress({ guesses: 0, expected: Number(offer.amount) }),
          onProgress: (guesses, expected) => setProgress({ guesses, expected }),
        },
      )
      if (r.response.status !== 201) {
        const err = new Error(r.data?.error || `Entry failed (${r.response.status})`)
        err.reason = r.data?.reason
        throw err
      }
      setResult({ ...r.data, payment: r.payment })
      setPhase('done')
    } catch (err) {
      setError(err)
      setPhase('error')
    }
  }

  if (!event)
    return error ? (
      <ErrorNote error={error} />
    ) : (
      <div className="grid place-items-center py-20 text-muted">
        <Spinner />
      </div>
    )

  const pct = progress.expected ? Math.min(95, (progress.guesses / progress.expected) * 100) : 5
  const puzzleState = phase === 'done' ? 'done' : phase === 'solving' ? 'active' : phase === 'error' ? 'error' : 'pending'

  return (
    <div className="mx-auto max-w-md">
      <Link to="/" className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <I.ArrowLeft size={16} /> {event.name}
      </Link>
      <h1 className="text-3xl">{phase === 'done' ? "You're in the draw" : 'Enter the lottery'}</h1>

      {phase === 'ready' && (
        <Card className="mt-5">
          <p className="mb-3 font-semibold">How many tickets?</p>
          <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-label="Number of tickets">
            {[1, 2].map((q) => (
              <button
                key={q}
                role="radio"
                aria-checked={quantity === q}
                onClick={() => setQuantity(q)}
                className={`min-h-14 rounded-[14px] border-2 font-display text-xl ${quantity === q ? 'border-lime bg-lime/10 text-lime' : 'border-line text-muted'}`}
              >
                {q} ticket{q > 1 ? 's' : ''}
              </button>
            ))}
          </div>
          <p className="mt-3 text-sm text-muted">Max 2 per verified ID. You pay only if you win.</p>
        </Card>
      )}

      <Card className="mt-4">
        <ol aria-live="polite">
          <Step state="done" title="Phone verified">
            <p className="text-sm text-muted">{user.phone}</p>
          </Step>
          <Step state={user.isVerified ? 'done' : 'error'} title="ID verified">
            {user.isVerified ? (
              <p className="text-sm text-muted">{user.name} · one entry per ID</p>
            ) : (
              <Link to={`/login?next=/enter/${eventId}`} className="text-sm text-lime">
                Verify your ID first
              </Link>
            )}
          </Step>
          <Step state={puzzleState} title={phase === 'done' ? 'Anti-bot puzzle solved' : 'Solving anti-bot puzzle…'}>
            {(phase === 'solving' || phase === 'error') && (
              <div className="mt-2">
                <div className="h-2.5 overflow-hidden rounded-full bg-bg" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Puzzle progress">
                  <div className="h-full rounded-full bg-lime transition-all" style={{ width: `${pct}%` }} />
                </div>
                <p className="mt-1.5 text-xs text-muted">
                  {progress.expected ? `${num(progress.guesses)} SHA-256 guesses (about ${num(progress.expected)} expected)` : 'Fetching a puzzle…'}
                </p>
              </div>
            )}
            {phase === 'done' && result?.payment && (
              <p className="text-sm text-muted">
                {num(result.payment.guesses)} guesses in {(result.payment.milliseconds / 1000).toFixed(1)}s · x402 Work ({result.payment.network})
              </p>
            )}
          </Step>
          <Step state={phase === 'done' ? 'done' : 'pending'} title="Entry confirmed" />
        </ol>
      </Card>

      <ErrorNote error={error} className="mt-4" />

      {phase === 'done' && result && (
        <Card className="mt-4 text-center animate-pop">
          {result.entry.entryNumber ? (
            <>
              <p className="text-sm text-muted">Your entry number</p>
              <p className="font-display text-6xl text-lime">#{result.entry.entryNumber}</p>
            </>
          ) : (
            <p className="font-display text-xl">You already entered this lottery</p>
          )}
          <p className="mt-3 text-muted">
            Draw on <span className="text-ink">{timeShort(event.lotteryClose)}</span>
          </p>
          <p className="mt-2 text-sm text-muted">
            Not picked? You join the waitlist in draw order. Returned tickets go to the waitlist first, at face price.
          </p>
          <Link to="/" className="mt-4 inline-flex min-h-12 items-center justify-center rounded-[14px] border border-line px-5 font-semibold">
            Back to event
          </Link>
        </Card>
      )}

      {(phase === 'ready' || phase === 'error') && (
        <Button className="mt-5 w-full" onClick={start} disabled={!user.isVerified}>
          {phase === 'error' ? 'Try again' : `Enter with ${quantity} ticket${quantity > 1 ? 's' : ''}`}
        </Button>
      )}

      <Card className="mt-5 flex gap-3 p-4">
        <I.Cpu size={22} className="shrink-0 text-lime" />
        <div className="text-sm text-muted">
          <p className="font-semibold text-ink">Why the puzzle stops bots</p>
          <p className="mt-1">
            Your phone makes about {num(event.antiBot?.guesses)} SHA-256 guesses: about a second for you. A bot farm sending a million
            entries needs {num((event.antiBot?.guesses || 0) / 1000)} billion guesses, and a million real verified IDs. Bots that skip the
            puzzle are rejected before they reach the draw.
          </p>
        </div>
      </Card>
    </div>
  )
}
