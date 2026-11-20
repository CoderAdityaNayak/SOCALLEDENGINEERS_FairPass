// All blockchain access goes through here, using the quais SDK (Quai's fork of ethers v6).
import crypto from 'node:crypto'
import { quais } from 'quais'
import { config } from '../config.js'

export const provider = new quais.JsonRpcProvider(config.rpcUrl, undefined, { usePathing: true })
export const organiser = new quais.Wallet(config.organiserKey, provider)
export const contract = new quais.Contract(config.contract.address, config.contract.abi, provider)
const iface = contract.interface

export const explorerTx = (hash) => `${config.explorer}/tx/${hash}`
export const explorerAddress = (addr) => `${config.explorer}/address/${addr}`
export const explorerToken = (tokenId) => `${config.explorer}/token/${config.contract.address}/instance/${tokenId}`

// ------------------------------------------------------------------ custodial wallets

/** True if the address is a Quai-ledger address in zone Cyprus-1. */
export function isCyprus1(address) {
  try {
    return quais.isQuaiAddress(address) && quais.getZoneForAddress(address) === quais.Zone.Cyprus1
  } catch {
    return false
  }
}

/** A fresh Cyprus-1 wallet: random keys until the address lands in Cyprus-1 (about 1 in 512). */
export function createCyprus1Wallet() {
  for (;;) {
    const wallet = new quais.Wallet('0x' + crypto.randomBytes(32).toString('hex'))
    if (isCyprus1(wallet.address)) return wallet
  }
}

const walletKey = crypto.scryptSync(config.serverSecret, 'fairpass-custodial-wallet', 32)

/** AES-256-GCM: iv(12) | tag(16) | ciphertext, hex encoded. */
export function encryptKey(privateKey) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', walletKey, iv)
  const enc = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('hex')
}

export function decryptKey(encHex) {
  const buf = Buffer.from(encHex, 'hex')
  const decipher = crypto.createDecipheriv('aes-256-gcm', walletKey, buf.subarray(0, 12))
  decipher.setAuthTag(buf.subarray(12, 28))
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8')
}

/** The signing wallet for a user row (custodial key, or the organiser's own key). */
export function walletForUser(user) {
  if (user.encKey) return new quais.Wallet(decryptKey(user.encKey), provider)
  if (user.walletAddress?.toLowerCase() === organiser.address.toLowerCase()) return organiser
  throw new Error('This user has no key held by FairPass')
}

// ------------------------------------------------------------------ transaction queue

// One queue per signer so two requests never race for the same nonce.
const queues = new Map()
function enqueue(address, job) {
  const key = address.toLowerCase()
  const run = (queues.get(key) || Promise.resolve()).then(job, job)
  queues.set(
    key,
    run.catch(() => {}),
  )
  return run
}

/** Turns a revert into the contract's custom error name (e.g. "PriceAboveCap") where possible. */
export function decodeError(err) {
  const data = err?.data ?? err?.info?.error?.data ?? err?.error?.data ?? err?.revert?.data
  if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) {
    try {
      const parsed = iface.parseError(data)
      if (parsed) return { name: parsed.name, args: parsed.args.map(String) }
    } catch {}
  }
  if (err?.revert?.name) return { name: err.revert.name, args: (err.revert.args || []).map(String) }
  return { name: null, message: err?.shortMessage || err?.message || String(err) }
}

export class ChainError extends Error {
  constructor(err, action) {
    const info = decodeError(err)
    super(info.name ? `${action} reverted: ${info.name}` : `${action} failed: ${info.message}`)
    this.reason = info.name
    this.status = info.name ? 409 : 502
  }
}

// Orchard blocks take 10-50 s to confirm a transaction. Instead of waiting for each one, we hand out
// nonces ourselves: broadcasts are serialized per signer (fast), confirmations are awaited in parallel.
const nonces = new Map()

/** Broadcasts `sendFn(nonce)` with the signer's next nonce. Returns the sent transaction. */
function broadcast(wallet, sendFn) {
  const key = wallet.address.toLowerCase()
  return enqueue(wallet.address, async () => {
    let nonce = nonces.get(key)
    if (nonce === undefined) nonce = await provider.getTransactionCount(wallet.address, 'pending')
    try {
      const tx = await sendFn(nonce)
      nonces.set(key, nonce + 1)
      return tx
    } catch (err) {
      nonces.delete(key) // resync from the node next time
      throw err
    }
  })
}

/** Broadcasts a contract call from `wallet` (gas estimation catches reverts here). Returns the tx. */
async function submit(wallet, action, method, args, overrides = {}) {
  try {
    const c = contract.connect(wallet)
    return await broadcast(wallet, (nonce) => c[method](...args, { ...overrides, nonce }))
  } catch (err) {
    throw new ChainError(err, action)
  }
}

