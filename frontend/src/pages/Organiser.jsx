// Organiser dashboard (desktop layout with sidebar): lottery, draw, bot stats, resale settings, new events, draw proof.
import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { dateLong, inr, num, quai, REASONS, sqlTime } from '../lib/format.js'
import { previewMaxInr } from '../lib/liveEvent.js'
import { Badge, Button, Card, Countdown, ErrorNote, Spinner, TxLink } from '../components/ui.jsx'
import * as I from '../components/Icons.jsx'

function Stat({ label, value, tone, icon: Icon, sub }) {
  return (
    <Card className={`p-4 ${tone === 'err' ? 'border-err/50 bg-err/10' : ''}`}>
      <div className="flex items-center justify-between text-sm text-muted">
        <span>{label}</span>
        {Icon && <Icon size={18} className={tone === 'err' ? 'text-err-soft' : 'text-lime'} />}
      </div>
      <p className={`mt-2 font-display text-3xl tabular-nums ${tone === 'err' ? 'text-err-soft' : ''}`}>{value}</p>
      {sub && <p className="mt-1 text-xs text-muted">{sub}</p>}
    </Card>
  )
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

function DrawProof({ eventId, drawn }) {
  const [proof, setProof] = useState(null)
  const [check, setCheck] = useState(null)
  useEffect(() => {
    api(`/events/${eventId}/draw-proof`).then(setProof).catch(() => {})
  }, [eventId, drawn])
  if (!proof) return null

  async function verifyHere() {
    setCheck('running')
    const commitOk = (await sha256Hex(proof.seed)) === proof.seedHash
    const keyed = await Promise.all(proof.entries.map(async (e) => ({ id: e.id, k: await sha256Hex(`${proof.seed}:${e.id}`) })))
    const order = keyed.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.id - b.id)).map((e) => e.id)
    setCheck(commitOk && JSON.stringify(order) === JSON.stringify(proof.orderedEntryIds) ? 'ok' : 'fail')
  }

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg">Draw proof</h2>
        {proof.seed ? <Badge tone="lime">Seed revealed</Badge> : <Badge>Committed</Badge>}
      </div>
      <dl className="mt-3 space-y-2 text-sm">
        <div>
          <dt className="text-muted">Commitment sha256(seed), public since the lottery opened</dt>
          <dd className="break-all font-mono text-xs">{proof.seedHash}</dd>
        </div>
        <div>
          <dt className="text-muted">Seed</dt>
          <dd className="break-all font-mono text-xs">{proof.seed || 'Secret until the draw'}</dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-muted">{proof.algorithm}</p>
      {proof.seed && (
        <>
          <div className="mt-3 flex items-center gap-3">
            <Button variant="secondary" onClick={verifyHere} loading={check === 'running'}>
              Verify in this browser
            </Button>
            {check === 'ok' && (
              <span className="flex items-center gap-1 text-sm text-lime">
                <I.Check size={16} /> Matches: the draw was not tampered with
              </span>
            )}
            {check === 'fail' && <span className="text-sm text-err-soft">Mismatch!</span>}
          </div>
          <div className="mt-4 max-h-64 overflow-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-card text-xs uppercase text-muted">
                <tr>
                  <th className="py-1">Rank</th>
                  <th className="py-1">Entry</th>
                  <th className="py-1">Won / asked</th>
                  <th className="py-1">Result</th>
                  <th className="py-1">sha256(seed:id)</th>
                </tr>
              </thead>
              <tbody>
                {proof.entries.map((e) => (
                  <tr key={e.id} className="border-t border-line">
                    <td className="py-1.5">{e.drawRank}</td>
                    <td>#{e.id}</td>
                    <td>{e.ticketsWon ?? 0} / {e.quantity}</td>
                    <td>
                      <Badge tone={e.status === 'won' ? 'lime' : 'muted'}>{e.status}</Badge>
                    </td>
                    <td className="font-mono text-xs text-muted">{e.drawKey?.slice(0, 16)}…</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  )
}

/** Firestore mirror + Quai status, with a manual resync. */
function SyncStatus({ chainEventId, minted }) {
  const [health, setHealth] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const load = useCallback(() => api('/health').then(setHealth).catch(() => setHealth(null)), [])
  useEffect(() => {
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [load])
  const f = health?.firestore
  const ok = f?.enabled && !f.pending && f.ok !== false
  async function resync() {
    setBusy(true)
    setMsg(null)
    try {
      const r = await api('/admin/firestore/resync', { method: 'POST' })
      setMsg(`Resynced: ${r.uploaded} documents uploaded, ${r.removed} removed`)
      load()
    } catch (err) {
      setMsg(err.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card className="grid gap-4 sm:grid-cols-2">
      <div>
        <p className="flex items-center gap-2 text-sm text-muted">
          <span className={`size-2.5 rounded-full ${!f?.enabled ? 'bg-muted' : ok ? 'bg-lime' : 'bg-err-soft'}`} aria-hidden="true" />
          Firestore copy
        </p>
        <p className="mt-1 font-semibold">
          {!f
            ? 'Checking…'
            : !f.enabled
              ? 'Off (no Firebase config)'
              : f.ok === false
                ? 'Not reaching Firebase (retrying)'
                : f.pending
                  ? `${f.pending} change(s) waiting`
                  : 'In sync'}
        </p>
        {f?.enabled && (
          <p className="mt-1 text-xs text-muted">
            {f.path} · {num(f.written)} writes
            {f.lastCheck ? ` · checked ${new Date(f.lastCheck).toLocaleTimeString('en-IN')}` : ''}
            {f.lastError && f.failures ? ` · last problem: ${f.lastError}` : ''}
          </p>
        )}
        {f?.enabled && (
          <Button variant="secondary" className="mt-3 min-h-10 text-sm" loading={busy} onClick={resync}>
            <I.Refresh size={16} /> Resync now
          </Button>
        )}
        {msg && <p className="mt-2 text-xs text-muted" role="status">{msg}</p>}
      </div>
      <div>
        <p className="flex items-center gap-2 text-sm text-muted">
          <span className="size-2.5 rounded-full bg-lime" aria-hidden="true" /> Quai Orchard
        </p>
        <p className="mt-1 font-semibold">
          Chain event #{chainEventId} · {num(minted)} ticket{minted === 1 ? '' : 's'} on-chain
        </p>
        <p className="mt-1 text-xs text-muted">
          Entries stay off-chain until the draw. Tickets, resales, returns and check-ins are Quai transactions.
        </p>
      </div>
    </Card>
  )
}

/** Slider + number input for a 0-100 % markup, with the live ₹ preview. */
function MarkupInput({ id, value, onChange, faceInr }) {
  const pct = Number(value) || 0
  return (
    <div>
      <div className="flex items-center gap-3">
        <input
          id={id}
          type="range"
          min={0}
          max={100}
          step={1}
          value={pct}
          onChange={(e) => onChange(Number(e.target.value))}
          className="h-2 w-full cursor-pointer accent-[#C6F432]"
          aria-describedby={`${id}-preview`}
        />
        <div className="relative w-24 shrink-0">
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            value={value}
            onChange={(e) => onChange(e.target.value === '' ? '' : Math.max(0, Math.min(100, Math.floor(Number(e.target.value)))))}
            className="min-h-11 w-full rounded-[12px] border border-line bg-bg pl-3 pr-7 text-right font-display text-lg focus:border-lime focus:outline-none"
            aria-label="Resale markup percent"
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted">%</span>
        </div>
      </div>
      <p id={`${id}-preview`} className="mt-2 text-sm" aria-live="polite">
        Face <span className="font-semibold">{inr(faceInr)}</span> → max resale{' '}
        <span className="font-semibold text-lime">{inr(previewMaxInr(faceInr || 0, pct))}</span>
        {pct === 0 && <span className="text-muted"> (resale only at face price)</span>}
      </p>
    </div>
  )
}

/** Organiser changes the resale markup for this event (on-chain setResaleCap). */
function ResaleSettings({ event, invalidListings, onSaved }) {
  const [pct, setPct] = useState(event.resaleCapPct)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => setPct(event.resaleCapPct), [event.id, event.resaleCapPct])
  const changed = pct !== '' && Number(pct) !== event.resaleCapPct

  async function save() {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const r = await api(`/events/${event.id}/resale-cap`, { method: 'POST', body: { pct: Number(pct) } })
      setResult(r)
      onSaved?.()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card id="resale">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg">Resale settings</h2>
          <p className="text-sm text-muted">How far above face price fans may resell. Enforced by the contract, also for existing listings.</p>
        </div>
        <div className="text-right">
          <p className="font-display text-3xl text-lime">+{event.resaleCapPct}%</p>
          <p className="text-xs text-muted">max {inr(event.maxResalePriceInr)}</p>
        </div>
      </div>
      <div className="mt-4">
        <label htmlFor="cap-edit" className="mb-2 block text-sm font-medium text-muted">
          New resale markup allowed (%)
        </label>
        <MarkupInput id="cap-edit" value={pct} onChange={setPct} faceInr={event.facePriceInr} />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button onClick={save} loading={busy} disabled={!changed || busy}>
          {busy ? 'Saving on Quai (about 30 s)…' : 'Save'}
        </Button>
        {event.resaleCapTx && (
          <TxLink href={event.resaleCapTx}>
            Last change on Quaiscan{event.resaleCapUpdatedAt ? ` (${new Date(event.resaleCapUpdatedAt).toLocaleTimeString('en-IN')})` : ''}
          </TxLink>
        )}
      </div>
      {result && (
        <p role="status" className="mt-3 text-sm text-muted">
          Changed from +{result.oldPct}% to +{result.pct}%.
          {result.listingsInvalidated > 0 && ` ${result.listingsInvalidated} listing(s) above the new cap are now invalid; their sellers see a warning.`}
          {result.listingsRevalidated > 0 && ` ${result.listingsRevalidated} listing(s) are valid again.`}
        </p>
      )}
      {invalidListings > 0 && !result && (
        <p className="mt-3 text-sm text-err-soft">{invalidListings} listing(s) are above the current cap and can't be bought.</p>
      )}
      <ErrorNote error={error} className="mt-3" />
    </Card>
  )
}

const in2days = () => {
  const d = new Date(Date.now() + 2 * 86400000)
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 16)
}

/** Create a new event on Quai, with the face price in ₹ and the resale markup. */
function CreateEvent({ onCreated, onCancel }) {
  const [f, setF] = useState({
    name: '',
    artist: '',
    date: '',
    venue: '',
    city: '',
    supply: 100,
    facePriceInr: 4500,
    resaleCapPct: 10,
    lotteryTickets: '',
    lotteryClose: in2days(),
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { event } = await api('/events', {
        method: 'POST',
        body: {
          ...f,
          supply: Number(f.supply),
          facePriceInr: Number(f.facePriceInr),
          resaleCapPct: Number(f.resaleCapPct),
          lotteryTickets: f.lotteryTickets === '' ? undefined : Number(f.lotteryTickets),
          lotteryClose: new Date(f.lotteryClose).toISOString(),
        },
      })
      onCreated(event)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const field = (k, label, props = {}) => (
    <div>
      <label htmlFor={`ce-${k}`} className="mb-1.5 block text-sm font-medium text-muted">
        {label}
      </label>
      <input
        id={`ce-${k}`}
        value={f[k]}
        onChange={set(k)}
        className="min-h-11 w-full rounded-[12px] border border-line bg-bg px-3 focus:border-lime focus:outline-none"
        {...props}
      />
    </div>
  )

  return (
    <Card>
      <form onSubmit={submit}>
        <h2 className="text-lg">New event</h2>
        <p className="text-sm text-muted">Created on Quai Orchard (one transaction, about 30 s). The lottery opens immediately.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {field('name', 'Event name', { required: true, placeholder: 'World Tour' })}
          {field('artist', 'Artist', { placeholder: '[Headliner]' })}
          {field('date', 'Show date and time', { type: 'datetime-local', required: true })}
          {field('lotteryClose', 'Lottery closes', { type: 'datetime-local', required: true })}
          {field('venue', 'Venue', { placeholder: 'DY Patil Stadium' })}
          {field('city', 'City', { placeholder: 'Mumbai' })}
          {field('supply', 'Seats', { type: 'number', min: 1, required: true })}
          {field('lotteryTickets', 'Tickets in this draw (optional)', { type: 'number', min: 1, placeholder: `all ${f.supply || ''} seats` })}
          {field('facePriceInr', 'Face price (₹)', { type: 'number', min: 1, step: 1, required: true })}
        </div>
        <div className="mt-4">
          <label htmlFor="ce-cap" className="mb-2 block text-sm font-medium text-muted">
            Resale markup allowed (%)
          </label>
          <MarkupInput id="ce-cap" value={f.resaleCapPct} onChange={(v) => setF({ ...f, resaleCapPct: v })} faceInr={f.facePriceInr} />
        </div>
        <ErrorNote error={error} className="mt-4" />
        <div className="mt-5 flex gap-3">
          <Button type="submit" loading={busy}>
            {busy ? 'Creating on Quai…' : 'Create event'}
          </Button>
          {onCancel && (
            <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          )}
        </div>
      </form>
    </Card>
  )
}

export default function Organiser() {
  const [events, setEvents] = useState(null)
  const [eventId, setEventId] = useState(null)
  const [stats, setStats] = useState(null)
  const [drawing, setDrawing] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    api('/events')
      .then(({ events }) => {
        setEvents(events)
        setEventId((id) => id ?? (events.find((e) => e.lotteryStatus === 'open') || events[0])?.id ?? null)
      })
      .catch(setError)
  }, [])

  const load = useCallback(() => {
    if (!eventId) return
    api(`/events/${eventId}/stats`)
      .then((s) => {
        setStats(s)
        setEvents((list) => (list || []).map((e) => (e.id === s.event.id ? s.event : e))) // keep the sidebar status live
      })
      .catch(setError)
  }, [eventId])
  useEffect(() => {
    load()
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [load])

  async function runDraw() {
    if (!confirm('Run the draw now? This reveals the seed, picks winners and mints their tickets on Quai.')) return
    setDrawing(true)
    setError(null)
    try {
      await api(`/events/${eventId}/draw`, { method: 'POST' })
      load()
    } catch (err) {
      setError(err)
    } finally {
      setDrawing(false)
    }
  }

  const created = (event) => {
    setEvents((list) => [...(list || []), event])
    setCreating(false)
    setStats(null)
    setEventId(event.id)
  }

  if (events && events.length === 0)
    return (
      <div className="mx-auto max-w-3xl">
        <CreateEvent onCreated={created} />
      </div>
    )
  if (!stats)
    return error ? (
      <ErrorNote error={error} />
    ) : (
      <div className="grid place-items-center py-20 text-muted">
        <Spinner />
      </div>
    )
  const ev = stats.event
  const blockedRows = Object.entries(stats.blocked).sort((a, b) => b[1] - a[1])
  const maxBlocked = Math.max(1, ...blockedRows.map(([, n]) => n))
  const rejectedScans = Object.entries(stats.scans)
    .filter(([k]) => k !== 'VALID')
    .reduce((a, [, n]) => a + n, 0)

  return (
    <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
      <aside className="lg:sticky lg:top-24 lg:self-start">
        <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted">Events</p>
        <nav className="flex gap-2 overflow-x-auto lg:flex-col" aria-label="Events">
          {(events || []).map((e) => (
            <button
              key={e.id}
              onClick={() => {
                setCreating(false)
                setEventId(e.id)
              }}
              aria-current={e.id === eventId}
              className={`shrink-0 rounded-[12px] px-3 py-2 text-left text-sm ${e.id === eventId && !creating ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}`}
            >
              <span className="block font-semibold">{e.name}</span>
              <span className="text-xs capitalize">{e.lotteryStatus}</span>
            </button>
          ))}
          <button
            onClick={() => setCreating(true)}
            className={`flex shrink-0 items-center gap-2 rounded-[12px] px-3 py-2 text-left text-sm ${creating ? 'bg-raised text-ink' : 'text-lime hover:bg-raised'}`}
          >
            <I.Plus size={16} /> New event
          </button>
        </nav>
        <div className="mt-6 hidden space-y-1 text-sm lg:block">
          <a href="#stats" className="block text-muted hover:text-ink">Overview</a>
          <a href="#resale" className="block text-muted hover:text-ink">Resale settings</a>
          <a href="#attempts" className="block text-muted hover:text-ink">Entry attempts</a>
          <a href="#proof" className="block text-muted hover:text-ink">Draw proof</a>
        </div>
      </aside>

      {creating ? (
        <div className="min-w-0">
          <CreateEvent onCreated={created} onCancel={() => setCreating(false)} />
        </div>
      ) : (
        <div className="min-w-0 space-y-6">
          <Card className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-sm text-muted">{ev.artist}</p>
              <h1 className="text-3xl">{ev.name}</h1>
              <p className="text-sm text-muted">
                {dateLong(ev.date)} · {[ev.venue, ev.city].filter(Boolean).join(', ')} · {num(ev.supply)} seats · {inr(ev.facePriceInr)} (
                {quai(ev.facePrice)})
              </p>
              <TxLink href={ev.contract} className="mt-1">
                Contract on Quaiscan
              </TxLink>
            </div>
            <div className="flex flex-col items-start gap-3 sm:items-end">
              {ev.lotteryStatus === 'open' ? (
                <>
                  <p className="text-sm text-muted">Lottery closes in</p>
                  <Countdown to={ev.lotteryClose} />
                </>
              ) : (
                <Badge tone={ev.lotteryStatus === 'drawn' ? 'lime' : 'muted'} className="capitalize">
                  {ev.lotteryStatus}
                </Badge>
              )}
              <Button onClick={runDraw} loading={drawing} disabled={!!ev.drawnAt || stats.entries.total === 0}>
                <I.Shuffle size={18} /> {ev.drawnAt ? 'Draw complete' : 'Run draw'}
              </Button>
            </div>
          </Card>
          <ErrorNote error={error} />

          <SyncStatus chainEventId={ev.chainEventId} minted={stats.tickets.minted} />

          {stats.minting && (
            <Card className="flex items-center gap-3 p-4">
              {stats.minting.running ? <Spinner /> : <I.Check className="text-lime" />}
              <p className="text-sm">
                {stats.minting.running ? 'Minting winners’ tickets on Quai… ' : 'Minting finished: '}
                {stats.minting.done} / {stats.minting.total} minted{stats.minting.failed ? `, ${stats.minting.failed} failed` : ''}
              </p>
            </Card>
          )}

          <section id="stats" className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="Key numbers">
            <Stat label="Verified entries" value={num(stats.entries.total)} icon={I.Users} sub={`${num(stats.entries.ticketsRequested)} tickets requested`} />
            <Stat label="Bot attempts blocked" value={num(stats.blockedTotal)} tone="err" icon={I.Bot} sub={`${num(stats.pow.solved)} / ${num(stats.pow.issued)} puzzles solved`} />
            <Stat label="Tickets for sale" value={num(stats.tickets.forSale)} icon={I.Tag} sub={`${num(stats.tickets.resold)} resold · ${num(stats.tickets.returned)} returned`} />
            <Stat
              label="Resale cap"
              value={`+${ev.resaleCapPct}%`}
              icon={I.Percent}
              sub={`max ${inr(ev.maxResalePriceInr)}${stats.tickets.invalidListings ? ` · ${stats.tickets.invalidListings} invalid listing(s)` : ''}`}
            />
            <Stat label="Minted on Quai" value={num(stats.tickets.minted)} icon={I.Ticket} sub={`${num(stats.entries.ticketsWon)} tickets won`} />
            <Stat
              label="Winners / waitlist"
              value={`${num(stats.entries.won + stats.entries.partial)} / ${num(stats.entries.waitlist)}`}
              icon={I.Shuffle}
              sub={stats.entries.partial ? `${num(stats.entries.partial)} got part of their quantity` : undefined}
            />
            <Stat label="Checked in" value={num(stats.tickets.scanned)} icon={I.Scan} sub={`${num(rejectedScans)} rejected scans`} />
            <Stat label="Puzzle size" value={num(stats.pow.guessesPerPuzzle)} icon={I.Cpu} sub="SHA-256d guesses per entry" />
          </section>

          <ResaleSettings event={ev} invalidListings={stats.tickets.invalidListings} onSaved={load} />

          <div className="grid gap-6 xl:grid-cols-[1fr_1.4fr]">
            <Card>
              <h2 className="text-lg">Blocked by reason</h2>
              {blockedRows.length === 0 ? (
                <p className="mt-3 text-sm text-muted">Nothing blocked yet. Run scripts/bot-attack.js to see the defences work.</p>
              ) : (
                <ul className="mt-4 space-y-3">
                  {blockedRows.map(([reason, n]) => (
                    <li key={reason}>
                      <div className="flex justify-between text-sm">
                        <span>{REASONS[reason] || reason}</span>
                        <span className="tabular-nums text-muted">{num(n)}</span>
                      </div>
                      <div className="mt-1 h-2 rounded-full bg-bg">
                        <div className="h-full rounded-full bg-err-soft" style={{ width: `${(n / maxBlocked) * 100}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card id="attempts" className="min-w-0">
              <h2 className="text-lg">Latest entry attempts</h2>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs uppercase text-muted">
                    <tr>
                      <th className="py-1 pr-3">Time</th>
                      <th className="py-1 pr-3">Phone</th>
                      <th className="py-1 pr-3">Result</th>
                      <th className="py-1">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.latest.map((r, i) => (
                      <tr key={i} className="border-t border-line">
                        <td className="whitespace-nowrap py-2 pr-3 tabular-nums text-muted">{sqlTime(r.at)}</td>
                        <td className="whitespace-nowrap pr-3 font-mono text-xs">{r.phone || 'anonymous'}</td>
                        <td className="pr-3">
                          <Badge tone={r.kind === 'entered' ? 'lime' : 'err'}>{REASONS[r.result] || r.result}</Badge>
                        </td>
                        <td className="text-xs text-muted">{r.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>

          {stats.recentTx.length > 0 && (
            <Card>
              <h2 className="text-lg">On-chain activity</h2>
              <ul className="mt-3 divide-y divide-line text-sm">
                {stats.recentTx.map((t, i) => (
                  <li key={i} className="flex items-center justify-between gap-3 py-2">
                    <span className="capitalize">
                      {t.kind.replace('_', ' ')}
                      {t.tokenId ? ` · token #${t.tokenId}` : ''}
                    </span>
                    <TxLink href={t.url}>{t.txHash.slice(0, 10)}…</TxLink>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <div id="proof">
            <DrawProof eventId={eventId} drawn={ev.drawnAt} />
          </div>
        </div>
      )}
    </div>
  )
}
