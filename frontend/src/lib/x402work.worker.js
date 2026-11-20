// Web Worker: solves an x402 Work puzzle off the main thread so the UI stays smooth.
import { solveWork } from './x402work-core.js'

self.onmessage = (e) => {
  const { offer } = e.data
  try {
    const result = solveWork(offer, { onProgress: (guesses) => self.postMessage({ type: 'progress', guesses }) })
    self.postMessage({ type: 'done', ...result })
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message })
  }
}
