// Small fetch wrapper for the FairPass backend.
export const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:8080').replace(/\/$/, '')

const TOKEN_KEY = 'fairpass_token'

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}
export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {}
}

export class ApiError extends Error {
  constructor(status, data) {
    super(data?.error || `Request failed (${status})`)
    this.status = status
    this.reason = data?.reason
    this.data = data
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const token = getToken()
  let res
  try {
    res = await fetch(API_URL + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, { error: 'Cannot reach the FairPass server. Is the backend running?' })
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, data)
  return data
}

export const authHeaders = () => {
  const token = getToken()
  return token ? { authorization: `Bearer ${token}` } : {}
}
