# ChainMakers

Fair concert ticketing on Quai Network, built for a hackathon (track: Cybersecurity & Blockchain, problem B2 "Fair tickets").
The developer is new to blockchain: explain briefly what you do at each step.

## Problem (B2)

Coldplay Mumbai, Sept 2024: 1.3 crore fans in BookMyShow's queue, sold out in minutes, resold for up to ₹3 lakh.
Bots took queue places; fake tickets were sold on Instagram/WhatsApp/Telegram. India has no anti-scalping law.
Goal: fans get tickets at a fair price, resale is possible but cannot be exploited, and a fake ticket is useless at the gate.

## The idea

- **Tickets** are ERC-721 NFTs on Quai Orchard testnet (Cyprus-1). Ownership is on-chain, so a fake ticket has no token and fails at the gate.
- **Anti-bot sale**: a lottery instead of first-come-first-served (speed gives no advantage).
  - One verified ID per entry (the backend stores a hash of the ID, never the raw ID number).
  - Each lottery entry must pay an **x402 Work** proof-of-work puzzle, so mass bot entries cost real compute.
- **Resale only through the contract**: plain transfers are blocked. Price cap = face price + `resaleCapPct` (default 10%).
  - **Return to pool**: the seller gets the face price back and the ticket goes to the next person on the waitlist.
- **Gate**: the fan's app shows a QR with `{tokenId, timestamp, signature}` that refreshes every 30 s.
  The scanner checks that (1) it is fresh (< 30 s), (2) the recovered signer == `ownerOf(tokenId)` on-chain,
  (3) the ticket is not used, then calls `markUsed(tokenId)`. A screenshot expires; a forged QR has the wrong signer.
- **Corporate booking**: a verified company books N seats, each tied to a verified employee. These tickets cannot be resold.

## Stack

| Folder | What | Tech |
|---|---|---|
| `/contracts` | Solidity contracts + deploy scripts + tests | Hardhat **2** (2.29.2), toolbox 6.1.2 (the hh2 line), `@quai/hardhat-deploy-metadata`, OpenZeppelin 5 |
| `/backend` | API: ID verification, lottery entry (x402 Work), waitlist, corporate booking, gate scanning | Node 20+, Express 5, SQLite via `better-sqlite3`, ESM |
| `/frontend` | Fan app, resale, gate QR, scanner page | React 19 + Vite + Tailwind v4 (`@tailwindcss/vite`, no tailwind.config) |
| `/scripts` | Utilities: wallet generation, seeding, bot simulation | Node ESM + `quais` |

Root `package.json` uses npm workspaces (`npm install` at the root installs everything).

## Quai rules (important)

- **Solidity 0.8.20** with `evmVersion: 'london'`, optimizer on, and `metadata: { bytecodeHash: 'ipfs', useLiteralContent: true }`
  (needed for IPFS metadata and Quaiscan verification). Do not use newer Solidity or opcodes after London.
- **Use the `quais` SDK, not `ethers`** (pinned `1.0.0-alpha.58`), everywhere: scripts, backend, frontend. Hardhat's
  toolbox pulls in ethers internally; don't use it in our code.
- **Addresses must be Cyprus-1**: Cyprus-1 is region 0, zone 0, so Quai-ledger addresses start with `0x00` and the
  second byte is < `0x80`. Check with `quais.isQuaiAddress(addr)`. Deployer, organiser and reward keys must all be Cyprus-1.
  Contracts only live on the Quai ledger (not Qi).
- Providers: `new quais.JsonRpcProvider(RPC_URL, undefined, { usePathing: true })`.
  Browser wallet is Pelagus: `new quais.BrowserProvider(window.pelagus)`.
- Deploying: `const ipfsHash = await hre.deployMetadata.pushMetadataToIPFS('ContractName')`, then
  `new quais.ContractFactory(abi, bytecode, wallet, ipfsHash)` (the IPFS hash is the 4th argument).
- Hardhat console does not work with Quai contracts; write scripts instead.

### Orchard testnet (Cyprus-1)

- Chain ID: `15000`
- RPC: `https://orchard.rpc.quai.network/cyprus1` (WS: `wss://orchard.rpc.quai.network/cyprus1`)
- Explorer: https://orchard.quaiscan.io
- Faucet: https://orchard.faucet.quai.network

## x402 Work (proof-of-work on lottery entry)

Docs: https://x402.qu.ai/llms.txt. Flow: client POSTs -> server replies `402` with a `PAYMENT-REQUIRED` header
(base64 JSON offer with a mining job) -> client solves it -> client repeats the **byte-identical** request with a
`PAYMENT-SIGNATURE` header -> server verifies via the hosted facilitator and returns `200` + `PAYMENT-RESPONSE`.

- Server: `x402-work-client` (installed from `https://x402.qu.ai/x402-work-client-0.4.1.tgz`, not the npm registry),
  `workSeller({ payTo: REWARD_ADDRESS, amount })` then `seller.charge({ url, description, paymentSignature })`.
- `amount` = expected guesses. 65536 is about 1 s in a browser. Use profile `quai/sha256d-v1` (browser-solvable).
- No official browser package: the frontend solver is a Web Worker port of the reference sha256d solver in
  https://x402.qu.ai/docs/pay.md (validate against its worked example). Jobs expire after ~15 s.
- CORS must allow header `payment-signature` and expose `payment-required`, `payment-response`.
- The work facilitator runs on network `quai:9` (mainnet) even though our contracts are on Orchard; that is fine,
  the puzzle is just an anti-bot cost and is separate from our contracts.
- Facilitator requires an HTTPS `resource.url` (HTTP only for localhost).

## Folder structure

```
/
├── CLAUDE.md            this file
├── package.json         npm workspaces root
├── contracts/           Hardhat 2 project
│   ├── contracts/       .sol files
│   ├── scripts/         deploy scripts (quais)
│   ├── test/
│   └── hardhat.config.js
├── backend/             Express API
│   └── src/index.js
├── frontend/            React + Vite + Tailwind
│   └── src/
└── scripts/             utility scripts
```

Each part has its own `.env.example`; copy to `.env` (git-ignored). Never commit private keys. SQLite `*.db` files are ignored.

## Commands

- `npm install` (root) — install all workspaces
- `npm run compile` — compile contracts
- `npm run deploy -w contracts` — deploy to Cyprus-1 (needs `contracts/.env`)
- `npm run dev:backend` / `npm run dev:frontend`

## Status

Scaffold only. No features built yet.
