// Gate scanner: camera (html5-qrcode) or paste the QR JSON -> full-screen VALID / REJECTED.
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { GATE_RESULTS } from '../lib/format.js'
import { Button, Card, ErrorNote, Spinner } from '../components/ui.jsx'
import * as I from '../components/Icons.jsx'

const REJECT_TEXT = {
  EXPIRED: 'This QR is older than 30 seconds. Likely a screenshot. Ask the fan to open the live ticket.',
  NOT_ON_CHAIN: 'This ticket was never minted by FairPass. It is fake.',
  NOT_OWNER: 'The QR was not signed by the wallet that owns this ticket.',
  ALREADY_USED: 'This ticket has already been checked in.',
  LISTED: 'This ticket is listed for resale. The owner must cancel the listing before entering.',
  MALFORMED: 'This is not a FairPass QR code.',
}

function CheckRow({ check }) {
  const tone = check.pass === true ? 'text-lime' : check.pass === false ? 'text-err-soft' : 'text-muted'
  return (
    <tr className="border-t border-current/15">
      <td className="py-2 pr-3">{check.label}</td>
      <td className="py-2 pr-3 text-sm opacity-80">{check.detail}</td>
      <td className={`py-2 text-right font-semibold ${tone}`}>
        <span className="inline-flex items-center gap-1">
          {check.pass === true ? <I.Check size={16} /> : check.pass === false ? <I.X size={16} /> : <I.Minus size={16} />}
          {check.pass === true ? 'Pass' : check.pass === false ? 'Fail' : 'Skipped'}
        </span>
      </td>
    </tr>
  )
}

