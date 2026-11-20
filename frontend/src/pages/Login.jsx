// Login: phone -> OTP -> name + ID number (KYC).
import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { api } from '../lib/api.js'
import { useSession } from '../lib/session.jsx'
import { Button, Card, ErrorNote, Field } from '../components/ui.jsx'
import * as I from '../components/Icons.jsx'

const HOME_FOR_ROLE = { organiser: '/organiser', staff: '/gate', fan: '/' }

export default function Login() {
  const { user, signIn, setUser } = useSession()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const next = params.get('next')
  const [step, setStep] = useState(user && !user.isVerified ? 'kyc' : 'phone')
  const [phone, setPhone] = useState('')
  const [otp, setOtp] = useState('')
  const [devOtp, setDevOtp] = useState(null)
  const [name, setName] = useState('')
  const [idNumber, setIdNumber] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const done = (u) => navigate(next || HOME_FOR_ROLE[u.role] || '/', { replace: true })

  async function run(fn) {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const sendOtp = (e) =>
    run(async () => {
      e.preventDefault()
      const r = await api('/auth/otp', { method: 'POST', body: { phone } })
      setPhone(r.phone)
      setDevOtp(r.devOtp || null)
      setStep('otp')
    })

  const verifyOtp = (e) =>
    run(async () => {
      e.preventDefault()
      const r = await api('/auth/verify', { method: 'POST', body: { phone, otp } })
      signIn(r.token, r.user)
      if (r.user.isVerified || r.user.role === 'organiser') done(r.user)
      else setStep('kyc')
    })

  const submitKyc = (e) =>
    run(async () => {
      e.preventDefault()
      const r = await api('/auth/kyc', { method: 'POST', body: { name, idNumber } })
      setUser(r.user)
      done(r.user)
    })

  const steps = ['phone', 'otp', 'kyc']
  return (
    <div className="mx-auto max-w-md">
      <div className="mb-6 flex gap-2" aria-hidden="true">
        {steps.map((s, i) => (
          <div key={s} className={`h-1.5 flex-1 rounded-full ${steps.indexOf(step) >= i ? 'bg-lime' : 'bg-line'}`} />
        ))}
      </div>

      {step === 'phone' && (
        <form onSubmit={sendOtp}>
          <h1 className="text-3xl">Log in with your phone</h1>
          <p className="mb-6 mt-2 text-muted">We'll send a one-time code. No passwords, no wallet needed.</p>
          <Field label="Mobile number" type="tel" inputMode="tel" autoComplete="tel" placeholder="98765 43210" value={phone} onChange={(e) => setPhone(e.target.value)} required />
          <ErrorNote error={error} className="mt-4" />
          <Button type="submit" className="mt-6 w-full" loading={busy}>
            Send code <I.ArrowRight size={18} />
          </Button>
        </form>
      )}

      {step === 'otp' && (
        <form onSubmit={verifyOtp}>
          <h1 className="text-3xl">Enter the code</h1>
          <p className="mb-6 mt-2 text-muted">Sent to {phone}.</p>
          <Field
            label="6-digit code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="••••••"
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
            hint={devOtp ? `Demo mode: your code is ${devOtp} (also printed in the server console)` : 'The code is printed in the server console (mock SMS).'}
            required
            autoFocus
          />
          <ErrorNote error={error} className="mt-4" />
          <Button type="submit" className="mt-6 w-full" loading={busy} disabled={otp.length !== 6}>
            Verify
          </Button>
          <Button type="button" variant="ghost" className="mt-2 w-full" onClick={() => setStep('phone')}>
            Use a different number
          </Button>
        </form>
      )}

      {step === 'kyc' && (
        <form onSubmit={submitKyc}>
          <h1 className="text-3xl">Verify your ID</h1>
          <p className="mb-6 mt-2 text-muted">One ID = one lottery entry per event. This is what stops bots and scalper farms.</p>
          <div className="space-y-4">
            <Field label="Full name (as on your ID)" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />
            <Field
              label="Aadhaar or PAN number"
              autoComplete="off"
              placeholder="2345 6789 0123 or ABCDE1234F"
              value={idNumber}
              onChange={(e) => setIdNumber(e.target.value)}
              required
            />
          </div>
          <Card className="mt-4 flex gap-3 p-4 text-sm text-muted">
            <I.Shield size={20} className="shrink-0 text-lime" />
            <span>We store only a keyed hash of your ID number, never the number itself. The same ID can't be used by two accounts.</span>
          </Card>
          <ErrorNote error={error} className="mt-4" />
          <Button type="submit" className="mt-6 w-full" loading={busy}>
            Verify ID
          </Button>
        </form>
      )}
    </div>
  )
}
