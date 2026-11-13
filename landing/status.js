(function () {
  'use strict';

  // Relative by default, exactly like app.js: this page is served from the same
  // origin as the API it probes, and a baked-in host sends every visitor on a
  // deployed site to a port on their own machine.
  const appUrl = (document.body.dataset.appUrl || '').replace(/\/+$/, '');
  const healthUrl = document.body.dataset.healthUrl || appUrl + '/api/health';
  // Only the artifacts the download page actually links to. Checking names that
  // were never uploaded reports a permanent "Check links" and trains people to
  // ignore the row.
  const downloadFiles = ['downloads/Cordia-Setup-0.13.6.exe'];

  const refreshButton = document.getElementById('status-refresh');
  const overallLabel = document.getElementById('status-overall-label');
  const overallDot = document.getElementById('status-overall-dot');
  const overallChip = document.getElementById('status-overall-chip');
  const lastChecked = document.getElementById('status-last-checked');
  const latencyLabel = document.getElementById('status-latency');
  const heroBadge = document.getElementById('status-hero-badge');

  const stateClasses = ['is-warn', 'is-down', 'is-unknown'];

  function setState(element, state) {
    if (!element) return;
    stateClasses.forEach(function (name) {
      element.classList.remove(name);
    });
    if (state && state !== 'ok') element.classList.add('is-' + state);
  }

  function setComponent(name, state, text) {
    const row = document.querySelector('[data-component="' + name + '"]');
    if (!row) return;
    const status = row.querySelector('.component-status');
    if (!status) return;
    setState(status, state);
    status.innerHTML = '<i></i> ' + text;
  }

  function setOverall(ok, detail) {
    const state = ok ? 'ok' : 'down';
    const label = ok ? 'All systems operational' : 'Status unavailable';
    setState(overallDot, state);
    setState(overallChip, state);
    setState(heroBadge, state);
    if (overallLabel) overallLabel.textContent = label;
    if (overallChip) overallChip.textContent = ok ? 'Operational' : 'Unavailable';
    if (heroBadge) heroBadge.innerHTML = '<i></i> ' + label;
    if (detail) overallLabel.title = detail;
  }

  function nowLabel() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  async function checkHealth() {
    const started = performance.now();
    const sameOrigin = new URL(healthUrl, window.location.href).origin === window.location.origin;

    if (sameOrigin) {
      try {
        const response = await fetch(healthUrl, {
          cache: 'no-store',
          headers: { Accept: 'application/json' }
        });
        const data = await response.json().catch(function () {
          return {};
        });
        const ok = response.ok && data.ok !== false;
        return {
          ok: ok,
          latency: Math.round(performance.now() - started),
          detail: ok ? 'API health check passed.' : 'API returned an unhealthy response.'
        };
      } catch (error) {
        return { ok: false, latency: null, detail: 'API did not respond.' };
      }
    }

    try {
      await fetch(healthUrl, { mode: 'no-cors', cache: 'no-store' });
      return {
        ok: true,
        latency: Math.round(performance.now() - started),
        detail: 'API is reachable; detailed health is limited by cross-origin rules.'
      };
    } catch (error) {
      return { ok: false, latency: null, detail: 'API is unreachable.' };
    }
  }

  async function checkDownloads() {
    try {
      const results = await Promise.all(
        downloadFiles.map(function (file) {
          return fetch(file, { method: 'HEAD', cache: 'no-store' }).then(function (response) {
            return response.ok;
          });
        })
      );
      return results.every(Boolean);
    } catch (error) {
      return false;
    }
  }

  function render(result, downloadsOk) {
    setOverall(result.ok, result.detail);
    ['api', 'realtime', 'voice', 'push'].forEach(function (name) {
      setComponent(name, result.ok ? 'ok' : 'down', result.ok ? 'Operational' : 'Unavailable');
    });
    setComponent('downloads', downloadsOk ? 'ok' : 'warn', downloadsOk ? 'Operational' : 'Check links');

    if (lastChecked) {
      lastChecked.textContent = 'Last checked ' + nowLabel() + (result.detail ? ' · ' + result.detail : '');
    }
    if (latencyLabel) {
      latencyLabel.textContent = 'Latency ' + (result.latency === null ? '—' : result.latency + ' ms');
    }
  }

  async function runCheck() {
    if (refreshButton) refreshButton.disabled = true;
    const health = await checkHealth();
    const downloadsOk = await checkDownloads();
    render(health, downloadsOk);
    if (refreshButton) refreshButton.disabled = false;
  }

  if (refreshButton) {
    refreshButton.addEventListener('click', runCheck);
  }

  runCheck();
  window.setInterval(runCheck, 60000);
})();
