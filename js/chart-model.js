// chart-model.js — pure functions turning engine /chords payloads into the app's
// canonical model (build step 5). No DOM, no fetch — unit-testable from Node.
//
// Payload reality (verified live 2026-07-17):
// - sections[].chords are SECTION-RELATIVE ({t:0} = section start); absolute = s.s + c.t
// - top-level chords[] are PREVIEW-RELATIVE (absolute = previewStart + t, when anchored)
// - sectionless full charts exist (marathon FULL-CHART: partial:false, sections:[], chords absolute)
// - `partial` STAYS true on marathon-filled sectioned songs — the full/partial predicate
//   below is the truth, never the raw flag (naive gating dead-ends 58/60 full charts)

export const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_TO_SHARP = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#', Cb: 'B', Fb: 'E' };

export function parseChordName(name) {
  // "G", "F#m7", "Bb", "C/G", "D#sus4" → { root, quality, bass }
  const m = /^([A-G][#b]?)(.*)$/.exec((name || '').trim());
  if (!m) return null;
  let [, root, rest] = m;
  root = FLAT_TO_SHARP[root] || root;
  let bass = null;
  const slash = rest.indexOf('/');
  if (slash !== -1) {
    const b = rest.slice(slash + 1);
    rest = rest.slice(0, slash);
    const bm = /^([A-G][#b]?)$/.exec(b);
    bass = bm ? (FLAT_TO_SHARP[bm[1]] || bm[1]) : null;
  }
  return { root, quality: rest, bass };
}

export function transposeChord(name, semis) {
  const p = parseChordName(name);
  if (!p) return name;
  const shift = (n) => NOTES[((NOTES.indexOf(n) + semis) % 12 + 12) % 12];
  return shift(p.root) + p.quality + (p.bass ? '/' + shift(p.bass) : '');
}

// Capo N: the SOUNDING chord is played with the shape N semitones lower.
export function capoShape(name, capo) { return transposeChord(name, -capo); }

function flattenSections(sections) {
  const rows = [];
  for (const s of sections || []) {
    if (!Array.isArray(s.chords)) continue;
    for (const c of s.chords) {
      rows.push({ t: +(s.s + c.t).toFixed(3), n: c.n, section: s.label,
                  verified: !!s.verified, source: s.chordSource || 'unknown' });
    }
  }
  rows.sort((a, b) => a.t - b.t);
  return rows;
}

// The one true classifier (plan step 11).
// 'full'    — whole-song timeline exists (charted sections or a sectionless full chart)
// 'partial' — only the preview window is charted (charting-soon UI + request_chart)
// 'none'    — no payload at all (engine 404)
export function chartState(payload) {
  if (!payload) return 'none';
  const flat = flattenSections(payload.sections);
  if (flat.length > 4) return 'full';
  if (payload.partial === false && Array.isArray(payload.chords) && payload.chords.length > 4) return 'full';
  return 'partial';
}

export function parseChart(payload) {
  if (!payload) return { state: 'none', songChords: [], sections: [], envelope: null };
  const state = chartState(payload);
  const flat = flattenSections(payload.sections);

  let songChords, timeline; // timeline: 'absolute' | 'loop-only'
  if (state === 'full' && flat.length > 4) {
    songChords = flat; timeline = 'absolute';
  } else if (state === 'full') {
    songChords = (payload.chords || []).map((c) => ({ t: c.t, n: c.n, section: null }));
    timeline = 'absolute';
  } else if (payload.previewStart != null) {
    songChords = (payload.chords || []).map((c) => ({ t: +(payload.previewStart + c.t).toFixed(3), n: c.n, section: null }));
    timeline = 'absolute'; // absolute, but covers only ~30s — UI shows charting-soon for the rest
  } else {
    songChords = (payload.chords || []).map((c) => ({ t: c.t, n: c.n, section: null }));
    timeline = 'loop-only'; // unanchored preview: progression is real, absolute position isn't
  }

  const env = payload.envelope && Array.isArray(payload.envelope.v)
    ? { hop: payload.envelope.hop, start: payload.envelope.start || 0, v: payload.envelope.v }
    : null;

  return {
    state, timeline, songChords,
    sections: payload.sections || [],
    envelope: env,
    artist: payload.artist, title: payload.title,
    key: payload.key || null, capo: payload.capo || 0,
    bpm: payload.bpm || null,
    durationS: payload.durationMs ? payload.durationMs / 1000 : null,
    previewStart: payload.previewStart ?? null,
    lrcId: payload.lrcId ?? null, lrcHash: payload.lrcHash ?? null,
  };
}

export function chordAt(songChords, t) {
  let cur = null;
  for (const c of songChords) { if (c.t <= t) cur = c; else break; }
  return cur;
}

export function nextChangeAfter(songChords, t) {
  for (const c of songChords) if (c.t > t) return c;
  return null;
}
