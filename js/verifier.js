/* ── Certificate verifier: real in-browser SHA-256 over canonical JSON ───── */
(function (global) {
  'use strict';
  const V = {};
  let tamper = false;

  function findReading(idRaw) {
    const id = String(idRaw || '').trim().toLowerCase();
    if (!id) return null;
    return CW.READINGS.find((r) => r.measurementId === id || r.sha256 === id || r.sha256.startsWith(id)) || null;
  }

  function stepShell(items) {
    document.getElementById('vsteps').innerHTML = items.map((s, i) => `
      <li class="vstep" id="vstep-${i + 1}">
        <div class="vstep-head">
          <div class="vstep-title"><span class="n">${i + 1}</span>${s.title}</div>
          <span class="pill" id="vpill-${i + 1}">pending</span>
        </div>
        <div class="vstep-desc">${s.desc}</div>
        <div id="vbody-${i + 1}"></div>
      </li>`).join('');
  }

  const TITLES = [
    { title: 'Copy the identifiers from the certificate', desc: 'measurementId, HCS sequence number and mint transaction id — the only three things you need from us.' },
    { title: 'Open the HCS topic on HashScan and find that sequence number', desc: 'Consensus order and timestamps come from the network, not from KWRT.' },
    { title: 'Read the message payload', desc: 'The message carries the canonical reading: meterId, intervalStart, intervalEnd, energyKwh, deviceSignature and the SHA-256 digest.' },
    { title: 'Recompute SHA-256 locally and compare', desc: 'Computed here in your browser with window.crypto.subtle over the exact canonical bytes. This is the step that makes tampering detectable.' },
    { title: 'Check the mint transaction', desc: 'Minted amount must equal energyKwh floored to the milli-kWh, and its consensus time must be after the HCS message.' },
    { title: 'For a retired certificate, confirm the burn and the receipt', desc: 'Burning removes supply, so a retired kWh cannot be resold.' }
  ];

  async function verify(id, keepTamper) {
    if (!keepTamper) tamper = false;
    const r = findReading(id);
    stepShell(TITLES);
    const hint = document.getElementById('ver-hint');
    if (!r) {
      hint.innerHTML = `<span style="color:var(--red)">No reading found for <span class="mono">${U.esc(id || '(empty)')}</span>. Pick one from the list — 60 readings are seeded.</span>`;
      return;
    }
    const inst = CW.byId[r.installationId];
    const cert = CW.CERTIFICATES.find((c) => c.measurementId === r.measurementId);
    const ret = cert ? CW.RETIREMENTS.find((x) => x.certId === cert.id) : null;
    hint.innerHTML = `Verifying <span class="mono">${r.measurementId}</span> — ${inst.producer}, ${U.hour(r.localHour)} local, ${r.energyKwh.toFixed(3)} kWh, verdict <span class="mono">${r.verdict}</span>.
      <button class="btn btn-ghost btn-sm" id="ver-tamper" style="margin-left:8px">${tamper ? 'Restore stored value' : 'Tamper with stored energyKwh'}</button>`;
    document.getElementById('ver-tamper').onclick = () => { tamper = !tamper; verify(r.measurementId, true); };

    const set = (n, state, label, html) => {
      const li = document.getElementById('vstep-' + n);
      li.className = 'vstep ' + (state === 'ok' ? 'is-ok' : state === 'bad' ? 'is-bad' : 'is-run');
      const pill = document.getElementById('vpill-' + n);
      pill.className = 'pill ' + (state === 'ok' ? 'pill-pass' : state === 'bad' ? 'pill-fail' : 'pill-run');
      pill.textContent = label;
      if (html !== undefined) document.getElementById('vbody-' + n).innerHTML = html;
    };

    /* 1 */
    set(1, 'run', 'reading…');
    await U.sleep(240);
    set(1, 'ok', 'copied', `<div class="codebox"><span class="lbl">from the certificate page</span>measurementId      ${r.measurementId}
hcsSequenceNumber  #${r.hcs1.seq} (reading) · #${r.hcs2.seq} (verdict)
mintTransactionId  ${r.mint ? r.mint.transactionId : '— (verdict ' + r.verdict + ', nothing minted)'}
certificate        ${cert ? cert.id + ' · ' + cert.status : 'none'}</div>`);

    /* 2 */
    set(2, 'run', 'querying topic…');
    await U.sleep(360);
    set(2, 'ok', 'found', `<div class="codebox"><span class="lbl">HashScan</span>topic ${CW.CHAIN.topicId} · sequence #${r.hcs1.seq}
consensusTimestamp ${r.hcs1.consensusTimestamp}</div>
      <div style="margin-top:10px"><a class="hs-link" href="${CW.hs.topic()}" target="_blank" rel="noopener">Open topic ${CW.CHAIN.topicId} ↗</a></div>
      <p class="note">In this prototype the topic content is simulated locally; on a live deployment this step reads the mirror node.</p>`);

    /* 3 */
    const storedEnergy = tamper ? Math.round((r.energyKwh + 5) * 1000) / 1000 : r.energyKwh;
    const payload = {
      meterId: r.meterId,
      intervalStart: r.intervalStart,
      intervalEnd: r.intervalEnd,
      energyKwh: storedEnergy,
      deviceSignature: r.deviceSignature,
      sha256: r.sha256
    };
    set(3, 'run', 'reading payload…');
    await U.sleep(300);
    set(3, 'ok', 'payload read', `<div class="codebox"><span class="lbl">HCS message #${r.hcs1.seq} payload</span>${U.esc(JSON.stringify(payload, null, 2))}</div>
      ${tamper ? '<p class="note" style="color:var(--amber)">energyKwh has been tampered with locally (+5 kWh) to demonstrate detection. The sha256 field is unchanged.</p>' : ''}`);

    /* 4 — the real one */
    set(4, 'run', 'hashing…');
    const canonical = CW.canonicalPayload({
      meterId: r.meterId, intervalStart: r.intervalStart, intervalEnd: r.intervalEnd,
      energyKwh: storedEnergy, deviceSignature: r.deviceSignature
    });
    const digest = await CW.sha256Hex(canonical);
    const match = digest === r.sha256;
    await U.sleep(200);
    set(4, match ? 'ok' : 'bad', match ? 'hash matches' : 'hash mismatch', `
      <div class="codebox"><span class="lbl">canonical JSON — exact bytes hashed (keys sorted, no whitespace)</span>${U.esc(canonical)}</div>
      <div class="codebox"><span class="lbl">recomputed with window.crypto.subtle.digest('SHA-256')</span><span class="${match ? 'hl' : ''}">${digest}</span></div>
      <div class="codebox"><span class="lbl">sha256 field in the HCS message</span><span class="${match ? 'hl' : ''}">${r.sha256}</span></div>
      <div class="hashmatch" style="${match ? '' : 'color:var(--red)'}">${match
        ? '✓ identical — the reading behind this certificate has not been altered since it was timestamped'
        : '✗ different — the stored reading no longer matches the hash on HCS, so the certificate is invalid'}</div>
      <p class="note">Reproduce it in a shell: <span class="mono">printf '%s' '&lt;canonical JSON&gt;' | shasum -a 256</span></p>`);

    /* 5 */
    set(5, 'run', 'checking mint…');
    await U.sleep(320);
    if (!r.mint) {
      set(5, 'bad', 'no mint', `<div class="codebox">Verdict <b>${r.verdict}</b> — no mint exists, and that verdict is itself on HCS as sequence #${r.hcs2.seq}.
${r.validation.failed.length ? 'Rules failed: ' + r.validation.failed.join(', ') : 'Statistical outlier held for operator review.'}</div>
        <p class="note">A rejected reading still has a permanent, public verdict. That is the point: the system's false-positive behaviour is auditable, not hidden.</p>`);
    } else {
      const amountOk = Math.abs(r.mint.amountKwh - Math.floor(storedEnergy * 1000) / 1000) < 1e-9;
      const orderOk = parseFloat(r.mint.transactionId.split('@')[1]) > parseFloat(r.hcs1.consensusTimestamp);
      const ok = amountOk && orderOk && match;
      set(5, ok ? 'ok' : 'bad', ok ? 'mint consistent' : 'inconsistent', `<div class="codebox">
mint transaction   ${r.mint.transactionId}
minted amount      ${r.mint.amountKwh.toFixed(3)} KWRT  (= kWh, 3 decimals)
energyKwh floored  ${(Math.floor(storedEnergy * 1000) / 1000).toFixed(3)} kWh   ${amountOk ? '→ equal' : '→ MISMATCH'}
HCS consensus      ${r.hcs1.consensusTimestamp}
mint consensus     ${r.mint.transactionId.split('@')[1]}   ${orderOk ? '→ after the HCS message' : '→ ORDER VIOLATION'}
carry-over         ${(r.carryOverWh || 0).toFixed(3)} Wh into the next interval</div>
        <div style="margin-top:10px"><a class="hs-link" href="${CW.hs.tx(r.mint.transactionId)}" target="_blank" rel="noopener">Open mint transaction ↗</a>
        <a class="hs-link" href="${CW.hs.token()}" target="_blank" rel="noopener" style="margin-left:6px">Token ${CW.CHAIN.tokenId} ↗</a></div>`);
    }

    /* 6 */
    set(6, 'run', 'checking retirement…');
    await U.sleep(260);
    if (ret) {
      set(6, 'ok', 'retired & burned', `<div class="codebox">
burn transaction   ${ret.burnTransactionId}
burned amount      ${ret.kwh.toFixed(3)} KWRT — removed from total supply
receipt            HCS #${ret.hcsSeq} at ${ret.consensusTimestamp}
beneficiary        ${ret.beneficiary}
reason             ${U.esc(ret.reason)}</div>
        <div style="margin-top:10px"><a class="hs-link" href="${CW.hs.tx(ret.burnTransactionId)}" target="_blank" rel="noopener">Open burn transaction ↗</a>
        <a class="hs-link" href="${CW.hs.topic()}" target="_blank" rel="noopener" style="margin-left:6px">Receipt HCS #${ret.hcsSeq} ↗</a></div>`);
    } else {
      set(6, 'ok', cert ? 'not yet retired' : 'not applicable', `<div class="codebox">${cert
        ? `certificate ${cert.id} is ${cert.status} — no burn expected yet. Retiring it is a burn plus a receipt on HCS; both are checkable the same way.`
        : 'nothing was minted for this reading, so there is nothing to retire.'}</div>`);
    }

    if (!match) {
      hint.innerHTML += ' <span style="color:var(--red)">Verification failed at step 4 — do not trust this certificate.</span>';
    }
  }

  V.render = function (params) {
    const pick = document.getElementById('ver-pick');
    if (!pick.options.length) {
      const opts = CW.READINGS.map((r) => {
        const inst = CW.byId[r.installationId];
        return `<option value="${r.measurementId}">${r.verdict} · ${inst.producer} ${U.hour(r.localHour)} · ${r.energyKwh.toFixed(1)} kWh · ${r.measurementId}</option>`;
      }).join('');
      pick.innerHTML = opts;
      pick.onchange = () => { document.getElementById('ver-id').value = pick.value; verify(pick.value); };
      document.getElementById('ver-run').onclick = () => verify(document.getElementById('ver-id').value);
      document.getElementById('ver-id').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') verify(document.getElementById('ver-id').value);
      });
      stepShell(TITLES);
    }
    if (params && params.measurementId) {
      document.getElementById('ver-id').value = params.measurementId;
      pick.value = params.measurementId;
      verify(params.measurementId);
    } else if (!document.getElementById('ver-id').value) {
      const first = CW.CERTIFICATES.find((c) => c.status === 'RETIRED') || CW.CERTIFICATES[0];
      document.getElementById('ver-id').value = first.measurementId;
      pick.value = first.measurementId;
      verify(first.measurementId);
    }
  };
  global.Verifier = V;
})(window);
