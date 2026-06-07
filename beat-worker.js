// Background beat-analysis worker for Looper Deluxe.
// Runs Essentia.js RhythmExtractor2013 + onset-snap OFF the main thread so the page never freezes.
// Loaded same-origin (a Blob worker can't importScripts cross-origin). Essentia UMD embeds its wasm,
// so no separate .wasm / locateFile is needed.
// The UMD builds expect a CommonJS environment. Shim module/exports, then capture each export.
self.module = { exports: {} }; self.exports = self.module.exports;
importScripts('./lib/essentia-wasm.umd.js');
const EssentiaWASM = self.module.exports.EssentiaWASM || self.module.exports || self.EssentiaWASM;
self.module = { exports: {} }; self.exports = self.module.exports;
importScripts('./lib/essentia.js-core.umd.js');
const Essentia = self.module.exports.Essentia || self.module.exports || self.Essentia;

let ess = null;

// Snap each detected beat to the nearest real audio onset (energy-flux peak) within ±70ms.
// Removes Essentia's intrinsic ~30ms reporting latency so beats land on the true transient.
function snap(sig, sr, ticks) {
  const hop = Math.max(1, Math.floor(sr * 0.005));
  const env = [];
  for (let i = 0; i < sig.length; i += hop) {
    let s = 0; const e = Math.min(i + hop, sig.length);
    for (let j = i; j < e; j++) s += sig[j] * sig[j];
    env.push(Math.sqrt(s / hop));
  }
  const flux = [0];
  for (let k = 1; k < env.length; k++) flux.push(Math.max(0, env[k] - env[k - 1]));
  const win = Math.max(1, Math.round(0.07 * sr / hop));
  return ticks.map(function (t) {
    const c = Math.round(t * sr / hop);
    let bi = c, bv = -1;
    for (let i = Math.max(1, c - win); i <= Math.min(flux.length - 1, c + win); i++) {
      if (flux[i] > bv) { bv = flux[i]; bi = i; }
    }
    return bv > 0 ? (bi * hop) / sr : t;
  });
}

