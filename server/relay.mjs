#!/usr/bin/env node
/* ── KWRT prototype — live testnet relay ─────────────────────────────────────
   Serves the prototype site and the live-testnet API on one local port:

     http://127.0.0.1:8787/              → the KWRT prototype
     http://127.0.0.1:8787/relay/health  → relay status
     http://127.0.0.1:8787/relay/config  → public demo config + live balances
     POST /relay/live/buy                → client buys the Atlas Wind certificate
     POST /relay/live/reset              → puts the demo back to its starting state

   The live demo uses two fixed testnet accounts:
     • seller — Atlas Wind Energy, holds the KWRT supply
     • client — KWRT Demo Client, holds HBAR and (before buying) zero KWRT

   Private keys live only in the local .env and are used only inside this
   process. Nothing key-related is ever returned to the browser.

   Transport: Hedera's native gRPC ports are blocked on some networks, so
   this relay submits transactions through the public HashIO JSON-RPC relay
   and the HTS system contract (0x167) over HTTPS.

   Run:
     node server/relay.mjs
   ───────────────────────────────────────────────────────────────────────── */

import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import {
  provider,
  walletFromHederaKey,
  transferToken,
  sendHbar,
  mirrorAccount,
  mirrorToken,
  tokenBalanceFromAccount,
  tinybarsToHbar,
  formatHbar,
  tokenIdToEvmAddress,
  accountIdToEvmAddress,
  sleep
} from '../scripts/hedera-evm.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(__dirname, 'live-config.json');
const PORT = Number(process.env.RELAY_PORT || 8787);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

