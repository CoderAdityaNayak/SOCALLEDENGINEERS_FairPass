// App shell: top bar (logo, Pelagus, account) and a role-based bottom navigation.
import { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router'
import { useSession } from '../lib/session.jsx'
import { connectPelagus } from '../lib/pelagus.js'
import { shortAddr } from '../lib/format.js'
import * as I from './Icons.jsx'

export function Logo() {
  return (
    <span className="flex items-center gap-2">
      <span className="grid size-8 place-items-center rounded-[10px] bg-lime text-lime-ink">
        <I.Ticket size={18} strokeWidth={2.4} />
      </span>
      <span className="font-display text-lg">FairPass</span>
    </span>
  )
}

function PelagusButton() {
  const [state, setState] = useState({ address: null, error: null, busy: false })
  async function onClick() {
    setState((s) => ({ ...s, busy: true, error: null }))
    try {
      const r = await connectPelagus()
      setState({ address: r.address, cyprus1: r.cyprus1, busy: false, error: null })
    } catch (err) {
      setState({ address: null, busy: false, error: err.message })
    }
  }
  return (
    <div className="relative">
      <button
        onClick={onClick}
        className="inline-flex min-h-10 items-center gap-2 rounded-[12px] border border-line px-3 text-sm text-ink hover:border-muted"
        aria-label={state.address ? `Pelagus connected: ${state.address}` : 'Connect Pelagus wallet'}
        title={state.error || state.address || 'Optional: connect your own Pelagus wallet'}
      >
        <I.Wallet size={16} />
        <span className="hidden sm:inline">{state.busy ? 'Connecting…' : state.address ? shortAddr(state.address) : 'Connect Pelagus'}</span>
        {state.address && <span className={`size-2 rounded-full ${state.cyprus1 ? 'bg-lime' : 'bg-err-soft'}`} aria-hidden="true" />}
      </button>
      {state.error && (
        <p role="status" className="absolute right-0 top-12 z-20 w-60 rounded-[12px] border border-line bg-card p-3 text-xs text-muted shadow-lg">
          {state.error}
        </p>
      )}
    </div>
  )
}

const NAV = {
  fan: [
    { to: '/', label: 'Event', icon: I.Home, end: true },
    { to: '/tickets', label: 'Tickets', icon: I.Ticket },
  ],
  staff: [
    { to: '/gate', label: 'Scan', icon: I.Scan },
    { to: '/', label: 'Event', icon: I.Home, end: true },
  ],
  organiser: [
    { to: '/organiser', label: 'Dashboard', icon: I.Chart },
    { to: '/gate', label: 'Scan', icon: I.Scan },
    { to: '/', label: 'Event', icon: I.Home, end: true },
  ],
}

export function Layout() {
  const { user, signOut } = useSession()
  const navigate = useNavigate()
  const items = user ? NAV[user.role] || NAV.fan : []
  return (
    <div className="min-h-dvh pb-24">
      <header className="sticky top-0 z-10 border-b border-line/60 bg-bg/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4">
          <NavLink to="/" aria-label="FairPass home">
            <Logo />
          </NavLink>
          <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
            {items.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) => `rounded-[10px] px-3 py-2 text-sm ${isActive ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}`}
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <PelagusButton />
            {user ? (
              <button
                onClick={() => {
                  signOut()
                  navigate('/login')
                }}
                className="grid size-10 place-items-center rounded-[12px] border border-line text-muted hover:text-ink"
                aria-label={`Sign out ${user.name || user.phone}`}
                title={`Signed in as ${user.name || user.phone} (${user.role})`}
              >
                <I.Logout size={18} />
              </button>
            ) : (
              <NavLink to="/login" className="rounded-[12px] bg-lime px-4 py-2 text-sm font-semibold text-lime-ink">
                Log in
              </NavLink>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>

      {items.length > 0 && (
        <nav className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden" aria-label="Main">
          <div className="mx-auto flex max-w-md justify-around">
            {items.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) => `flex min-h-16 min-w-20 flex-col items-center justify-center gap-1 text-xs ${isActive ? 'text-lime' : 'text-muted'}`}
              >
                <n.icon size={22} />
                {n.label}
              </NavLink>
            ))}
          </div>
        </nav>
      )}
    </div>
  )
}
