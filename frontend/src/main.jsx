import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router'
import './index.css'
import { SessionProvider, useSession } from './lib/session.jsx'
import { Layout } from './components/Layout.jsx'
import { Spinner } from './components/ui.jsx'
import Login from './pages/Login.jsx'
import Home from './pages/Home.jsx'
import EventPage from './pages/Event.jsx'
import Enter from './pages/Enter.jsx'
import MyTickets from './pages/MyTickets.jsx'
import TicketPage from './pages/Ticket.jsx'
import Resale from './pages/Resale.jsx'
import Gate from './pages/Gate.jsx'
import Organiser from './pages/Organiser.jsx'

/** Sends logged-out users to /login (and back afterwards); optionally restricts roles. */
function Protected({ roles, children }) {
  const { user, loading } = useSession()
  const location = useLocation()
  if (loading)
    return (
      <div className="grid place-items-center py-20 text-muted">
        <Spinner />
      </div>
    )
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />
  if (roles && !roles.includes(user.role))
    return <p className="py-20 text-center text-muted">This page is for {roles.join(' / ')} accounts.</p>
  return children
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <SessionProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Home />} />
            <Route path="events/:eventId" element={<EventPage />} />
            <Route path="login" element={<Login />} />
            <Route path="enter/:eventId" element={<Protected><Enter /></Protected>} />
            <Route path="tickets" element={<Protected><MyTickets /></Protected>} />
            <Route path="tickets/:tokenId" element={<Protected><TicketPage /></Protected>} />
            <Route path="tickets/:tokenId/resale" element={<Protected><Resale /></Protected>} />
            <Route path="gate" element={<Protected roles={['staff', 'organiser']}><Gate /></Protected>} />
            <Route path="organiser" element={<Protected roles={['organiser']}><Organiser /></Protected>} />
            <Route path="*" element={<p className="py-20 text-center text-muted">Page not found.</p>} />
          </Route>
        </Routes>
      </BrowserRouter>
    </SessionProvider>
  </StrictMode>,
)
