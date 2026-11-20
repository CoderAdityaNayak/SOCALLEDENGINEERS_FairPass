// Loads backend settings from .env and the deployed contract info from contract.json.
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const backendRoot = path.join(here, '..')

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name} in backend/.env (see backend/.env.example)`)
  return value
}

const contractFile = path.join(here, 'contract.json')
if (!fs.existsSync(contractFile)) {
  throw new Error('backend/src/contract.json is missing. Deploy the contract first: npm run deploy')
}
const contract = JSON.parse(fs.readFileSync(contractFile, 'utf8'))

export const config = {
  port: Number(process.env.PORT || 8080),
  frontendOrigin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173',
  publicApiUrl: (process.env.PUBLIC_API_URL || 'http://localhost:8080').replace(/\/$/, ''),
  databasePath: path.resolve(backendRoot, process.env.DATABASE_PATH || './data/fairpass.db'),

  rpcUrl: process.env.RPC_URL || 'https://orchard.rpc.quai.network',
  explorer: contract.explorer || 'https://orchard.quaiscan.io',
  contract,

  organiserKey: required('ORGANISER_PK'),
  jwtSecret: required('JWT_SECRET'),
  serverSecret: required('SERVER_SECRET'), // encrypts custodial keys and peppers ID hashes

  rewardAddress: process.env.REWARD_ADDRESS,
  x402Amount: Number(process.env.X402_WORK_AMOUNT || 65536),
  x402Mode: process.env.X402_MODE || 'facilitator', // 'facilitator' (hosted x402 Work) or 'local'

  qrMaxAgeSeconds: Number(process.env.QR_MAX_AGE_SECONDS || 30),
  rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE || 30),

  // Gas sponsoring for custodial wallets (mocked fiat on-ramp)
  gasTopUpQuai: process.env.GAS_TOPUP_QUAI || '0.005',
  gasMinQuai: process.env.GAS_MIN_QUAI || '0.002',

  // Optional Firestore mirror (services/firestore.js). Empty FIREBASE_PROJECT_ID = disabled.
  firebase: {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
  },
  firestoreMirrorAllBlocked: process.env.FIRESTORE_MIRROR_ALL_BLOCKED === '1',

  demoMode: process.env.DEMO_MODE === '1',
  demoOtp: process.env.DEMO_FIXED_OTP || '', // e.g. 123456 so demo logins are easy
  organiserPhone: process.env.ORGANISER_PHONE || '+919000000001',
}
