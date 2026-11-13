/* ── Trust model & costs ─────────────────────────────────────────────────── */
(function (global) {
  'use strict';
  const T = {};

  const TRUST = [
    ['Meter reading', 'trusted', 'Trusted device',
      'The device key attests the reading. A physically compromised meter can lie; KWRT detects statistical implausibility, not tampering-with-intent.'],
    ['Reading integrity after submission', 'trustless', 'Trustless',
      'SHA-256 plus an HCS consensus timestamp. Nobody, including us, can alter a submitted reading undetectably — and the verifier tab lets you prove it yourself.'],
    ['Validation verdict', 'trusted', 'Trusted issuer, publicly auditable',
      'The engine is deterministic and open-source; its inputs and verdicts are on HCS, so anyone can re-run it and disagree publicly.'],
    ['Mint authority', 'trusted', 'Trusted issuer (prototype)',
      'The HTS supply key is held by the backend. KWRTGuard.sol registers measurement hashes and rejects duplicate approvals, but the supply key is not yet delegated to the contract. <b>This is the main centralisation in the prototype</b> — roadmap item 1 delegates it.'],
    ['Ownership and retirement', 'trustless', 'Trustless',
      'HTS transfers and burns are native network operations; total supply on any mirror node reflects retirements.']
  ];

  const LAYERS = [
    ['Natural-key uniqueness (DB)', '<span class="mono">UNIQUE(meterId, intervalStart, intervalEnd)</span>. This — not a hash — is what makes a reading unrepeatable. The hash provides integrity; the constraint provides identity. No client-supplied id or nonce takes part.'],
    ['HCS proof uniqueness', '<span class="mono">UNIQUE(measurementId)</span> on the proof table: one measurement can never carry two proofs.'],
    ['On-chain guard', '<span class="mono">KWRTGuard.registerMeasurement(hash)</span> reverts on a hash already seen; <span class="mono">approveMint(hash, hcsSequence)</span> reverts unless the hash is registered and unminted.'],
    ['Burn-on-retire', 'Retirement removes supply, so a retired kWh cannot be resold — verifiable from the token’s total supply on any mirror node.']
  ];

  const LIMITS = [
    'Prototype on testnet. Not an accredited registry and not legally equivalent to I-REC or Guarantees of Origin.',
    'A token represents an <b>environmental attribute</b>, not physical electrons or grid delivery.',
    'The mint authority is a backend-held key — the honest weak point of this prototype.',
    'Hardware-level meter tampering is out of scope: the engine detects implausible data, not a physically subverted device.',
    'Cross-registry double counting needs industry-wide meter registration and is not solved by one platform.',
    'No production key management, no multi-tenant isolation, no load testing beyond the demo.',
    'This front-end makes <b>no live Hedera calls except the optional "Buy with your wallet" flow in the Marketplace</b>, which executes a real transaction on testnet via your own wallet and a local relay. All other transaction ids, sequence numbers and receipts shown here are generated in the browser.'
  ];

  function trustTable() {
    const rows = TRUST.map(([c, kind, label, why]) => `<tr>
      <td style="width:22%"><b>${c}</b></td>
      <td style="width:20%"><span class="pill ${kind === 'trustless' ? 'pill-trustless' : 'pill-trusted'}">${label}</span></td>
      <td>${why}</td>
    </tr>`).join('');
    document.getElementById('tbl-trust').innerHTML =
      `<thead><tr><th>Component</th><th>Trust required</th><th>Why</th></tr></thead><tbody>${rows}</tbody>`;
  }

  function costTable() {
    const f = CW.FEES;
    const rows = [
      ['<span class="mono">ConsensusSubmitMessage</span> × 2 (reading hash + verdict)', '2 × ' + U.usd(f.hcsMessage), (2 * f.hcsMessage).toFixed(4)],
      ['<span class="mono">TokenMint</span> (1 KWRT = 1 kWh, 3 decimals)', '~' + U.usd(f.tokenMint, 3), f.tokenMint.toFixed(4)],
      ['<b>Total per certified hourly reading</b>', '', (2 * f.hcsMessage + f.tokenMint).toFixed(4)],
      ['<span class="mono">CryptoTransfer</span> + HTS transfer on a trade (only when traded)', '~' + U.usd(f.transfer, 3), f.transfer.toFixed(4)],
      ['<span class="mono">TokenBurn</span> + retirement receipt (only when retired)', '', (f.burn + f.hcsMessage).toFixed(4)]
    ].map(([a, b, c], i) => `<tr${i === 2 ? ' style="background:rgba(36,227,155,.05)"' : ''}>
      <td>${a}</td><td class="num">${b}</td><td class="num"><b>$${c}</b></td></tr>`).join('');
    document.getElementById('tbl-costs').innerHTML =
      `<thead><tr><th>Operation</th><th class="num">Unit fee</th><th class="num">USD</th></tr></thead><tbody>${rows}</tbody>`;

    const s = CW.stats();
    const perReading = 2 * CW.FEES.hcsMessage + CW.FEES.tokenMint;
    document.getElementById('cost-callout').innerHTML = `
      <div class="big">≈ ${U.usd(perReading)} per certified reading · ≈ $0.03 per MWh</div>
      <div class="small">A 500 kW plant producing ~800 MWh/year on hourly intervals (~8,760 readings) costs
        <b>≈ $${(perReading * 8760).toFixed(0)}/year</b> on-chain — two to three orders of magnitude below conventional
        REC issuance fees. This deployment has spent <b>$${s.costUsd.toFixed(3)}</b> across ${s.hcsMessages} HCS
        messages, ${s.pass} mints, ${s.trades} transfers and ${s.retired} burns.</div>`;
  }

  function lists() {
    document.getElementById('layers').innerHTML = LAYERS.map(([k, v]) => `<li><b>${k}.</b> ${v}</li>`).join('');
    document.getElementById('limits').innerHTML = LIMITS.map((l) => `<li>${l}</li>`).join('');
    document.getElementById('units').innerHTML = [
      ['Token', '1 KWRT = 1 kWh', 'HTS fungible token <span class="mono">' + CW.CHAIN.tokenId + '</span> on Hedera testnet, treasury <span class="mono">' + CW.CHAIN.treasury + '</span>.'],
      ['Decimals', 'decimals = 3', 'Smallest issuable unit is 1 Wh, so 12.4 kWh is representable exactly — no silent rounding of a whole kWh.'],
      ['Rounding rule', 'floor to the milli-kWh', 'The discarded remainder is carried into the installation’s next interval, so no energy is invented and none is lost across a day.'],
      ['Granularity', 'one certificate per hour', 'An hourly certificate cannot be used to offset consumption in a different hour, which is what makes 24/7 matching possible later.'],
      ['Verdicts on chain', '2 HCS messages per reading', 'Reading hash first, then the batched verdict — including rejections, so the false-positive rate is observable.']
    ].map(([k, v, d]) => `<div class="unit"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join('');
  }

  T.render = function () { trustTable(); costTable(); lists(); };
  global.Trust = T;
})(window);
