// Express app: middleware, routes and error handling.
import express from 'express'
import cors from 'cors'
import { config } from './config.js'
import { HttpError } from './auth.js'
import { ChainError } from './services/quai.js'
import { router as authRouter } from './routes/auth.js'
import { router as eventsRouter } from './routes/events.js'
import { router as lotteryRouter } from './routes/lottery.js'
import { router as ticketsRouter } from './routes/tickets.js'
import { router as gateRouter } from './routes/gate.js'
import { router as corporateRouter } from './routes/corporate.js'

export function createApp() {
  const app = express()
  app.set('trust proxy', false) // use the real socket IP for rate limits; don't trust X-Forwarded-For
  app.use(express.json({ limit: '100kb' }))
  app.use(
    cors({
      origin: config.frontendOrigin,
      // x402 Work uses these headers; the browser must be allowed to send/read them.
      allowedHeaders: ['content-type', 'authorization', 'payment-signature', 'x-fairpass-demo-client'],
      exposedHeaders: ['payment-required', 'payment-response'],
    }),
  )

  app.get('/health', (_req, res) => res.json({ ok: true, contract: config.contract.address, chainId: config.contract.chainId }))
  app.use('/auth', authRouter)
  app.use('/events', eventsRouter)
  app.use('/events', lotteryRouter)
  app.use('/corporate', corporateRouter)
  app.use(ticketsRouter)
  app.use(gateRouter)

  app.use((_req, _res, next) => next(new HttpError(404, 'Not found')))
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra })
    if (err instanceof ChainError) {
      console.error(`[chain] ${req.method} ${req.path}: ${err.message}`)
      return res.status(err.status).json({ error: err.message, reason: err.reason })
    }
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' })
    console.error(`[error] ${req.method} ${req.path}`, err)
    res.status(500).json({ error: 'Something went wrong' })
  })
  return app
}
