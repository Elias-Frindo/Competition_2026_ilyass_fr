/* ── KWRT prototype validation engine ──────────────────────────────────────
   Six deterministic physical rules + rolling z-score / IQR statistics over
   the trailing 30 same-hour intervals. Deterministic and inspectable — this
   is classical validation and statistics, NOT machine learning, and we do
   not call it AI. Verdicts: PASS (mint) · FAIL (hard physical violation,
   verdict still written to HCS) · SUSPECT (statistics only -> QUARANTINE).  */
(function (global) {
  'use strict';

  const round = (v, d = 2) => Math.round(v * Math.pow(10, d)) / Math.pow(10, d);

  function quantile(sorted, q) {
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  function statistics(value, baseline) {
    const series = (baseline || []).filter((v) => typeof v === 'number');
    if (series.length < 8) {
      return { n: series.length, applicable: false, z: 0, mean: 0, sd: 0, q1: 0, q3: 0, iqr: 0, lo: 0, hi: 0, zFlag: false, iqrFlag: false };
    }
    const n = series.length;
    const mean = series.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(series.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1));
    const sorted = series.slice().sort((a, b) => a - b);
    const q1 = quantile(sorted, 0.25), q3 = quantile(sorted, 0.75), iqr = q3 - q1;
    const lo = q1 - 1.5 * iqr, hi = q3 + 1.5 * iqr;
    const degenerate = sd < 1e-6 && iqr < 1e-6;
    const z = degenerate ? 0 : (sd < 1e-6 ? 0 : (value - mean) / sd);
    const zFlag = !degenerate && Math.abs(z) > 3;
    const iqrFlag = !degenerate && (value < lo || value > hi);
    return { n, applicable: true, z, mean, sd, q1, q3, iqr, lo, hi, zFlag, iqrFlag, degenerate };
  }

  /**
   * ctx = { energyKwh, intervalStart:Date, intervalHours, installation,
   *         prevKwh, flatlinePrevIdentical, duplicateSeen, baseline }
   */
  function evaluate(ctx) {
    const inst = ctx.installation;
    const hours = ctx.intervalHours || 1;
    const e = ctx.energyKwh;
    const ceiling = inst.performanceCeiling != null ? inst.performanceCeiling : 1.15;
    const rules = [];

    /* 1. RANGE — non-negative and within the meter's own rated maximum */
    const rangeMax = inst.meterRatingKw * hours;
    rules.push({
      code: 'RANGE',
      check: '0 ≤ energyKwh ≤ meterRating × intervalHours',
      measured: `${round(e, 3)} kWh`,
      threshold: `0 – ${round(rangeMax, 1)} kWh`,
      config: `meterRating ${inst.meterRatingKw} kW`,
      pass: e >= 0 && e <= rangeMax,
      severity: 'HARD'
    });

    /* 2. CAPACITY — energy cannot exceed nameplate × interval × ceiling */
    const capMax = inst.capacityKw * hours * ceiling;
    rules.push({
      code: 'CAPACITY',
      check: 'energyKwh ≤ capacityKw × intervalHours × ceiling',
      measured: `${round(e, 3)} kWh`,
      threshold: `≤ ${round(capMax, 2)} kWh`,
      config: `capacity ${inst.capacityKw} kW · ceiling ${ceiling.toFixed(2)}×`,
      pass: e <= capMax,
      severity: 'HARD'
    });

    /* 3. SOLAR_GEOMETRY — real solar elevation at the installation's lat/lon */
    const mid = new Date(ctx.intervalStart.getTime() + (hours * 3600000) / 2);
    let elev = null, geomPass = true, geomMeasured = 'skipped (non-solar source)';
    let geomThreshold = 'n/a for ' + inst.sourceType;
    if (inst.sourceType === 'SOLAR') {
      elev = global.Solar.elevation(mid, inst.lat, inst.lon);
      geomMeasured = `elevation ${elev.toFixed(2)}° · ${round(e, 2)} kWh`;
      geomThreshold = 'production only when elevation > −0.5°';
      geomPass = e <= 0.001 || elev > -0.5;
    }
    rules.push({
      code: 'SOLAR_GEOMETRY',
      check: 'no solar production below the refraction-corrected horizon',
      measured: geomMeasured,
      threshold: geomThreshold,
      config: `lat ${inst.lat.toFixed(4)} · lon ${inst.lon.toFixed(4)} · ${inst.sourceType}`,
      pass: geomPass,
      skipped: inst.sourceType !== 'SOLAR',
      severity: 'HARD',
      elevation: elev
    });

    /* 4. FLATLINE — last N intervals byte-identical (stuck sensor) */
    rules.push({
      code: 'FLATLINE',
      check: `last ${inst.flatlineN} intervals not byte-identical`,
      measured: ctx.flatlinePrevIdentical ? `${inst.flatlineN} identical values` : 'values vary',
      threshold: `< ${inst.flatlineN} identical`,
      config: `N = ${inst.flatlineN}`,
      pass: !ctx.flatlinePrevIdentical,
      severity: 'HARD'
    });

    /* 5. RAMP — change vs previous interval within source-type physics */
    const hasPrev = typeof ctx.prevKwh === 'number' && ctx.prevKwh !== null;
    const delta = hasPrev ? Math.abs(e - ctx.prevKwh) / hours : 0;
    rules.push({
      code: 'RAMP',
      check: '|Δ energy| / intervalHours within source ramp limit',
      measured: hasPrev ? `${round(delta, 2)} kW/h` : 'no previous interval',
      threshold: `≤ ${inst.rampLimitKwPerH} kW/h`,
      config: `${inst.sourceType} ramp limit ${inst.rampLimitKwPerH} kW/h`,
      pass: !hasPrev || delta <= inst.rampLimitKwPerH,
      skipped: !hasPrev,
      severity: 'HARD'
    });

    /* 6. DUPLICATE — fast pre-check; the DB unique constraint is authoritative */
    rules.push({
      code: 'DUPLICATE',
      check: 'natural key (meterId, intervalStart, intervalEnd) unseen',
      measured: ctx.duplicateSeen ? 'natural key already present' : 'natural key unseen',
      threshold: 'must be unique — DB UNIQUE constraint is authoritative',
      config: '—',
      pass: !ctx.duplicateSeen,
      severity: 'HARD'
    });

    const stats = statistics(e, ctx.baseline);
    const failed = rules.filter((r) => !r.pass);
    const statFlag = stats.applicable && (stats.zFlag || stats.iqrFlag);

    let verdict = 'PASS', reason = 'All six physical rules pass; the value sits inside the trailing same-hour distribution.';
    if (failed.length) {
      verdict = 'FAIL';
      reason = `Hard physical violation: ${failed.map((r) => r.code).join(', ')}. The verdict is still written to HCS so rejections stay auditable.`;
    } else if (statFlag) {
      verdict = 'SUSPECT';
      reason = `Physically possible but statistically implausible (${stats.zFlag ? '|z| > 3' : ''}${stats.zFlag && stats.iqrFlag ? ' and ' : ''}${stats.iqrFlag ? 'outside 1.5·IQR' : ''}). Routed to QUARANTINE for operator review rather than destroyed.`;
    }
    return { verdict, reason, rules, stats, failed: failed.map((r) => r.code), capMax, rangeMax, elevation: elev };
  }

  global.Validation = { evaluate, statistics };
})(window);
