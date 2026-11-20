// Organiser dashboard (desktop layout with sidebar): lottery, draw, bot stats, corporate requests, draw proof.
import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { dateLong, num, quai, REASONS, sqlTime } from '../lib/format.js'
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
                  <th className="py-1">Qty</th>
                  <th className="py-1">Result</th>
                  <th className="py-1">sha256(seed:id)</th>
                </tr>
              </thead>
              <tbody>
                {proof.entries.map((e) => (
                  <tr key={e.id} className="border-t border-line">
                    <td className="py-1.5">{e.drawRank}</td>
                    <td>#{e.id}</td>
                    <td>{e.quantity}</td>
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

function CorporateRequests({ event, onChange }) {
  const [companies, setCompanies] = useState([])
  const [quota, setQuota] = useState({})
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const load = useCallback(
    () =>
      api('/corporate')
        .then((r) => setCompanies(r.companies.filter((c) => c.eventId === event.id)))
        .catch(setError),
    [event.id],
  )
  useEffect(() => {
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [load])

  async function approve(c) {
    setBusy(c.id)
    setError(null)
    try {
      await api(`/corporate/${c.id}/approve`, { method: 'POST', body: { seatQuota: Number(quota[c.id] || Math.min(5, event.corporateCap)) } })
      await load()
      onChange?.()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <div className="flex items-center justify-between">
        <h2 className="text-lg">Corporate requests</h2>
        <span className="text-sm text-muted">Pool cap {event.corporateCap} seats (5%)</span>
      </div>
      {companies.length === 0 ? (
        <p className="mt-3 text-sm text-muted">No requests yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {companies.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div>
                <p className="font-semibold">{c.name}</p>
                <p className="font-mono text-xs text-muted">GSTIN {c.gstin}</p>
                {c.approved && (
                  <p className="text-xs text-muted">
                    {c.seatsMinted} / {c.seatQuota} seats minted
                  </p>
                )}
              </div>
              {c.approved ? (
                <Badge tone="lime">
                  <I.Check size={12} /> Approved · {c.seatQuota} seats
                </Badge>
              ) : (
                <div className="flex items-center gap-2">
                  <label className="sr-only" htmlFor={`q-${c.id}`}>
                    Seats for {c.name}
                  </label>
                  <input
                    id={`q-${c.id}`}
                    type="number"
                    min={1}
                    max={event.corporateCap}
                    value={quota[c.id] ?? Math.min(5, event.corporateCap)}
                    onChange={(e) => setQuota({ ...quota, [c.id]: e.target.value })}
                    className="min-h-10 w-20 rounded-[10px] border border-line bg-bg px-3"
                  />
                  <Button className="min-h-10" loading={busy === c.id} onClick={() => approve(c)}>
                    Approve
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <ErrorNote error={error} className="mt-3" />
    </Card>
  )
}

export default function Organiser() {
  const [events, setEvents] = useState([])
  const [eventId, setEventId] = useState(null)
  const [stats, setStats] = useState(null)
  const [drawing, setDrawing] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    api('/events')
      .then(({ events }) => {
        setEvents(events)
        setEventId((id) => id ?? (events.find((e) => e.lotteryStatus === 'open') || events[0])?.id)
      })
      .catch(setError)
  }, [])

  const load = useCallback(() => {
    if (!eventId) return
    api(`/events/${eventId}/stats`)
      .then((s) => {
        setStats(s)
        setEvents((list) => list.map((e) => (e.id === s.event.id ? s.event : e))) // keep the sidebar status live
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

  return (
    <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
      <aside className="lg:sticky lg:top-24 lg:self-start">
        <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted">Events</p>
        <nav className="flex gap-2 overflow-x-auto lg:flex-col" aria-label="Events">
          {events.map((e) => (
            <button
              key={e.id}
              onClick={() => setEventId(e.id)}
              aria-current={e.id === eventId}
              className={`shrink-0 rounded-[12px] px-3 py-2 text-left text-sm ${e.id === eventId ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}`}
            >
              <span className="block font-semibold">{e.name}</span>
              <span className="text-xs capitalize">{e.lotteryStatus}</span>
            </button>
          ))}
        </nav>
        <div className="mt-6 hidden space-y-1 text-sm lg:block">
          <a href="#stats" className="block text-muted hover:text-ink">Overview</a>
          <a href="#attempts" className="block text-muted hover:text-ink">Entry attempts</a>
          <a href="#corporate" className="block text-muted hover:text-ink">Corporate</a>
          <a href="#proof" className="block text-muted hover:text-ink">Draw proof</a>
        </div>
      </aside>

      <div className="min-w-0 space-y-6">
        <Card className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm text-muted">{ev.artist}</p>
            <h1 className="text-3xl">{ev.name}</h1>
            <p className="text-sm text-muted">
              {dateLong(ev.date)} · {[ev.venue, ev.city].filter(Boolean).join(', ')} · {num(ev.supply)} seats · {quai(ev.facePrice)}
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
          <Stat label="Resale cap" value={`+${ev.resaleCapPct}%`} icon={I.Percent} sub={`max ${quai(ev.maxResalePrice)}`} />
          <Stat label="Minted on Quai" value={num(stats.tickets.minted)} icon={I.Ticket} sub={`${num(stats.tickets.corporate)} corporate`} />
          <Stat label="Winners / waitlist" value={`${num(stats.entries.won)} / ${num(stats.entries.waitlist)}`} icon={I.Shuffle} />
          <Stat label="Checked in" value={num(stats.tickets.scanned)} icon={I.Scan} sub={`${num(Object.entries(stats.scans).filter(([k]) => k !== 'VALID').reduce((a, [, n]) => a + n, 0))} rejected scans`} />
          <Stat label="Puzzle size" value={num(stats.pow.guessesPerPuzzle)} icon={I.Cpu} sub="SHA-256d guesses per entry" />
        </section>

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
                    {t.kind}
                    {t.tokenId ? ` · token #${t.tokenId}` : ''}
                  </span>
                  <TxLink href={t.url}>{t.txHash.slice(0, 10)}…</TxLink>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <div id="corporate">
          <CorporateRequests event={ev} onChange={load} />
        </div>
        <div id="proof">
          <DrawProof eventId={eventId} drawn={ev.drawnAt} />
        </div>
      </div>
    </div>
  )
}
