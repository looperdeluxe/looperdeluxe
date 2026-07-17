// lyrics.js — LRC fetch, pin validation, and THE timeline derivation (build step 7).
// The stage/ribbon/karaoke all consume ONE structure built here: lyric lines with
// interpolated word times and chords attached to words (the v14 one-source-of-truth
// rule). Songs without usable lyrics get a chord-block timeline instead — degrade,
// never render garbage.

const LRCLIB = 'https://lrclib.net/api';
const CACHE_KEY = 'ld.lrcCache'; // load-bearing, not polish: lrclib went down 2026-07-17
const CACHE_MAX = 40;

export function parseSyncedLyrics(sync) {
  if (!sync) return null;
  const lines = [];
  const re = /\[(\d+):(\d+\.?\d*)\]\s*(.*)/g;
  let m;
  while ((m = re.exec(sync))) {
    const text = m[3].trim();
    if (text) lines.push({ t: parseInt(m[1], 10) * 60 + parseFloat(m[2]), text });
  }
  return lines.length > 5 ? lines : null;
}

// Same recipe as the pipeline's lrc_pin(): sha1 of comma-joined 0.1s-rounded line
// times, first 12 hex chars. Must stay in lockstep with lrc_structure.py.
export async function lineTimesHash(lines) {
  const s = lines.map((l) => l.t.toFixed(1)).join(',');
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

// Unpinned fallback: every charted section boundary must sit near SOME lyric-line
// time — if the fetched sync disagrees with the sections' geometry, it's a
// different lyric version and attaching chords to its words would be garbage.
export function sectionsAgreeWithLines(sections, lines, eps = 2.0) {
  const starts = (sections || []).filter((s) => s.family !== 'instrumental').map((s) => s.s);
  if (!starts.length || !lines) return false;
  const ok = starts.filter((s0) => lines.some((l) => Math.abs(l.t - s0) < eps));
  return ok.length / starts.length >= 0.7;
}

function cacheGet(key) {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    return c[key] ? c[key].sync : null;
  } catch (e) { return null; }
}
function cachePut(key, sync) {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    c[key] = { sync, at: Date.now() };
    const keys = Object.keys(c);
    if (keys.length > CACHE_MAX) {
      keys.sort((a, b) => c[a].at - c[b].at).slice(0, keys.length - CACHE_MAX)
        .forEach((k) => delete c[k]);
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch (e) { /* storage full/blocked — cache is best-effort */ }
}

async function lrclibJson(path) {
  // browsers forbid setting User-Agent; lrclib's docs ask for Lrclib-Client instead
  const r = await fetch(LRCLIB + path, { headers: { 'Lrclib-Client': 'LooperDeluxe (https://looperdeluxe.com)' } });
  if (!r.ok) throw new Error('lrclib ' + r.status);
  return r.json();
}

// Returns { lines, verified } or null. Order: cache → pinned id → search+validate.
export async function fetchLyrics({ artist, title, durationS, lrcId, lrcHash, sections }) {
  const key = (artist + '|' + title).toLowerCase();

  const cached = cacheGet(key);
  if (cached) {
    const lines = parseSyncedLyrics(cached);
    if (lines && (!lrcHash || (await lineTimesHash(lines)) === lrcHash)) {
      return { lines, verified: !!lrcHash };
    }
  }

  try {
    if (lrcId != null) {
      const row = await lrclibJson('/get/' + lrcId);
      const lines = parseSyncedLyrics(row.syncedLyrics);
      if (lines && (!lrcHash || (await lineTimesHash(lines)) === lrcHash)) {
        cachePut(key, row.syncedLyrics);
        return { lines, verified: true };
      }
    }
    const rows = await lrclibJson('/search?' + new URLSearchParams({ track_name: title, artist_name: artist }));
    for (const row of rows) {
      const lines = parseSyncedLyrics(row.syncedLyrics);
      if (!lines) continue;
      if (durationS && row.duration && Math.abs(row.duration - durationS) > 4) continue;
      if (lrcHash && (await lineTimesHash(lines)) !== lrcHash) continue;
      if (!lrcHash && sections && sections.length && !sectionsAgreeWithLines(sections, lines)) continue;
      cachePut(key, row.syncedLyrics);
      return { lines, verified: !!lrcHash || sectionsAgreeWithLines(sections, lines) };
    }
  } catch (e) {
    console.warn('[lyrics] lrclib unavailable:', e.message);
  }
  return null; // caller degrades to chord-only timeline
}

// ——— THE timeline ———
// lines: [{t, text}] · songChords: [{t, n}] (absolute) · durationS for the last span.
// Word times interpolate across each line's span; each chord attaches to the word
// nearest its change time. Returns null if inputs can't make an honest timeline.
export function deriveTimeline(lines, songChords, durationS) {
  if (!lines || !lines.length || !songChords || !songChords.length) return null;
  const out = lines.map((l, i) => {
    const end = i + 1 < lines.length ? lines[i + 1].t : (durationS || l.t + 5);
    const words = l.text.split(/\s+/).filter(Boolean);
    const span = Math.max(end - l.t, 0.5);
    return {
      t: l.t, end,
      words: words.map((w, j) => ({ w, t: +(l.t + (span * j) / Math.max(words.length, 1)).toFixed(2), chord: null })),
    };
  });
  const changes = [];
  for (const c of songChords) {
    let best = null, bestD = Infinity;
    for (let li = 0; li < out.length; li++) {
      if (c.t < out[li].t - 8 || c.t > out[li].end + 8) continue;
      for (let wi = 0; wi < out[li].words.length; wi++) {
        const d = Math.abs(out[li].words[wi].t - c.t);
        if (d < bestD) { bestD = d; best = [li, wi]; }
      }
    }
    if (best && bestD < 4) {
      out[best[0]].words[best[1]].chord = c.n;
      changes.push({ t: c.t, n: c.n, line: best[0], word: best[1] });
    } else {
      changes.push({ t: c.t, n: c.n, line: null, word: null }); // instrumental stretch
    }
  }
  return { lines: out, changes };
}

// Chord-only fallback: no lyrics → the timeline is just the changes.
export function chordOnlyTimeline(songChords) {
  if (!songChords || !songChords.length) return null;
  return { lines: [], changes: songChords.map((c) => ({ t: c.t, n: c.n, line: null, word: null })) };
}
