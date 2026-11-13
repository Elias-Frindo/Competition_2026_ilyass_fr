/* ── Validation engine inspector: live sliders, live verdict ─────────────── */
(function (global) {
  'use strict';
  const E = {};
  const ids = ['eng-inst', 'eng-energy', 'eng-hour', 'eng-cap', 'eng-ceiling', 'eng-flat', 'eng-dup'];
  let baseInst = null;

  function currentInstallation() {
    const sel = document.getElementById('eng-inst').value;
    const src = CW.byId[sel];
    const cap = +document.getElementById('eng-cap').value;
    return Object.assign({}, src, {
      capacityKw: cap,
      meterRatingKw: cap * 2,
      performanceCeiling: +document.getElementById('eng-ceiling').value,
      rampLimitKwPerH: Math.round(cap * (src.sourceType === 'WIND' ? 0.6 : 0.9))
    });
  }

  function compute() {
    const inst = currentInstallation();
    const hour = +document.getElementById('eng-hour').value;
    const energy = +document.getElementById('eng-energy').value;
    const start = new Date(Date.UTC(2026, 7, 22, hour - inst.tzOffset, 0, 0));

    // trailing 30 same-hour baseline from the installation's clear-sky expectation
    const mid = new Date(start.getTime() + 1800000);
    const elev = Solar.elevation(mid, inst.lat, inst.lon);
    const level = inst.sourceType === 'WIND'
      ? inst.capacityKw * 0.38
      : inst.capacityKw * Solar.clearSkyFactor(elev) * 0.93;
    const baseline = Array.from({ length: 30 }, (_, k) => Math.round(level * (0.94 + ((k * 29) % 13) / 100) * 1000) / 1000);
    const prevLevel = inst.sourceType === 'WIND'
      ? inst.capacityKw * 0.34
      : inst.capacityKw * Solar.clearSkyFactor(Solar.elevation(new Date(mid.getTime() - 3600000), inst.lat, inst.lon)) * 0.93;

    const res = Validation.evaluate({
      energyKwh: energy, intervalStart: start, intervalHours: 1, installation: inst,
      prevKwh: Math.round(prevLevel * 1000) / 1000,
      flatlinePrevIdentical: document.getElementById('eng-flat').checked,
      duplicateSeen: document.getElementById('eng-dup').checked,
      baseline
    });
    return { inst, hour, energy, start, elev, res, level, prevLevel };
  }

  function render() {
    const s = compute();
    const { inst, res } = s;

    // outputs
    document.getElementById('out-energy').textContent = s.energy.toFixed(1) + ' kWh';
    document.getElementById('out-hour').textContent =
      U.hour(s.hour) + '–' + U.hour((s.hour + 1) % 24) + ' local (UTC+' + inst.tzOffset + ')';
    document.getElementById('out-cap').textContent = U.num(inst.capacityKw) + ' kW';
    document.getElementById('out-ceiling').textContent = inst.performanceCeiling.toFixed(2) + '×';
    document.getElementById('scale-energy-mid').textContent = U.num(1200) + ' kWh';
    document.getElementById('scale-energy-max').textContent = U.num(2400) + ' kWh';

    const geom = res.rules.find((r) => r.code === 'SOLAR_GEOMETRY');
    const capRule = res.rules.find((r) => r.code === 'CAPACITY');
    document.querySelector('.slider[data-for="energy"]').className =
      'slider' + (!capRule.pass ? ' is-bad' : res.stats.zFlag || res.stats.iqrFlag ? ' is-warn' : '');
    document.querySelector('.slider[data-for="hour"]').className = 'slider' + (!geom.pass ? ' is-bad' : '');

    // verdict pill
    const pill = document.getElementById('eng-verdict-pill');
    pill.className = 'pill ' + U.pillClass(res.verdict);
    pill.textContent = res.verdict + (res.verdict === 'SUSPECT' ? ' → QUARANTINE' : res.verdict === 'PASS' ? ' → MINT' : ' → REJECT');

    // rules table
    const rows = res.rules.map((r) => {
      const state = r.skipped ? '<span class="pill">SKIPPED</span>'
        : r.pass ? '<span class="pill pill-pass">PASS</span>' : '<span class="pill pill-fail">FAIL</span>';
      return `<tr>
        <td><b class="mono">${r.code}</b><br><span style="font-size:11.5px">${r.check}</span></td>
        <td class="mono">${r.measured}</td>
        <td class="mono">${r.threshold}</td>
        <td class="mono" style="font-size:11.5px">${r.config}</td>
        <td>${state}</td>
      </tr>`;
    }).join('');
    document.getElementById('tbl-rules').innerHTML =
      `<thead><tr><th>Rule</th><th>Measured</th><th>Threshold</th><th>Per-installation config</th><th>Result</th></tr></thead><tbody>${rows}</tbody>`;

    // stats table
    const st = res.stats;
    const statRows = [
      ['Rolling z-score', st.z.toFixed(2), '|z| ≤ 3', st.zFlag ? 'FLAG' : 'OK'],
      ['IQR fence', s.energy.toFixed(1) + ' kWh', `${st.lo.toFixed(1)} – ${st.hi.toFixed(1)} kWh (1.5·IQR)`, st.iqrFlag ? 'FLAG' : 'OK'],
      ['Trailing mean / sd', `${st.mean.toFixed(1)} / ${st.sd.toFixed(1)} kWh`, `n = ${st.n} same-hour intervals`, '—'],
      ['Quartiles', `Q1 ${st.q1.toFixed(1)} · Q3 ${st.q3.toFixed(1)}`, `IQR ${st.iqr.toFixed(1)} kWh`, '—']
    ].map(([a, b, c, d]) => `<tr><td><b>${a}</b></td><td class="mono">${b}</td><td class="mono">${c}</td>
      <td>${d === 'FLAG' ? '<span class="pill pill-quar">FLAG</span>' : d === 'OK' ? '<span class="pill pill-pass">OK</span>' : '<span class="mono" style="color:var(--text-3)">—</span>'}</td></tr>`).join('');
    document.getElementById('tbl-stats').innerHTML =
      `<thead><tr><th>Statistic</th><th>Value</th><th>Band</th><th>Result</th></tr></thead><tbody>${statRows}</tbody>`;

    // context block
    document.getElementById('eng-ctx').innerHTML = [
      ['Installation', `${inst.producer} · ${inst.site}, ${inst.country}`],
      ['Source type', inst.sourceType],
      ['Solar elevation at mid-interval', inst.sourceType === 'SOLAR' ? s.elev.toFixed(2) + '°' : 'n/a'],
      ['Capacity × ceiling', `${(inst.capacityKw * inst.performanceCeiling).toFixed(1)} kWh / h`],
      ['Meter rated maximum', `${U.num(inst.meterRatingKw)} kWh / h`],
      ['Ramp limit', `${U.num(inst.rampLimitKwPerH)} kW/h (prev ${s.prevLevel.toFixed(1)} kWh)`],
      ['Interval (UTC)', new Date(s.start).toISOString().replace('.000Z', 'Z')],
      ['Verdict reason', res.reason]
    ].map(([k, v]) => `<div><span class="k">${k}</span><span class="v">${U.esc(v)}</span></div>`).join('');
  }

  function setInstDefaults() {
    const inst = CW.byId[document.getElementById('eng-inst').value];
    document.getElementById('eng-cap').value = inst.capacityKw;
    document.getElementById('eng-ceiling').value = inst.performanceCeiling;
    const start = new Date(Date.UTC(2026, 7, 22, 12 - inst.tzOffset, 30, 0));
    const expect = inst.sourceType === 'WIND'
      ? inst.capacityKw * 0.38
      : inst.capacityKw * Solar.clearSkyFactor(Solar.elevation(start, inst.lat, inst.lon)) * 0.93;
    document.getElementById('eng-hour').value = 12;
    document.getElementById('eng-energy').value = Math.round(expect * 10) / 10;
  }

  E.render = function () {
    const sel = document.getElementById('eng-inst');
    if (!sel.options.length) {
      sel.innerHTML = CW.INSTALLATIONS.map((i) =>
        `<option value="${i.id}">${i.producer} — ${i.site} · ${i.sourceType} · ${U.num(i.capacityKw)} kW</option>`).join('');
      baseInst = 'INS-01';
      setInstDefaults();
      ids.forEach((id) => {
        const node = document.getElementById(id);
        node.addEventListener('input', () => { if (id === 'eng-inst') setInstDefaults(); render(); });
        node.addEventListener('change', render);
      });
      document.getElementById('eng-reset').onclick = () => {
        document.getElementById('eng-inst').value = baseInst;
        document.getElementById('eng-flat').checked = false;
        document.getElementById('eng-dup').checked = false;
        setInstDefaults(); render();
      };
    }
    render();
  };
  global.Engine = E;
})(window);
