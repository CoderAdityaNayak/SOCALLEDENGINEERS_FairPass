// Skeleton only. Feature routes (lottery, resale, gate, corporate) come later.
import 'dotenv/config'
import express from 'express'
import cors from 'cors'

const app = express()
app.use(express.json())
app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173',
    // x402 Work uses these headers; the browser must be allowed to send/read them.
    allowedHeaders: ['content-type', 'payment-signature'],
    exposedHeaders: ['payment-required', 'payment-response'],
  }),
)

app.get('/health', (_req, res) => res.json({ ok: true }))

const port = Number(process.env.PORT || 8080)
app.listen(port, () => console.log(`backend listening on http://localhost:${port}`))
