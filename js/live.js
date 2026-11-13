/* ── Live testnet section ─────────────────────────────────────────────────────
   Talks to the local relay (server/relay.mjs). The relay serves this page on
   http://127.0.0.1:8787 and exposes:

     GET  /relay/config      public config + live balances
     POST /relay/live/buy    real testnet purchase
     POST /relay/live/reset  return the demo to its starting state

   No keys, no signing and no WalletConnect in the browser: the relay holds
   the two demo accounts and submits transactions server-side.
   ───────────────────────────────────────────────────────────────────────── */
(function (global) {
  'use strict';

  const L = {};
  const RELAY_PORT = '8787';
  const RELAY_BASE = (location.protocol === 'http:' || location.protocol === 'https:') && location.port === RELAY_PORT
    ? ''
    : `http://127.0.0.1:${RELAY_PORT}`;

  let state = null;
  let lastRun = null;
  let error = null;
  let busy = false;
  let timer = null;

  const $ = (id) => document.getElementById(id);

  function hbar(v) {
    return Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function token(v) {
    const n = Number(v);
    return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
  }

  function shortHash(hash) {
    return hash && hash.length > 18 ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : hash;
  }

  async function api(path, options) {
    let res;
    try {
      res = await fetch(RELAY_BASE + path, options);
    } catch (err) {
      const e = new Error('Cannot reach the local relay. Start it with: node server/relay.mjs');
      e.offline = true;
      throw e;
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      const e = new Error(body.error || `Relay returned HTTP ${res.status}`);
      e.payload = body;
      throw e;
    }
    return body;
  }

  /* ── rendering ─────────────────────────────────────────────────────────── */
  function accountCard(el, account, role) {
    if (!account) return;
    el.innerHTML = `
      <div class="account-id">
        <a class="account-link mono" href="${account.hashscan}" target="_blank" rel="noopener">${account.accountId} ↗</a>
        <span class="account-evm mono">${U.esc(account.evmAddress || '')}</span>
      </div>
      <div class="account-balances">
        <div class="bal">
          <span class="bal-label">HBAR</span>
          <span class="bal-value">${hbar(account.hbar)}</span>
        </div>
        <div class="bal">
          <span class="bal-label">KWRT</span>
          <span class="bal-value ${Number(account.kwrt) === 0 ? 'bal-zero' : ''}">${token(account.kwrt)}</span>
        </div>
      </div>
      <p class="account-note">${role === 'client'
        ? (Number(account.kwrt) === 0 ? 'Ready: holds HBAR, no KWRT yet.' : 'Holds the certificate after settlement.')
        : 'Receives HBAR, sends KWRT.'}</p>`;
  }

  function renderAsk() {
    const config = state.config;
    const ask = config.ask;
    const buy = $('live-buy');
    const note = $('live-buy-note');
    const purchased = Boolean(ask.purchased);
    const client = state.balances.client;

    $('live-ask').innerHTML = `
      <div class="live-ask-head">
        <div>
          <div class="live-ask-title">${U.esc(ask.producer)}</div>
          <div class="live-ask-sub mono">${U.esc(ask.certId)} · ${U.esc(ask.sourceType)} · ${U.esc(ask.country)}</div>
        </div>
        <span class="live-kwh">${ask.kwh.toLocaleString('en-US', { minimumFractionDigits: 0 })}<span> kWh</span></span>
      </div>
      <dl class="live-facts">
        <div><dt>Price</dt><dd>${ask.priceHbarPerKwh.toFixed(4)} ℏ/kWh</dd></div>
        <div><dt>Total</dt><dd><b>${ask.priceHbar.toFixed(3)} HBAR</b></dd></div>
        <div><dt>Token amount</dt><dd>${token(ask.amountTokenUnits / 1000)} KWRT</dd></div>
        <div><dt>Token</dt><dd class="mono">${U.esc(config.tokenId)}</dd></div>
      </dl>`;

    buy.textContent = purchased
      ? 'Certificate already bought'
      : busy
        ? 'Submitting to testnet…'
        : `Buy certificate — ${ask.priceHbar.toFixed(3)} HBAR`;
    buy.disabled = busy || purchased || !client || Number(client.hbar) < ask.priceHbar + 1;
    buy.classList.add('btn-live');
    $('live-reset').disabled = busy || (!purchased && !ask.paymentSent && Number(client?.kwrt || 0) === 0);

    if (error) {
      note.innerHTML = `<span class="live-error">${U.esc(error)}</span>`;
    } else if (purchased) {
      note.textContent = `Bought by ${ask.purchasedBy || state.config.client.accountId}. Reset the demo to run it again.`;
    } else {
      note.textContent = 'The client starts with HBAR and zero KWRT. The relay signs both legs and reports the real hashes.';
    }
  }

  function stepHtml(step, status) {
    const icon = status === 'fail' ? '✕' : status === 'run' ? '…' : '✓';
    return `<div class="live-step ${status}">
      <span class="live-step-ico">${icon}</span>
      <div class="live-step-body">
        <div class="live-step-label">${U.esc(step.label)}</div>
        ${step.hash
          ? `<a class="live-step-hash mono" href="${step.hashscan}" target="_blank" rel="noopener">${shortHash(step.hash)} ↗</a>`
          : ''}
      </div>
    </div>`;
  }

  function renderSteps(steps, opts) {
    const box = $('live-steps');
    const list = steps || [];
    if (!list.length) {
      box.innerHTML = '<p class="note" style="margin-top:0">No purchase yet. The client will pay HBAR and receive KWRT.</p>';
      return;
    }
    box.innerHTML = list.map((s) => stepHtml(s, opts && opts.failed ? 'fail' : 'ok')).join('') +
      (opts && opts.message
        ? `<div class="${opts.failed ? 'live-error' : 'live-success'}">${U.esc(opts.message)}</div>`
        : '');
  }

  function renderLinks() {
    const config = state.config;
    const tx = config.transactions || {};
    const rows = [
      { label: 'KWRT token', id: config.tokenId, url: `${config.hashscan}/token/${config.tokenId}` },
      { label: 'Seller account', id: config.seller.accountId, url: `${config.hashscan}/account/${config.seller.accountId}` },
      { label: 'Client account', id: config.client.accountId, url: `${config.hashscan}/account/${config.client.accountId}` },
      { label: 'HCS topic', id: config.topicId, url: `${config.hashscan}/topic/${config.topicId}` }
    ];
    if (tx.tokenCreate) rows.push({ label: 'Token create tx', id: shortHash(tx.tokenCreate), url: `${config.hashscan}/transaction/${tx.tokenCreate}` });
    if (tx.mint) rows.push({ label: 'Mint tx', id: shortHash(tx.mint), url: `${config.hashscan}/transaction/${tx.mint}` });
    if (config.ask.purchaseTransactionId) rows.push({ label: 'Purchase tx', id: shortHash(config.ask.purchaseTransactionId), url: `${config.hashscan}/transaction/${config.ask.purchaseTransactionId}` });
    if (config.ask.purchasePaymentTransactionId) rows.push({ label: 'Payment tx', id: shortHash(config.ask.purchasePaymentTransactionId), url: `${config.hashscan}/transaction/${config.ask.purchasePaymentTransactionId}` });

    $('live-links').innerHTML = rows.map((r) => `
      <a class="live-link" href="${r.url}" target="_blank" rel="noopener">
        <span class="live-link-label">${r.label}</span>
        <span class="mono">${U.esc(r.id)}</span>
      </a>`).join('');
  }

  function render() {
    if (!state) return;
    $('live-relay-pill').innerHTML = '<span class="live-pill-dot"></span>relay: online';
    $('live-relay-pill').classList.remove('is-offline');
    accountCard($('live-seller'), state.balances.seller, 'seller');
    accountCard($('live-client'), state.balances.client, 'client');
    renderAsk();
    renderLinks();
    if (lastRun) renderSteps(lastRun.steps, lastRun);
  }

  function renderOffline(err) {
    error = err.message;
    $('live-relay-pill').classList.add('is-offline');
    $('live-relay-pill').innerHTML = '<span class="live-pill-dot"></span>relay: offline';
    $('live-buy').disabled = true;
    $('live-reset').disabled = true;
    $('live-buy-note').innerHTML = `<span class="live-error">${U.esc(error)}</span>`;
    $('live-steps').innerHTML = `<div class="live-offline">
      <b>The live demo needs its local relay.</b>
      <p>Run this from the project folder, then reload:</p>
      <code>node server/relay.mjs</code>
      <p>Then open <a href="http://127.0.0.1:8787" target="_blank" rel="noopener">http://127.0.0.1:8787</a> and choose Live testnet.</p>
    </div>`;
  }

  /* ── data ──────────────────────────────────────────────────────────────── */
  async function load(silent) {
    try {
      const data = await api('/relay/config');
      state = {
        config: data.config,
        token: data.token,
        balances: data.balances
      };
      error = null;
      const cfg = state.config;
      if (cfg.ask.purchased) {
        lastRun = {
          steps: [
            {
              label: `Client paid ${cfg.ask.priceHbar.toFixed(3)} HBAR to ${cfg.seller.label}`,
              hash: cfg.ask.purchasePaymentTransactionId,
              hashscan: `${cfg.hashscan}/transaction/${cfg.ask.purchasePaymentTransactionId}`
            },
            {
              label: `${cfg.seller.label} sent ${cfg.ask.kwh} KWRT to the client`,
              hash: cfg.ask.purchaseTransactionId,
              hashscan: `${cfg.hashscan}/transaction/${cfg.ask.purchaseTransactionId}`
            }
          ],
          message: 'Settled on Hedera testnet. Both hashes are real.'
        };
        renderSteps(lastRun.steps, lastRun);
      } else if (!lastRun) {
        renderSteps(null);
      }
      render();
    } catch (err) {
      console.error('[live]', err);
      renderOffline(err);
    }
    if (!silent) render();
  }

  async function buy() {
    if (busy) return;
    busy = true;
    error = null;
    lastRun = null;
    const ask = state.config.ask;
    renderAsk();
    $('live-steps').innerHTML = [
      stepHtml({ label: `Client pays ${ask.priceHbar.toFixed(3)} HBAR to ${state.config.seller.label}` }, 'run'),
      stepHtml({ label: `${state.config.seller.label} sends ${ask.kwh} KWRT to the client` }, 'run')
    ].join('');

    try {
      const result = await api('/relay/live/buy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ askKey: ask.askKey })
      });
      lastRun = {
        steps: result.steps,
        message: result.synced
          ? `Settled on Hedera testnet. The client now holds ${token(result.balances.client.kwrt)} KWRT.`
          : 'Transactions submitted. The mirror node is still catching up — hit Refresh in a few seconds.'
      };
      state.config.ask = result.ask;
      state.balances = result.balances;
      renderSteps(lastRun.steps, lastRun);
      if (typeof Dashboard !== 'undefined' && Dashboard.pushEvent) {
        Dashboard.pushEvent('LIVE BUY', 'chain',
          `Client <b>${state.config.client.accountId}</b> bought <b>${ask.kwh} kWh</b> from ${U.esc(ask.producer)} on testnet — <span class="mono">${shortHash(result.steps[1].hash)}</span>`);
      }
    } catch (err) {
      console.error('[live buy]', err);
      error = err.message;
      renderSteps(err.payload && err.payload.steps ? err.payload.steps : null, { failed: true, message: err.message });
      if (err.payload && err.payload.refund) {
        $('live-steps').insertAdjacentHTML('beforeend',
          `<div class="live-step ok"><span class="live-step-ico">✓</span><div class="live-step-body">
            <div class="live-step-label">Payment refunded to the client</div>
            <a class="live-step-hash mono" href="${err.payload.refund.hashscan}" target="_blank" rel="noopener">${shortHash(err.payload.refund.hash)} ↗</a>
          </div></div>`);
      }
    } finally {
      busy = false;
      await load(true);
      render();
    }
  }

  async function reset() {
    if (busy) return;
    busy = true;
    error = null;
    $('live-buy').disabled = true;
    $('live-reset').disabled = true;
    $('live-buy').textContent = 'Resetting demo…';
    try {
      const result = await api('/relay/live/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      lastRun = {
        steps: result.steps,
        message: 'Demo reset. The client is back to HBAR and zero KWRT.'
      };
      state.balances = result.balances;
      renderSteps(lastRun.steps, lastRun);
      if (typeof Dashboard !== 'undefined' && Dashboard.pushEvent) {
        Dashboard.pushEvent('LIVE RESET', 'chain', 'Live demo reset — KWRT returned to the seller and the client refunded.');
      }
    } catch (err) {
      console.error('[live reset]', err);
      error = err.message;
      renderSteps(null, { failed: true, message: err.message });
    } finally {
      busy = false;
      await load(true);
      render();
    }
  }

  /* ── public ────────────────────────────────────────────────────────────── */
  L.render = function () {
    if (!$('live-ask')) return;
    load();
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      const view = $('view-live');
      if (view && view.classList.contains('is-active') && !busy) load(true);
    }, 20000);
  };

  document.addEventListener('DOMContentLoaded', () => {
    const buyBtn = $('live-buy');
    const resetBtn = $('live-reset');
    const refreshBtn = $('live-refresh');
    if (buyBtn) buyBtn.onclick = buy;
    if (resetBtn) resetBtn.onclick = reset;
    if (refreshBtn) refreshBtn.onclick = () => load();
  });

  global.Live = L;
})(window);
