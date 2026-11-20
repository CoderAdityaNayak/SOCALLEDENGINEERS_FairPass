# FairPass

**Fair concert tickets on Quai Network.** A random draw instead of a queue, resale capped at face price + 10%,
and a rotating QR that only the real on-chain owner can produce, so a fake or screenshotted ticket is useless at the gate.

> Hackathon track: Cybersecurity & Blockchain · Problem B2 "Fair tickets"
> Contract (Quai Orchard testnet, Cyprus-1): [`0x002cb29004b6A97790464e2411173C6204f1A869`](https://orchard.quaiscan.io/address/0x002cb29004b6A97790464e2411173C6204f1A869)

---

## The problem

In September 2024, **1.3 crore people** queued on BookMyShow for Coldplay's three Mumbai concerts. Tickets sold out in
minutes; a police complaint alleged bots took **lakhs of queue places**; tickets reappeared on resale sites for up to
**₹3 lakh**. In October 2024 the Enforcement Directorate raided **5 cities** over **fake tickets** sold on Instagram,
WhatsApp and Telegram. India has no law written specifically against scalping.

Three things went wrong: **speed decided who got tickets** (so bots win), **resale had no ceiling** (so scalping pays),
and **a ticket was just an image** (so fakes and screenshots work).

## The solution

| Pillar | How FairPass does it |
|---|---|
| **1. Fair entry** | A **lottery**, not a race. **One entry per verified person per event**; the fan chooses how many tickets they want. Every entry must carry an **x402 Work proof-of-work** (about a second of hashing for a fan, a million times that for a bot farm sending a million entries, which would also need a million real IDs) and passes a per-IP rate limit. The draw is **commit-reveal**: `sha256(seed)` is public before anyone enters, the seed is revealed at the draw, and anyone can recompute the order. In that order each winner gets the quantity they asked for; when tickets run out, that fan gets what's left and waits for the rest. |
| **2. Fair resale** | Tickets are **ERC-721 NFTs that can only move through the FairPass contract** (plain transfers and approvals revert). Resale price ≤ `face × (100 + cap) / 100`, enforced **on-chain**. **The organiser sets the cap per event** (0–100 %, default 10 %) with `setResaleCap`; purchases re-check the **current** cap, so lowering it makes existing over-cap listings unbuyable (their sellers are warned). **Return to pool**: the seller gets face price back and the ticket goes to the **next fan on the waitlist**. The seller can't pick the buyer, which kills cash side deals. |
| **3. Real tickets** | Only tokens minted by the contract exist. The fan's QR = `{tokenId, timestamp, signature}`, **re-signed every 30 s** by the owner's key. The gate checks **fresh (< 30 s)**, **signer == `ownerOf(tokenId)` on-chain**, **not used**, then calls **`markUsed`** on-chain. A screenshot expires; a forged QR has the wrong signer; a fake ticket isn't on-chain. |

Prices are shown in ₹ (the contract works in QUAI; a fixed mock rate `INR_PER_QUAI`, default ₹4,50,000 per QUAI, converts: 0.01 QUAI = ₹4,500).

## Architecture

```mermaid
flowchart LR
  subgraph Phone["Fan's phone (React + Vite)"]
    UI[Event / Entry / Ticket / Resale pages]
    W[Web Worker: x402 Work SHA-256d solver]
  end
  subgraph Gate["Gate staff (React)"]
    S[Camera scanner<br/>html5-qrcode]
  end
  subgraph API["FairPass backend (Node + Express)"]
    A[Auth: OTP + JWT<br/>KYC: HMAC of ID]
    L[Lottery: anti-bot pipeline<br/>commit-reveal draw]
    T[Tickets: QR signing<br/>resale / return / resale cap]
    DB[(SQLite)]
    K[Custodial Cyprus-1 wallets<br/>AES-256-GCM keys]
  end
  F[x402 Work facilitator<br/>x402.qu.ai]
  Q[(Quai Orchard · Cyprus-1<br/>FairPass.sol ERC-721)]
  P[Pelagus wallet<br/>optional]

  UI -- "POST /enter → 402 puzzle" --> L
  W -- "PAYMENT-SIGNATURE" --> L
  L -- "jobs / settle" --> F
  L -- "mintTickets (one tx per winner)" --> Q
  T -- "list / buy / returnToPool / reassign / setResaleCap (quais)" --> Q
  S -- "POST /gate/verify" --> T
  T -- "ownerOf · used · markUsed" --> Q
  A --- DB
  L --- DB
  T --- DB
  T --- K
  UI -. connect .-> P
```

### What lives on-chain vs off-chain

| On-chain (FairPass.sol on Quai) | Off-chain (backend + SQLite) |
|---|---|
| Which tickets exist (only contract mints) | Phone login, ID verification (only a keyed hash of the ID is stored) |
| Who owns each ticket (`ownerOf`) | Lottery entries, x402 Work proofs, blocked attempts, rate limits |
| Transfer lock: only `buyResale`, `returnToPool`, `reassign` move tokens | Draw seed commitment + reveal (verifiable by anyone via `/draw-proof`) |
| Resale cap per event (organiser-set), checked again at purchase, and the 2% organiser royalty | Seat numbers, ticket quantities, waitlist order |
| Gate check-in (`markUsed`, `used`) and gate staff list | Custodial wallet keys (encrypted), gas sponsoring, mock fiat refunds |
| `ResaleCapChanged`, `TicketMinted`, … events (public history) | Gate pass signing (QR), scan log, ₹ display prices |

### Where the data lives

| Store | What | Where |
|---|---|---|
| **Quai Orchard** | Tickets, owners, listings, used flags, gate staff | `FairPass.sol` at the address above |
| **SQLite** (source of truth) | Users, entries, draw, seats, listings, scans, blocked attempts | `backend/data/demo.db` (`npm run demo`) or `backend/data/fairpass.db` |
| **Cloud Firestore** (optional mirror) | A copy of every SQLite row, updated within about a second | `fairpass/live/{table}/{id}` (always the current database; heals itself every minute) |

The Firestore mirror turns on when `FIREBASE_PROJECT_ID` (and the rest of the web config) is set in `backend/.env`.
Every insert, update and delete is copied by SQLite triggers. Documents also carry organiser-readable fields (fan
name and phone, ID type and masked ID such as `XXXX XXXX 1234`, lottery entry number, event name, block/row/seat,
holder and staff names on scans, Quaiscan links), and `event_stats/{eventId}` holds the per-event totals. Each event
document carries the current `resaleCapPct`, the ₹ maximum and the Quaiscan link of the last cap change; the event and
resale pages subscribe to it with `onSnapshot`, so fans see a new cap within seconds (set `VITE_FIREBASE_*` in
`frontend/.env`; without it they poll the API). Listings above a lowered cap carry `listingInvalid`.
There are no passwords (login is phone + OTP, and OTPs are never stored); the full Aadhaar/PAN number is never stored,
only its keyed hash, its type and its last 4 characters. Left out on purpose: custodial wallet keys, and the draw
seed until the draw has happened. Blocked bot attempts are stored as one summary per event (counts by reason + the
latest 50) so a 10,000-request bot attack doesn't use up the free plan's 20,000 writes a day; set
`FIRESTORE_MIRROR_ALL_BLOCKED=1` to store every attempt. `GET /health` shows the mirror's status.

## Run it

**Requirements:** Node 20+ (tested on 24), Git. Windows, macOS or Linux.

```bash
npm install                      # installs all four workspaces
cp backend/.env.example backend/.env   # then fill ORGANISER_PK, REWARD_ADDRESS, JWT_SECRET, SERVER_SECRET
npm run demo                     # starts API (:8080) + app (:5173), seeds demo data, prints logins
```

`backend/.env` needs:

| Variable | Value |
|---|---|
| `ORGANISER_PK` | Private key of the wallet that deployed the contract (contract owner). Cyprus-1, funded with Orchard QUAI. |
| `REWARD_ADDRESS` | Cyprus-1 Quai address that receives x402 Work mining rewards (the organiser's address is fine). |
| `JWT_SECRET`, `SERVER_SECRET` | Any long random strings (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). |

`npm run demo` resets its own database (`backend/data/demo.db`), creates a fresh event **on Quai** and prints:

| Role | Phone | Notes |
|---|---|---|
| Organiser | 9000000001 | Dashboard: pick the event in the dropdown, run its draw, change its resale cap, create events |
| Gate staff | 9000000002 | Scanner |
| Fans 1-5 | 9000000011 … 9000000015 | Fan 1 (Asha) enters live; fans 2-5 entered World Tour (2, 1, 1, 1 tickets); Ravi and Meera also entered Monsoon Sessions |

Three events are created on Quai, each with its own price and resale cap. The home page lists them as cards; fans
pick one, and an event they already entered shows "Already entered".

| Event | Face price | Resale cap | Tickets in the draw |
|---|---|---|---|
| World Tour · [Headliner] · Mumbai | ₹4,500 | +10% | 4 |
| Monsoon Sessions · Indie Collective · Mumbai | ₹2,500 | +5% | 3 |
| Coastal Beats · Sunset DJ Night · Goa | ₹6,000 | +20% | 5 |

**Every demo login uses OTP `123456`.** (Outside the demo, OTPs are printed in the API console: mock SMS.)

### Demo script (≈ 5 minutes)

1. **Bots:** in a second terminal run `npm run bot-attack`. 10,000 entry attempts → **9,998 blocked** (no account,
   no verified ID, duplicate ID, rate limit, missing or fake proof-of-work). Open the **organiser dashboard**: the red
   "Bot attempts blocked" card and the per-reason bars.
2. **Fair entry:** log in as **Asha** → pick an event card → *Enter lottery* → choose how many tickets (+/−) → watch the checklist solve
   the **anti-bot puzzle** (real x402 Work) → entry number. As organiser, **Run draw** → winners are **minted on Quai**
   (one transaction per winner; links in "On-chain activity"). "Draw proof → Verify in this browser" recomputes the
   draw from the revealed seed, including who got only part of their quantity.
3. **Organiser-controlled resale:** in **Resale settings**, slide to **15%** → Save (on-chain, about 30 s; Quaiscan link
   appears). As a winner (the draw proof shows who won) → ticket → *Can't go?*: "Max resale (+15%)" already shows
   ₹5,175, updated live. Type `5300`: the field turns red, *Above the cap*. List at `5040` (+12%) instead. Back as
   organiser, lower the cap to **5%** → the dashboard reports 1 listing invalidated; the seller's ticket now shows
   *"invalid – above new cap"* and nobody can buy it (the contract re-checks the cap at purchase).
4. **Return to pool:** the seller taps **Return to pool** → the next waitlisted fan receives it on-chain (shown live,
   with Quaiscan links).
5. **Gate:** as gate staff → *Scan*. Show a winner's live QR on another device (or use *Copy code* → *Paste code*):
   - a QR older than 30 s → **REJECTED · Expired QR**
   - `{"tokenId":999999,...}` → **REJECTED · Not on-chain**
   - the live QR → **VALID · Let them in** (marked used on-chain)
   - scan it again → **REJECTED · Already used**

### Other commands

| Command | What it does |
|---|---|
| `npm run test:contracts` | 25 Hardhat tests for every contract rule (incl. lowering the cap blocks an existing listing) |
| `npm run test:backend` | Integration tests (real Orchard contract + x402 facilitator; sends testnet transactions) |
| `npm test -w frontend` | Browser solver vs the published x402 worked example and the Node verifier |
| `npm run e2e` | The full story against a running API: quantities + partial win → VALID → ALREADY_USED → NOT_ON_CHAIN → NOT_OWNER → cap 15% (over-cap rejected, +12% listed) → cap 5% (listing invalid, can't be bought) → EXPIRED → return → waiting fan |
| `npm run bot-attack` | The 10,000-request bot farm simulation |
| `npm run deploy` | Deploy FairPass + demo event to Orchard (needs `contracts/.env` `PRIVATE_KEY`) |
| `npm run dev:backend` / `npm run dev:frontend` | Run each part on its own |

## Sponsor tools used

- **Quai Network**: `FairPass.sol` deployed on Orchard testnet, zone Cyprus-1 (chain 15000); every mint, resale,
  return, reassignment and check-in is a Quai transaction. All app code talks to Quai through the **`quais`** SDK;
  custodial wallets are generated inside Cyprus-1.
- **x402 Work** (`x402-work-client`): the anti-bot proof-of-work on every lottery entry, using the hosted facilitator
  with profile `quai/sha256d-v1`. The official client is Node-only, so FairPass ships a browser port of its solver
  (Web Worker), tested against the published worked example. Solved puzzles are real mining shares paid to the organiser.
- **Pelagus**: optional "Connect Pelagus" in the header (quais `BrowserProvider`, `quai_requestAccounts`).

## Questions judges will ask

**Why blockchain? Couldn't a database do this?**
The two things fans and resellers must trust are *who owns a ticket* and *what resale is allowed*. On-chain, the
transfer lock and the resale cap are enforced by code that nobody can bypass, and every cap change the organiser makes
is a public `ResaleCapChanged` event on Quaiscan. Anyone (a fan, a journalist, the police) can check that a ticket is
real without trusting the seller.
Fakes on Instagram stop working because "is it real?" has a public answer.

**Bots outnumber fans. What stops a farm with real IDs?**
Layers, each raising the cost: one entry per verified person (a million entries need a million IDs, and reused IDs are
caught at KYC); the per-IP rate limit; and the x402 Work puzzle on every entry. There's no per-person ticket cap, but
one person asking for many tickets is still a single entry in the draw, and those tickets can't be scalped. And because it's a lottery, an entry
is just one ticket in a hat: a farm that does get in has no speed advantage, and its tickets can't be scalped
(cap + transfer lock). In our simulation, 9,998 of 10,000 bot attempts are blocked; the 2 that get in had to behave
exactly like 2 honest fans.

**What about cash side deals ("pay me ₹50,000 on UPI and I'll transfer it")?**
There is no "transfer to a friend" in the contract. A seller can list at most face + the organiser's cap to *anyone*, or return to the
pool, where the ticket goes to the next person on the waitlist, not to someone the seller chooses. A buyer who paid cash
on the side can't be guaranteed the ticket. At the gate, the QR must be signed by the on-chain owner, so lending the
login is the only workaround, and the holder's name is shown to staff.

**What if my phone dies at the gate?**
The ticket isn't the phone: it's the token owned by your account. Log in on any phone (OTP) and a fresh QR is
generated. Staff can also see the holder's name and seat. (A production version would add a staff-side lookup by ID.)

**Do fans need a crypto wallet or gas?**
No. Each fan gets a **custodial Cyprus-1 wallet** created by the backend (key encrypted with AES-256-GCM). The
organiser wallet sponsors gas and, in this demo, mocks the fiat payment (UPI in production). Fans who want
self-custody can connect **Pelagus**.

**Privacy: you're collecting Aadhaar numbers?**
We never store the ID number. We store `HMAC-SHA256(server secret, ID)`: the same ID always gives the same fingerprint
(so duplicates are caught), but the fingerprint can't be reversed or brute-forced without the server secret (a plain
SHA-256 of a 12-digit Aadhaar could be). Nothing personal goes on-chain: the chain sees only wallet addresses and token ids.

## What's mocked

| Mocked | In production |
|---|---|
| SMS OTP (printed to the API console; demo uses `123456`) | SMS gateway |
| KYC (format check of Aadhaar / PAN; keyed hash stored) | DigiLocker / Aadhaar e-KYC |
| ₹ prices (fixed rate `INR_PER_QUAI`) | Live price feed or rupee-pegged token |
| Payments and refunds (organiser wallet funds custodial wallets) | UPI / card payment gateway |
| Gas | Paid by the organiser wallet (sponsored) |

## Project layout

```
contracts/   Hardhat 2 · FairPass.sol (Solidity 0.8.20, OpenZeppelin 5.4.0) · deploy script · 25 tests
backend/     Express 5 · better-sqlite3 · JWT · quais · x402-work-client · firebase (Firestore mirror) · integration tests
frontend/    React 19 · Vite · Tailwind v4 · react-router · qrcode.react · html5-qrcode · firebase (live resale cap) · x402 Work browser solver
scripts/     demo.js · bot-attack.js · e2e.js
```

Details for contributors (Quai and x402 gotchas we hit) are in [CLAUDE.md](CLAUDE.md).
