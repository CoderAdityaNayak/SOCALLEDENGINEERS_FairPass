# FairPass

Fair concert ticketing on Quai Network. Hackathon project (Cybersecurity & Blockchain, problem B2 "Fair tickets").
The developer is new to blockchain: give a one-line explanation of what you are doing at each phase/step.

Working rules: work through the phases in order. After each phase: run/test it, fix errors, git commit with a clear
message. Only stop to ask for things only the user can do (e.g. a deploy with their private key).

## Problem

Sept 2024: 1.3 crore people queued on BookMyShow for Coldplay Mumbai. Sold out in minutes; bots took lakhs of queue
spots; resale up to ₹3 lakh. Fake tickets sold on Instagram/WhatsApp/Telegram; the ED raided 5 cities.
Goal: fans get tickets at a fair price, resale is possible but can't be exploited, and a fake ticket is useless at the gate.

## Solution

1. **Fair entry**: lottery instead of first-come. **One entry per verified person per event**; the fan chooses how many
   tickets they want (`quantity`, min 1, max the tickets in the draw). There is NO per-person ticket cap any more.
   Every entry carries an **x402 Work** proof-of-work and the per-IP rate limit applies (these ARE the anti-bot
   protection and must stay). The draw uses **commit-reveal** (publish sha256(seed) when the lottery opens, reveal seed
   at draw) so anyone can verify it. In draw order each winner gets the quantity they asked for; when supply runs out
   mid-draw that entry gets what's left (`ticketsWon`, status `partial`) and the rest of its quantity is waitlisted;
   everyone after is waitlisted.
