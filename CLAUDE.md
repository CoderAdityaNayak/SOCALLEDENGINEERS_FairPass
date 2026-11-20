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

1. **Fair entry**: lottery instead of first-come. One verified ID = one entry per event (max 2 tickets per ID).
   Every entry carries an **x402 Work** proof-of-work (cheap for one fan, very expensive for a bot sending millions).
   The draw uses **commit-reveal** (publish sha256(seed) when the lottery opens, reveal seed at draw) so anyone can verify it.
2. **Fair resale**: tickets are ERC-721 NFTs that can ONLY move through the contract. Resale price ≤
   `facePrice × (100 + resaleCapPct) / 100` (default cap 10%). **Return to pool**: seller gets face price back and the
   ticket goes to the next waitlisted fan (seller can't pick the buyer, which kills cash side deals).
3. **Real tickets**: only contract-minted tokens are valid. Fan QR = `{tokenId, timestamp, signature}`, refreshed every 30 s.
   Gate checks: fresh (< 30 s), signer == `ownerOf(tokenId)` on-chain, not used → then `markUsed` on-chain.
4. **Corporate booking**: a verified company (GSTIN, mock-verified) books N seats; each seat tied to a verified employee
   (limit is per attendee, not per buyer). One ID appears only once per event across ALL pools. Corporate tickets
   can't be resold, only returned to the pool. Manager can swap a seat to another verified employee (`swapsLeft = 2`).
   Corporate pool max = 5% of supply.

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
- **Deploy**: `const ipfsHash = await hre.deployMetadata.pushMetadataToIPFS('FairPass')`, then
  `new quais.ContractFactory(abi, bytecode, wallet, ipfsHash)` → `deploy(...)` → `waitForDeployment()` → `getAddress()`.
  Hardhat console doesn't work with Quai; use scripts.
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
- Jobs expire in ~15 s; a proof is spent once. CORS: allow `payment-signature`, expose `payment-required`, `payment-response`.

## Phases

1. **Setup**: monorepo, .gitignore, .env.example per part, this file, git. ✅
2. **Contract** `contracts/contracts/FairPass.sol`: `struct Event {name, date, facePrice, maxSupply, minted, resaleCapPct, organiser}`;
   mappings events, ticketEvent, used, listedPrice, gateStaff, isCorporate; `createEvent` / `mintTicket(to,eventId,corporate)` onlyOwner;
   `listForResale` (owner, not corporate, not used, ≤ cap); `cancelListing`; `buyResale` payable (exact price, seller paid,
   2% royalty to organiser); `returnToPool` (to contract owner); `reassign` onlyOwner; `markUsed` onlyGateStaff;
   `isValid`; `addGateStaff`. `_update` override: tokens move ONLY via mint/buyResale/returnToPool/reassign.
   Events TicketMinted/Listed/Resold/Returned/Reassigned/Used. Hardhat tests for every rule.
3. **Deploy**: `contracts/scripts/deploy.js` deploys, creates "[Headliner] World Tour" (0.01 QUAI, 100 supply, cap 10),
   adds deployer as gate staff, writes `{address, abi, chainId}` to `backend/src/contract.json` and `frontend/src/contract.json`.
   User runs it with their funded Pelagus Cyprus-1 key. Fallback: local Hardhat network.
4. **Backend core**: SQLite tables users, events, entries, companies, corporate_seats, tickets, scans, blocked_attempts;
   `src/services/quai.js`; mock OTP auth (OTP printed to console) + JWT + custodial wallet; KYC (ID → SHA-256 hash, duplicate → 409
   + blocked_attempts); events CRUD (organiser → createEvent on-chain); role middleware; random block/row/seat at mint.
5. **Lottery + anti-bot**: `POST /events/:id/enter` (x402 Work + verified + one per idHash + IP rate limit; every rejection logged);
   commit-reveal draw `POST /events/:id/draw`, `GET /events/:id/draw-proof`, `GET /events/:id/stats`; `scripts/bot-attack.js` (10,000 attempts).
6. **Tickets/gate/resale/corporate**: `/me/tickets`, `/tickets/:id/qr`, `/gate/verify` (EXPIRED / NOT_ON_CHAIN / NOT_OWNER /
   ALREADY_USED / VALID), list/buy/return, corporate apply/approve/seats/swap, `scripts/e2e.js`.
7. **Frontend**: dark mobile-first design (bg #0B0D12, cards #151922, borders #262C38, text #F2F4F8, muted #9AA3B2, lime #C6F432 with
   dark text, error #C62828/#FF8A8A; Space Grotesk 700 headings, Inter body; radius 14–22px; stroke SVG icons; no emoji).
   Pages: Login, Home/Event, Enter lottery, My ticket, Resale, Gate scanner, Organiser dashboard, Corporate booking; Pelagus connect; role nav.
8. **Demo**: `npm run demo` (seeds organiser, staff, 5 fans, 1 company + 5 employees, open event; prints phones + OTPs), README.

### Demo script

1. bot-attack → dashboard shows blocked count
2. fans enter (PoW visible) → organiser runs draw → winners minted on Quai (Quaiscan link)
3. fan lists at huge price → rejected; return to pool → waitlisted fan gets it
4. company books 5 seats for 5 verified employees
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

- `npm install` (root) · `npm run compile` · `npm run test:contracts`
- `npm run deploy -w contracts` (Orchard, needs `contracts/.env`) · `npm run dev:backend` · `npm run dev:frontend`
