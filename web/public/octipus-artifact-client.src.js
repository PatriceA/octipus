/**
 * Live Artifacts browser SDK — runs inside the sandboxed embed iframe.
 * Reads the artifact id + scoped JWT from <meta> tags injected at render
 * time. Subscribes via the gateway WS, fetches updated snapshots via REST,
 * patches DOM via `[data-bind="<sourceName>"]` swap.
 *
 * Keep this file dependency-free and ES2017-clean. Bundling: copy verbatim
 * to /octipus-artifact-client.js, compute sha256 at build, pin in CSP.
 */
(function () {
  'use strict';
  const meta = (n) => document.querySelector(`meta[name="${n}"]`)?.getAttribute('content') ?? '';
  const ARTIFACT_ID = meta('octipus-artifact-id');
  const TOKEN = meta('octipus-artifact-token');
  const GATEWAY = meta('octipus-gateway-wss') || (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/gateway';
  if (!ARTIFACT_ID || !TOKEN) return;

  const STALE_MS = 30_000;
  let socket = null;
  let backoff = 500;
  let lastEventAt = Date.now();
  const listeners = new Map();

  function setStale(stale) {
    document.documentElement.toggleAttribute('data-octipus-stale', stale);
  }

  function emit(name, payload) {
    const fns = listeners.get(name) ?? [];
    for (const fn of fns) {
      try { fn(payload); } catch (e) { console.error('[octipus-artifact]', e); }
    }
  }

  async function fetchData(sourceName) {
    const res = await fetch(`/api/artifacts/${encodeURIComponent(ARTIFACT_ID)}/data/${encodeURIComponent(sourceName)}`, {
      headers: { Authorization: 'ArtifactToken ' + TOKEN },
      credentials: 'include',
    });
    if (!res.ok) throw new Error('fetch ' + res.status);
    return res.json();
  }

  async function applyUpdate(sourceName) {
    const data = await fetchData(sourceName);
    const targets = document.querySelectorAll(`[data-bind="${sourceName}"]`);
    if (data && data.payload != null) {
      const html = typeof data.payload === 'string' ? data.payload : JSON.stringify(data.payload);
      targets.forEach((el) => { el.textContent = html; });
    }
    emit('data', { sourceName, data });
  }

  function connect() {
    try {
      socket = new WebSocket(GATEWAY);
    } catch (e) {
      scheduleReconnect();
      return;
    }
    socket.onopen = () => {
      backoff = 500;
      socket.send(JSON.stringify({
        type: 'subscribe',
        patterns: ['artifact.data_updated', 'artifact.version_updated', 'artifact.source_error'],
      }));
      socket.send(JSON.stringify({
        type: 'auth', method: 'artifact_token',
        credentials: { artifactId: ARTIFACT_ID, token: TOKEN },
        clientType: 'webchat',
      }));
      setStale(false);
    };
    socket.onmessage = (msg) => {
      lastEventAt = Date.now();
      let env;
      try { env = JSON.parse(msg.data); } catch { return; }
      const ev = env && env.event;
      if (!ev || !ev.payload || ev.payload.artifactId !== ARTIFACT_ID) return;
      if (ev.type === 'artifact.data_updated') applyUpdate(ev.payload.sourceName).catch(console.error);
      else if (ev.type === 'artifact.version_updated') location.reload();
      else if (ev.type === 'artifact.source_error') emit('error', ev.payload);
    };
    socket.onclose = () => scheduleReconnect();
    socket.onerror = () => { try { socket && socket.close(); } catch (_) {} };
  }

  function scheduleReconnect() {
    setStale(true);
    setTimeout(() => { backoff = Math.min(backoff * 2, 30_000); connect(); }, backoff);
  }

  setInterval(() => { if (Date.now() - lastEventAt > STALE_MS) setStale(true); }, 5_000);

  window.octipus = {
    artifactId: ARTIFACT_ID,
    fetchData,
    subscribe(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
      return () => {
        const arr = listeners.get(name) || [];
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      };
    },
  };

  connect();
})();
