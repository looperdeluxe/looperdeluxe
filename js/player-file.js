// player-file.js — timeSource impl #2: user-uploaded audio via WaveSurfer v7 (build step 3).
// Exists NOW (before any UI) so the timeSource contract is proven by two different
// players — if the interface only fit YouTube, we'd find out here, not at step 18.
// Rates here are continuous (we own the audio) but still clamped to MAX_RATE.

import WaveSurfer from 'https://unpkg.com/wavesurfer.js@7/dist/wavesurfer.esm.js';
import { MAX_RATE } from './player-youtube.js';

export function createFileSource(container) {
  let ws = null, st = 'idle', curRate = 1;
  const stateCbs = new Set();

  function setState(s) {
    if (s === st) return;
    st = s;
    for (const cb of stateCbs) { try { cb(s); } catch (e) { console.error('[file] onState', e); } }
  }

  return {
    async load(src) { // src: URL or blob URL
      setState('loading');
      if (ws) ws.destroy();
      ws = WaveSurfer.create({
        container,
        height: 48,
        waveColor: '#4b5563',
        progressColor: '#22d3ee',
        // media-element backend keeps playbackRate continuous + preservesPitch where supported
        backend: 'MediaElement',
      });
      ws.on('play', () => setState('playing'));
      ws.on('pause', () => setState(st === 'ended' ? 'ended' : 'paused'));
      ws.on('finish', () => setState('ended'));
      await ws.load(src);
      const media = ws.getMediaElement && ws.getMediaElement();
      if (media && 'preservesPitch' in media) media.preservesPitch = true;
      setState('ready');
    },
    play() { ws && ws.play(); },
    pause() { ws && ws.pause(); },
    seek(t) { if (ws && ws.getDuration()) ws.setTime(t); },
    async rate(r) {
      curRate = Math.min(Math.max(r, 0.4), MAX_RATE);
      if (ws) ws.setPlaybackRate(curRate, true); // true = preserve pitch
      return curRate;
    },
    now() { return ws ? ws.getCurrentTime() : 0; }, // media-element time IS smooth — no interpolation needed
    state() { return st; },
    duration() { return ws ? ws.getDuration() || 0 : 0; },
    availableRates() { return []; }, // continuous — empty list means "any value ≤ MAX_RATE"
    currentRate() { return curRate; },
    setOffset() {}, // uploads have no video offset; kept for contract parity
    onState(cb) { stateCbs.add(cb); return () => stateCbs.delete(cb); },
    destroy() { stateCbs.clear(); if (ws) ws.destroy(); ws = null; setState('idle'); },
  };
}
