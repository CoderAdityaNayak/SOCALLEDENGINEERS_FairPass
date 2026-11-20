// Browser version of payWithWork: POST, and if the server answers 402 with an x402 Work puzzle,
// solve it in a Web Worker and repeat the identical request with the PAYMENT-SIGNATURE header.
import { decodeHeader, encodeHeader, pickOffer } from './x402work-core.js'

function solveInWorker(offer, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./x402work.worker.js', import.meta.url), { type: 'module' })
    worker.onmessage = (e) => {
      if (e.data.type === 'progress') onProgress?.(e.data.guesses)
      else {
        worker.terminate()
        if (e.data.type === 'done') resolve(e.data)
        else reject(new Error(e.data.message))
      }
    }
    worker.onerror = (e) => {
      worker.terminate()
      reject(new Error(e.message || 'Puzzle solver crashed'))
    }
    worker.postMessage({ offer })
  })
}

/**
 * @param {string} url
 * @param {object} body          JSON body (sent byte-identically on the retry)
 * @param {object} opts          { headers, onChallenge(offer), onProgress(guesses, expected), maxPrice }
 * @returns {{ response: Response, data: any, payment?: { guesses, milliseconds, amount, network, receipt } }}
 */
export async function payWithWork(url, body, { headers = {}, onChallenge, onProgress, maxPrice } = {}) {
  const payload = JSON.stringify(body)
  const send = (extra = {}) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers, ...extra }, body: payload })

  const first = await send()
  const challenge = first.status === 402 && first.headers.get('payment-required')
  if (!challenge) return { response: first, data: await first.json().catch(() => ({})) }

  const required = decodeHeader(challenge)
  const offer = pickOffer(required, { maxPrice })
  onChallenge?.(offer)
  const started = performance.now()
  const { solution, guesses } = await solveInWorker(offer, (g) => onProgress?.(g, Number(offer.amount)))
  const milliseconds = Math.round(performance.now() - started)

  const paid = await send({
    'payment-signature': encodeHeader({ x402Version: 2, resource: required.resource, accepted: offer, payload: { solution } }),
  })
  const receiptHeader = paid.headers.get('payment-response')
  return {
    response: paid,
    data: await paid.json().catch(() => ({})),
    payment: {
      guesses,
      milliseconds,
      amount: Number(offer.amount),
      network: offer.network,
      receipt: receiptHeader ? decodeHeader(receiptHeader) : null,
    },
  }
}
