// ₹ <-> QUAI. The contract works in wei (QUAI has 18 decimals); fans see rupees at a fixed mock rate
// (INR_PER_QUAI, default 450000, so 0.01 QUAI = ₹4,500). Payments are mocked fiat.
// Rule: every ₹ amount that is compared with an on-chain limit is derived FROM wei and rounded DOWN to the
// paisa, so converting it back never lands above the contract's cap.
import { quais } from 'quais'
import { config } from '../config.js'

const WEI = 10n ** 18n
const ratePaise = () => BigInt(Math.round(config.inrPerQuai * 100)) // paise per QUAI

/** ₹ (number or string) -> wei, rounded down. */
export function inrToWei(inr) {
  const paise = BigInt(Math.round(Number(inr) * 100))
  return (paise * WEI) / ratePaise()
}

/** wei -> ₹ (number with 2 decimals), rounded down to the paisa. */
export const weiToInr = (wei) => Number((BigInt(wei) * ratePaise()) / WEI) / 100

export const faceWei = (event) => quais.parseQuai(String(event.facePrice))

/** The exact on-chain maximum resale price: face × (100 + pct) / 100, integer division like Solidity. */
export const maxResaleWei = (event, pct = event.resaleCapPct) => (faceWei(event) * BigInt(100 + Number(pct))) / 100n

/** Face price in ₹ (the organiser's number when we have it). */
export const faceInr = (event) => (event.facePriceInr != null ? Number(event.facePriceInr) : weiToInr(faceWei(event)))

/** Wei worth one paisa: anything closer than this to the cap is rounding dust from the ₹ conversion. */
const onePaisaWei = () => WEI / ratePaise() + 1n

/**
 * The maximum resale price in ₹. Uses the clean figure (face ₹ × (100 + pct) / 100, e.g. ₹2,625) when it is
 * within one paisa of the exact on-chain cap; otherwise the cap rounded down to the paisa.
 */
export function maxResaleInr(event, pct = event.resaleCapPct) {
  const cap = maxResaleWei(event, pct)
  if (event.facePriceInr != null) {
    const clean = Math.round(Number(event.facePriceInr) * (100 + Number(pct))) / 100
    const diff = inrToWei(clean) - cap
    if ((diff < 0n ? -diff : diff) <= onePaisaWei()) return clean
  }
  return weiToInr(cap)
}

/**
 * Converts a listing price in ₹ to wei. A price at most one paisa above the cap (₹ rounding dust, e.g. listing
 * at the displayed ₹2,625) is snapped to the exact cap so it isn't rejected by the contract for 1 wei.
 */
export function listingWei(inr, event) {
  const wei = inrToWei(inr)
  const cap = maxResaleWei(event)
  return wei > cap && wei - cap <= onePaisaWei() ? cap : wei
}

export const formatInr = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
