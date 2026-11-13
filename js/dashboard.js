/* ── Dashboard: KPIs, hourly production chart, live event feed, tables ── */
(function (global) {
  'use strict';
  const D = {};
  let feedTimer = null, feedPaused = false, feedIdx = 0;

  function chips() {
    const c = CW.CHAIN;
    document.getElementById('chain-chips').innerHTML = [
      `<span class="chip">topic <b><a href="${CW.hs.topic()}" target="_blank" rel="noopener">${c.topicId}</a></b></span>`,
      `<span class="chip">token <b><a href="${CW.hs.token()}" target="_blank" rel="noopener">${c.tokenId}</a></b> ${c.symbol}</span>`,
      `<span class="chip">treasury <b><a href="${CW.hs.account(c.treasury)}" target="_blank" rel="noopener">${c.treasury}</a></b></span>`,
      `<span class="chip">decimals <b>${c.decimals}</b></span>`,
      `<span class="chip">1 ${c.symbol} <b>= 1 kWh</b></span>`
    ].join('');
  }

  function kpis() {
    const s = CW.stats();
    const tiles = [
      { k: 'kWh certified', v: U.num(s.kwhCertified, 1), u: 'kWh', d: `${s.certificates} certificates minted from ${s.pass} PASS readings`, tone: 'green' },
      { k: 'Certificates', v: `${s.active} <span class="u">active</span> / ${s.retired} <span class="u">retired</span>`, u: '', d: `${s.listed} listed · ${s.transferred} transferred · ${s.trades} trades settled`, tone: 'mixed' },
      { k: 'Quarantined readings', v: U.num(s.quarantine), u: 'awaiting review', d: `${s.fail} rejected · ${s.readings} readings ingested today`, tone: 'amber' },
      { k: 'On-chain cost to date', v: '$' + s.costUsd.toFixed(3), u: '', d: `${s.hcsMessages} HCS messages + ${s.pass} mints + ${s.trades} transfers + ${s.retired} burns`, tone: 'cyan' }
    ];
    document.getElementById('kpis').innerHTML = tiles.map((t) => `
      <div class="kpi" data-tone="${t.tone}">
        <span class="k">${t.k}</span>
        <span class="v">${t.v}${t.u ? ` <span class="u">${t.u}</span>` : ''}</span>
        <span class="d">${t.d}</span>
      </div>`).join('');
  }

  /* ── SVG hourly production chart ── */
  function chart() {
    const inst = CW.byId['INS-01'];
    const rows = CW.READINGS.filter((r) => r.installationId === 'INS-01').sort((a, b) => a.localHour - b.localHour);
    const W = 760, H = 300, m = { t: 16, r: 16, b: 34, l: 48 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const maxY = Math.max(inst.capacityKw * 1.15, ...rows.map((r) => r.energyKwh)) * 1.06;
    const x = (h) => m.l + (h / 23) * iw;
    const y = (v) => m.t + ih - (v / maxY) * ih;

    const passRows = rows.filter((r) => r.verdict === 'PASS');
    const linePts = passRows.map((r) => `${x(r.localHour).toFixed(1)},${y(r.energyKwh).toFixed(1)}`).join(' ');
    const areaPts = `${x(passRows[0].localHour).toFixed(1)},${y(0)} ` + linePts + ` ${x(passRows[passRows.length - 1].localHour).toFixed(1)},${y(0)}`;

    const yTicks = 4, gridEls = [];
    for (let i = 0; i <= yTicks; i++) {
      const v = (maxY / yTicks) * i;
      gridEls.push(`<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`);
      gridEls.push(`<text class="lbl" x="${m.l - 8}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end">${Math.round(v)}</text>`);
    }
    const xLabels = [0, 4, 8, 12, 16, 20, 23].map((h) =>
      `<text class="lbl" x="${x(h).toFixed(1)}" y="${H - m.b + 18}" text-anchor="middle">${U.hour(h)}</text>`).join('');

    // night shading from real solar geometry
    const nightBands = [];
    let bandStart = null;
    for (let h = 0; h <= 24; h++) {
      const mid = new Date(Date.UTC(2026, 7, 22, h - inst.tzOffset, 30, 0));
      const dark = h === 24 ? true : Solar.elevation(mid, inst.lat, inst.lon) <= -0.5;
      if (dark && bandStart === null) bandStart = h;
      if (!dark && bandStart !== null) { nightBands.push([bandStart, h]); bandStart = null; }
    }
    if (bandStart !== null) nightBands.push([bandStart, 23.4]);
    const bands = nightBands.map(([a, b]) =>
      `<rect class="night" x="${x(a).toFixed(1)}" y="${m.t}" width="${Math.max(1, x(b) - x(a)).toFixed(1)}" height="${ih}"/>`).join('');

    const colour = { PASS: 'var(--accent)', FAIL: 'var(--red)', QUARANTINE: 'var(--amber)' };
    const pts = rows.map((r, i) => {
      const c = colour[r.verdict];
      return `<circle class="pt" tabindex="0" role="img" data-i="${i}" cx="${x(r.localHour).toFixed(1)}" cy="${y(r.energyKwh).toFixed(1)}" r="4.2"
        fill="${c}" stroke="var(--bg)" stroke-width="1.4"
        aria-label="${U.hour(r.localHour)} ${r.energyKwh} kWh ${r.verdict}"></circle>`;
    }).join('');

    const capY = y(inst.capacityKw * inst.performanceCeiling);
    document.getElementById('chart-wrap').innerHTML = `
      <svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Hourly production with verdicts">
        <defs><linearGradient id="cw-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(36,227,155,.30)"/><stop offset="100%" stop-color="rgba(36,227,155,0)"/>
        </linearGradient></defs>
        ${bands}${gridEls.join('')}
        <line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${capY.toFixed(1)}" y2="${capY.toFixed(1)}" stroke="var(--amber)" stroke-dasharray="4 4" opacity=".55"/>
        <text class="lbl" x="${W - m.r}" y="${(capY - 6).toFixed(1)}" text-anchor="end" fill="var(--amber)">capacity × ceiling ${Math.round(inst.capacityKw * inst.performanceCeiling)} kWh</text>
        <polygon class="area" points="${areaPts}"/>
        <polyline class="line" points="${linePts}"/>
        <line class="axis" x1="${m.l}" x2="${W - m.r}" y1="${m.t + ih}" y2="${m.t + ih}"/>
        <line class="axis" x1="${m.l}" x2="${m.l}" y1="${m.t}" y2="${m.t + ih}"/>
        <text class="lbl" x="${m.l - 8}" y="${m.t - 4}" text-anchor="end">kWh</text>
        ${nightBands.filter(([a, b]) => x(Math.min(b, 23.4)) - x(a) > 46).map(([a, b]) => `<text class="lbl" x="${((x(a) + x(Math.min(b, 23.4))) / 2).toFixed(1)}" y="${(m.t + ih - 8).toFixed(1)}" text-anchor="middle" opacity=".65">night</text>`).join('')}
        ${xLabels}${pts}
      </svg>`;

    const note = document.getElementById('chart-note');
    const wrap = document.getElementById('chart-wrap');
    wrap.querySelectorAll('.pt').forEach((node) => {
      const r = rows[+node.dataset.i];
      const show = (ev) => {
        const b = node.getBoundingClientRect();
        U.tooltip(`<b>${U.hour(r.localHour)}–${U.hour((r.localHour + 1) % 24)} local</b><br>
          ${r.energyKwh.toFixed(3)} kWh · ${r.verdict}<br>
          ${r.validation.failed.length ? 'failed: ' + r.validation.failed.join(', ') + '<br>' : ''}
          measurementId ${r.measurementId}<br>HCS seq #${r.hcs1.seq} / #${r.hcs2.seq}`,
          b.left + b.width / 2, b.top);
        note.innerHTML = `<b>${U.hour(r.localHour)}</b> · ${r.energyKwh.toFixed(3)} kWh · <span class="mono">${r.verdict}</span> · ${U.esc(r.validation.reason)}`;
        void ev;
      };
      node.addEventListener('mouseenter', show);
      node.addEventListener('focus', show);
      node.addEventListener('mouseleave', () => U.tooltip(null));
      node.addEventListener('blur', () => U.tooltip(null));
      node.addEventListener('click', () => { global.App.go('verifier', { measurementId: r.measurementId }); });
    });
  }

  /* ── event feed ── */
  function buildFeed() {
    const items = [];
    const push = (tag, verdict, msg) => items.push({ tag, verdict, msg });
    CW.READINGS.slice().reverse().forEach((r) => {
      const inst = CW.byId[r.installationId];
      push('HCS', 'chain', `<b>${inst.producer}</b> reading hash → HCS seq <span class="mono">#${r.hcs1.seq}</span> (${r.energyKwh.toFixed(1)} kWh, ${U.hour(r.localHour)} local)`);
      push(r.verdict, r.verdict, `Verdict <b>${r.verdict}</b> for <span class="mono">${r.measurementId}</span> → HCS seq <span class="mono">#${r.hcs2.seq}</span>${r.validation.failed.length ? ' · ' + r.validation.failed.join(', ') : ''}`);
      if (r.verdict === 'PASS') push('MINT', 'chain', `Minted <b>${r.mint.amountKwh.toFixed(3)} KWRT</b> · tx <span class="mono">${U.shortId(r.mint.transactionId, 18)}</span>`);
    });
    CW.TRADES.forEach((t) => push('TRADE', 'chain', `<b>${t.buyer}</b> bought ${t.kwh.toFixed(1)} kWh from ${t.seller} at ${t.priceHbarPerKwh} ℏ/kWh — atomic settlement`));
    CW.RETIREMENTS.forEach((r) => push('BURN', 'chain', `Retired <b>${r.kwh.toFixed(1)} kWh</b> for ${r.beneficiary} · burn + receipt HCS seq <span class="mono">#${r.hcsSeq}</span>`));
    return items;
  }

  let feedItems = [];
  function feedTick() {
    if (feedPaused) return;
    const list = document.getElementById('feed');
    const item = feedItems[feedIdx % feedItems.length];
    feedIdx++;
    const li = document.createElement('li');
    const now = new Date();
    li.innerHTML = `<span class="t">${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}</span>
      <span class="m"><span class="tag ${U.tagClass(item.verdict === 'chain' ? 'INFO' : item.verdict)}">${item.tag}</span>${item.msg}</span>`;
    list.insertBefore(li, list.firstChild);
    while (list.children.length > 40) list.removeChild(list.lastChild);
  }

  function feed() {
    feedItems = buildFeed();
    const list = document.getElementById('feed');
    list.innerHTML = '';
    for (let i = 0; i < 9; i++) feedTick();
    if (feedTimer) clearInterval(feedTimer);
    feedTimer = setInterval(feedTick, 2600);
    const btn = document.getElementById('feed-toggle');
    btn.onclick = () => {
      feedPaused = !feedPaused;
      btn.textContent = feedPaused ? 'Resume' : 'Pause';
      btn.setAttribute('aria-pressed', String(!feedPaused));
    };
  }

  D.pushEvent = function (tag, verdict, msg) {
    feedItems.unshift({ tag, verdict, msg });
    const wasPaused = feedPaused; feedPaused = false;
    feedIdx = 0; feedTick(); feedPaused = wasPaused;
  };

  /* ── tables ── */
  function installations() {
    const rows = CW.INSTALLATIONS.map((i) => {
      const n = CW.READINGS.filter((r) => r.installationId === i.id).length;
      return `<tr>
        <td><b>${i.producer}</b><br><span class="mono" style="font-size:11px;color:var(--text-3)">${i.meterId} · ${i.site}, ${i.country}</span></td>
        <td>${i.sourceType}</td>
        <td class="num">${U.num(i.capacityKw)} kW</td>
        <td class="num">${i.performanceCeiling.toFixed(2)}×</td>
        <td class="num">${U.num(i.rampLimitKwPerH)} kW/h</td>
        <td class="num">${i.lat.toFixed(2)}, ${i.lon.toFixed(2)}</td>
        <td class="num">${n}</td>
      </tr>`;
    }).join('');
    document.getElementById('tbl-installations').innerHTML =
      `<thead><tr><th>Installation</th><th>Source</th><th class="num">Capacity</th><th class="num">Ceiling</th><th class="num">Ramp limit</th><th class="num">lat, lon</th><th class="num">Readings</th></tr></thead><tbody>${rows}</tbody>`;
  }

  function quarantine() {
    const rows = CW.QUARANTINE.map((r) => {
      const inst = CW.byId[r.installationId];
      const s = r.validation.stats;
      return `<tr>
        <td><b>${inst.producer}</b><br><span class="mono" style="font-size:11px;color:var(--text-3)">${r.measurementId}</span></td>
        <td>${U.hour(r.localHour)}</td>
        <td class="num">${r.energyKwh.toFixed(1)}</td>
        <td class="num">${s.mean.toFixed(1)}</td>
        <td class="num">${s.z.toFixed(2)}</td>
        <td>${r.injectedReason ? U.esc(r.injectedReason) : 'statistical outlier'}</td>
        <td><button class="btn btn-ghost btn-sm" data-review="${r.measurementId}">Review</button></td>
      </tr>`;
    }).join('');
    const t = document.getElementById('tbl-quarantine');
    t.innerHTML = `<thead><tr><th>Reading</th><th>Hour</th><th class="num">kWh</th><th class="num">Trailing mean</th><th class="num">z</th><th>Operator note</th><th></th></tr></thead><tbody>${rows}</tbody>`;
    t.querySelectorAll('[data-review]').forEach((b) => {
      b.onclick = () => {
        const r = CW.QUARANTINE.find((x) => x.measurementId === b.dataset.review);
        const seq = CW.nextSeq();
        b.outerHTML = `<span class="pill pill-pass">APPROVED #${seq}</span>`;
        D.pushEvent('REVIEW', 'PASS', `Operator approved quarantined reading <span class="mono">${r.measurementId}</span> — decision written to HCS seq <span class="mono">#${seq}</span>`);
      };
    });
  }

  D.render = function () { chips(); kpis(); chart(); feed(); installations(); quarantine(); };
  global.Dashboard = D;
})(window);
