/* ── KWRT prototype — in-browser seed data (deterministic, no network) ──────
   Mirrors the README seed set: 6 producers (Morocco + Tunisia), 3 buyers,
   60 hourly readings -> 48 PASS, 8 FAIL (2 night-time, 2 over-capacity,
   2 flatline, 2 ramp), 4 QUARANTINE, 12 open orders, 6 trades, 5 retirements.
   Nothing here touches a network: every transaction id and sequence number
   is generated locally and labelled "Testnet simulation" in the UI.        */
(function (global) {
  'use strict';

  const CHAIN = {
    network: 'testnet',
    topicId: '0.0.10155252',
    tokenId: '0.0.10155253',
    treasury: '0.0.10149503',
    symbol: 'KWRT',
    decimals: 3,
    guard: '0.0.10155301',
    hashscan: 'https://hashscan.io/testnet'
  };
  const FEES = { hcsMessage: 0.0008, tokenMint: 0.001, transfer: 0.001, burn: 0.001 };

  const hs = {
    topic: () => `${CHAIN.hashscan}/topic/${CHAIN.topicId}`,
    token: () => `${CHAIN.hashscan}/token/${CHAIN.tokenId}`,
    account: (id) => `${CHAIN.hashscan}/account/${id}`,
    tx: (id) => `${CHAIN.hashscan}/transaction/${encodeURIComponent(id)}`
  };

  /* deterministic PRNG */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rnd = mulberry32(20260822);
  const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');

  /* ── installations ───────────────────────────────────────────────── */
  const INSTALLATIONS = [
    { id: 'INS-01', producer: 'SolarTech Morocco',  country: 'Morocco', site: 'Tangier',   meterId: 'MTR-TNG-01', sourceType: 'SOLAR', capacityKw: 500,  lat: 35.7595, lon: -5.8340, tzOffset: 1 },
    { id: 'INS-02', producer: 'Atlas Wind Energy',  country: 'Morocco', site: 'Midelt',    meterId: 'MTR-MDL-02', sourceType: 'WIND',  capacityKw: 2000, lat: 32.6852, lon: -4.7350, tzOffset: 1 },
    { id: 'INS-03', producer: 'Riad Solar Coop',    country: 'Morocco', site: 'Marrakech', meterId: 'MTR-RAK-03', sourceType: 'SOLAR', capacityKw: 250,  lat: 31.6295, lon: -7.9811, tzOffset: 1 },
    { id: 'INS-04', producer: 'Fez Green Power',    country: 'Morocco', site: 'Fès',       meterId: 'MTR-FEZ-04', sourceType: 'SOLAR', capacityKw: 750,  lat: 34.0331, lon: -5.0003, tzOffset: 1 },
    { id: 'INS-05', producer: 'TunisSun',           country: 'Tunisia', site: 'Tunis',     meterId: 'MTR-TUN-05', sourceType: 'SOLAR', capacityKw: 400,  lat: 36.8065, lon: 10.1815, tzOffset: 1 },
    { id: 'INS-06', producer: 'Sahara Solar Fields',country: 'Tunisia', site: 'Tozeur',    meterId: 'MTR-TOZ-06', sourceType: 'SOLAR', capacityKw: 1200, lat: 33.9197, lon: 8.1335,  tzOffset: 1 }
  ].map((i) => Object.assign(i, {
    performanceCeiling: 1.15,
    meterRatingKw: i.capacityKw * 2,          // meter's own rated maximum
    flatlineN: 5,
    rampLimitKwPerH: Math.round(i.capacityKw * (i.sourceType === 'WIND' ? 0.6 : 0.9)),
    devicePubKey: '302a300506032b6570032100' + hex(64 - 24)
  }));
  const byId = {}; INSTALLATIONS.forEach((i) => (byId[i.id] = i));

  const BUYERS = [
    { id: 'BUY-01', name: 'GreenCorp International', account: '0.0.10151101', policy: { priceCapHbarPerKwh: 0.042, sourceTypes: ['SOLAR'], maxVintageDays: 30, locality: ['Morocco'] } },
    { id: 'BUY-02', name: 'EcoFactory SA',           account: '0.0.10151102', policy: { priceCapHbarPerKwh: 0.038, sourceTypes: ['SOLAR', 'WIND'], maxVintageDays: 30, locality: ['Morocco', 'Tunisia'] } },
    { id: 'BUY-03', name: 'CleanTech Industries',    account: '0.0.10151103', policy: { priceCapHbarPerKwh: 0.050, sourceTypes: ['SOLAR', 'WIND'], maxVintageDays: 14, locality: ['Tunisia'] } }
  ];

  /* ── reading plan ────────────────────────────────────────────────── */
  const DAY = '2026-08-22';
  // Hours are chosen so that every certified reading carries real energy: a meter that
  // reports 0 kWh at night is legitimate, but it has nothing to certify, so it would
  // never produce a certificate. The 23:00 / 22:00 entries are the injected night-time
  // production attacks that SOLAR_GEOMETRY must catch.
  const plan = [
    { inst: 'INS-01', hours: [7,8,9,10,11,12,13,14,15,16,17,18,19,23] },
    { inst: 'INS-02', hours: [8,9,10,11,12,13,14,15,16] },
    { inst: 'INS-03', hours: [7,8,9,10,11,12,13,14,15] },
    { inst: 'INS-04', hours: [8,9,10,11,12,13,14,15,16] },
    { inst: 'INS-05', hours: [10,11,12,13,14,15,16,17,18,22] },
    { inst: 'INS-06', hours: [8,9,10,11,12,13,14,15,16] }
  ];

  // Injected anomalies, keyed "instId:localHour".
  const INJECT = {
    'INS-01:23': { kind: 'NIGHT',    kwh: 168.4 },
    'INS-05:22': { kind: 'NIGHT',    kwh: 96.2  },
    'INS-03:12': { kind: 'CAPACITY', kwh: 402.6 },
    'INS-06:13': { kind: 'CAPACITY', kwh: 1612.0 },
    'INS-04:8':  { kind: 'FLAT_SEED', kwh: 512.0 },
    'INS-04:9':  { kind: 'FLAT_SEED', kwh: 512.0 },
    'INS-04:10': { kind: 'FLAT_SEED', kwh: 512.0 },
    'INS-04:11': { kind: 'FLAT_SEED', kwh: 512.0 },
    'INS-04:12': { kind: 'FLAT_SEED', kwh: 512.0 },
    'INS-04:13': { kind: 'FLATLINE', kwh: 512.0 },
    'INS-04:14': { kind: 'FLATLINE', kwh: 512.0 },
    'INS-02:11': { kind: 'RAMP_SEED', kwh: 180.0 },
    'INS-02:12': { kind: 'RAMP',      kwh: 1500.0 },
    'INS-02:13': { kind: 'RAMP',      kwh: 140.0 },
    'INS-01:10': { kind: 'SUSPECT',   factor: 0.52, reason: 'curtailment instruction from the grid operator' },
    'INS-03:10': { kind: 'SUSPECT',   factor: 1.34, reason: 'post-cleaning output step above the trailing distribution' },
    'INS-05:16': { kind: 'SUSPECT',   factor: 0.50, reason: 'inverter restart mid-interval' },
    'INS-06:09': { kind: 'SUSPECT',   factor: 0.55, reason: 'dust storm attenuation' }
  };
  const injectFor = (inst, hour) => INJECT[inst + ':' + hour] || INJECT[inst + ':' + String(hour).padStart(2, '0')];

  /* local hour -> UTC Date (Morocco & Tunisia are UTC+1) */
  function utcFor(hourLocal, tzOffset) {
    return new Date(Date.UTC(2026, 7, 22, hourLocal - tzOffset, 0, 0));
  }
  const iso = (d) => d.toISOString().replace('.000Z', 'Z');

  function expectedKwh(inst, hourLocal, jitter) {
    if (inst.sourceType === 'WIND') {
      const base = 0.28 + 0.22 * Math.sin((hourLocal / 24) * Math.PI * 2 + 1.1);
      return inst.capacityKw * Math.max(0.06, base) * (0.94 + jitter * 0.12);
    }
    const mid = utcFor(hourLocal, inst.tzOffset);
    mid.setUTCMinutes(30);
    const elev = global.Solar.elevation(mid, inst.lat, inst.lon);
    const cf = global.Solar.clearSkyFactor(elev);
    return inst.capacityKw * cf * (0.90 + jitter * 0.09);
  }

  function canonicalPayload(r) {
    // Alphabetically ordered keys, no whitespace — the exact bytes that get hashed.
    return JSON.stringify({
      deviceSignature: r.deviceSignature,
      energyKwh: r.energyKwh,
      intervalEnd: r.intervalEnd,
      intervalStart: r.intervalStart,
      meterId: r.meterId
    });
  }

  async function sha256Hex(str) {
    const buf = await global.crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  const READINGS = [];
  let seq = 8412;
  let consensus = Date.UTC(2026, 7, 22, 6, 12, 4) / 1000;

  function nextConsensus(stepSeconds) {
    consensus += stepSeconds;
    return consensus.toFixed(0) + '.' + String(Math.floor(rnd() * 1e9)).padStart(9, '0');
  }
  function txId(payer, ts) { return `${payer}@${ts}`; }

  plan.forEach((p) => {
    const inst = byId[p.inst];
    let prevValue = null;
    p.hours.forEach((h) => {
      const jitter = rnd();
      const inj = injectFor(inst.id, h);
      const normal = expectedKwh(inst, h, jitter);
      let kwh;
      if (inj && typeof inj.kwh === 'number') kwh = inj.kwh;
      else if (inj && inj.factor) kwh = normal * inj.factor;
      else kwh = normal;
      kwh = Math.max(0, Math.round(kwh * 1000) / 1000);

      const start = utcFor(h, inst.tzOffset);
      const end = new Date(start.getTime() + 3600000);
      // baseline: trailing 30 same-hour intervals. Centred on the *normal* level so
      // statistics behave the way the field would: injected outliers stand out.
      // seed readings that only exist to set up a later rule violation keep a normal-looking
      // trailing distribution centred on themselves, so statistics do not double-flag them.
      const isSeed = inj && (inj.kind === 'FLAT_SEED' || inj.kind === 'RAMP_SEED');
      const level = inj && !isSeed ? normal : kwh;
      const baseline = Array.from({ length: 30 }, (_, k) => {
        const j = mulberry32(1000 + k + h * 7 + parseInt(inst.id.slice(-2), 10) * 31)();
        return Math.max(0, Math.round(level * (0.94 + j * 0.12) * 1000) / 1000);
      });

      const r = {
        installationId: inst.id,
        meterId: inst.meterId,
        localHour: h,
        intervalStart: iso(start),
        intervalEnd: iso(end),
        intervalHours: 1,
        energyKwh: kwh,
        deviceSignature: '3045' + hex(58),
        baseline,
        flatlinePrevIdentical: !!(inj && inj.kind === 'FLATLINE'),
        prevKwh: prevValue,
        duplicateSeen: false,
        injected: inj ? inj.kind : null,
        injectedReason: inj && inj.reason ? inj.reason : null
      };
      READINGS.push(r);
      prevValue = kwh;
    });
  });

  /* ── build everything that depends on hashing (async) ─────────────── */
  const CERTIFICATES = [], ORDERS = [], TRADES = [], RETIREMENTS = [], QUARANTINE = [], EVENTS = [];

  async function build() {
    for (const r of READINGS) {
      r.canonical = canonicalPayload(r);
      r.sha256 = await sha256Hex(r.canonical);
      r.measurementId = r.sha256.slice(0, 16);
      const v = global.Validation.evaluate({
        energyKwh: r.energyKwh,
        intervalStart: new Date(r.intervalStart),
        intervalHours: 1,
        installation: byId[r.installationId],
        prevKwh: r.prevKwh,
        flatlinePrevIdentical: r.flatlinePrevIdentical,
        duplicateSeen: r.duplicateSeen,
        baseline: r.baseline
      });
      r.validation = v;
      r.verdict = v.verdict === 'SUSPECT' ? 'QUARANTINE' : v.verdict;

      // HCS message #1 (reading hash) — written for every reading, pass or fail
      r.hcs1 = { seq: seq++, consensusTimestamp: nextConsensus(37 + Math.floor(rnd() * 20)), topicId: CHAIN.topicId };
      // HCS message #2 (verdict) — also written for rejections, so false positives are auditable
      r.hcs2 = { seq: seq++, consensusTimestamp: nextConsensus(3 + Math.floor(rnd() * 4)), topicId: CHAIN.topicId };

      if (r.verdict === 'PASS') {
        const amount = Math.floor(r.energyKwh * 1000) / 1000;
        r.mint = { transactionId: txId(CHAIN.treasury, r.hcs2.consensusTimestamp), amountKwh: amount, tokenId: CHAIN.tokenId };
        r.carryOverWh = Math.round((r.energyKwh - amount) * 1000 * 1000) / 1000;
        CERTIFICATES.push({
          id: 'CERT-' + String(CERTIFICATES.length + 1).padStart(3, '0'),
          measurementId: r.measurementId,
          installationId: r.installationId,
          producer: byId[r.installationId].producer,
          country: byId[r.installationId].country,
          sourceType: byId[r.installationId].sourceType,
          kwh: amount,
          vintage: r.intervalStart,
          status: 'ACTIVE',
          hcsSeq: r.hcs2.seq,
          mintTransactionId: r.mint.transactionId,
          reading: r
        });
      } else if (r.verdict === 'QUARANTINE') {
        QUARANTINE.push(r);
      }
    }

    /* certificate lifecycle: 12 LISTED, 6 TRANSFERRED (traded), 5 RETIRED —
       spread deterministically across producers rather than taken in block order */
    const price = (i) => Math.round((0.031 + (i % 7) * 0.0021) * 10000) / 10000;
    const order = CERTIFICATES.map((c, i) => i)
      .sort((a, b) => (((a * 17) % 48) - ((b * 17) % 48)) || (a - b));
    const rank = {}; order.forEach((certIdx, pos) => (rank[certIdx] = pos));
    CERTIFICATES.forEach((c, idx) => {
      const i = rank[idx];
      if (i < 12) {
        c.status = 'LISTED';
        c.priceHbarPerKwh = price(i);
        ORDERS.push({
          id: 'ORD-' + String(ORDERS.length + 1).padStart(3, '0'),
          side: 'ASK', certId: c.id, kwh: c.kwh, priceHbarPerKwh: c.priceHbarPerKwh,
          producer: c.producer, country: c.country, sourceType: c.sourceType,
          vintage: c.vintage, status: 'OPEN'
        });
      } else if (i < 18) {
        c.status = 'TRANSFERRED';
        const buyer = BUYERS[i % 3];
        c.owner = buyer.name;
        const p = price(i + 2);
        TRADES.push({
          id: 'TRD-' + String(TRADES.length + 1).padStart(3, '0'),
          certId: c.id, buyer: buyer.name, buyerAccount: buyer.account, seller: c.producer,
          kwh: c.kwh, priceHbarPerKwh: p, totalHbar: Math.round(c.kwh * p * 1000) / 1000,
          transactionId: txId(buyer.account, nextConsensus(120 + Math.floor(rnd() * 400))),
          atomic: true
        });
      } else if (i < 23) {
        c.status = 'RETIRED';
        const buyer = BUYERS[i % 3];
        c.owner = buyer.name;
        const ts = nextConsensus(200 + Math.floor(rnd() * 500));
        RETIREMENTS.push({
          id: 'RET-' + String(RETIREMENTS.length + 1).padStart(3, '0'),
          certId: c.id, kwh: c.kwh, beneficiary: buyer.name,
          burnTransactionId: txId(CHAIN.treasury, ts),
          hcsSeq: seq++, consensusTimestamp: nextConsensus(3),
          reason: 'Scope 2 hourly matching, Q3 2026'
        });
      }
    });

    /* bids from buyers */
    [
      { b: 0, kwh: 420, p: 0.0405 }, { b: 1, kwh: 260, p: 0.0372 }, { b: 2, kwh: 900, p: 0.0468 },
      { b: 0, kwh: 150, p: 0.0388 }, { b: 1, kwh: 640, p: 0.0355 }, { b: 2, kwh: 310, p: 0.0441 },
      { b: 0, kwh: 780, p: 0.0330 }
    ].forEach((x, i) => {
      const buyer = BUYERS[x.b];
      ORDERS.push({
        id: 'BID-' + String(i + 1).padStart(3, '0'), side: 'BID', buyer: buyer.name, buyerId: buyer.id,
        kwh: x.kwh, priceHbarPerKwh: x.p, status: 'OPEN',
        sourceTypes: buyer.policy.sourceTypes, locality: buyer.policy.locality
      });
    });

    return API;
  }

  /* ── aggregates ──────────────────────────────────────────────────── */
  function stats() {
    const pass = READINGS.filter((r) => r.verdict === 'PASS');
    const fail = READINGS.filter((r) => r.verdict === 'FAIL');
    const quar = READINGS.filter((r) => r.verdict === 'QUARANTINE');
    const retired = CERTIFICATES.filter((c) => c.status === 'RETIRED');
    const active = CERTIFICATES.filter((c) => c.status !== 'RETIRED');
    const kwh = pass.reduce((s, r) => s + r.mint.amountKwh, 0);
    const cost =
      READINGS.length * 2 * FEES.hcsMessage +
      pass.length * FEES.tokenMint +
      TRADES.length * FEES.transfer +
      RETIREMENTS.length * (FEES.burn + FEES.hcsMessage);
    return {
      readings: READINGS.length, pass: pass.length, fail: fail.length, quarantine: quar.length,
      kwhCertified: kwh, certificates: CERTIFICATES.length,
      active: active.length, retired: retired.length,
      listed: CERTIFICATES.filter((c) => c.status === 'LISTED').length,
      transferred: CERTIFICATES.filter((c) => c.status === 'TRANSFERRED').length,
      trades: TRADES.length, openOrders: ORDERS.filter((o) => o.side === 'ASK' && o.status === 'OPEN').length,
      costUsd: cost, hcsMessages: READINGS.length * 2 + RETIREMENTS.length,
      perReadingUsd: 2 * FEES.hcsMessage + FEES.tokenMint
    };
  }

  const API = {
    CHAIN, FEES, hs, INSTALLATIONS, BUYERS, READINGS, CERTIFICATES, ORDERS, TRADES,
    RETIREMENTS, QUARANTINE, EVENTS, DAY,
    byId, build, stats, sha256Hex, canonicalPayload, rnd, hex, txId,
    nextSeq: () => seq++, nextConsensus
  };
  global.CW = API;
})(window);
