// clock.js — THE one master clock (build step 1).
// A single rAF loop owns time; every moving thing (stage, ribbon, loop ring, gap
// countdown, metronome, coach, waveform cursor) subscribes here and NEVER keeps
// its own timer. This is the rule that kills the old site's four-clock desyncs.
//
// timeSource contract (executable version: bench-timesource.html):
//   load(src) -> Promise        resolves when playable
//   play() / pause()
//   seek(seconds)
//   rate(r) -> Promise<actual>  requests a playback rate; RESOLVES WITH WHAT THE
//                               PLAYER ACTUALLY ACCEPTED (request-and-verify).
//                               Implementations clamp to MAX_RATE (1.0 — Brooks).
//   now() -> seconds            content time. Interpolated, monotonic while
//                               playing, FROZEN during ads/buffering/unknowns.
//   state() -> 'idle'|'loading'|'ready'|'playing'|'paused'|'buffering'|'ended'|'error'
//   duration() -> seconds (0 until known)
//   availableRates() -> number[]
//   onState(cb) -> unsubscribe
//   destroy()

export function createClock() {
  const subs = new Set();
  let source = null, running = false, rafId = 0, lastTs = 0;

  function tick(ts) {
    if (!running) return;
    const dt = lastTs ? (ts - lastTs) / 1000 : 0;
    lastTs = ts;
    const t = source ? source.now() : 0;
    for (const fn of subs) {
      try { fn(t, dt); } catch (e) { console.error('[clock] subscriber threw', e); }
    }
    rafId = requestAnimationFrame(tick);
  }

  return {
    setSource(s) { source = s; },
    getSource() { return source; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    start() { if (running) return; running = true; lastTs = 0; rafId = requestAnimationFrame(tick); },
    stop() { running = false; cancelAnimationFrame(rafId); },
    get running() { return running; },
  };
}
