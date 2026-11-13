#!/usr/bin/env node
/* ── KWRT prototype — live demo setup ───────────────────────────────────────
   Run ONCE before presenting, from the command line, with the seller key in
   .env. This never runs in the browser and its keys never leave this process.

   The demo uses two fixed testnet accounts so it runs without a wallet
   extension:
     • seller  — Atlas Wind Energy, holds the KWRT supply
     • client  — KWRT Demo Client, holds HBAR and zero KWRT

   What it does:
     1. Creates/reuses a disposable client account (HBAR only, no KWRT) when
        CLIENT_ID / CLIENT_KEY are missing from .env, then writes them back.
     2. Creates a KWRT-branded HTS token (name=symbol=KWRT, 3 decimals) if
        no valid KWRT token is already configured.
     3. Associates the client account with KWRT without giving it a balance,
        and tops up its HBAR if needed.
     4. Mints the Atlas Wind Energy certificate supply to the seller.
     5. Writes server/live-config.json for the relay and prints the public
        config. The relay server is the only process that reads private keys.

   Transport note: Hedera's native gRPC ports are blocked on some networks,
   so this script uses the public HashIO JSON-RPC relay (HTTPS 443) and the
   HTS system contract instead of the native SDK client.

   Usage:
     cp scripts/.env.example .env   # fill in OPERATOR_ID / OPERATOR_KEY
     npm install
     node scripts/setup-live-mint.mjs
   ───────────────────────────────────────────────────────────────────── */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet, formatEther } from 'ethers';
import { PrivateKey } from '@hiero-ledger/sdk';
import {
  provider,
  walletFromHederaKey,
  compressedPublicKey,
  createFungibleToken,
  mintToken,
  associateToken,
  sendHbar,
  sendHbarToNewAccount,
  waitForAccount,
  waitForToken,
  mirrorAccount,
  mirrorToken,
  accountSummary,
  tinybarsToHbar,
  formatHbar,
  tokenIdToEvmAddress
} from './hedera-evm.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '..', '.env');
const CONFIG_PATH = path.join(__dirname, '..', 'server', 'live-config.json');
const TOPIC_ID = '0.0.10155252';
const ASK = {
  askKey: 'CERT-013',
  certId: 'CERT-013',
  producer: 'Atlas Wind Energy',
  country: 'Morocco',
  sourceType: 'WIND',
  kwh: 783.0,
  priceHbarPerKwh: 0.037
};
const AMOUNT_UNITS = Math.floor(ASK.kwh * 1000);
const PRICE_HBAR = Number((ASK.kwh * ASK.priceHbarPerKwh).toFixed(3));
const MIN_CLIENT_HBAR = 50;

/* ── 0. .gitignore safety check — refuse to run without it ────────────── */
function assertEnvIsIgnored() {
  const gitignorePath = path.join(__dirname, '..', '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    console.error(
      '\n[REFUSING TO RUN] No .gitignore found at the project root.\n' +
      'This script is about to read operator private keys from .env.\n'
    );
    process.exit(1);
  }
  const contents = fs.readFileSync(gitignorePath, 'utf8');
  const coversEnv = contents.split('\n').some((line) => {
    const l = line.trim();
    return l === '.env' || l === '*.env' || l === '.env*';
  });
  if (!coversEnv) {
    console.error(
      '\n[REFUSING TO RUN] .gitignore exists but does not appear to cover .env.\n' +
      'Add a line containing exactly ".env" (or "*.env") to .gitignore, then retry.\n'
    );
    process.exit(1);
  }
}
assertEnvIsIgnored();

/* ── 1. Load & validate seller credentials ─────────────────────────────── */
const SELLER_ID = process.env.SELLER_ID || process.env.OPERATOR_ID;
const SELLER_KEY = process.env.SELLER_KEY || process.env.OPERATOR_KEY;

if (!SELLER_ID || !SELLER_KEY) {
  console.error(
    '\n[missing config] Set SELLER_ID / SELLER_KEY (or OPERATOR_ID / OPERATOR_KEY)\n' +
    'in .env. This must be the testnet account that holds the KWRT supply.\n'
  );
  process.exit(1);
}

