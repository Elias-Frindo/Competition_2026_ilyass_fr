# KWRT

**Hourly renewable energy certificates, issued and traded on Hedera.**

KWRT is a working prototype built for the **Hedera Cross Campus Challenge 2026** (Morocco / Tunisia).
Most of the interface is a deterministic simulation. One section — **Live testnet** — executes real
Hedera testnet transactions, with real accounts, a real HTS token supply and real HashScan-verifiable
receipts.

> **Prototype, not a registry.** KWRT is not an accredited registry, and its tokens are not legally
> equivalent to I-REC or a Guarantee of Origin. A token represents an environmental attribute, not
> physical electrons or grid delivery. See [Limitations](#limitations).

---

## Contents

- [What is real, what is simulated](#what-is-real-what-is-simulated)
- [Quick start](#quick-start)
- [The live purchase](#the-live-purchase)
- [Live testnet resources](#live-testnet-resources)
- [Configuration](#configuration)
- [Why the relay uses HashIO](#why-the-relay-uses-hashio)
- [Security model](#security-model)
- [Verify the demo yourself](#verify-the-demo-yourself)
- [Project layout](#project-layout)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Team & license](#team--license)

---

## What is real, what is simulated

| Area | Behaviour |
|---|---|
| Dashboard, pipeline runner, validation engine, verifier, marketplace order book, trust & costs | **Simulated in the browser.** Deterministic seed data; transaction ids and HCS sequence numbers are generated locally. |
| **Live testnet** section | **Real Hedera testnet.** A fixed client account with HBAR and zero KWRT buys a 783 kWh wind certificate from a fixed seller account. Both hashes are real and open on HashScan. |

The live section is intentionally independent from the simulated marketplace: judges can inspect the
simulation without any network access, then run the live purchase on testnet in its own view.

## Quick start

**Prerequisites**

- Node.js ≥ 20.
- A Hedera testnet account that will act as the seller/treasury, funded with HBAR.
- **An ECDSA (secp256k1) key for that account.** The live path goes through Hedera's EVM relay, which
  addresses accounts by secp256k1 EVM address; ED25519 keys cannot sign there.

```bash
npm install
cp scripts/.env.example .env      # fill in SELLER_ID and SELLER_KEY
node scripts/setup-live-mint.mjs  # or: npm run setup:live
node server/relay.mjs             # or: npm run relay
```

Then open **<http://127.0.0.1:8787>** and choose **Live testnet** in the navigation.

`setup:live` is idempotent. On a fresh checkout it:

1. creates a disposable **client** account, funds it with 100 HBAR and writes `CLIENT_ID` /
   `CLIENT_KEY` back into `.env`;
2. creates a **KWRT** HTS token (name `KWRT`, symbol `KWRT`, 3 decimals) unless a valid one is
   already configured;
3. associates the client with KWRT **without giving it any tokens**;
4. mints the 783 kWh certificate supply to the seller;
5. writes `server/live-config.json` (public data only) for the relay.

The relay serves the site and the live API on the same port, so there is no CORS setup and no wallet
extension to install.

## The live purchase

Two fixed accounts are involved:

| Role | Account | Starting state |
|---|---|---|
| Seller — **Atlas Wind Energy** | `0.0.10149503` | holds the KWRT supply, receives HBAR |
| Client — **KWRT Demo Client** | `0.0.11440477` | holds HBAR, **zero KWRT** |

The certificate on offer is `CERT-013`: **783 kWh** of wind production at **0.037 HBAR/kWh**, for a
total of **28.971 HBAR**.

Clicking **Buy certificate** sends a request to the local relay, which executes two signed testnet
transactions in order:

1. **Payment** — the client sends `28.971 HBAR` to the seller.
2. **Delivery** — the seller transfers `783 KWRT` to the client.

The steps are sequential, not atomic, so the relay compensates: if the token leg fails after payment,
it refunds the HBAR automatically and reports the failure. Each leg is simulated first (HTS returns a
response code instead of reverting), so a malformed call costs nothing. After submission the relay
polls the mirror node until both balances reflect the transfer, then records the purchase in
`server/live-config.json`.

**Reset demo** returns the certificate to the seller and refunds the client, putting the demo back to
its starting state for the next run.

## Live testnet resources

Current deployment (replace these if you run `setup:live` with another account):

| Resource | ID / hash | Explorer |
|---|---|---|
| HCS topic | `0.0.10155252` | [HashScan](https://hashscan.io/testnet/topic/0.0.10155252) |
| KWRT token (3 decimals) | `0.0.11440547` | [HashScan](https://hashscan.io/testnet/token/0.0.11440547) |
| Token create tx | `0x8de3e52ba696e7fc31b18513aee6a7fc5cf36875265078a2b1b11f666f407313` | [HashScan](https://hashscan.io/testnet/transaction/0x8de3e52ba696e7fc31b18513aee6a7fc5cf36875265078a2b1b11f666f407313) |
| Mint tx (783 000 units) | `0xec3cc43abcd9103620cc3466f30a5d792c2f9cec02c83c16ae03555090a59679` | [HashScan](https://hashscan.io/testnet/transaction/0xec3cc43abcd9103620cc3466f30a5d792c2f9cec02c83c16ae03555090a59679) |
| Seller / treasury | `0.0.10149503` | [HashScan](https://hashscan.io/testnet/account/0.0.10149503) |
| Client | `0.0.11440477` | [HashScan](https://hashscan.io/testnet/account/0.0.11440477) |

**Units.** 1 KWRT = 1 kWh with `decimals = 3`, so one token unit is 1 Wh. The 783 kWh certificate is
minted as 783 000 units.

## Configuration

`.env` lives in the project root, is gitignored, and is read **only** by the setup script and the
relay. Nothing in it is ever sent to the browser.

| Variable | Required | Meaning |
|---|---|---|
| `SELLER_ID` | yes | Seller account, e.g. `0.0.10149503`. Falls back to `OPERATOR_ID`. |
| `SELLER_KEY` | yes | Seller ECDSA private key. Falls back to `OPERATOR_KEY`. **Secret.** |
| `CLIENT_ID` | created | Disposable client account. Written by `setup:live` on first run. |
| `CLIENT_KEY` | created | Client raw ECDSA key. Written by `setup:live`. **Secret.** |
| `KWRT_TOKEN_ID` | created | KWRT token id. Written by `setup:live`. |
| `KWRT_MINT_TX` | created | Hash of the mint transaction. Written by `setup:live`. |
| `RELAY_PORT` | no | Relay port, default `8787`. |

`server/live-config.json` contains only public data (account ids, token id, ask, transaction hashes)
plus the purchase state. It is safe to inspect and to commit; it contains no keys.

## Why the relay uses HashIO

Hedera's native gRPC endpoints (`50211` / `50212`) are blocked on some corporate, campus and mobile
networks. The primitive that keeps working is HTTPS on port 443. The live demo therefore talks to
testnet through the public **HashIO JSON-RPC relay** (`https://testnet.hashio.io/api`, chain id 296)
and uses the **HTS system contract** at `0x167` for token operations.

Consequences:

- Accounts must have ECDSA keys (see [Quick start](#quick-start)).
- Sending HBAR must target the account's **EVM alias address**, not its long-zero form; the helpers
  resolve account ids through the mirror node before signing.
- HTS token creation charges its fee through `msg.value`; token creation is simulated first, and
  excess value is refunded by the network.

All of this lives in [`scripts/hedera-evm.mjs`](scripts/hedera-evm.mjs) and is reused by both the
setup script and the relay.

## Security model

- **No private key ever reaches the browser.** The two demo keys live in `.env`; signing happens in
  `server/relay.mjs` on the local machine.
- **The relay binds to `127.0.0.1`** and serves a strict allowlist: `index.html`, `styles.css`,
  `favicon.svg` and `js/*.js`. `.env`, `server/` and `scripts/` return 404.
- **The API accepts no keys and no arbitrary transactions.** It exposes only
  `GET /relay/config`, `POST /relay/live/buy` and `POST /relay/live/reset`. The buy endpoint has a
  single-flight lock and refuses to run twice.
- **It is a demo.** The accounts are disposable testnet accounts. Rotate the keys and move signing to
  a KMS/HSM before any mainnet use. Do not reuse this relay design as production custody.

## Verify the demo yourself

1. Open the **Live testnet** section and note the seller and client account ids.
2. On HashScan, open each account and check the HBAR and KWRT balances before and after a purchase.
3. Open the KWRT token page and confirm `name = KWRT`, `symbol = KWRT`, `decimals = 3`, type
   `FUNGIBLE_COMMON`, supply type `INFINITE`, and that the treasury is the seller.
4. Open the **payment** transaction: the client is debited 28.971 HBAR and the seller is credited.
5. Open the **delivery** transaction: 783 KWRT move from the seller to the client.
6. Confirm the mint transaction created exactly 783 000 units and that the token's total supply is
   783 000 before any burn.

Every link in the live section points at HashScan, so no step requires trusting a value printed by
the page.

## Project layout

```
index.html                 one-page prototype shell
styles.css                 dark UI theme + live-section styles
favicon.svg                KWRT mark
js/
  app.js                   view routing and boot
  live.js                  Live testnet section (talks to the relay)
  marketplace.js           simulated order book and buyer agent
  dashboard.js …            other simulated views
scripts/
  hedera-evm.mjs           HashIO provider, HTS ABI, account/token helpers
  setup-live-mint.mjs      one-time idempotent setup
  .env.example             environment template
server/
  relay.mjs                static server + live buy/reset API
  live-config.json         generated public demo state
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot reach the local relay` | Start `node server/relay.mjs` and open `http://127.0.0.1:8787`, not the file directly. |
| Relay reports `CLIENT_KEY is missing` | Re-run `node scripts/setup-live-mint.mjs`. |
| `Expected a secp256k1 (ECDSA) key` | The seller key is ED25519. Use an ECDSA-keyed testnet account for the live demo. |
| `INSUFFICIENT_TX_FEE` on token creation | The token-create `msg.value` buffer is too low for the current exchange rate; raise `TOKEN_CREATE_FEE` in `scripts/hedera-evm.mjs`. |
| `INVALID_ALIAS_KEY` on a transfer | An address resolved to a long-zero form. Use account ids (the helpers resolve them) or the account's `evm_address`. |
| Client has no HBAR | Send testnet HBAR to its account, or reset the demo; the seller refunds the client. |
| Purchase says “already bought” | Click **Reset demo**, then buy again. |
| Token already exists / stale state | `KWRT_TOKEN_ID` in `.env` points at an old token; clear it and re-run `setup:live`. |

## Limitations

- Testnet only; no mainnet deployment.
- The two demo keys are stored in a local `.env`. That is acceptable for a judged demo and not
  acceptable for production.
- The certificate is a plain fungible token; there is no on-chain guard contract, DID or verifiable
  credential in this build.
- The live market has one seller, one buyer and one certificate. Order matching, price discovery and
  retirement are demonstrated in the simulated views, not on-chain.
- Cross-registry double counting and physical meter tampering are out of scope.
- A token represents an environmental attribute, not delivered electrons.

## Team & license

| | |
|---|---|
| Project | KWRT — hourly renewable energy certificates |
| Challenge | Hedera Cross Campus Challenge 2026 — Morocco / Tunisia |
| License | MIT |
