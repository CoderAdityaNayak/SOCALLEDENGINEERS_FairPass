// Shared UI building blocks.
import { useEffect, useState } from 'react'
import * as I from './Icons.jsx'

export function Button({ variant = 'primary', className = '', loading, children, ...props }) {
  const styles = {
    primary: 'bg-lime text-lime-ink hover:brightness-105 disabled:bg-line disabled:text-muted',
    secondary: 'bg-raised text-ink border border-line hover:border-muted disabled:text-muted',
    ghost: 'text-ink hover:bg-raised disabled:text-muted',
    danger: 'bg-err text-white hover:brightness-110 disabled:bg-line disabled:text-muted',
  }
  return (
    <button
      className={`inline-flex min-h-12 items-center justify-center gap-2 rounded-[14px] px-5 font-semibold transition disabled:cursor-not-allowed ${styles[variant]} ${className}`}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading && <Spinner size={18} />}
      {children}
    </button>
  )
}

export function Card({ className = '', children, ...props }) {
  return (
    <div className={`rounded-[20px] border border-line bg-card p-5 ${className}`} {...props}>
      {children}
    </div>
  )
}

export function Spinner({ size = 20, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={`animate-spin ${className}`} aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" fill="none" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  )
}

export function Field({ label, hint, error, id, className = '', ...props }) {
  const inputId = id || `f-${label?.replace(/\W+/g, '-').toLowerCase()}`
  return (
    <div className={className}>
      <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium text-muted">
        {label}
      </label>
      <input
        id={inputId}
        className={`min-h-12 w-full rounded-[14px] border bg-bg px-4 text-base text-ink placeholder:text-muted/60 focus:outline-none ${
          error ? 'border-err-soft focus:border-err-soft' : 'border-line focus:border-lime'
        }`}
        aria-invalid={!!error}
        aria-describedby={error || hint ? `${inputId}-msg` : undefined}
        {...props}
      />
      {(error || hint) && (
        <p id={`${inputId}-msg`} className={`mt-1.5 text-sm ${error ? 'text-err-soft' : 'text-muted'}`}>
          {error || hint}
        </p>
      )}
    </div>
  )
}

export function ErrorNote({ error, className = '' }) {
  if (!error) return null
  return (
    <div role="alert" className={`flex gap-2 rounded-[14px] border border-err/50 bg-err/10 p-3 text-sm text-err-soft ${className}`}>
      <I.Alert size={18} className="mt-0.5 shrink-0" />
      <span>{error.message || String(error)}</span>
    </div>
  )
}

export function Badge({ tone = 'muted', children, className = '' }) {
  const tones = {
    muted: 'bg-raised text-muted border-line',
    lime: 'bg-lime/15 text-lime border-lime/30',
    err: 'bg-err/15 text-err-soft border-err/40',
  }
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${tones[tone]} ${className}`}>
      {children}
    </span>
  )
}

export function TxLink({ href, children = 'View on Quaiscan', className = '' }) {
  if (!href) return null
  return (
    <a href={href} target="_blank" rel="noreferrer" className={`inline-flex items-center gap-1 text-sm text-lime underline-offset-4 hover:underline ${className}`}>
      {children}
      <I.External size={14} />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  )
}

/** Live countdown to `to` (ISO date). */
export function useCountdown(to) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const ms = Math.max(0, Date.parse(to) - now)
  return {
    done: ms === 0,
    d: Math.floor(ms / 86400000),
    h: Math.floor(ms / 3600000) % 24,
    m: Math.floor(ms / 60000) % 60,
    s: Math.floor(ms / 1000) % 60,
  }
}

export function Countdown({ to, className = '' }) {
  const c = useCountdown(to)
  const pad = (n) => String(n).padStart(2, '0')
  const parts = [
    ['d', c.d],
    ['h', c.h],
    ['m', c.m],
    ['s', c.s],
  ]
  return (
    <div className={`flex gap-2 ${className}`} role="timer" aria-label={`${c.d} days ${c.h} hours ${c.m} minutes left`}>
      {parts.map(([u, v]) => (
        <div key={u} className="min-w-12 rounded-[12px] bg-bg px-2 py-1.5 text-center">
          <div className="font-display text-xl tabular-nums">{pad(v)}</div>
          <div className="text-[11px] uppercase tracking-wide text-muted">{u}</div>
        </div>
      ))}
    </div>
  )
}

export function PageTitle({ children, sub, back }) {
  return (
    <div className="mb-5">
      {back}
      <h1 className="text-2xl">{children}</h1>
      {sub && <p className="mt-1 text-muted">{sub}</p>}
    </div>
  )
}

export function Empty({ icon: Icon = I.Ticket, title, children }) {
  return (
    <Card className="flex flex-col items-center py-10 text-center">
      <Icon size={32} className="mb-3 text-muted" />
      <p className="font-display text-lg">{title}</p>
      {children && <div className="mt-1 text-muted">{children}</div>}
    </Card>
  )
}