/** Waits for a tx to be mined; returns { hash, receipt, events }. */
async function confirm(tx, action) {
  try {
    const receipt = await tx.wait()
    const events = []
    for (const log of receipt.logs || []) {
      try {
        const parsed = iface.parseLog(log)
        if (parsed) events.push(parsed)
      } catch {}
    }
    return { hash: tx.hash, receipt, events }
  } catch (err) {
    throw new ChainError(err, action)
  }
}

/** Sends a contract call from `wallet`, waits for it to be mined, returns { hash, receipt, events }. */
async function send(wallet, action, method, args, overrides = {}) {
  return confirm(await submit(wallet, action, method, args, overrides), action)
}

// ------------------------------------------------------------------ gas sponsoring (mocked fiat)

/** Tops up a custodial wallet so it can pay gas (and `extraWei` for a purchase). Organiser pays. */
export async function sponsor(address, extraWei = 0n) {
  const balance = await provider.getBalance(address)
  const min = quais.parseQuai(config.gasMinQuai) + extraWei
  if (balance >= min) return null
  const value = quais.parseQuai(config.gasTopUpQuai) + extraWei
  const tx = await broadcast(organiser, (nonce) =>
    organiser.sendTransaction({ from: organiser.address, to: address, value, nonce }),
  )
  await tx.wait()
  return tx.hash
}

// ------------------------------------------------------------------ reads

export async function ownerOf(tokenId) {
  try {
    return await contract.ownerOf(tokenId)
  } catch (err) {
    const info = decodeError(err)
    if (info.name === 'ERC721NonexistentToken' || /nonexistent|revert/i.test(info.message || '')) return null
    throw err
  }
}

export const isUsed = (tokenId) => contract.used(tokenId)
export const isValid = (tokenId) => contract.isValid(tokenId)
export const listedPrice = (tokenId) => contract.listedPrice(tokenId)
export const maxResalePrice = (tokenId) => contract.maxResalePrice(tokenId)
export const chainEvent = (eventId) => contract.events(eventId)

// ------------------------------------------------------------------ organiser writes

export async function createEvent({ name, date, facePrice, maxSupply, resaleCapPct }) {
  const r = await send(organiser, 'createEvent', 'createEvent', [name, Math.floor(new Date(date).getTime() / 1000), quais.parseQuai(String(facePrice)), maxSupply, resaleCapPct])
  const ev = r.events.find((e) => e.name === 'EventCreated')
  return { chainEventId: Number(ev.args.eventId), hash: r.hash }
}

/** Mints `quantity` tickets to one wallet in a single transaction. Returns all new token ids. */
export async function mintTickets(to, chainEventId, quantity = 1) {
  const r = await send(organiser, 'mintTickets', 'mintTickets', [to, chainEventId, quantity])
  const tokenIds = r.events.filter((e) => e.name === 'TicketMinted').map((e) => Number(e.args.tokenId))
  if (tokenIds.length !== quantity) throw new Error(`mintTickets: expected ${quantity} tickets, saw ${tokenIds.length}`)
  return { tokenIds, hash: r.hash }
}

/** Organiser changes the event's resale cap on-chain; waits for confirmation. */
export async function setResaleCap(chainEventId, pct) {
  return send(organiser, 'setResaleCap', 'setResaleCap', [chainEventId, pct])
}

export async function markUsed(tokenId) {
  return send(organiser, 'markUsed', 'markUsed', [tokenId])
}

/** For the gate: returns as soon as markUsed is broadcast; `confirmed` resolves when it is mined. */
export async function markUsedFast(tokenId) {
  const tx = await submit(organiser, 'markUsed', 'markUsed', [tokenId])
  return { hash: tx.hash, confirmed: confirm(tx, 'markUsed') }
}

export async function reassign(tokenId, to) {
  return send(organiser, 'reassign', 'reassign', [tokenId, to])
}

export async function addGateStaff(address) {
  return send(organiser, 'addGateStaff', 'addGateStaff', [address])
}

// ------------------------------------------------------------------ ticket-holder writes (custodial)

export async function listForResale(wallet, tokenId, priceWei) {
  await sponsor(wallet.address)
  return send(wallet, 'listForResale', 'listForResale', [tokenId, priceWei])
}

export async function cancelListing(wallet, tokenId) {
  await sponsor(wallet.address)
  return send(wallet, 'cancelListing', 'cancelListing', [tokenId])
}

export async function buyResale(wallet, tokenId, priceWei) {
  await sponsor(wallet.address, priceWei) // mock: the fan "pays" fiat, the organiser funds the wallet
  return send(wallet, 'buyResale', 'buyResale', [tokenId], { value: priceWei })
}

export async function returnToPool(wallet, tokenId) {
  await sponsor(wallet.address)
  return send(wallet, 'returnToPool', 'returnToPool', [tokenId])
}

export { quais }
