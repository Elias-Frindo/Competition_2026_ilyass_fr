/* ── App shell: view routing + boot ─────────────────────────────────────── */
(function (global) {
  'use strict';
  const App = {};
  const renderers = {
    dashboard: () => Dashboard.render(),
    pipeline: () => Pipeline.render(),
    engine: () => Engine.render(),
    verifier: (p) => Verifier.render(p),
    marketplace: () => Marketplace.render(),
    live: () => Live.render(),
    trust: () => Trust.render()
  };
  const rendered = {};
  let current = 'dashboard';

  App.go = function (view, params) {
    if (!renderers[view]) return;
    current = view;
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('is-active', v.id === 'view-' + view));
    if (!rendered[view] || params || view === 'marketplace') { renderers[view](params); rendered[view] = true; }
    if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  async function boot() {
    if (!global.crypto || !global.crypto.subtle) {
      document.getElementById('main').insertAdjacentHTML('afterbegin',
        '<div class="panel" style="border-color:var(--red);margin-bottom:16px">This prototype needs <code>window.crypto.subtle</code> (a secure context) to recompute SHA-256 digests in the browser.</div>');
    }
    await CW.build();
    Dashboard.render(); rendered.dashboard = true;
    Pipeline.render(); rendered.pipeline = true;
    document.getElementById('nav').addEventListener('click', (e) => {
      const btn = e.target.closest('.nav-btn');
      if (btn) App.go(btn.dataset.view);
    });
    const hash = (location.hash || '').replace('#', '');
    if (renderers[hash]) App.go(hash);
    window.addEventListener('resize', () => U.tooltip(null));
    global.KWRT = { data: CW, stats: CW.stats() };
  }

  global.App = App;
  document.addEventListener('DOMContentLoaded', () => {
    boot().catch((err) => {
      console.error(err);
      document.getElementById('main').insertAdjacentHTML('afterbegin',
        '<div class="panel" style="border-color:var(--red);margin-bottom:16px">Failed to initialise the simulation: ' + U.esc(err.message) + '</div>');
    });
  });
})(window);
