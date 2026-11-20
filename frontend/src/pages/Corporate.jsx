// Corporate booking: apply with GSTIN, invite employees, watch their verification, swap seats.
import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { useSession } from '../lib/session.jsx'
import { Badge, Button, Card, ErrorNote, Field, PageTitle, Spinner, TxLink } from '../components/ui.jsx'
import * as I from '../components/Icons.jsx'

function Apply({ onDone }) {
  const [events, setEvents] = useState([])
  const [form, setForm] = useState({ name: '', gstin: '', eventId: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  useEffect(() => {
    api('/events').then(({ events }) => {
      setEvents(events)
      setForm((f) => ({ ...f, eventId: f.eventId || events.find((e) => e.lotteryStatus === 'open')?.id || events[0]?.id || '' }))
    })
  }, [])
  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api('/corporate/apply', { method: 'POST', body: { ...form, eventId: Number(form.eventId) } })
      onDone()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit}>
      <Card className="space-y-4">
        <Field label="Company name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        <Field
          label="GSTIN"
          placeholder="27AAPFU0939F1ZV"
          maxLength={15}
          value={form.gstin}
          onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })}
          hint="15 characters. We check the format and checksum (registry lookup is mocked)."
          required
        />
        <div>
          <label htmlFor="ev" className="mb-1.5 block text-sm font-medium text-muted">
            Event
          </label>
          <select
            id="ev"
            value={form.eventId}
            onChange={(e) => setForm({ ...form, eventId: e.target.value })}
            className="min-h-12 w-full rounded-[14px] border border-line bg-bg px-4"
          >
            {events.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </div>
        <ErrorNote error={error} />
        <Button type="submit" className="w-full" loading={busy}>
          Apply for corporate seats
        </Button>
      </Card>
      <p className="mt-3 text-sm text-muted">
        Each seat is tied to one verified employee. The limit is per attendee, not per buyer, and corporate tickets can't be resold.
      </p>
    </form>
  )
}

function SeatRow({ seat, onSwap }) {
  const [open, setOpen] = useState(false)
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const status = seat.tokenId
    ? { tone: 'lime', text: `Seat ${seat.seat}` }
    : seat.note?.startsWith('Minting')
      ? { tone: 'muted', text: 'Minting…' }
      : seat.note?.includes('already')
        ? { tone: 'err', text: 'ID already used' }
        : { tone: 'muted', text: 'Waiting for KYC' }
  async function swap(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onSwap(seat.id, phone)
      setOpen(false)
      setPhone('')
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-semibold">{seat.employeeName || seat.phone}</p>
          <p className="text-sm text-muted">
            {seat.employeeName ? seat.phone : 'Invited'}
            {seat.tokenId ? ` · token #${seat.tokenId}` : ''}
          </p>
          {seat.note && !seat.note.startsWith('Waiting') && <p className="text-xs text-muted">{seat.note}</p>}
          {seat.explorer && <TxLink href={seat.explorer}>On Quaiscan</TxLink>}
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={status.tone}>
            {status.text === 'Minting…' && <Spinner size={12} />}
            {status.text}
          </Badge>
          <Button
            variant="secondary"
            className="min-h-10 px-3 text-sm"
            onClick={() => setOpen(!open)}
            disabled={seat.swapsLeft <= 0 || seat.ticketStatus === 'used' || seat.note?.startsWith('Swapping')}
            aria-expanded={open}
          >
            <I.Swap size={16} /> Swap ({seat.swapsLeft})
          </Button>
        </div>
      </div>
      {open && (
        <form onSubmit={swap} className="mt-3 flex items-end gap-2">
          <Field className="flex-1" label="New employee's phone (must be verified)" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required />
          <Button type="submit" className="min-h-12" loading={busy}>
            Swap
          </Button>
        </form>
      )}
      <ErrorNote error={error} className="mt-2" />
    </li>
  )
}

