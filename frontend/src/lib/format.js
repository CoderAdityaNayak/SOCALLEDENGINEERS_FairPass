import contract from '../contract.json'

export const EXPLORER = contract.explorer || 'https://orchard.quaiscan.io'
export const CONTRACT_ADDRESS = contract.address
export const explorerAddress = (a) => `${EXPLORER}/address/${a}`

export const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')
export const quai = (v) => `${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 6 })} QUAI`
export const num = (n) => Number(n || 0).toLocaleString('en-IN')

export const dateLong = (iso) =>
  new Date(iso).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
export const dateShort = (iso) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
export const timeShort = (iso) =>
  new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/** SQLite "YYYY-MM-DD HH:MM:SS" (UTC) -> local time */
export const sqlTime = (s) => new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z').toLocaleTimeString('en-IN')

export const REASONS = {
  NO_ID: 'No account',
  NOT_VERIFIED: 'ID not verified',
  DUPLICATE_ENTRY: 'Duplicate ID',
  DUPLICATE_ID: 'Stolen / reused ID',
  RATE_LIMITED: 'Rate limited',
  INVALID_POW: 'Fake proof-of-work',
  NO_POW_SUBMITTED: 'Puzzle never solved',
  LOTTERY_CLOSED: 'Lottery closed',
  ENTERED: 'Entered',
}

export const GATE_RESULTS = {
  VALID: 'Valid ticket',
  EXPIRED: 'Expired QR',
  NOT_ON_CHAIN: 'Not on-chain',
  NOT_OWNER: 'Not the owner',
  ALREADY_USED: 'Already used',
  MALFORMED: 'Not a FairPass QR',
}