let sellerWallet;
try {
  sellerWallet = walletFromHederaKey(SELLER_KEY);
} catch (err) {
  console.error(`[bad key] Could not parse seller private key: ${err.message}`);
  process.exit(1);
}

/* ── 2. .env helpers ───────────────────────────────────────────────────── */
function readEnvFile() {
  return fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
}

function upsertEnv(text, key, value) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) return text.replace(re, `${key}=${value}`);
  return text.replace(/\s*$/, '') + `\n${key}=${value}\n`;
}

function saveEnvValue(key, value) {
  fs.writeFileSync(ENV_PATH, upsertEnv(readEnvFile(), key, value), 'utf8');
}

function readExistingConfig() {
  try {
    return fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : null;
  } catch (_err) {
    return null;
  }
}

function walletFromStoredKey(value) {
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return new Wallet(value, provider());
  return walletFromHederaKey(value);
}

/* ── 3. Client account: create a disposable one if .env has none ───────── */
async function ensureClient() {
  const existingId = process.env.CLIENT_ID;
  const existingKey = process.env.CLIENT_KEY;

  if (existingId && existingKey) {
    const wallet = walletFromStoredKey(existingKey);
    const account = await mirrorAccount(existingId);
    if (!account) throw new Error(`CLIENT_ID ${existingId} exists in .env but not on testnet.`);
    console.log(`[ok] Using existing client account ${existingId} (${wallet.address}).`);
    return { id: existingId, wallet, created: false };
  }

  console.log('[client] No CLIENT_ID / CLIENT_KEY in .env — creating a disposable client account...');
  const wallet = Wallet.createRandom();
  const { hash } = await sendHbarToNewAccount(sellerWallet, wallet.address, 100);
  const account = await waitForAccount(wallet.address);
  if (!account) throw new Error(`Account creation tx ${hash} did not appear on the mirror node yet.`);

  saveEnvValue('CLIENT_ID', account.account);
  saveEnvValue('CLIENT_KEY', wallet.privateKey);
  console.log(`[ok] Created client account ${account.account} with 100 HBAR and no KWRT.`);
  console.log('[ok] Wrote CLIENT_ID and CLIENT_KEY to .env (never commit this file).');
  return { id: account.account, wallet, created: true };
}