2. **Fair resale**: tickets are ERC-721 NFTs that can ONLY move through the contract. Resale price ≤
   `facePrice × (100 + resaleCapPct) / 100`. **The organiser controls `resaleCapPct` per event** (0–100, default 10;
   0 = resale only at face price) with `setResaleCap` on-chain. `buyResale` re-checks the CURRENT cap, so lowering the
   cap makes existing listings above it unbuyable; the backend marks them `listingInvalid = "invalid – above new cap"`
   and the seller sees a warning. **Return to pool**: seller gets face price back and the ticket goes to the next
   waitlisted fan (seller can't pick the buyer, which kills cash side deals).
3. **Real tickets**: only contract-minted tokens are valid. Fan QR = `{tokenId, timestamp, signature}`, refreshed every 30 s.
   Gate checks: fresh (< 30 s), signer == `ownerOf(tokenId)` on-chain, not used → then `markUsed` on-chain.
4. ~~Corporate booking~~ was **removed** (contract, backend, Firestore, frontend, demo). Don't reintroduce it.

**Prices in ₹**: on-chain prices are QUAI (wei). Each event also stores `facePriceInr`; the UI shows ₹ using a fixed
mock rate `INR_PER_QUAI` (default 450000, so 0.01 QUAI = ₹4,500). Payments are mocked fiat. Listing prices are entered
in ₹ and converted to wei with floor division, then checked against the exact on-chain cap in wei.

## Tech (must follow)

- **Chain**: Quai Orchard testnet, zone Cyprus-1, chainId `15000`, RPC `https://orchard.rpc.quai.network/cyprus1`,
  explorer https://orchard.quaiscan.io, faucet https://orchard.faucet.quai.network
- **Solidity 0.8.20** (max on Quai), `evmVersion: 'london'`, optimizer on, `metadata: { bytecodeHash: 'ipfs', useLiteralContent: true }`.
- **OpenZeppelin pinned to 5.4.0.** 5.5+ needs `pragma ^0.8.24` and will not compile. Hardhat **2** (2.29.2) + toolbox 6.1.2.
- **`quais` SDK (1.0.0-alpha.58), NOT ethers**, in backend/frontend/scripts. (Hardhat unit tests use `hre.ethers` from
  the toolbox on the in-process Hardhat network; that is the only place ethers is allowed.)
- **Addresses must be Cyprus-1** (`quais.getZoneForAddress(a) === quais.Zone.Cyprus1`, i.e. prefix `0x00`, 2nd byte < 0x80,
  and `quais.isQuaiAddress(a)`). `quais.Wallet.createRandom` does not exist: make custodial wallets by generating random
  32-byte keys with `new quais.Wallet(key)` until the address is in Cyprus-1 (~500 tries, milliseconds).
- **RPC gotcha**: with `usePathing: true`, pass the BASE URL `https://orchard.rpc.quai.network` (quais appends
  `/cyprus1` itself). Passing `.../cyprus1` with usePathing hangs forever. Zone-specific reads need the shard:
  `provider.getBlockNumber(quais.Shard.Cyprus1)` (no argument = Prime chain). Address-based calls route automatically.
- quais facts: `new quais.JsonRpcProvider(RPC, undefined, { usePathing: true })`; `wallet.signMessage(msg)`;
  `quais.verifyMessage(msg, sig)` returns the address; `quais.parseQuai` / `formatQuai`.
- **Deploy**: `new quais.ContractFactory(abi, bytecode, wallet, ipfsHash)` → `deploy(...)` → `waitForDeployment()` →
  `getAddress()`. quais REQUIRES a 46-char IPFS CID. `@quai/hardhat-deploy-metadata`'s upload fails against ipfs.qu.ai
  (kubo 0.17) and silently returns "", so `deploy.js` computes the CID locally (`ipfs-only-hash` of the solc metadata,
  checked against the bytecode) and uploads with plain `fetch` (`add?pin=false`; `pin=true` → 504). Hardhat console
  doesn't work with Quai; use scripts.

### Deployed (Orchard, Cyprus-1)

- FairPass: `0x002cb29004b6A97790464e2411173C6204f1A869` — https://orchard.quaiscan.io/address/0x002cb29004b6A97790464e2411173C6204f1A869
- Owner / organiser / gate staff (user's Pelagus wallet): `0x001EbFd19D321Ac69CB7E7E8C1268Ea19ab94b83`
- Demo event id 1: "[Headliner] World Tour", 0.01 QUAI, 100 seats, cap 10%. Metadata CID `QmWK2fsTqXndrkecJHxSY353JdJmvaTMKNcb6a3VkMkV7Q`.
- `backend/src/contract.json` / `frontend/src/contract.json` hold `{address, abi, chainId, ...}` (committed; no secrets).
- The backend must sign as the owner: `backend/.env` `ORGANISER_PK` = the same key as `contracts/.env` `PRIVATE_KEY`.
- **Wallet**: Pelagus optional (`new quais.BrowserProvider(window.pelagus)`, connect with `send('quai_requestAccounts')`).
  Fans without a wallet get a custodial Cyprus-1 wallet created by the backend (private key encrypted with a server secret).
  The organiser wallet sponsors gas/payment for custodial wallets (mocked fiat).
- **Backend**: Node 20+ ESM, Express 5, better-sqlite3, JWT. **Frontend**: React 19 + Vite + Tailwind v4 + react-router +
  qrcode.react + html5-qrcode.

### x402 Work (anti-bot)

- Flow: POST → `402` + `PAYMENT-REQUIRED` (base64 JSON offer with a mining job) → client solves → repeats the
  **byte-identical** request with `PAYMENT-SIGNATURE` → server settles via facilitator → `200` + `PAYMENT-RESPONSE`.
- Server: `x402-work-client` from `https://x402.qu.ai/x402-work-client-0.4.1.tgz` (sha256 `2a276f40…523a`), `workSeller({ payTo, amount })`
  then `charge({ url, description, paymentSignature })` → `{paid:false,status:402,headers,body}` or `{paid:true,receipt,headers}`;
  throws `WorkSellerError {status, code, retryAfter}` when the facilitator is down/rate-limited.
- Profile `quai/sha256d-v1`, facilitator network is `quai:9` (mainnet work; separate from our Orchard contracts). payTo = organiser address.
- **`x402-work-client` is Node-only** (imports `node:crypto`, uses `Buffer`). The browser uses our own port of its
  `solveWork` in a Web Worker (`frontend/src/lib/x402work.*`), tested against the published worked example
  (amount 4096 → nonce `0x00000375`). Browser ≈ 50k guesses/s, so keep `amount` small (e.g. 65536 ≈ 1–3 s on a phone).
- Server pre-verifies every proof locally (package exports `workHeader`, `workDigest`, `workScore`, `workTarget`)
  and binds job ids to the user that requested them, so garbage proofs never reach the facilitator.
  Cheap checks (auth, KYC, duplicate ID, rate limit) run BEFORE a challenge is requested.
- **The facilitator gives the SAME job to everyone who asks within a few seconds** (fans compete with different
  solutions; each solution settles once). So issued puzzles are keyed by `jobId:userId`, never by jobId alone.
- Fallback `X402_MODE=local` (or automatic when the facilitator is down): FairPass issues identical-shape SHA-256d jobs on
  network `quai:15000` and verifies them itself.
- Jobs expire in ~15 s; a proof is spent once. CORS: allow `payment-signature`, expose `payment-required`, `payment-response`.

## Phases

1. **Setup**: monorepo, .gitignore, .env.example per part, this file, git. ✅
2. **Contract** ✅ `contracts/contracts/FairPass.sol`: `struct Event {name, date, facePrice, maxSupply, minted, resaleCapPct, organiser}`;
   mappings events, ticketEvent, used, listedPrice, gateStaff; `createEvent` (cap 0–100) / `mintTicket(to,eventId)` /
   `mintTickets(to,eventId,quantity)` onlyOwner; `setResaleCap(eventId,newPct)` onlyOwner (0–100, emits
   `ResaleCapChanged(eventId, oldPct, newPct)`); `listForResale` (owner, not used, ≤ current cap); `cancelListing`;
   `buyResale` payable (exact price, re-checks the CURRENT cap, seller paid, 2% royalty to organiser); `returnToPool`
   (to contract owner); `reassign` onlyOwner; `markUsed` onlyGateStaff; `isValid`; `addGateStaff`. `_update` override:
   tokens move ONLY via mint/buyResale/returnToPool/reassign. Hardhat tests for every rule.
3. **Deploy** ✅: `contracts/scripts/deploy.js` deploys, creates "[Headliner] World Tour" (0.01 QUAI, 100 supply, cap 10),
   adds deployer as gate staff, writes `{address, abi, chainId}` to `backend/src/contract.json` and `frontend/src/contract.json`.
   User runs it with their funded Pelagus Cyprus-1 key (`npm run deploy`). Fallback: local Hardhat network.
4. **Backend core** ✅: SQLite tables users, events, entries, tickets, scans, blocked_attempts, activity, pow_challenges;
   `src/services/quai.js`; mock OTP auth (OTP printed to console) + JWT + custodial wallet; KYC (ID → keyed hash, duplicate → 409
   + blocked_attempts); events (organiser → createEvent on-chain, `facePriceInr` + `resaleCapPct`); role middleware;
   random block/row/seat at mint.
5. **Lottery + anti-bot** ✅: `POST /events/:id/enter {quantity}` (x402 Work + verified + one entry per idHash per event +
   IP rate limit; every rejection logged); commit-reveal draw with partial fill `POST /events/:id/draw`,
   `GET /events/:id/draw-proof`, `GET /events/:id/stats`; `scripts/bot-attack.js` (10,000 attempts).
6. **Tickets/gate/resale** ✅: `/me/tickets`, `/tickets/:id/qr`, `/gate/verify` (EXPIRED / NOT_ON_CHAIN / NOT_OWNER /
   ALREADY_USED / VALID), list (`priceInr`) / cancel / buy / return, `POST /events/:id/resale-cap {pct}` (organiser:
   setResaleCap on Quai, wait for confirmation, save pct + tx, mark listings above the new max invalid), `scripts/e2e.js`.
7. **Frontend** ✅: dark mobile-first design (bg #0B0D12, cards #151922, borders #262C38, text #F2F4F8, muted #9AA3B2, lime #C6F432 with
   dark text, error #C62828/#FF8A8A; Space Grotesk 700 headings, Inter body; radius 14–22px; stroke SVG icons; no emoji).
   Pages: Login, Home/Event, Enter lottery (quantity input), My ticket, Resale, Gate scanner, Organiser dashboard
   (create-event form with resale % + live ₹ preview, "Resale settings" card); Pelagus connect; role nav.
   The event page and resale page read the live cap from Firestore `fairpass/live/events/{id}` with `onSnapshot`
   (frontend `firebase` + `VITE_FIREBASE_*`), falling back to API polling when Firebase isn't configured.
8. **Demo** ✅: `npm run demo` (resets backend/data/demo.db, DEMO_MODE=1 + DEMO_FIXED_OTP=123456, creates a fresh on-chain
   event with 3 lottery tickets and cap 10%, seeds organiser 9000000001, staff 9000000002, fans 9000000011-15 (2-5
   pre-entered)), README.md.

### Demo script

1. bot-attack → dashboard shows blocked count
2. fans enter choosing how many tickets (PoW visible) → organiser runs draw → winners minted on Quai (Quaiscan link)
3. organiser sets resale to 15% (Resale settings card, on-chain tx) → a winner tries to list above +15% → rejected
   (red error); lists at +12% instead → organiser lowers the cap to 5% → that listing shows "invalid – above new cap"
   for the seller and can't be bought
4. return to pool → the waitlisted fan gets the ticket
5. gate: expired QR → REJECTED, fake → REJECTED, real → VALID, rescan → ALREADY_USED

## Folder structure

```
/
├── CLAUDE.md, README.md, package.json (npm workspaces)
├── contracts/   Hardhat 2: contracts/FairPass.sol, scripts/deploy.js, test/
├── backend/     Express API: src/index.js, src/db.js, src/routes/*, src/services/{quai,x402}.js, src/contract.json
├── frontend/    React + Vite + Tailwind: src/pages/*, src/lib/*, src/contract.json
└── scripts/     bot-attack.js, e2e.js, seed/demo helpers
```

Each part has `.env.example`; copy to `.env` (git-ignored). Never commit private keys. `*.db` is ignored.

## Commands

- `npm install` (root) · `npm run compile` · `npm run test:contracts` (20) · `npm run test:backend` (21, real Orchard + facilitator, ~6 min) · `npm test -w frontend`
- `npm run demo` · `npm run bot-attack` · `npm run e2e` (against a running API with DEMO_MODE=1)
- `npm run deploy` (Orchard, needs `contracts/.env` PRIVATE_KEY) · `npm run dev:backend` · `npm run dev:frontend`

## Implementation notes

- Orchard txs take 20-50 s. The backend hands out nonces itself (`services/quai.js` broadcast queue per signer) so
  several txs are broadcast back-to-back and confirmed in parallel. The gate locks the ticket in SQLite, broadcasts
  `markUsed` and answers VALID immediately (`markUsedFast`).
- JWTs carry the DB instance id (`meta` table), so tokens from a reset database are rejected.
- **Firestore mirror** (`services/firestore.js`, firebase 13.4.0 `firestore/lite`, web config in `backend/.env`, project
  navya-e59a8 in test mode): SQLite stays the source of truth; TEMP triggers on every table call the JS function
  `fs_sync`, a flusher batch-writes rows to `fairpass/live/{table}/{pk}` every ~0.5 s. Self-healing `reconcile()`: at
  startup (full rewrite if `fairpass/live.instanceId` differs) and every FIRESTORE_CHECK_SECONDS (60) it compares
  document counts with SQLite, re-uploads deleted docs and removes leftovers; rows are re-read at write time and
  deletions re-checked, so concurrent changes aren't clobbered. `POST /admin/firestore/resync` (organiser) forces it;
  the organiser dashboard shows the status. Excluded: `users.encKey`,
  `events.seed` before the draw. `blocked_attempts` go to `blocked_summary/{eventId}` unless FIRESTORE_MIRROR_ALL_BLOCKED=1.
  If test-mode rules expire, writes fail with permission-denied (logged, retried); the app keeps working.
- DEMO_MODE only: OTPs are returned in API responses, and `x-fairpass-demo-client` splits the rate-limit bucket so the bot
  simulator doesn't lock the presenter's browser out. Both are ignored outside demo mode.
- Gate pass message: `FairPass gate pass\ncontract: <addr>\nchain: <id>\ntoken: <id>\ntime: <unix>` (services/gatepass.js).
- Shell gotcha: never put Markdown with backticks inside a double-quoted `node -e "..."`; bash runs them as commands.
