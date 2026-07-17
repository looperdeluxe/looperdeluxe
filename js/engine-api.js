// engine-api.js — the app's single doorway to engine.looperdeluxe.com (build step 4).
// Only the ~11 client-relevant endpoints + /coach live here; marathon/ops endpoints
// belong to marathon.html and are deliberately absent. Every call goes through req():
// one timeout policy, one retry policy (GETs retry once on 5xx/network — POSTs never,
// they may not be idempotent), and errors carry .status so UI states (step 11) can
// tell "engine down" from "song not charted" without string-matching.

const DEFAULT_BASE = 'https://engine.looperdeluxe.com';

function base() {
  // dev override only ever honored on localhost — never ship a tailnet hostname
  try {
    if (typeof location !== 'undefined' &&
        (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      return localStorage.getItem('ld.devApi') || DEFAULT_BASE;
    }
  } catch (e) { /* non-browser context (node tests) */ }
  return DEFAULT_BASE;
}

export class EngineError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'EngineError';
    this.status = status;     // HTTP status, or 0 for network/timeout
    this.payload = payload;   // parsed error body when the engine sent one
  }
}

async function req(path, { method = 'GET', json, blob, timeout = 12000, retriesLeft } = {}) {
  if (retriesLeft === undefined) retriesLeft = method === 'GET' ? 1 : 0;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const opts = { method, signal: ctl.signal };
    if (json !== undefined) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(json);
    } else if (blob !== undefined) {
      opts.body = blob;
    }
    const r = await fetch(base() + path, opts);
    if (!r.ok) {
      const payload = await r.json().catch(() => null);
      if (r.status >= 500 && retriesLeft > 0) {
        return await req(path, { method, json, blob, timeout, retriesLeft: retriesLeft - 1 });
      }
      throw new EngineError((payload && payload.error) || `engine ${r.status}`, r.status, payload);
    }
    return await r.json();
  } catch (e) {
    if (e instanceof EngineError) throw e;
    if (retriesLeft > 0) {
      return await req(path, { method, json, blob, timeout, retriesLeft: retriesLeft - 1 });
    }
    throw new EngineError(e.name === 'AbortError' ? 'engine timeout' : 'engine unreachable', 0, null);
  } finally {
    clearTimeout(timer);
  }
}

const q = (params) => new URLSearchParams(
  Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''))
).toString();

export const engine = {
  // ——— read paths ———
  search: async (query, { n = 8, artist } = {}) =>
    (await req('/search?' + q({ q: query, n, artist }))).results || [],
  chords: (artist, title) => req('/chords?' + q({ artist, title })),
  analysis: (videoId) => req('/analysis?' + q({ v: videoId })),
  versions: (songId) => req('/versions?' + q({ v: songId })),
  version: (songId, id) => req('/version?' + q({ v: songId, id })),
  // "no offset known" is the NORMAL case for most videos — null, not an exception
  videoOffset: async (videoId) => {
    try { return await req('/video_offset?' + q({ vid: videoId })); }
    catch (e) { if (e instanceof EngineError && e.status === 404) return null; throw e; }
  },
  health: () => req('/health', { timeout: 5000 }),

  // ——— write paths (no auto-retry) ———
  requestChart: (artist, title) => req('/request_chart?' + q({ artist, title })),
  postAnalysis: (videoId, payload) => req('/analysis?' + q({ v: videoId }), { method: 'POST', json: payload }),
  publishVersion: (songId, payload) => req('/version?' + q({ v: songId }), { method: 'POST', json: payload }),
  vote: (songId, id, dir) => req('/vote?' + q({ v: songId, id, dir }), { method: 'POST' }),
  align: (params, audioBlob) => req('/align?' + q(params), { method: 'POST', blob: audioBlob, timeout: 30000 }),
  playthrough: (params, audioBlob) => req('/playthrough?' + q(params), { method: 'POST', blob: audioBlob, timeout: 60000 }),
  coach: (question, context, tier, licenseKey) =>
    req('/coach', { method: 'POST', json: { question, context, tier, license_key: licenseKey }, timeout: 30000 }),

  // ——— telemetry (test pages / harnesses) ———
  benchReport: (page, ok, data) =>
    req('/matcher_report', { method: 'POST', json: { song: 'bench:' + page, ok, found: data } }),
};
