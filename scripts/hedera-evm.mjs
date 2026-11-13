/* ── KWRT prototype — Hedera testnet helpers over the HashIO JSON-RPC relay ──
   Hedera's native gRPC ports (50211/50212) are blocked on some networks,
   so the live demo talks to testnet through the public HashIO JSON-RPC
   endpoint (HTTPS 443) instead. HTS operations go through the system
   contract at 0x167, which is the standard EVM path on Hedera.

   Everything here runs server-side only. Private keys never reach the
   browser.
   ───────────────────────────────────────────────────────────────────────── */

import {
  JsonRpcProvider,
  Wallet,
  Interface,
  parseEther,
  formatEther,
  getAddress
} from 'ethers';
import { PrivateKey } from '@hiero-ledger/sdk';

export const HASHIO_URL = 'https://testnet.hashio.io/api';
export const MIRROR_URL = 'https://testnet.mirrornode.hedera.com/api/v1';
export const HASHSCAN_URL = 'https://hashscan.io/testnet';
export const CHAIN_ID = 296n;

export const HTS_ADDRESS = '0x0000000000000000000000000000000000000167';

const HTS_ABI = [
  'function createFungibleToken((string name, string symbol, address treasury, string memo, bool tokenSupplyType, uint32 maxSupply, bool freezeDefault, (uint256 keyType, (bool inheritAccountKey, address contractId, bytes ed25519, bytes ECDSA_secp256k1, address delegatableContractId) key)[] tokenKeys, (uint32 second, address autoRenewAccount, uint32 autoRenewPeriod) expiry) token, uint256 initialTotalSupply, uint256 decimals) payable returns (int64 responseCode, address token)',
  'function mintToken(address token, uint64 amount, bytes[] metadata) returns (int64 responseCode, uint64 newTotalSupply, int64[] serialNumbers)',
  'function associateToken(address account, address token) returns (int64 responseCode)',
  'function transferToken(address token, address sender, address receiver, int64 amount) returns (int64 responseCode)',
  'function dissociateToken(address account, address token) returns (int64 responseCode)'
];

export const htsInterface = new Interface(HTS_ABI);

export const KEY_TYPE = {
  ADMIN: 1,
  SUPPLY: 16
};

const SUCCESS = 22n;

let sharedProvider = null;
export function provider() {
  if (!sharedProvider) {
    sharedProvider = new JsonRpcProvider(HASHIO_URL, Number(CHAIN_ID), { staticNetwork: true });
  }
  return sharedProvider;
}

/* Turn a Hedera private key string (DER or raw, ED25519 or ECDSA) into an
   ethers wallet. The live demo requires an ECDSA key because EVM accounts
   are addressed by the secp256k1 public key. */
export function walletFromHederaKey(privateKeyString) {
  const pk = PrivateKey.fromString(privateKeyString);
  if (pk.type !== 'secp256k1') {
    throw new Error(`Expected a secp256k1 (ECDSA) key, got ${pk.type}. The EVM relay path needs an ECDSA key.`);
  }
  const raw = pk.toStringRaw().replace(/^0x/, '');
  return new Wallet('0x' + raw, provider());
}

export function compressedPublicKey(wallet) {
  return wallet.signingKey.compressedPublicKey;
}

/* 0.0.x <-> 20-byte EVM address (shard 4 bytes, realm 8 bytes, num 8 bytes). */
export function accountIdToEvmAddress(accountId) {
  const [shard, realm, num] = String(accountId).split('.').map((v) => BigInt(v));
  return '0x' + shard.toString(16).padStart(8, '0') + realm.toString(16).padStart(16, '0') + num.toString(16).padStart(16, '0');
}

export function evmAddressToAccountId(address) {
  const hex = address.toLowerCase().replace(/^0x/, '').padStart(40, '0');
  const shard = BigInt('0x' + hex.slice(0, 8));
  const realm = BigInt('0x' + hex.slice(8, 24));
  const num = BigInt('0x' + hex.slice(24, 40));
  return `${shard}.${realm}.${num}`;
}

export function tokenIdToEvmAddress(tokenId) {
  return accountIdToEvmAddress(tokenId);
}

