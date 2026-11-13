/* ── Marketplace: order book, rule-based buyer agent, settlement, retirement ── */
(function (global) {
  'use strict';
  const M = {};
  const NOW = new Date('2026-08-22T12:00:00Z');
  const vintageDays = (iso) => Math.max(0, Math.round((NOW - new Date(iso)) / 86400000 * 10) / 10);

  function bids() {
    const rows = CW.ORDERS.filter((o) => o.side === 'BID').sort((a, b) => b.priceHbarPerKwh - a.priceHbarPerKwh)
      .map((o) => `<tr>
        <td><b>${o.buyer}</b><br><span style="font-size:11px;color:var(--text-3)">${o.sourceTypes.join(' / ')} · ${o.locality.join(', ')}</span></td>
        <td class="num">${o.priceHbarPerKwh.toFixed(4)}</td>
        <td class="num">${U.num(o.kwh)}</td>
        <td class="num">${(o.kwh * o.priceHbarPerKwh).toFixed(2)}</td>
      </tr>`).join('');
    document.getElementById('tbl-bids').innerHTML =
      `<thead><tr><th>Buyer</th><th class="num">ℏ/kWh</th><th class="num">kWh</th><th class="num">Total ℏ</th></tr></thead><tbody>${rows}</tbody>`;
  }

  function asks() {
    const rows = CW.ORDERS.filter((o) => o.side === 'ASK').sort((a, b) => a.priceHbarPerKwh - b.priceHbarPerKwh)
      .map((o) => `<tr id="ask-${o.id}">
        <td><b>${o.producer}</b><br><span class="mono" style="font-size:11px;color:var(--text-3)">${o.certId} · ${o.sourceType} · ${o.country}</span></td>
        <td class="num">${o.priceHbarPerKwh.toFixed(4)}</td>
        <td class="num">${o.kwh.toFixed(1)}</td>
        <td class="num">${vintageDays(o.vintage).toFixed(1)} d</td>
        <td>${o.status === 'OPEN' ? '<span class="pill">OPEN</span>' : '<span class="pill pill-pass">FILLED</span>'}</td>
      </tr>`).join('');
    document.getElementById('tbl-asks').innerHTML =
      `<thead><tr><th>Certificate</th><th class="num">ℏ/kWh</th><th class="num">kWh</th><th class="num">Vintage</th><th>Status</th></tr></thead><tbody>${rows}</tbody>`;
  }

  function policyPanel() {
    const b = CW.BUYERS.find((x) => x.id === document.getElementById('mkt-agent').value) || CW.BUYERS[0];
    const p = b.policy;
    document.getElementById('policy').innerHTML = [
      ['Price cap', p.priceCapHbarPerKwh.toFixed(4) + ' ℏ/kWh'],
      ['Accepted source types', p.sourceTypes.join(' / ')],
      ['Maximum vintage', '< ' + p.maxVintageDays + ' days'],
      ['Locality', p.locality.join(', ')],
      ['Account', b.account],
      ['Matcher', 'deterministic rule-based, not AI']
    ].map(([k, v]) => `<div class="row"><span>${k}</span><span class="v">${v}</span></div>`).join('');
  }

  function evaluateAsk(ask, p) {
    const checks = [
      { k: 'price ≤ cap', ok: ask.priceHbarPerKwh <= p.priceCapHbarPerKwh, v: `${ask.priceHbarPerKwh.toFixed(4)} ≤ ${p.priceCapHbarPerKwh.toFixed(4)}` },
      { k: 'source type', ok: p.sourceTypes.includes(ask.sourceType), v: ask.sourceType },
      { k: 'vintage', ok: vintageDays(ask.vintage) < p.maxVintageDays, v: vintageDays(ask.vintage).toFixed(1) + ' d < ' + p.maxVintageDays + ' d' },
      { k: 'locality', ok: p.locality.includes(ask.country), v: ask.country }
    ];
    return { ok: checks.every((c) => c.ok), checks };
  }

  async function runMatch() {
    const buyer = CW.BUYERS.find((x) => x.id === document.getElementById('mkt-agent').value) || CW.BUYERS[0];
    const open = CW.ORDERS.filter((o) => o.side === 'ASK' && o.status === 'OPEN')
      .sort((a, b) => a.priceHbarPerKwh - b.priceHbarPerKwh);
    const box = document.getElementById('settle');
    const btn = document.getElementById('mkt-match');
    btn.disabled = true;
    box.innerHTML = `<div class="settle-anim"><div class="mono" style="font-size:11.5px;color:var(--text-2)">Scanning ${open.length} open asks against ${buyer.name}'s policy…</div></div>`;
    await U.sleep(420);

    let chosen = null, rejected = [];
    for (const ask of open) {
      const res = evaluateAsk(ask, buyer.policy);
      if (res.ok) { chosen = { ask, res }; break; }
      rejected.push({ ask, res });
    }

    if (!chosen) {
      box.innerHTML = `<div class="settle-anim">
        <div class="mono" style="font-size:11.5px;color:var(--amber)">No ask satisfies the policy — nothing is bought. The agent never relaxes its own constraints.</div>
        ${rejected.slice(0, 3).map((x) => `<div class="settle-leg on" style="opacity:.8">${x.ask.certId}: ${x.res.checks.filter((c) => !c.ok).map((c) => c.k + ' (' + c.v + ')').join(', ')}</div>`).join('')}
      </div>`;
      btn.disabled = false;
      return;
    }

    const { ask, res } = chosen;
    const total = Math.round(ask.kwh * ask.priceHbarPerKwh * 1000) / 1000;
    box.innerHTML = `<div class="settle-anim">
      <div style="font-size:12px;color:var(--text-2);margin-bottom:8px">Matched <b class="mono">${ask.certId}</b> — ${ask.producer}, ${ask.kwh.toFixed(1)} kWh at ${ask.priceHbarPerKwh.toFixed(4)} ℏ/kWh</div>
      ${res.checks.map((c) => `<div class="settle-leg" data-leg><span class="arrow">✓</span> ${c.k}: ${c.v}</div>`).join('')}
      <div class="settle-leg hbar" data-leg><span class="arrow">→</span> ${total.toFixed(3)} ℏ  ${buyer.name} → ${ask.producer}</div>
      <div class="settle-leg" data-leg><span class="arrow">←</span> ${ask.kwh.toFixed(3)} KWRT  treasury → ${buyer.account}</div>
      <div class="atomic" id="atomic-line"></div>
    </div>`;
    const legs = box.querySelectorAll('[data-leg]');
    for (const leg of legs) { leg.classList.add('on'); await U.sleep(190); }

    const tx = CW.txId(buyer.account, CW.nextConsensus(60));
    document.getElementById('atomic-line').classList.add('on');
    document.getElementById('atomic-line').innerHTML =
      `Single atomic transaction — both legs or neither.<br>tx ${tx}
       <a class="hs-link" href="${CW.hs.tx(tx)}" target="_blank" rel="noopener" style="display:inline-block;margin-top:8px">Transfer tx ↗</a>`;

    ask.status = 'FILLED';
    const cert = CW.CERTIFICATES.find((c) => c.id === ask.certId);
    if (cert) { cert.status = 'TRANSFERRED'; cert.owner = buyer.name; }
    CW.TRADES.push({
      id: 'TRD-' + String(CW.TRADES.length + 1).padStart(3, '0'),
      certId: ask.certId, buyer: buyer.name, buyerAccount: buyer.account, seller: ask.producer,
      kwh: ask.kwh, priceHbarPerKwh: ask.priceHbarPerKwh, totalHbar: total, transactionId: tx, atomic: true
    });
    asks(); trades(); retirePicker();
    const row = document.getElementById('ask-' + ask.id);
    if (row) row.classList.add('mkt-flash');
    Dashboard.pushEvent('TRADE', 'chain', `<b>${buyer.name}</b> agent matched ${ask.certId} — ${ask.kwh.toFixed(1)} kWh at ${ask.priceHbarPerKwh.toFixed(4)} ℏ/kWh, settled atomically`);
    btn.disabled = false;
  }

  function trades() {
    const rows = CW.TRADES.slice().reverse().map((t) => `<tr>
      <td><b class="mono">${t.id}</b><br><span class="mono" style="font-size:11px;color:var(--text-3)">${t.certId}</span></td>
      <td>${t.buyer}<br><span style="font-size:11px;color:var(--text-3)">from ${t.seller}</span></td>
      <td class="num">${t.kwh.toFixed(1)}</td>
      <td class="num">${t.priceHbarPerKwh.toFixed(4)}</td>
      <td class="num">${t.totalHbar.toFixed(2)}</td>
      <td><a class="hs-link" href="${CW.hs.tx(t.transactionId)}" target="_blank" rel="noopener">tx ↗</a></td>
    </tr>`).join('');
    document.getElementById('tbl-trades').innerHTML =
      `<thead><tr><th>Trade</th><th>Buyer</th><th class="num">kWh</th><th class="num">ℏ/kWh</th><th class="num">Total ℏ</th><th>Atomic settlement</th></tr></thead><tbody>${rows}</tbody>`;
  }

  function retirements() {
    const rows = CW.RETIREMENTS.slice().reverse().map((r) => `<tr>
      <td><b class="mono">${r.id}</b><br><span class="mono" style="font-size:11px;color:var(--text-3)">${r.certId}</span></td>
      <td>${r.beneficiary}</td>
      <td class="num">${r.kwh.toFixed(1)}</td>
      <td><span class="mono" style="font-size:11px">burn ${U.shortId(r.burnTransactionId, 12)}</span><br><span class="mono" style="font-size:11px;color:var(--text-3)">receipt HCS #${r.hcsSeq}</span></td>
    </tr>`).join('');
    document.getElementById('tbl-retirements').innerHTML =
      `<thead><tr><th>Retirement</th><th>Beneficiary</th><th class="num">kWh</th><th>On-chain</th></tr></thead><tbody>${rows}</tbody>`;
  }

  function retirePicker() {
    const sel = document.getElementById('ret-pick');
    const eligible = CW.CERTIFICATES.filter((c) => c.status === 'ACTIVE' || c.status === 'TRANSFERRED');
    sel.innerHTML = eligible.map((c) =>
      `<option value="${c.id}">${c.id} · ${c.producer} · ${c.kwh.toFixed(1)} kWh · ${c.status}</option>`).join('');
  }

  async function retire() {
    const sel = document.getElementById('ret-pick');
    const cert = CW.CERTIFICATES.find((c) => c.id === sel.value);
    const btn = document.getElementById('ret-run');
    if (!cert) return;
    btn.disabled = true;
    const box = document.getElementById('receipt');
    box.innerHTML = `<div class="settle-anim"><div class="settle-leg on"><span class="arrow">→</span> TokenBurn ${cert.kwh.toFixed(3)} KWRT — supply reduced</div></div>`;
    await U.sleep(520);
    const burnTs = CW.nextConsensus(90);
    const burnTx = CW.txId(CW.CHAIN.treasury, burnTs);
    const seq = CW.nextSeq();
    const rec = {
      id: 'RET-' + String(CW.RETIREMENTS.length + 1).padStart(3, '0'),
      certId: cert.id, kwh: cert.kwh, beneficiary: cert.owner || 'GreenCorp International',
      burnTransactionId: burnTx, hcsSeq: seq, consensusTimestamp: CW.nextConsensus(3),
      reason: 'Scope 2 hourly matching, Q3 2026'
    };
    CW.RETIREMENTS.push(rec);
    cert.status = 'RETIRED';
    box.innerHTML = `<div class="settle-anim">
      <div class="settle-leg on"><span class="arrow">→</span> TokenBurn ${cert.kwh.toFixed(3)} KWRT — supply reduced, cannot be resold</div>
      <div class="settle-leg hbar on"><span class="arrow">→</span> HCS retirement receipt #${seq} for ${rec.beneficiary}</div>
      <div class="atomic on">burn tx ${burnTx}
        <a class="hs-link" href="${CW.hs.tx(burnTx)}" target="_blank" rel="noopener" style="display:inline-block;margin-top:8px">Burn tx ↗</a>
        <a class="hs-link" href="${CW.hs.topic()}" target="_blank" rel="noopener" style="display:inline-block;margin:8px 0 0 6px">Receipt HCS #${seq} ↗</a>
      </div></div>`;
    retirements(); retirePicker(); asks();
    Dashboard.pushEvent('BURN', 'chain', `Retired <b>${cert.kwh.toFixed(1)} kWh</b> (${cert.id}) for ${rec.beneficiary} — burn + receipt HCS <span class="mono">#${seq}</span>`);
    btn.disabled = false;
  }

  /* ── render ────────────────────────────────────────────────────────────── */
  M.render = function () {
    const agent = document.getElementById('mkt-agent');
    if (!agent.options.length) {
      agent.innerHTML = CW.BUYERS.map((b) => `<option value="${b.id}">${b.name}</option>`).join('');
      agent.onchange = policyPanel;
      document.getElementById('mkt-match').onclick = runMatch;
      document.getElementById('ret-run').onclick = retire;
    }
    bids(); asks(); policyPanel(); trades(); retirements(); retirePicker();
  };
  global.Marketplace = M;
})(window);