function CompanyView({ company, reload }) {
  const [phones, setPhones] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const verified = company.seats.filter((s) => s.employeeVerified).length
  const minted = company.seatsMinted
  const left = company.seatQuota - company.seats.length

  async function invite(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const list = phones.split(/[\s,;]+/).filter(Boolean)
      await api(`/corporate/${company.id}/seats`, { method: 'POST', body: { phones: list } })
      setPhones('')
      reload()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-display text-xl">{company.name}</p>
            <p className="font-mono text-xs text-muted">GSTIN {company.gstin}</p>
            <p className="mt-1 text-sm text-muted">{company.eventName}</p>
          </div>
          {company.approved ? <Badge tone="lime">Approved · {company.seatQuota} seats</Badge> : <Badge>Waiting for organiser</Badge>}
        </div>
        {company.approved && company.seats.length > 0 && (
          <div className="mt-4">
            <div className="flex justify-between text-sm">
              <span className="text-muted">Employees verified</span>
              <span>
                {verified} / {company.seats.length} verified · {minted} tickets minted
              </span>
            </div>
            <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-bg" role="progressbar" aria-valuenow={minted} aria-valuemin={0} aria-valuemax={company.seats.length} aria-label="Seats minted">
              <div className="h-full rounded-full bg-lime transition-all" style={{ width: `${(minted / company.seats.length) * 100}%` }} />
            </div>
          </div>
        )}
      </Card>

      {company.approved && left > 0 && (
        <form onSubmit={invite}>
          <Card>
            <label htmlFor="phones" className="mb-1.5 block font-semibold">
              Add employees ({left} seat{left === 1 ? '' : 's'} left)
            </label>
            <textarea
              id="phones"
              rows={3}
              value={phones}
              onChange={(e) => setPhones(e.target.value)}
              placeholder="One phone per line, or separated by commas"
              className="w-full rounded-[14px] border border-line bg-bg p-3 focus:border-lime focus:outline-none"
            />
            <p className="mt-1 text-sm text-muted">Each employee logs in with their phone and verifies their own ID. Their seat is minted to them on Quai.</p>
            <ErrorNote error={error} className="mt-3" />
            <Button type="submit" className="mt-3 w-full" loading={busy} disabled={!phones.trim()}>
              <I.Plus size={18} /> Invite employees
            </Button>
          </Card>
        </form>
      )}

      {company.seats.length > 0 && (
        <Card>
          <h2 className="text-lg">Seats</h2>
          <ul className="divide-y divide-line">
            {company.seats.map((s) => (
              <SeatRow
                key={s.id}
                seat={s}
                onSwap={async (id, newPhone) => {
                  await api(`/corporate/seats/${id}/swap`, { method: 'POST', body: { newPhone } })
                  reload()
                }}
              />
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

export default function Corporate() {
  const { user, refresh } = useSession()
  const [companies, setCompanies] = useState(null)
  const [error, setError] = useState(null)
  const load = useCallback(() => api('/corporate/mine').then((r) => setCompanies(r.companies)).catch(setError), [])
  useEffect(() => {
    load()
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [load])

  if (!user.isVerified)
    return (
      <div className="mx-auto max-w-md">
        <PageTitle>Corporate booking</PageTitle>
        <ErrorNote error={new Error('Verify your own ID before booking for your company.')} />
      </div>
    )
  if (!companies)
    return error ? (
      <ErrorNote error={error} />
    ) : (
      <div className="grid place-items-center py-20 text-muted">
        <Spinner />
      </div>
    )

  return (
    <div className="mx-auto max-w-xl">
      <PageTitle sub="Book seats for named, verified employees.">Corporate booking</PageTitle>
      {companies.length === 0 ? (
        <Apply
          onDone={() => {
            load()
            refresh()
          }}
        />
      ) : (
        <div className="space-y-8">
          {companies.map((c) => (
            <CompanyView key={c.id} company={c} reload={load} />
          ))}
        </div>
      )}
    </div>
  )
}