export async function mirror(path) {
  const res = await fetch(`${MIRROR_URL}${path}`, { headers: { accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Mirror node ${path} -> HTTP ${res.status}`);
  return res.json();
}

export async function mirrorAccount(idOrEvm) {
  return mirror(`/accounts/${idOrEvm}`);
}

export async function mirrorToken(id) {
  return mirror(`/tokens/${id}`);
}

export function tinybarsToHbar(tinybars) {
  return Number(tinybars) / 1e8;
}

export function formatHbar(value) {
  return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* Poll the mirror node until it knows about a freshly created account. */
export async function waitForAccount(idOrEvm, attempts = 20, delayMs = 2000) {
  for (let i = 0; i < attempts; i += 1) {
    const account = await mirrorAccount(idOrEvm).catch(() => null);
    if (account && account.account) return account;
    await sleep(delayMs);
  }
  return null;
}

export async function waitForToken(id, attempts = 20, delayMs = 2000) {
  for (let i = 0; i < attempts; i += 1) {
    const token = await mirrorToken(id).catch(() => null);
    if (token && token.token_id) return token;
    await sleep(delayMs);
  }
  return null;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendAndWait(wallet, txRequest) {
  const tx = await wallet.sendTransaction({ chainId: CHAIN_ID, ...txRequest });
  const receipt = await tx.wait();
  return { hash: tx.hash, receipt };
}

/* Pre-flight simulation: HTS never reverts, it returns a response code.
   Simulating first means a bad call costs nothing. */
async function simulateHts(wallet, data, value = 0n) {
  const raw = await provider().call({ to: HTS_ADDRESS, from: wallet.address, data, value });
  return htsInterface.decodeFunctionResult(data.slice(0, 10), raw);
}

function responseName(code) {
  const map = {
    22: 'SUCCESS',
    167: 'INVALID_TOKEN_ID',
    184: 'TOKEN_NOT_ASSOCIATED_TO_ACCOUNT',
    194: 'TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT',
    198: 'INSUFFICIENT_TOKEN_BALANCE',
    247: 'TOKEN_ALREADY_EXISTS',
    260: 'INSUFFICIENT_SENDER_ACCOUNT_BALANCE_FOR_TOKEN_TRANSFER',
    263: 'ACCOUNT_DOES_NOT_OWN_WIPED_NFT',
    267: 'INVALID_NFT_ID',
    270: 'TOKEN_IS_PAUSED',
    273: 'TOKEN_NOT_PAUSED',
    275: 'INVALID_SIGNATURE'
  };
  return map[Number(code)] || `HTS_RESPONSE_${code}`;
}

function ensureSuccess(result, context) {
  const code = result[0];
  if (BigInt(code) !== SUCCESS) {
    throw new Error(`${context} failed: ${responseName(code)} (${code})`);
  }
}

/* Resolve an account ID (0.0.x) to the account's EVM alias address.
   Sending value to a long-zero address is rejected by testnet with
   INVALID_ALIAS_KEY, so always transfer to the account's evm_address. */
export async function resolveEvmAddress(accountOrAddress) {
  const value = String(accountOrAddress);
  if (/^\d+\.\d+\.\d+$/.test(value)) {
    const account = await mirrorAccount(value);
    if (!account) throw new Error(`Account ${value} was not found on the mirror node`);
    return account.evm_address || accountIdToEvmAddress(value);
  }
  return accountOrAddress;
}

/* ── HBAR transfer ─────────────────────────────────────────────────────── */
export async function sendHbar(wallet, to, hbar, gasLimit = 1000000n) {
  const destination = await resolveEvmAddress(to);
  return sendAndWait(wallet, { to: destination, value: parseEther(String(hbar)), gasLimit });
}

export async function sendHbarToNewAccount(wallet, to, hbar) {
  // Sending HBAR to an address with no account auto-creates it on Hedera.
  return sendAndWait(wallet, { to, value: parseEther(String(hbar)), gasLimit: 1000000n });
}

/* HTS token creation charges the TokenCreate fee through msg.value.
   At the current testnet exchange rate it is ~18.x HBAR; 30 leaves a buffer. */
const TOKEN_CREATE_FEE = parseEther('30');

/* ── HTS: create fungible token ────────────────────────────────────────── */
export async function createFungibleToken({ wallet, name, symbol, memo, decimals, treasury, supplyKey, adminKey, autoRenewAccount }) {
  const emptyKey = {
    inheritAccountKey: false,
    contractId: '0x0000000000000000000000000000000000000000',
    ed25519: '0x',
    ECDSA_secp256k1: '0x',
    delegatableContractId: '0x0000000000000000000000000000000000000000'
  };
  const keyValue = (ecdsaBytes) => ({ ...emptyKey, ECDSA_secp256k1: ecdsaBytes });

  const keys = [];
  if (adminKey) keys.push({ keyType: KEY_TYPE.ADMIN, key: keyValue(adminKey) });
  if (supplyKey) keys.push({ keyType: KEY_TYPE.SUPPLY, key: keyValue(supplyKey) });

  const now = Math.floor(Date.now() / 1000);
  const expiry = {
    second: now + 90 * 86400,
    autoRenewAccount: autoRenewAccount || treasury,
    autoRenewPeriod: 7776000
  };

  const token = {
    name,
    symbol,
    treasury,
    memo: memo || '',
    tokenSupplyType: false, // false = infinite supply
    maxSupply: 0,
    freezeDefault: false,
    tokenKeys: keys,
    expiry
  };

  const data = htsInterface.encodeFunctionData('createFungibleToken', [token, 0, decimals]);
  const sim = await simulateHts(wallet, data, TOKEN_CREATE_FEE);
  ensureSuccess(sim, 'createFungibleToken');

  const { hash, receipt } = await sendAndWait(wallet, { to: HTS_ADDRESS, data, value: TOKEN_CREATE_FEE, gasLimit: 3000000n });

  // The EVM receipt does not expose the HTS return data; the mirror node does.
  let tokenAddress = sim[1];
  const result = await waitForContractResult(hash);
  if (result && result.call_result) {
    const decoded = htsInterface.decodeFunctionResult('createFungibleToken', result.call_result);
    ensureSuccess(decoded, 'createFungibleToken');
    tokenAddress = decoded[1];
  }
  return { hash, tokenAddress, tokenId: evmAddressToAccountId(tokenAddress), receipt };
}

export async function waitForContractResult(hash, attempts = 20, delayMs = 1500) {
  for (let i = 0; i < attempts; i += 1) {
    const res = await fetch(`${MIRROR_URL}/contracts/results/${hash}`, { headers: { accept: 'application/json' } });
    if (res.ok) return res.json();
    await sleep(delayMs);
  }
  return null;
}

export async function mintToken({ wallet, token, amount }) {
  const data = htsInterface.encodeFunctionData('mintToken', [token, amount, []]);
  const sim = await simulateHts(wallet, data);
  ensureSuccess(sim, 'mintToken');
  const { hash } = await sendAndWait(wallet, { to: HTS_ADDRESS, data, gasLimit: 1500000n });
  return { hash, newTotalSupply: sim[1] };
}

export async function associateToken({ wallet, account, token }) {
  const accountAddress = await resolveEvmAddress(account);
  const data = htsInterface.encodeFunctionData('associateToken', [accountAddress, token]);
  const sim = await simulateHts(wallet, data);
  ensureSuccess(sim, 'associateToken');
  const { hash } = await sendAndWait(wallet, { to: HTS_ADDRESS, data, gasLimit: 1500000n });
  return { hash };
}

export async function transferToken({ wallet, token, sender, receiver, amount }) {
  const [senderAddress, receiverAddress] = await Promise.all([
    resolveEvmAddress(sender),
    resolveEvmAddress(receiver)
  ]);
  const data = htsInterface.encodeFunctionData('transferToken', [token, senderAddress, receiverAddress, amount]);
  const sim = await simulateHts(wallet, data);
  ensureSuccess(sim, 'transferToken');
  const { hash } = await sendAndWait(wallet, { to: HTS_ADDRESS, data, gasLimit: 1500000n });
  return { hash };
}

/* ── Balances ──────────────────────────────────────────────────────────── */
export function tokenBalanceFromAccount(account, tokenId) {
  const entry = (account?.balance?.tokens || []).find((t) => t.token_id === tokenId);
  return entry ? Number(entry.balance) / 10 ** Number(entry.decimals || 3) : 0;
}

export async function accountSummary(accountId, tokenId) {
  const account = await mirrorAccount(accountId);
  if (!account) throw new Error(`Account ${accountId} not found on testnet`);
  return {
    accountId: account.account,
    evmAddress: account.evm_address,
    hbar: tinybarsToHbar(account.balance.balance),
    token: tokenBalanceFromAccount(account, tokenId),
    tokens: (account.balance.tokens || []).map((t) => ({ tokenId: t.token_id, balance: Number(t.balance), decimals: t.decimals })),
    keyType: account.key?._type || 'unknown'
  };
}

export { formatEther, parseEther, getAddress };