/* ── 4. KWRT token: reuse a valid KWRT token, or create a fresh one ────── */
async function ensureToken(previousConfig) {
  const fromEnv = process.env.KWRT_TOKEN_ID;
  const fromConfig = previousConfig && previousConfig.tokenId;
  const candidate = fromEnv || fromConfig;

  if (candidate) {
    const info = await mirrorToken(candidate).catch(() => null);
    if (info && info.name === 'KWRT' && info.symbol === 'KWRT' && Number(info.decimals) === 3) {
      const sellerBalance = await tokenHeldBy(SELLER_ID, candidate);
      console.log(`[ok] Reusing KWRT token ${candidate} (${info.name}/${info.symbol}, ${info.decimals} decimals).`);
      let mintTx = process.env.KWRT_MINT_TX || (previousConfig && previousConfig.transactions && previousConfig.transactions.mint) || null;
      if (sellerBalance < AMOUNT_UNITS) {
        const shortfall = AMOUNT_UNITS - sellerBalance;
        console.log(`[mint] Seller holds ${sellerBalance} units; minting ${shortfall} more...`);
        const mint = await mintToken({ wallet: sellerWallet, token: tokenIdToEvmAddress(candidate), amount: shortfall });
        mintTx = mint.hash;
        saveEnvValue('KWRT_MINT_TX', mint.hash);
        console.log(`[minted] ${shortfall} KWRT units · tx ${mint.hash}`);
      } else {
        console.log(`[ok] Seller already holds ${sellerBalance} KWRT units (ask needs ${AMOUNT_UNITS}).`);
      }
      return {
        tokenId: candidate,
        tokenEvm: tokenIdToEvmAddress(candidate),
        totalSupply: Number(info.total_supply) / 10 ** Number(info.decimals),
        mintTransactionId: mintTx,
        createTransactionId: previousConfig?.transactions?.tokenCreate || null,
        created: false
      };
    }
    console.log(`[migrate] Token ${candidate} is ${info ? `"${info.name}/${info.symbol}" with ${info.decimals} decimals` : 'unknown'} — creating a KWRT-branded replacement.`);
  }

  console.log('[creating] Creating KWRT token (name=KWRT, symbol=KWRT, 3 decimals)...');
  const created = await createFungibleToken({
    wallet: sellerWallet,
    name: 'KWRT',
    symbol: 'KWRT',
    memo: 'KWRT hourly renewable energy certificates',
    decimals: 3,
    treasury: sellerWallet.address,
    supplyKey: compressedPublicKey(sellerWallet),
    adminKey: compressedPublicKey(sellerWallet),
    autoRenewAccount: sellerWallet.address
  });
  console.log(`[ok] Created KWRT token ${created.tokenId} · tx ${created.hash}`);
  saveEnvValue('KWRT_TOKEN_ID', created.tokenId);

  const info = await waitForToken(created.tokenId);
  if (!info) throw new Error(`Token ${created.tokenId} was created but the mirror node does not show it yet.`);

  const mint = await mintToken({ wallet: sellerWallet, token: created.tokenAddress, amount: AMOUNT_UNITS });
  saveEnvValue('KWRT_MINT_TX', mint.hash);
  console.log(`[minted] ${ASK.kwh.toFixed(3)} kWh -> ${AMOUNT_UNITS} KWRT units to seller ${SELLER_ID} · tx ${mint.hash}`);

  return {
    tokenId: created.tokenId,
    tokenEvm: created.tokenAddress,
    totalSupply: AMOUNT_UNITS / 1000,
    mintTransactionId: mint.hash,
    createTransactionId: created.hash,
    created: true
  };
}

async function tokenHeldBy(accountId, tokenId) {
  const account = await mirrorAccount(accountId);
  const entry = (account?.balance?.tokens || []).find((t) => t.token_id === tokenId);
  return entry ? Number(entry.balance) : 0;
}

/* ── 5. Ensure client can receive KWRT (association), with no balance ──── */
async function ensureClientAssociation(clientId, clientWallet, tokenId) {
  const held = await tokenHeldBy(clientId, tokenId);
  const account = await mirrorAccount(clientId);
  const associated = (account?.balance?.tokens || []).some((t) => t.token_id === tokenId);
  if (associated) {
    console.log(`[ok] Client ${clientId} is already associated with ${tokenId} (balance ${held}).`);
    return;
  }

  console.log(`[associate] Associating client ${clientId} with ${tokenId}...`);
  const { hash } = await associateToken({
    wallet: clientWallet,
    account: clientWallet.address,
    token: tokenIdToEvmAddress(tokenId)
  });
  console.log(`[ok] Client is associated with KWRT and still holds 0 KWRT · tx ${hash}`);
}

/* ── 6. Make sure the client has HBAR for the live purchase ────────────── */
async function ensureClientFunds(clientId) {
  const account = await mirrorAccount(clientId);
  const current = tinybarsToHbar(account.balance.balance);
  if (current >= MIN_CLIENT_HBAR) {
    console.log(`[ok] Client has ${formatHbar(current)} HBAR (minimum ${MIN_CLIENT_HBAR}).`);
    return;
  }
  const topUp = Number((MIN_CLIENT_HBAR - current).toFixed(2));
  console.log(`[fund] Sending ${topUp} HBAR from seller to client...`);
  const { hash } = await sendHbar(sellerWallet, clientId, topUp);
  console.log(`[ok] Client funded to at least ${MIN_CLIENT_HBAR} HBAR · tx ${hash}`);
}

