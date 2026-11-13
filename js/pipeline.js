/* ── Pipeline runner: the 10-step path, animated ────────────────────────── */
(function (global) {
  'use strict';
  const P = {};
  let runToken = 0, running = false, awaitingReview = null;

  const STEPS = [
    { n: 1,  title: 'Register producer, installation and meter', desc: 'Device Ed25519 public key bound to the installation in the meter registry.', chain: null },
    { n: 2,  title: 'Simulator emits a signed hourly reading', desc: 'Meter signs the canonical payload with its device key before transmission.', chain: null },
    { n: 3,  title: 'Signature check, then natural-key dedup', desc: 'Invalid signature → dropped and logged. Then UNIQUE(meterId, intervalStart, intervalEnd) — the natural key, not a hash, is what makes a reading unrepeatable.', chain: null },
    { n: 4,  title: 'Reading hash submitted to HCS (message #1)', desc: 'SHA-256 of the canonical payload gets a consensus timestamp. From here nobody, including us, can alter the reading undetectably.', chain: 'topic' },
    { n: 5,  title: 'Validation engine: 6 rules + z-score / IQR', desc: 'Deterministic physical rules plus statistics over the trailing 30 same-hour intervals. Not machine learning.', chain: null },
    { n: 6,  title: 'Verdict written to HCS (message #2)', desc: 'Rule scores and verdict batched into one message — rejections are written too, so false positives stay auditable.', chain: 'topic' },
    { n: 7,  title: 'HTS mint — 1 KWRT = 1 kWh, 3 decimals', desc: 'Mint reads the HCS sequence number and consensus timestamp; absent either, mint is refused. Energy rounds down to the milli-kWh, remainder carried to the next interval.', chain: 'tx' },
    { n: 8,  title: 'Certificate ACTIVE → listed on the order book', desc: 'The certificate is a row derived from a confirmed mint receipt, linking measurementId → HCS seq → mint tx.', chain: null },
    { n: 9,  title: 'Buyer agent matches, atomic HBAR ↔ token settlement', desc: 'Rule-based policy: price cap, source type, vintage < 30 days, locality. Payment and transfer are one transaction — no half-settled state.', chain: 'tx' },
    { n: 10, title: 'Retire: HTS burn + HCS retirement receipt', desc: 'Burning removes supply, so a retired kWh cannot be resold — verifiable from total supply on any mirror node.', chain: 'both' }
  ];

  function skeleton() {
    document.getElementById('steps').innerHTML = STEPS.map((s) => `
      <li class="step" id="step-${s.n}">
        <div class="step-n">${s.n}</div>
        <div class="step-body">
          <div class="step-title">${s.title}</div>
          <div class="step-desc">${s.desc}</div>
          <div class="step-meta" id="meta-${s.n}"></div>
        </div>
        <div class="step-right">
          <span class="step-lat" id="lat-${s.n}">queued</span>
          <span id="link-${s.n}">${s.chain ? '' : '<span class="onchain-none">off-chain</span>'}</span>
        </div>
      </li>`).join('');
  }

  function setSummary(o) {
    if (o.scenario !== undefined) document.getElementById('rs-scenario').textContent = o.scenario;
    if (o.reading !== undefined) document.getElementById('rs-reading').textContent = o.reading;
    if (o.verdict !== undefined) {
      const v = document.getElementById('rs-verdict');
      v.innerHTML = o.verdict === '—' ? '—' : `<span class="pill ${U.pillClass(o.verdict)}">${o.verdict}</span>`;
    }
    if (o.elapsed !== undefined) document.getElementById('rs-elapsed').textContent = U.num(o.elapsed) + ' ms';
    if (o.cost !== undefined) document.getElementById('rs-cost').textContent = U.usd(o.cost);
    if (o.note !== undefined) document.getElementById('rs-step-note').innerHTML = o.note;
    if (o.progress !== undefined) {
      const bar = document.getElementById('rs-progress');
      bar.style.width = o.progress + '%';
      bar.classList.toggle('is-quar', !!o.quar);
    }
  }

  function meta(n, pairs) {
    document.getElementById('meta-' + n).innerHTML = pairs
      .map(([k, v]) => `<span class="kv"><span>${k}</span> ${v}</span>`).join('');
  }
  function link(n, href, label) {
    document.getElementById('link-' + n).innerHTML = `<a class="hs-link" href="${href}" target="_blank" rel="noopener">${label} ↗</a>`;
  }
  function mark(n, cls, latency) {
    const li = document.getElementById('step-' + n);
    li.className = 'step ' + cls;
    document.getElementById('lat-' + n).textContent = latency == null ? '' : latency + ' ms';
  }

  function makeReading(scenario) {
    const inst = CW.byId['INS-01'];
    const hour = 10;
    const start = new Date(Date.UTC(2026, 7, 22, hour - inst.tzOffset, 0, 0));
    const end = new Date(start.getTime() + 3600000);
    const clear = Solar.clearSkyFactor(Solar.elevation(new Date(start.getTime() + 1800000), inst.lat, inst.lon));
    const normal = inst.capacityKw * clear * 0.94;
    const kwh = Math.round((scenario === 'quarantine' ? normal * 0.47 : normal) * 1000) / 1000;
    const baseline = Array.from({ length: 30 }, (_, k) => Math.round(normal * (0.95 + ((k * 37) % 11) / 100) * 1000) / 1000);
    return {
      installation: inst, meterId: inst.meterId, localHour: hour,
      intervalStart: start.toISOString().replace('.000Z', 'Z'),
      intervalEnd: end.toISOString().replace('.000Z', 'Z'),
      energyKwh: kwh, deviceSignature: '3045' + CW.hex(58),
      baseline, prevKwh: Math.round(normal * 0.82 * 1000) / 1000
    };
  }

  async function run(scenario) {
    if (running) return;
    running = true; awaitingReview = null;
    const token = ++runToken;
    const t0 = performance.now();
    let cost = 0;
    skeleton();
    ['run-pass', 'run-quar'].forEach((id) => (document.getElementById(id).disabled = true));

    const r = makeReading(scenario);
    r.canonical = CW.canonicalPayload(r);
    r.sha256 = await CW.sha256Hex(r.canonical);
    r.measurementId = r.sha256.slice(0, 16);

    const verdictObj = Validation.evaluate({
      energyKwh: r.energyKwh, intervalStart: new Date(r.intervalStart), intervalHours: 1,
      installation: r.installation, prevKwh: r.prevKwh, flatlinePrevIdentical: false,
      duplicateSeen: false, baseline: r.baseline
    });
    const verdict = verdictObj.verdict === 'SUSPECT' ? 'QUARANTINE' : verdictObj.verdict;

    setSummary({
      scenario: scenario === 'quarantine' ? 'quarantine (statistical outlier)' : 'happy path (PASS → mint → trade → retire)',
      reading: r.measurementId, verdict: '—', elapsed: 0, cost: 0, progress: 0, quar: scenario === 'quarantine',
      note: 'Streaming…'
    });

    const seq1 = CW.nextSeq(), ts1 = CW.nextConsensus(41);
    const seq2 = CW.nextSeq(), ts2 = CW.nextConsensus(4);
    const mintTx = CW.txId(CW.CHAIN.treasury, ts2);
    const tradeTs = CW.nextConsensus(180), burnTs = CW.nextConsensus(240);
    const buyer = CW.BUYERS[0];
    const price = 0.0392;
    const amount = Math.floor(r.energyKwh * 1000) / 1000;

    const alive = () => token === runToken;
    const tick = () => setSummary({ elapsed: Math.round(performance.now() - t0) });

    async function step(n, latency, cls, pairs, linkArgs, note) {
      if (!alive()) return false;
      mark(n, 'is-active', null);
      document.getElementById('lat-' + n).textContent = 'running…';
      setSummary({ progress: ((n - 1) / 10) * 100, note });
      await U.sleep(latency);
      if (!alive()) return false;
      if (pairs) meta(n, pairs);
      if (linkArgs) link(n, linkArgs[0], linkArgs[1]);
      mark(n, cls, latency);
      setSummary({ progress: (n / 10) * 100 });
      tick();
      return true;
    }

    if (!await step(1, 180, 'is-done',
      [['meterId', r.meterId], ['devicePubKey', U.shortId(r.installation.devicePubKey, 14)], ['installation', r.installation.id + ' · ' + r.installation.site]],
      null, 'Registering the installation and its device key (off-chain).')) return finish();

    if (!await step(2, 240, 'is-done',
      [['intervalStart', r.intervalStart], ['energyKwh', r.energyKwh.toFixed(3)], ['deviceSignature', U.shortId(r.deviceSignature, 12)]],
      null, 'Meter signs the canonical payload with its Ed25519 device key.')) return finish();

    if (!await step(3, 210, 'is-done',
      [['signature', 'VALID'], ['natural key', 'unseen'], ['sha256', U.shortId(r.sha256, 12)]],
      null, 'Verifying the signature, then the natural-key uniqueness constraint.')) return finish();

    cost += CW.FEES.hcsMessage;
    if (!await step(4, 620, 'is-done',
      [['topicId', CW.CHAIN.topicId], ['sequenceNumber', '#' + seq1], ['consensusTimestamp', ts1], ['fee', U.usd(CW.FEES.hcsMessage)]],
      [CW.hs.topic(), 'HCS #' + seq1], 'Submitting the reading hash to HCS topic ' + CW.CHAIN.topicId + '.')) return finish();
    setSummary({ cost });

    const failedTxt = verdictObj.failed.length ? verdictObj.failed.join(', ') : 'none';
    if (!await step(5, 460, verdict === 'PASS' ? 'is-done' : verdict === 'QUARANTINE' ? 'is-quar' : 'is-fail',
      [['verdict', verdict], ['rules failed', failedTxt], ['z-score', verdictObj.stats.z.toFixed(2)], ['IQR band', `${verdictObj.stats.lo.toFixed(1)} – ${verdictObj.stats.hi.toFixed(1)} kWh`]],
      null, 'Running six physical rules plus z-score and IQR statistics.')) return finish();
    setSummary({ verdict });

    cost += CW.FEES.hcsMessage;
    if (!await step(6, 580, verdict === 'PASS' ? 'is-done' : 'is-quar',
      [['sequenceNumber', '#' + seq2], ['consensusTimestamp', ts2], ['payload', 'verdict + 6 rule scores (batched)'], ['fee', U.usd(CW.FEES.hcsMessage)]],
      [CW.hs.topic(), 'HCS #' + seq2], 'Writing the verdict to HCS — including rejections.')) return finish();
    setSummary({ cost });

    if (verdict !== 'PASS') {
      [7, 8, 9, 10].forEach((n) => {
        mark(n, 'step', null);
        document.getElementById('lat-' + n).textContent = 'blocked';
        meta(n, [['blocked by', 'no mint without a PASS verdict']]);
      });
      const q = document.getElementById('step-5');
      q.classList.add('is-quar');
      meta(5, [['verdict', 'QUARANTINE'], ['trigger', verdictObj.stats.zFlag ? '|z| > 3' : 'outside 1.5·IQR'],
        ['measured', r.energyKwh.toFixed(1) + ' kWh'], ['trailing mean', verdictObj.stats.mean.toFixed(1) + ' kWh']]);
      setSummary({
        progress: 60, quar: true,
        note: `Held in <span class="mono">QUARANTINE</span>: ${U.esc(verdictObj.reason)} An operator decision is required, and that decision is itself written to HCS. <button class="btn btn-amber btn-sm" id="q-approve" style="margin-left:8px">Approve as operator</button>`
      });
      const btn = document.getElementById('q-approve');
      awaitingReview = { r, verdictObj, cost, t0, token, seqPromise: true };
      btn.onclick = async () => {
        btn.disabled = true;
        const seqR = CW.nextSeq();
        cost += CW.FEES.hcsMessage;
        meta(5, [['verdict', 'QUARANTINE → APPROVED'], ['operator', 'ops@kwrt (JWT)'], ['review message', 'HCS #' + seqR]]);
        mark(5, 'is-done', null);
        link(5, CW.hs.topic(), 'HCS #' + seqR);
        setSummary({ verdict: 'PASS', cost, quar: false, note: 'Operator approved. The review decision is on HCS; the pipeline resumes at mint.' });
        Dashboard.pushEvent('REVIEW', 'PASS', `Operator approved <span class="mono">${r.measurementId}</span> — decision on HCS seq <span class="mono">#${seqR}</span>`);
        running = false;
        await tail(token, r, { mintTx, tradeTs, burnTs, buyer, price, amount, cost, t0, seq2 });
      };
      running = false;
      return;
    }

    await tail(token, r, { mintTx, tradeTs, burnTs, buyer, price, amount, cost, t0, seq2 });
  }

  async function tail(token, r, x) {
    running = true;
    let cost = x.cost;
    const t0 = x.t0;
    const alive = () => token === runToken;
    const tick = () => setSummary({ elapsed: Math.round(performance.now() - t0) });

    async function step(n, latency, cls, pairs, linkArgs, note) {
      if (!alive()) return false;
      mark(n, 'is-active', null);
      document.getElementById('lat-' + n).textContent = 'running…';
      setSummary({ note });
      await U.sleep(latency);
      if (!alive()) return false;
      if (pairs) meta(n, pairs);
      if (linkArgs) link(n, linkArgs[0], linkArgs[1]);
      mark(n, cls, latency);
      setSummary({ progress: (n / 10) * 100 });
      tick();
      return true;
    }

    cost += CW.FEES.tokenMint;
    const carry = Math.round((r.energyKwh - x.amount) * 1e6) / 1e3;
    if (!await step(7, 740, 'is-done',
      [['tokenId', CW.CHAIN.tokenId + ' (KWRT)'], ['amount', x.amount.toFixed(3) + ' kWh'], ['carry-over', carry.toFixed(3) + ' Wh → next interval'], ['transactionId', U.shortId(x.mintTx, 16)], ['fee', U.usd(CW.FEES.tokenMint)]],
      [CW.hs.tx(x.mintTx), 'Mint tx'], 'Minting KWRT against the HCS proof.')) return finish();
    setSummary({ cost });

    if (!await step(8, 300, 'is-done',
      [['certificate', 'ACTIVE → LISTED'], ['links', `measurementId ${r.measurementId} → HCS #${x.seq2} → mint tx`], ['ask', x.price + ' ℏ/kWh']],
      null, 'Listing the certificate on the order book (off-chain matching).')) return finish();

    cost += CW.FEES.transfer;
    const tradeTx = CW.txId(x.buyer.account, x.tradeTs);
    if (!await step(9, 820, 'is-done',
      [['agent', x.buyer.name], ['policy', `≤ ${x.buyer.policy.priceCapHbarPerKwh} ℏ/kWh · SOLAR · vintage < 30 d · Morocco`],
       ['settlement', `${(x.amount * x.price).toFixed(3)} ℏ ↔ ${x.amount.toFixed(3)} KWRT, atomic`], ['transactionId', U.shortId(tradeTx, 16)], ['fee', U.usd(CW.FEES.transfer)]],
      [CW.hs.tx(tradeTx), 'Transfer tx'], 'Buyer agent matched the ask; HBAR and token move in one transaction.')) return finish();
    setSummary({ cost });

    cost += CW.FEES.burn + CW.FEES.hcsMessage;
    const burnTx = CW.txId(CW.CHAIN.treasury, x.burnTs);
    const seqR = CW.nextSeq();
    if (!await step(10, 900, 'is-done',
      [['burn', x.amount.toFixed(3) + ' KWRT removed from supply'], ['burn tx', U.shortId(burnTx, 16)], ['receipt', 'HCS #' + seqR], ['beneficiary', x.buyer.name], ['fee', U.usd(CW.FEES.burn + CW.FEES.hcsMessage)]],
      [CW.hs.tx(burnTx), 'Burn tx'], 'Burning the tokens and writing the retirement receipt.')) return finish();

    document.getElementById('link-10').innerHTML +=
      ` <a class="hs-link" href="${CW.hs.topic()}" target="_blank" rel="noopener">HCS #${seqR} ↗</a>`;
    setSummary({
      cost, progress: 100,
      note: `Run complete — reading <span class="mono">${r.measurementId}</span> certified, traded and retired. Total on-chain cost <b>${U.usd(cost)}</b> (2 HCS messages + mint + transfer + burn + retirement receipt). Every identifier here is generated locally: this is a <b>testnet simulation</b>.`
    });
    Dashboard.pushEvent('DEMO', 'PASS', `Full pipeline run complete for <span class="mono">${r.measurementId}</span> — minted, traded, retired`);
    finish();
  }

  function finish() {
    running = false;
    ['run-pass', 'run-quar'].forEach((id) => (document.getElementById(id).disabled = false));
  }

  P.render = function () {
    skeleton();
    setSummary({ scenario: 'idle', reading: '—', verdict: '—', elapsed: 0, cost: 0, progress: 0, note: document.getElementById('rs-step-note').innerHTML });
    document.getElementById('run-pass').onclick = () => run('pass');
    document.getElementById('run-quar').onclick = () => run('quarantine');
    document.getElementById('run-reset').onclick = () => {
      runToken++; running = false; awaitingReview = null; skeleton();
      setSummary({ scenario: 'idle', reading: '—', verdict: '—', elapsed: 0, cost: 0, progress: 0, quar: false, note: 'Reset. Press <strong>Run full demo</strong> to stream the pipeline again.' });
      finish();
    };
  };
  global.Pipeline = P;
})(window);
