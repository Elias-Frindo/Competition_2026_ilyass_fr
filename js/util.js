/* small shared helpers */
(function (global) {
  'use strict';
  const U = {
    el: (sel, root) => (root || document).querySelector(sel),
    num(v, d = 0) {
      return Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    },
    usd(v, d = 4) { return '$' + Number(v).toFixed(d); },
    hour(h) { return String(h).padStart(2, '0') + ':00'; },
    localHM(isoStr, tzOffset) {
      const d = new Date(new Date(isoStr).getTime() + (tzOffset || 0) * 3600000);
      return String(d.getUTCHours()).padStart(2, '0') + ':00';
    },
    shortId(s, n = 10) { return s && s.length > n * 2 ? s.slice(0, n) + '…' + s.slice(-4) : s; },
    esc(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },
    pillClass(v) {
      return v === 'PASS' ? 'pill-pass' : v === 'FAIL' ? 'pill-fail' : v === 'QUARANTINE' || v === 'SUSPECT' ? 'pill-quar' : '';
    },
    tagClass(v) {
      return v === 'PASS' ? 'tag-pass' : v === 'FAIL' ? 'tag-fail' : v === 'QUARANTINE' || v === 'SUSPECT' ? 'tag-quar' : 'tag-info';
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    tooltip(html, x, y) {
      const t = document.getElementById('tooltip');
      if (!html) { t.classList.remove('on'); return; }
      t.innerHTML = html;
      t.classList.add('on');
      const r = t.getBoundingClientRect();
      const left = Math.min(Math.max(8, x - r.width / 2), window.innerWidth - r.width - 8);
      const top = y - r.height - 14 < 8 ? y + 18 : y - r.height - 14;
      t.style.left = left + 'px';
      t.style.top = top + 'px';
    }
  };
  global.U = U;
})(window);