function Result({ result, onNext }) {
  const nextRef = useRef(null)
  useEffect(() => nextRef.current?.focus(), [])
  if (result.valid)
    return (
      <div role="alertdialog" aria-label="Valid ticket" className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-lime p-6 text-lime-ink">
        <div className="mx-auto flex w-full max-w-md flex-1 flex-col">
          <div className="mx-auto mt-6 grid size-28 place-items-center rounded-full bg-lime-ink text-lime animate-pop">
            <I.Check size={64} strokeWidth={3} />
          </div>
          <p className="mt-6 text-center font-display text-5xl">VALID</p>
          <p className="text-center font-display text-2xl">Let them in</p>
          <div className="mt-6 rounded-[20px] bg-lime-ink/10 p-4">
            <p className="text-sm opacity-70">Holder</p>
            <p className="font-display text-2xl">{result.holderName || 'Ticket holder'}</p>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              {[
                ['Block', result.seat?.block],
                ['Row', result.seat?.row],
                ['Seat', result.seat?.seatNumber],
              ].map(([k, v]) => (
                <div key={k} className="rounded-[12px] bg-lime-ink/10 py-2">
                  <p className="text-xs uppercase opacity-70">{k}</p>
                  <p className="font-display text-xl">{v ?? '–'}</p>
                </div>
              ))}
            </div>
            <p className="mt-3 text-sm opacity-70">Token #{result.tokenId}</p>
          </div>
          <table className="mt-4 w-full text-left text-sm">
            <tbody>
              {result.checks.map((c) => (
                <tr key={c.id} className="border-t border-lime-ink/15">
                  <td className="py-2">{c.label}</td>
                  <td className="py-2 text-right font-semibold">
                    <span className="inline-flex items-center gap-1">
                      <I.Check size={16} /> Pass
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 flex items-center gap-2 text-sm font-semibold">
            <I.Shield size={16} /> Marked used on-chain
          </p>
          {result.markedUsed?.tx && (
            <a href={result.markedUsed.tx} target="_blank" rel="noreferrer" className="text-sm underline">
              View transaction on Quaiscan
            </a>
          )}
          <button ref={nextRef} onClick={onNext} className="mt-auto min-h-14 w-full rounded-[16px] bg-lime-ink text-lg font-semibold text-lime">
            Scan next
          </button>
        </div>
      </div>
    )
  return (
    <div role="alertdialog" aria-label="Rejected ticket" className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-err p-6 text-white">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col">
        <div className="mx-auto mt-6 grid size-28 place-items-center rounded-full bg-white text-err animate-pop">
          <I.X size={64} strokeWidth={3} />
        </div>
        <p className="mt-6 text-center font-display text-5xl">REJECTED</p>
        <p className="text-center font-display text-2xl">{GATE_RESULTS[result.result] || result.result}</p>
        <p className="mx-auto mt-3 max-w-sm text-center text-white/85">{REJECT_TEXT[result.result]}</p>
        {result.checks.length > 0 && (
          <table className="mt-6 w-full text-left [&_.text-lime]:text-white [&_.text-err-soft]:text-[#ffe0e0]">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-white/70">
                <th className="pb-1">Check</th>
                <th className="pb-1">Detail</th>
                <th className="pb-1 text-right">Result</th>
              </tr>
            </thead>
            <tbody>
              {result.checks.map((c) => (
                <CheckRow key={c.id} check={c} />
              ))}
            </tbody>
          </table>
        )}
        {result.tokenId && <p className="mt-3 text-sm text-white/70">Token #{result.tokenId}</p>}
        <button ref={nextRef} onClick={onNext} className="mt-auto min-h-14 w-full rounded-[16px] bg-white text-lg font-semibold text-err">
          Scan next
        </button>
      </div>
    </div>
  )
}

export default function Gate() {
  const [mode, setMode] = useState('camera')
  const [cameraError, setCameraError] = useState(null)
  const [pasted, setPasted] = useState('')
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const scanner = useRef(null)
  const busy = useRef(false)

  async function verify(qr) {
    if (busy.current) return
    busy.current = true
    setChecking(true)
    setError(null)
    try {
      setResult(await api('/gate/verify', { method: 'POST', body: { qr } }))
    } catch (err) {
      setError(err)
    } finally {
      setChecking(false)
      busy.current = false
    }
  }

  useEffect(() => {
    if (mode !== 'camera' || result) return
    let stopped = false
    let instance
    ;(async () => {
      try {
        const { Html5Qrcode } = await import('html5-qrcode')
        if (stopped) return
        instance = new Html5Qrcode('gate-camera', { verbose: false })
        scanner.current = instance
        await instance.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 240, height: 240 } },
          (text) => {
            if (!busy.current) verify(text)
          },
          () => {},
        )
        setCameraError(null)
      } catch (err) {
        if (!stopped) setCameraError(err?.message || String(err))
      }
    })()
    return () => {
      stopped = true
      if (instance?.isScanning) instance.stop().catch(() => {})
    }
  }, [mode, result])

  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-3xl">Gate scanner</h1>
      <p className="mt-1 text-muted">Checks: fresh QR, real token on Quai, signed by the owner, not used.</p>

      <div className="mt-5 grid grid-cols-2 gap-2 rounded-[16px] bg-card p-1" role="tablist" aria-label="Scan method">
        {[
          ['camera', 'Camera', I.Scan],
          ['paste', 'Paste code', I.Copy],
        ].map(([id, label, Icon]) => (
          <button
            key={id}
            role="tab"
            aria-selected={mode === id}
            onClick={() => setMode(id)}
            className={`flex min-h-11 items-center justify-center gap-2 rounded-[12px] font-semibold ${mode === id ? 'bg-raised text-ink' : 'text-muted'}`}
          >
            <Icon size={18} /> {label}
          </button>
        ))}
      </div>

      {mode === 'camera' ? (
        <Card className="mt-4 p-3">
          <div id="gate-camera" className="aspect-square w-full overflow-hidden rounded-[18px] bg-bg" />
          {cameraError && (
            <div className="p-3 text-sm text-muted">
              <p className="text-err-soft">Camera unavailable: {cameraError}</p>
              <button className="mt-2 text-lime underline" onClick={() => setMode('paste')}>
                Paste the code instead
              </button>
            </div>
          )}
          {checking && (
            <p className="flex items-center justify-center gap-2 p-3 text-muted">
              <Spinner size={16} /> Checking on Quai…
            </p>
          )}
        </Card>
      ) : (
        <Card className="mt-4">
          <label htmlFor="qr-json" className="mb-1.5 block text-sm font-medium text-muted">
            QR code contents (JSON)
          </label>
          <textarea
            id="qr-json"
            rows={5}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder='{"tokenId":1,"timestamp":1700000000,"signature":"0x…"}'
            className="w-full rounded-[14px] border border-line bg-bg p-3 font-mono text-sm focus:border-lime focus:outline-none"
          />
          <Button className="mt-3 w-full" loading={checking} disabled={!pasted.trim()} onClick={() => verify(pasted.trim())}>
            Verify ticket
          </Button>
          <p className="mt-2 text-xs text-muted">Tip: on the fan's ticket page, "Copy code" copies the live QR contents.</p>
        </Card>
      )}

      <ErrorNote error={error} className="mt-4" />
      {result && (
        <Result
          result={result}
          onNext={() => {
            setResult(null)
            setPasted('')
          }}
        />
      )}
      <div className="sr-only" aria-live="assertive">
        {result ? (result.valid ? 'Valid ticket' : `Rejected: ${GATE_RESULTS[result.result]}`) : ''}
      </div>
    </div>
  )
}