/* ── 7. Write the public relay config (no private keys) ────────────────── */
function writeConfig({ token, client, previousConfig }) {
  /* Keep the purchase state when the same accounts and token are reused, so a
     routine setup re-run never desynchronises the page from the chain. */
  const sameDemo = previousConfig
    && previousConfig.tokenId === token.tokenId
    && previousConfig.client?.accountId === client.id
    && previousConfig.seller?.accountId === SELLER_ID;
  const previousAsk = sameDemo ? previousConfig.ask : null;

  const config = {
    network: 'testnet',
    chainId: 296,
    hashio: 'https://testnet.hashio.io/api',
    mirror: 'https://testnet.mirrornode.hedera.com/api/v1',
    hashscan: 'https://hashscan.io/testnet',
    topicId: TOPIC_ID,
    updatedAt: new Date().toISOString(),
    tokenId: token.tokenId,
    token: {
      name: 'KWRT',
      symbol: 'KWRT',
      decimals: 3,
      totalSupply: token.totalSupply
    },
    seller: {
      accountId: SELLER_ID,
      evmAddress: sellerWallet.address,
      label: 'Atlas Wind Energy',
      role: 'seller'
    },
    client: {
      accountId: client.id,
      evmAddress: client.wallet.address,
      label: 'KWRT Demo Client',
      role: 'client'
    },
    ask: {
      askKey: ASK.askKey,
      certId: ASK.certId,
      producer: ASK.producer,
      country: ASK.country,
      sourceType: ASK.sourceType,
      kwh: ASK.kwh,
      amountTokenUnits: AMOUNT_UNITS,
      priceHbarPerKwh: ASK.priceHbarPerKwh,
      priceHbar: PRICE_HBAR,
      purchased: Boolean(previousAsk?.purchased),
      paymentSent: Boolean(previousAsk?.paymentSent),
      purchaseTransactionId: previousAsk?.purchaseTransactionId || null,
      purchasePaymentTransactionId: previousAsk?.purchasePaymentTransactionId || null,
      purchasedBy: previousAsk?.purchasedBy || null,
      purchasedAt: previousAsk?.purchasedAt || null
    },
    transactions: {
      tokenCreate: token.createTransactionId || previousConfig?.transactions?.tokenCreate || null,
      mint: token.mintTransactionId || null
    }
  };

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return config;
}

/* ── 8. Run ─────────────────────────────────────────────────────────────── */
async function main() {
  console.log('KWRT live-demo setup — testnet\n');

  const sellerAccount = await mirrorAccount(SELLER_ID);
  if (!sellerAccount) throw new Error(`Seller account ${SELLER_ID} not found on testnet.`);
  if (sellerAccount.evm_address && sellerAccount.evm_address.toLowerCase() !== sellerWallet.address.toLowerCase()) {
    console.warn(`[warn] .env key derives ${sellerWallet.address} but ${SELLER_ID} reports ${sellerAccount.evm_address}.`);
  } else {
    console.log(`[ok] Seller ${SELLER_ID} (${sellerWallet.address}) has ${formatHbar(tinybarsToHbar(sellerAccount.balance.balance))} HBAR.`);
  }

  const previousConfig = readExistingConfig();
  const client = await ensureClient();
  const token = await ensureToken(previousConfig);
  await ensureClientAssociation(client.id, client.wallet, token.tokenId);
  await ensureClientFunds(client.id);

  const config = writeConfig({ token, client, previousConfig });

  console.log('\n──────────────────────────────────────────────────────────────');
  console.log('Live demo ready — server/live-config.json (public data only)');
  console.log('──────────────────────────────────────────────────────────────\n');
  console.log(JSON.stringify(config, null, 2));

  const seller = await accountSummary(SELLER_ID, token.tokenId);
  const buyer = await accountSummary(client.id, token.tokenId);
  console.log('\nBalances now:');
  console.log(`  seller ${seller.accountId}: ${formatHbar(seller.hbar)} HBAR · ${seller.token} KWRT`);
  console.log(`  client ${buyer.accountId}: ${formatHbar(buyer.hbar)} HBAR · ${buyer.token} KWRT`);
  console.log('\nNext: node server/relay.mjs, then open http://127.0.0.1:8787 and choose "Live testnet".');
  console.log('Private keys stayed in .env and were never written to the config.\n');

  provider().destroy();
}

main().catch((err) => {
  console.error('\n[setup failed]', err);
  provider().destroy();
  process.exit(1);
});
