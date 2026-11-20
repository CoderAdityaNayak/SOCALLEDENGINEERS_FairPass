// Contract event listener: reads FairPass logs from Quai (Cyprus-1) and mirrors listing / sale / gift / return /
// reassign / cap events to Firestore (fairpass/live/chain_events). It follows the chain itself, so it also
// records actions that didn't go through this backend. Polls every CHAIN_POLL_SECONDS (15); the last block read
// is kept in the meta table so a restart continues where it stopped.
import { config } from '../config.js'
import { db } from '../db.js'
import { contract, explorerTx, provider, quais } from './quai.js'
import { writeChainEvent } from './firestore.js'

const WATCHED = new Set([
  'TicketMinted',
  'TicketListed',
  'ListingCancelled',
  'TicketResold',
  'TicketGifted',
  'TicketReturned',
  'TicketReassigned',
  'TicketUsed',
  'ResaleCapChanged',
])
const CYPRUS1 = [0, 0] // region 0, zone 0
const CHUNK = 5000 // blocks per getLogs call

export const listenerStatus = { running: false, lastBlock: null, mirrored: 0, lastError: null }

const getMeta = (k) => db.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value
const setMeta = (k, v) => db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(k, String(v))
const nameOf = (address) =>
  typeof address === 'string' ? db.prepare('SELECT name FROM users WHERE lower(walletAddress) = lower(?)').get(address)?.name ?? null : null

function describe(parsed) {
  const out = {}
  parsed.fragment.inputs.forEach((input, i) => {
    const v = parsed.args[i]
    out[input.name] = typeof v === 'bigint' ? v.toString() : v
    if (input.type === 'address') out[`${input.name}Name`] = nameOf(v)
  })
  if (out.price) out.priceQuai = quais.formatQuai(BigInt(out.price))
  if (out.allowedBuyer !== undefined) out.visibility = /^0x0+$/.test(out.allowedBuyer) ? 'public' : 'private'
  return out
}

async function poll() {
  const latest = await provider.getBlockNumber(quais.Shard.Cyprus1)
  let from = Number(getMeta('chainBlock') ?? 0) + 1
  if (from <= 1) {
    const receipt = config.contract.deployTx ? await provider.getTransactionReceipt(config.contract.deployTx) : null
    from = receipt?.blockNumber ?? latest
  }
  while (from <= latest) {
    const to = Math.min(latest, from + CHUNK - 1)
    const logs = await provider.getLogs({ address: config.contract.address, fromBlock: from, toBlock: to, nodeLocation: CYPRUS1 })
    for (const log of logs) {
      let parsed
      try {
        parsed = contract.interface.parseLog(log)
      } catch {
        continue
      }
      if (!parsed || !WATCHED.has(parsed.name)) continue
      const args = describe(parsed)
      await writeChainEvent(`${log.transactionHash}_${log.index}`, {
        event: parsed.name,
        tokenId: args.tokenId ?? null,
        chainEventId: args.eventId ?? null,
        args,
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
        txUrl: explorerTx(log.transactionHash),
        contract: config.contract.address,
      })
      listenerStatus.mirrored++
    }
    setMeta('chainBlock', to)
    listenerStatus.lastBlock = to
    from = to + 1
  }
}

/** Starts the listener (only useful when the Firestore mirror is on). */
export function startChainListener() {
  if (listenerStatus.running) return
  listenerStatus.running = true
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      await poll()
      listenerStatus.lastError = null
    } catch (err) {
      listenerStatus.lastError = err.shortMessage || err.message
    } finally {
      busy = false
    }
  }
  tick()
  setInterval(tick, Math.max(5, Number(process.env.CHAIN_POLL_SECONDS || 15)) * 1000).unref()
}