/* Local-only demo API: allow the page to be opened from another localhost port. */
app.use('/relay', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ── Config + keys ─────────────────────────────────────────────────────── */
function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error('server/live-config.json is missing. Run: node scripts/setup-live-mint.mjs');
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function writeConfig(config) {
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
}

function sellerWallet() {
  const key = process.env.SELLER_KEY || process.env.OPERATOR_KEY;
  if (!key) throw new Error('SELLER_KEY / OPERATOR_KEY is missing from .env');
  return walletFromHederaKey(key);
}

function clientWallet() {
  const key = process.env.CLIENT_KEY;
  if (!key) throw new Error('CLIENT_KEY is missing from .env. Re-run the setup script.');
  return new Wallet(key, provider());
}

const HASHSCAN = 'https://hashscan.io/testnet';
const txLink = (hash) => `${HASHSCAN}/transaction/${hash}`;

async function balances(config) {
  const [seller, client] = await Promise.all([
    mirrorAccount(config.seller.accountId),
    mirrorAccount(config.client.accountId)
  ]);
  if (!seller || !client) throw new Error('One of the demo accounts was not found on testnet.');

  return {
    seller: {
      accountId: config.seller.accountId,
      evmAddress: seller.evm_address || accountIdToEvmAddress(config.seller.accountId),
      label: config.seller.label,
      hbar: tinybarsToHbar(seller.balance.balance),
      kwrt: tokenBalanceFromAccount(seller, config.tokenId),
      hashscan: `${HASHSCAN}/account/${config.seller.accountId}`
    },
    client: {
      accountId: config.client.accountId,
      evmAddress: client.evm_address || accountIdToEvmAddress(config.client.accountId),
      label: config.client.label,
      hbar: tinybarsToHbar(client.balance.balance),
      kwrt: tokenBalanceFromAccount(client, config.tokenId),
      hashscan: `${HASHSCAN}/account/${config.client.accountId}`
    }
  };
}

/* Wait until the mirror node reflects the expected balances (max ~24s). */
async function settledBalances(config, predicate, attempts = 12, delayMs = 2000) {
  let last = await balances(config);
  for (let i = 0; i < attempts; i += 1) {
    if (predicate(last)) return { balances: last, synced: true };
    await sleep(delayMs);
    last = await balances(config);
  }
  return { balances: last, synced: predicate(last) };
}

/* ── Public state ──────────────────────────────────────────────────────── */
app.get('/relay/health', (req, res) => {
  res.json({ ok: true, service: 'kwrt-live-relay', time: new Date().toISOString() });
});

app.get('/relay/config', async (req, res) => {
  try {
    const config = readConfig();
    const token = await mirrorToken(config.tokenId).catch(() => null);
    const live = await balances(config);
    res.json({
      ok: true,
      config: {
        network: config.network,
        chainId: config.chainId,
        hashscan: config.hashscan,
        tokenId: config.tokenId,
        topicId: config.topicId,
        token: config.token,
        seller: config.seller,
        client: config.client,
        ask: config.ask,
        transactions: config.transactions,
        updatedAt: config.updatedAt
      },
      token: token
        ? {
            name: token.name,
            symbol: token.symbol,
            decimals: token.decimals,
            totalSupply: Number(token.total_supply) / 10 ** Number(token.decimals),
            treasury: token.treasury_account_id,
            supplyType: token.supply_type,
            hashscan: `${HASHSCAN}/token/${config.tokenId}`
          }
        : null,
      balances: live
    });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

/* ── Buy ───────────────────────────────────────────────────────────────── */
let busy = false;

app.post('/relay/live/buy', async (req, res) => {
  if (busy) return res.status(429).json({ ok: false, error: 'Another live transaction is already running.' });
  busy = true;
  try {
    const config = readConfig();
    const { ask } = config;
    if (!ask) throw new Error('live-config.json has no ask.');
    if (ask.purchased) {
      return res.status(409).json({ ok: false, error: 'This certificate was already bought. Reset the demo first.' });
    }

    const seller = sellerWallet();
    const client = clientWallet();
    const before = await balances(config);

    if (before.client.kwrt !== 0) {
      return res.status(409).json({
        ok: false,
        error: `Client already holds ${before.client.kwrt} KWRT. Reset the demo first.`,
        balances: before
      });
    }
    if (before.client.hbar < ask.priceHbar + 1) {
      return res.status(409).json({
        ok: false,
        error: `Client has ${formatHbar(before.client.hbar)} HBAR but needs at least ${formatHbar(ask.priceHbar + 1)}.`,
        balances: before
      });
    }
    if (before.seller.kwrt < ask.kwh) {
      return res.status(409).json({
        ok: false,
        error: `Seller only holds ${before.seller.kwrt} KWRT but the ask is ${ask.kwh}.`,
        balances: before
      });
    }

    const steps = [];

    // 1. Client pays HBAR to the seller. Persist the payment before the second
    //    leg so a crash still lets the reset path refund the client.
    const payment = await sendHbar(client, config.seller.accountId, ask.priceHbar);
    config.ask.paymentSent = true;
    config.ask.purchasePaymentTransactionId = payment.hash;
    config.updatedAt = new Date().toISOString();
    writeConfig(config);
    steps.push({
      key: 'payment',
      label: `Client pays ${ask.priceHbar} HBAR to ${config.seller.label}`,
      hash: payment.hash,
      hashscan: txLink(payment.hash)
    });

    // 2. Seller transfers the certificate tokens to the client.
    let transfer;
    try {
      transfer = await transferToken({
        wallet: seller,
        token: tokenIdToEvmAddress(config.tokenId),
        sender: config.seller.accountId,
        receiver: config.client.accountId,
        amount: Math.round(ask.kwh * 1000)
      });
    } catch (err) {
      // Put the HBAR back so a failed token leg does not leave the demo half-settled.
      let refund = null;
      try {
        refund = await sendHbar(seller, config.client.accountId, ask.priceHbar);
        config.ask.paymentSent = false;
        config.ask.purchasePaymentTransactionId = null;
        config.updatedAt = new Date().toISOString();
        writeConfig(config);
      } catch (_refundErr) {
        // Reported below; the UI will show that the refund also failed.
      }
      return res.status(502).json({
        ok: false,
        error: `Token transfer failed: ${err.message}`,
        steps,
        refund: refund ? { hash: refund.hash, hashscan: txLink(refund.hash) } : null
      });
    }

    steps.push({
      key: 'transfer',
      label: `${config.seller.label} sends ${ask.kwh} KWRT to the client`,
      hash: transfer.hash,
      hashscan: txLink(transfer.hash)
    });

    const settled = await settledBalances(
      config,
      (b) => b.client.kwrt >= ask.kwh && b.seller.kwrt <= before.seller.kwrt - ask.kwh
    );

    config.ask.purchased = true;
    config.ask.purchaseTransactionId = transfer.hash;
    config.ask.purchasePaymentTransactionId = payment.hash;
    config.ask.purchasedBy = config.client.accountId;
    config.ask.purchasedAt = new Date().toISOString();
    config.updatedAt = new Date().toISOString();
    writeConfig(config);

    res.json({
      ok: true,
      purchased: true,
      muted: false,
      steps,
      balances: settled.balances,
      synced: settled.synced,
      ask: config.ask
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    busy = false;
  }
});

/* ── Reset (for a second run of the demo) ──────────────────────────────── */
app.post('/relay/live/reset', async (req, res) => {
  if (busy) return res.status(429).json({ ok: false, error: 'Another live transaction is already running.' });
  busy = true;
  try {
    const config = readConfig();
    const { ask } = config;
    const before = await balances(config);
    const steps = [];

    if (before.client.kwrt >= ask.kwh) {
      const back = await transferToken({
        wallet: clientWallet(),
        token: tokenIdToEvmAddress(config.tokenId),
        sender: config.client.accountId,
        receiver: config.seller.accountId,
        amount: Math.round(ask.kwh * 1000)
      });
      steps.push({
        key: 'return',
        label: `Client returns ${ask.kwh} KWRT to ${config.seller.label}`,
        hash: back.hash,
        hashscan: txLink(back.hash)
      });
    }

    if (ask.purchased || ask.paymentSent) {
      const refund = await sendHbar(sellerWallet(), config.client.accountId, ask.priceHbar);
      steps.push({
        key: 'refund',
        label: `Seller refunds ${ask.priceHbar} HBAR to the client`,
        hash: refund.hash,
        hashscan: txLink(refund.hash)
      });
    }

    const settled = await settledBalances(config, (b) => b.client.kwrt === 0);

    config.ask.purchased = false;
    config.ask.paymentSent = false;
    config.ask.purchaseTransactionId = null;
    config.ask.purchasePaymentTransactionId = null;
    config.ask.purchasedBy = null;
    config.ask.purchasedAt = null;
    config.updatedAt = new Date().toISOString();
    writeConfig(config);

    res.json({ ok: true, steps, balances: settled.balances, synced: settled.synced });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    busy = false;
  }
});

/* ── Static site (whitelisted files only, never .env or server code) ───── */
const ALLOWED_FILES = new Set(['/', '/index.html', '/styles.css', '/favicon.svg']);

app.get('*', (req, res, next) => {
  const urlPath = decodeURIComponent(req.path);
  if (ALLOWED_FILES.has(urlPath)) {
    const file = urlPath === '/' ? 'index.html' : urlPath.slice(1);
    return res.sendFile(path.join(ROOT, file));
  }
  if (urlPath.startsWith('/js/') && urlPath.endsWith('.js') && !urlPath.includes('..')) {
    return res.sendFile(path.join(ROOT, urlPath));
  }
  next();
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`\nKWRT live relay → http://127.0.0.1:${PORT}`);
  console.log('Open the URL above, then choose "Live testnet" in the navigation.');
  console.log('Keys stay in .env; the browser only receives public account data.\n');
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
