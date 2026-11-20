// Small API client shared by bot-attack, e2e and demo scripts.
import { payWithWork } from 'x402-work-client'

export const API = (process.env.API_URL || 'http://localhost:8080').replace(/\/$/, '')

export async function api(method, path, { body, token, headers = {} } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data = {}
  try {
    data = await res.json()
  } catch {}
  return { status: res.status, data, headers: res.headers }
}

export async function must(promise, what) {
  const r = await promise
  if (r.status >= 400) throw new Error(`${what} failed: HTTP ${r.status} ${JSON.stringify(r.data)}`)
  return r.data
}

/** Phone login; needs DEMO_MODE=1 on the backend (OTP is returned in the response). */
export async function login(phone) {
  const otp = await must(api('POST', '/auth/otp', { body: { phone } }), `OTP for ${phone}`)
  if (!otp.devOtp) throw new Error('Backend is not in DEMO_MODE, so scripts cannot read the OTP')
  return must(api('POST', '/auth/verify', { body: { phone, otp: otp.devOtp } }), `login ${phone}`)
}

export async function verifyId(token, name, idNumber) {
  return api('POST', '/auth/kyc', { token, body: { name, idNumber } })
}

/** A random valid-looking Aadhaar number (12 digits, first digit 2-9). */
export const randomAadhaar = () =>
  String(2 + Math.floor(Math.random() * 8)) + Array.from({ length: 11 }, () => Math.floor(Math.random() * 10)).join('')

/** Enters the lottery solving the x402 Work puzzle (Node solver from x402-work-client). */
export async function enterWithWork(token, eventId, quantity = 1) {
  const { response, payment } = await payWithWork(
    `${API}/events/${eventId}/enter`,
    { quantity },
    { headers: { authorization: `Bearer ${token}` }, maxPrice: 1_000_000 },
  )
  let data = {}
  try {
    data = await response.json()
  } catch {}
  return { status: response.status, data, payment }
}

/** Buys a resale listing, solving the x402 Work puzzle like a fan's browser does. */
export async function buyWithWork(token, listingId) {
  const { response, payment } = await payWithWork(`${API}/listings/${listingId}/buy`, {}, { headers: { authorization: `Bearer ${token}` }, maxPrice: 1_000_000 })
  let data = {}
  try {
    data = await response.json()
  } catch {}
  return { status: response.status, data, payment }
}

/** Runs async jobs with a concurrency limit. */
export async function pool(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        results[i] = await fn(items[i], i)
      }
    }),
  )
  return results
}

export const fmt = (n) => n.toLocaleString('en-IN')
