// Shared bits for passing tickets on: lock countdown, capped price input, recipient lookup.
import { useState } from 'react'
import { api } from '../lib/api.js'
import { inr } from '../lib/format.js'
import { useCountdown, Button, ErrorNote } from './ui.jsx'
import * as I from './Icons.jsx'

/** "Transfers lock in 2d 4h" / "Transfers locked". */
export function LockCountdown({ lockAt, className = '' }) {
  const c = useCountdown(lockAt)
  if (!lockAt) return null
  if (c.done)
    return (
      <p className={`flex items-center gap-1.5 text-sm text-err-soft ${className}`}>
        <I.Alert size={15} /> Transfers locked (last 24 h before the show)
      </p>
    )
  const parts = c.d > 0 ? `${c.d}d ${c.h}h` : c.h > 0 ? `${c.h}h ${c.m}m` : `${c.m}m ${c.s}s`
  return (
    <p className={`flex items-center gap-1.5 text-sm text-muted ${className}`}>
      <I.Clock size={15} /> Transfers lock in {parts}
    </p>
  )
}

/** ₹ price input that turns red above the max and reports validity. */
export function PriceInput({ id = 'price', value, onChange, maxInr, capPct }) {
  const n = Number(value)
  const over = value !== '' && n > maxInr
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-muted">
        Price (₹)
      </label>
      <div className="relative">
        <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 font-display text-xl text-muted">₹</span>
        <input
          id={id}
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ''))}
          aria-invalid={over}
          aria-describedby={`${id}-msg`}
          className={`min-h-12 w-full rounded-[14px] border bg-bg pl-9 pr-4 font-display text-xl focus:outline-none ${over ? 'border-err-soft text-err-soft' : 'border-line focus:border-lime'}`}
        />
      </div>
      <p id={`${id}-msg`} role={over ? 'alert' : undefined} className={`mt-1.5 text-sm ${over ? 'text-err-soft' : 'text-muted'}`}>
        {over ? 'Above the cap. The FairPass contract will reject this price.' : `Up to ${inr(maxInr)} (face + ${capPct}%)`}
      </p>
    </div>
  )
}
export const priceValid = (value, maxInr) => value !== '' && Number(value) > 0 && Number(value) <= maxInr

/** Phone input + "Find" -> shows the person's verified name. Calls onFound({name, phone}) or onFound(null). */
export function RecipientLookup({ label = "Friend's phone number", onFound }) {
  const [phone, setPhone] = useState('')
  const [found, setFound] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  async function find(e) {
    e?.preventDefault()
    setBusy(true)
    setError(null)
    setFound(null)
    onFound(null)
    try {
      const r = await api(`/users/lookup?phone=${encodeURIComponent(phone)}`)
      setFound(r)
      onFound(r)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div>
      <label htmlFor="recipient" className="mb-1.5 block text-sm font-medium text-muted">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id="recipient"
          type="tel"
          inputMode="tel"
          value={phone}
          onChange={(e) => {
            setPhone(e.target.value)
            setFound(null)
            onFound(null)
          }}
          onKeyDown={(e) => e.key === 'Enter' && find(e)}
          placeholder="98765 43210"
          className="min-h-12 w-full rounded-[14px] border border-line bg-bg px-4 text-base focus:border-lime focus:outline-none"
        />
        <Button type="button" variant="secondary" onClick={find} loading={busy} disabled={phone.trim().length < 10}>
          Find
        </Button>
      </div>
      {found && (
        <p className="mt-2 flex items-center gap-2 rounded-[12px] border border-lime/30 bg-lime/10 p-3 text-sm" role="status">
          <I.Shield size={16} className="text-lime" />
          <span>
            <span className="font-semibold">{found.name}</span> · verified FairPass fan
          </span>
        </p>
      )}
      <ErrorNote error={error} className="mt-2" />
    </div>
  )
}