// Automatic chord detection: beat-synchronous chroma (Goertzel) + triad template matching.
// Returns one chord per bar (4 beats) as [{time, name, conf}]. First-pass quality — gold-standard
// (Ultimate Guitar) comes later via the VPS proxy; this is the "no typing" automatic source.
const NOTE_NAMES = ['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B'];
function detectChords(sig, sr, ticks) {
  if (ticks.length < 5) return [];
  // Decimate to ~11kHz (chords live well below Nyquist) for speed.
  const dec = Math.max(1, Math.floor(sr / 11025));
  const dsr = sr / dec;
  const ds = new Float32Array(Math.ceil(sig.length / dec));
  for (let i = 0, j = 0; i < sig.length; i += dec, j++) ds[j] = sig[i];
  // Pitch-class target frequencies across the guitar range (MIDI 40..76).
  const pcFreqs = [];
  for (let midi = 40; midi <= 76; midi++) {
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    if (f < dsr * 0.45) pcFreqs.push({ pc: midi % 12, f: f });
  }
  function goertzel(start, end, f) {
    const w = 2 * Math.PI * f / dsr, coeff = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let n = start; n < end; n++) { const s0 = ds[n] + coeff * s1 - s2; s2 = s1; s1 = s0; }
    return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2));
  }
  // 24 triad templates (12 major, 12 minor).
  const tpls = [];
  for (let r = 0; r < 12; r++) { const t = new Array(12).fill(0); [0,4,7].forEach(iv => t[(r+iv)%12] = 1); tpls.push({ root: r, min: false, t: t }); }
  for (let r = 0; r < 12; r++) { const t = new Array(12).fill(0); [0,3,7].forEach(iv => t[(r+iv)%12] = 1); tpls.push({ root: r, min: true, t: t }); }
  // Krumhansl-Schmuckler key profiles → estimate the song key, then bias chords toward that key.
  const MAJ_PROFILE = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
  const MIN_PROFILE = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
  function estimateKey(chroma) {
    let sum = 0; for (const v of chroma) sum += v; if (sum <= 0) return null;
    const c = chroma.map(v => v / sum);
    function corr(profile, shift) {
      let pm = 0, cm = 0; for (let i = 0; i < 12; i++) { pm += profile[i]; cm += c[(i+shift)%12]; }
      pm /= 12; cm /= 12; let num = 0, dp = 0, dc = 0;
      for (let i = 0; i < 12; i++) { const a = profile[i]-pm, b = c[(i+shift)%12]-cm; num += a*b; dp += a*a; dc += b*b; }
      return num / (Math.sqrt(dp*dc) + 1e-9);
    }
    let best = -2, root = 0, min = false;
    for (let r = 0; r < 12; r++) {
      const cmaj = corr(MAJ_PROFILE, r); if (cmaj > best) { best = cmaj; root = r; min = false; }
      const cmin = corr(MIN_PROFILE, r); if (cmin > best) { best = cmin; root = r; min = true; }
    }
    return { root: root, min: min };
  }
  function diatonicSet(key) {
    if (!key) return null; const r = key.root, s = new Set();
    const degs = key.min ? [[0,true],[3,false],[5,true],[7,true],[7,false],[8,false],[10,false]]
                         : [[0,false],[2,true],[4,true],[5,false],[7,false],[9,true]];
    degs.forEach(d => s.add(NOTE_NAMES[(r+d[0])%12] + (d[1] ? 'm' : '')));
    return s;
  }
  function matchChord(chroma, dia) {
    let mx = 0; for (let i = 0; i < 12; i++) if (chroma[i] > mx) mx = chroma[i];
    if (mx <= 0) return null;
    const c = chroma.map(v => v / mx);
    let best = -1, bi = 0, bestRaw = 0;
    for (let k = 0; k < tpls.length; k++) {
      const t = tpls[k].t; let dot = 0, nt = 0, nc = 0;
      for (let i = 0; i < 12; i++) { dot += c[i]*t[i]; nt += t[i]*t[i]; nc += c[i]*c[i]; }
      const raw = dot / (Math.sqrt(nt*nc) + 1e-9);
      const nm = NOTE_NAMES[tpls[k].root] + (tpls[k].min ? 'm' : '');
      const score = (dia && dia.has(nm)) ? raw * 1.15 : raw;   // key prior: boost in-key chords
      if (score > best) { best = score; bi = k; bestRaw = raw; }
    }
    // Triad is locked (root never changes — proven 100% root accuracy). Now SAFELY add a 7th as
    // colour, ONLY when that root's b7/maj7 is clearly present. Never flips a root → no regression.
    const r = tpls[bi].root, isMin = tpls[bi].min;
    let mxc = 0; for (let i = 0; i < 12; i++) if (chroma[i] > mxc) mxc = chroma[i];
    const cc = mxc > 0 ? chroma.map(v => v / mxc) : chroma;
    const triadAvg = (cc[r] + cc[(r + (isMin ? 3 : 4)) % 12] + cc[(r + 7) % 12]) / 3;
    const b7 = cc[(r + 10) % 12], maj7 = cc[(r + 11) % 12];
    let suf = isMin ? 'm' : '';
    if (b7 >= triadAvg * 0.35 && b7 > maj7 * 1.3)            suf = isMin ? 'm7' : '7';
    else if (!isMin && maj7 >= triadAvg * 0.35 && maj7 > b7 * 1.3) suf = 'maj7';
    return { name: NOTE_NAMES[r] + suf, conf: bestRaw };
  }
  // First pass: per-beat chroma + global chroma (for key estimation).
  const beatChroma = []; const globalChroma = new Array(12).fill(0);
  for (let i = 0; i < ticks.length - 1; i++) {
    const _b0 = ticks[i], _b1 = ticks[i+1], _skip = (_b1 - _b0) * 0.25;   // skip the chord onset (reverb bleed from the previous chord) → analyze the settled part
    const s = Math.floor((_b0 + _skip) * dsr), e = Math.floor(_b1 * dsr);
    if (e <= s) { beatChroma.push(null); continue; }
    const chroma = new Array(12).fill(0);
    for (let p = 0; p < pcFreqs.length; p++) chroma[pcFreqs[p].pc] += goertzel(s, e, pcFreqs[p].f);
    beatChroma.push(chroma);
    for (let k = 0; k < 12; k++) globalChroma[k] += chroma[k];
  }
  const keyObj = estimateKey(globalChroma);
  const dia = diatonicSet(keyObj);
  // Match each beat (key-biased), then median-filter (±1 beat) to kill per-beat flicker.
  let beatChords = beatChroma.map(ch => ch ? matchChord(ch, dia) : null);
  (function (kw) {
    const src = beatChords.slice();
    for (let i = 0; i < src.length; i++) {
      const counts = {};
      for (let j = Math.max(0,i-kw); j <= Math.min(src.length-1,i+kw); j++) { if (src[j]) counts[src[j].name] = (counts[src[j].name]||0)+1; }
      let bn = src[i] ? src[i].name : null, bc = 0;
      for (const n in counts) if (counts[n] > bc) { bc = counts[n]; bn = n; }
      beatChords[i] = bn ? { name: bn, conf: src[i] ? src[i].conf : 0.5 } : null;
    }
  })(2);   // median-filter window ±2 beats — stabilizes roots against walking bass / reverb (tested best vs ±1/±3)
  // Collapse to one chord per HALF-bar (majority over 2 beats) → chord changes land on time,
  // not quantized to whole bars (which made mid-bar changes show up to 2 beats late).
  const bars = [];
  for (let b = 0; b < beatChords.length; b += 2) {
    const grp = beatChords.slice(b, b + 2).filter(Boolean);
    if (!grp.length) continue;
    const counts = {}; let conf = 0;
    grp.forEach(g => { counts[g.name] = (counts[g.name] || 0) + 1; conf += g.conf; });
    let bn = grp[0].name, bc = 0;
    for (const k in counts) if (counts[k] > bc) { bc = counts[k]; bn = k; }
    bars.push({ time: ticks[b], name: bn, conf: conf / grp.length });
  }
  // Merge consecutive identical chords.
  const merged = [];
  for (const c of bars) { if (merged.length && merged[merged.length-1].name === c.name) continue; merged.push(c); }
  merged.key = keyObj ? (NOTE_NAMES[keyObj.root] + (keyObj.min ? 'm' : '')) : null;
  return merged;
}

self.onmessage = async function (ev) {
  const sig = ev.data.signal, sr = ev.data.sampleRate || 44100;
  try {
    if (!ess) {
      const w = (typeof EssentiaWASM === 'function') ? await EssentiaWASM() : EssentiaWASM;
      ess = new Essentia(w);
    }
    const vec = ess.arrayToVector(sig);
    const r = ess.RhythmExtractor2013(vec, 208, 'multifeature', 40);
    let ticks = Array.from(ess.vectorToArray(r.ticks));
    if (vec.delete) vec.delete();
    ticks = snap(sig, sr, ticks);
    let chords = [];
    try { chords = detectChords(sig, sr, ticks); } catch (ce) { chords = []; }
    self.postMessage({ ok: true, ticks: ticks, bpm: r.bpm, confidence: r.confidence, chords: chords, key: (chords && chords.key) || null });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err && err.message || err) });
  }
};
