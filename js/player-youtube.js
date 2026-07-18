// player-youtube.js — timeSource impl #1: the official YouTube IFrame player (build step 2).
// LEGAL NOTE: this file only drives YouTube's sanctioned player API. It never
// captures, separates, or modifies the audio/video streams (prohibited by
// YouTube developer policies) — playback stays inside their player, always.
//
// Time: getCurrentTime() is stair-stepped postMessage data, NOT smooth — so
// now() interpolates: lastAcceptedRead + wallElapsed×actualRate while PLAYING,
// resynced on every fresh read and on seek/rate/state changes.
// Ad guard: a zero/backwards jump we didn't ask for, or duration()==0, means
// we are NOT on content time (pre-roll, re-buffer) → now() freezes instead of
// painting chords over an ad. Fresh good reads resync automatically.

export const MAX_RATE = 1.0; // hard cap — Brooks 2026-07-17: never above 100%

let apiPromise = null;
function ytApi() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (!apiPromise) {
    apiPromise = new Promise((res) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (prev) prev(); res(window.YT); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
    });
  }
  return apiPromise;
}

const STATE_MAP = { '-1': 'ready', 0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering', 5: 'ready' };

export function createYouTubeSource(containerId, { mute = false } = {}) {
  let p = null, st = 'idle', offset = 0, destroyed = false, lastErr = null;
  let lastRaw = 0, lastWall = 0, actualRate = 1;
  let seekPending = 0; // wall-clock deadline while a deliberate jump is allowed
  const stateCbs = new Set();

  // resolves when the CURRENT video is playable, rejects on embed error/timeout —
  // load() awaits this on swaps too, so embed-block fallbacks (step 11) can loop
  function oncePlayable() {
    return new Promise((res, rej) => {
      const cb = (s) => {
        if (s === 'ready' || s === 'playing' || s === 'paused') { done(); res(); }
        else if (s === 'error') { done(); rej(Object.assign(new Error('yt embed error'), { code: lastErr })); }
      };
      const to = setTimeout(() => { done(); rej(new Error('yt load timeout')); }, 20000);
      const done = () => { clearTimeout(to); stateCbs.delete(cb); };
      stateCbs.add(cb);
    });
  }

  function setState(s) {
    if (s === st || destroyed) return;
    st = s;
    for (const cb of stateCbs) { try { cb(s); } catch (e) { console.error('[yt] onState', e); } }
  }

  // Accept or reject a raw read. Deliberate seeks open a 2s window where any
  // jump is trusted; otherwise only forward motion (with 0.3s jitter allowance)
  // on a video with known duration counts as content time.
  function read() {
    if (!p || !p.getCurrentTime) return;
    const raw = p.getCurrentTime() || 0;
    const dur = p.getDuration ? (p.getDuration() || 0) : 0;
    const wall = performance.now();
    const seeking = wall < seekPending;
    const forward = raw >= lastRaw - 0.3;
    if ((seeking || (dur > 0 && forward))) {
      lastRaw = raw;
      lastWall = wall;
      if (!seeking && raw > 0) seekPending = 0;
    }
    // rejected reads leave lastRaw/lastWall alone → now() freezes at last good time
  }

  return {
    async load(videoId) {
      const YT = await ytApi();
      setState('loading');
      lastRaw = 0; lastWall = performance.now(); seekPending = performance.now() + 4000;
      if (p) {
        const playable = oncePlayable();
        p.loadVideoById(videoId);
        await playable;
        return;
      }
      await new Promise((res, rej) => {
        p = new YT.Player(containerId, {
          videoId,
          playerVars: { playsinline: 1, controls: 0, rel: 0, modestbranding: 1, disablekb: 1 },
          events: {
            onReady: (e) => { if (mute) e.target.mute(); setState('ready'); res(); },
            onStateChange: (e) => {
              const s = STATE_MAP[e.data] || 'ready';
              if (s === 'playing') { lastWall = performance.now(); }
              setState(s);
            },
            onPlaybackRateChange: () => { actualRate = p.getPlaybackRate() || 1; lastWall = performance.now(); read(); },
            onError: (e) => { lastErr = e.data; setState('error'); rej(Object.assign(new Error('yt error ' + e.data), { code: e.data })); },
          },
        });
        // errors after successful load surface via onState('error'), not this promise
        setTimeout(() => rej(new Error('yt load timeout')), 20000);
      });
    },
    play() { p && p.playVideo && p.playVideo(); },
    pause() { p && p.pauseVideo && p.pauseVideo(); },
    seek(t) {
      if (!p || !p.seekTo) return;
      seekPending = performance.now() + 2000;
      lastRaw = Math.max(0, t - offset);
      lastWall = performance.now();
      p.seekTo(Math.max(0, t - offset), true);
    },
    async rate(r) {
      if (!p || !p.setPlaybackRate) return actualRate;
      const want = Math.min(Math.max(r, 0.25), MAX_RATE);
      p.setPlaybackRate(want);
      // verify: wait for the change event (or poll-timeout), then report reality
      const deadline = performance.now() + 1200;
      while (performance.now() < deadline) {
        const got = p.getPlaybackRate ? p.getPlaybackRate() : 1;
        if (Math.abs(got - want) < 0.001) break;
        await new Promise((res) => setTimeout(res, 120));
      }
      actualRate = p.getPlaybackRate ? (p.getPlaybackRate() || 1) : 1;
      return actualRate;
    },
    now() {
      read();
      let t = lastRaw;
      if (st === 'playing') {
        t = lastRaw + ((performance.now() - lastWall) / 1000) * actualRate;
        const dur = p && p.getDuration ? (p.getDuration() || 0) : 0;
        if (dur > 0 && t > dur) t = dur;
      }
      return t + offset;
    },
    state() { return st; },
    duration() { return p && p.getDuration ? (p.getDuration() || 0) : 0; },
    availableRates() {
      const rates = (p && p.getAvailablePlaybackRates ? p.getAvailablePlaybackRates() : [1]) || [1];
      return rates.filter((x) => x <= MAX_RATE + 0.001);
    },
    currentRate() { return actualRate; },
    setOffset(o) { offset = o || 0; }, // songTime = videoTime + offset (engine /video_offset)
    onState(cb) { stateCbs.add(cb); return () => stateCbs.delete(cb); },
    destroy() { destroyed = true; stateCbs.clear(); if (p && p.destroy) p.destroy(); p = null; setState('idle'); },
  };
}
