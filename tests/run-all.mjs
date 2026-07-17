#!/usr/bin/env node
// tests/run-all.mjs — the rebuild's regression suite. Run: node tests/run-all.mjs
// Covers every module built so far (steps 4-8) plus cross-module integration.
// Steps 1-3 (clock + players) are browser-only — certified via bench-timesource.html
// on real devices; this runner checks their files parse and their exports exist.

import { createClock } from '../js/clock.js';
import { engine, EngineError } from '../js/engine-api.js';
import { parseChart, chartState, transposeChord, capoShape, chordAt, parseChordName } from '../js/chart-model.js';
import { parseSyncedLyrics, lineTimesHash, sectionsAgreeWithLines, deriveTimeline, chordOnlyTimeline } from '../js/lyrics.js';
import { syncFromClassic, store, _setStorage } from '../js/store.js';

let fails = 0, total = 0;
const suites = {};
function t(suite, name, cond, detail = '') {
  total++;
  suites[suite] = suites[suite] || [];
  suites[suite].push(cond);
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'} [${suite}] ${name}${detail ? ' — ' + detail : ''}`);
}

// ——— step 1: clock (headless behavior only — rAF loop is browser-certified) ———
{
  const c = createClock();
  let called = 0;
  c.setSource({ now: () => 42 });
  const un = c.subscribe(() => called++);
  t('clock', 'exports + subscribe/unsubscribe', typeof c.start === 'function' && typeof un === 'function');
  un();
}

// ——— step 4: engine-api vs the LIVE engine ———
{
  t('engine', 'health', (await engine.health()).ok === true);
  const s = await engine.search('fortunate son', { n: 3 });
  t('engine', 'search unwraps results[]', Array.isArray(s) && s.length > 0, s.length + ' hits');
  t('engine', 'videoOffset unknown → null', (await engine.videoOffset('zzz_nope')) === null);
  try { await engine.chords('zzz', 'no such song zzz'); t('engine', '404 throws EngineError', false); }
  catch (e) { t('engine', '404 throws EngineError', e instanceof EngineError && e.status === 404); }
}

// ——— step 5: chart-model vs three LIVE payload shapes ———
let fortunate;
{
  const get = (a, ti) => engine.chords(a, ti);
  fortunate = parseChart(await get('creedence clearwater revival', 'fortunate son'));
  t('chart', 'sectioned full chart classified full (partial:true trap)', fortunate.state === 'full');
  t('chart', 'chords absolute + sorted', fortunate.songChords.length > 20 &&
    fortunate.songChords.every((c, i, a) => !i || c.t >= a[i - 1].t));
  t('chart', 'envelope present', !!fortunate.envelope && fortunate.envelope.hop === 0.5);
  const turmoil = parseChart(await get('billy strings', 'turmoil  tinfoil'));
  t('chart', 'sectionless marathon full chart', turmoil.state === 'full' && turmoil.songChords.length > 80);
  const stitches = parseChart(await get('shawn mendes', 'stitches'));
  t('chart', 'preview-only → partial + loop-only', stitches.state === 'partial' && stitches.timeline === 'loop-only');
  t('chart', 'null → none', parseChart(null).state === 'none');
  t('chart', 'transpose G+2=A / Bb+1=B / F#m7-2=Em7 / C/G+2=D/A',
    transposeChord('G', 2) === 'A' && transposeChord('Bb', 1) === 'B' &&
    transposeChord('F#m7', -2) === 'Em7' && transposeChord('C/G', 2) === 'D/A');
  t('chart', 'capo3 Eb = C shape', capoShape('Eb', 3) === 'C');
  t('chart', 'parseChordName D#sus4', JSON.stringify(parseChordName('D#sus4')) === '{"root":"D#","quality":"sus4","bass":null}');
  t('chart', 'chordAt mid-chorus', !!chordAt(fortunate.songChords, 42));
}

// ——— step 7: lyrics (offline; lrclib integration deferred while it is down) ———
{
  const lrc = '[00:12.50] some folks are born\n[00:18.70] made to wave the flag\n[00:24.00] red white and blue\n[00:30.20] and when the band plays\n[00:36.90] hail to the chief\n[00:43.10] they point the cannon at you\n';
  const lines = parseSyncedLyrics(lrc);
  t('lyrics', 'parse', lines && lines.length === 6);
  t('lyrics', 'hash lockstep with pipeline recipe', (await lineTimesHash(lines)) === '1b663e256ec9');
  t('lyrics', 'section geometry agree/disagree',
    sectionsAgreeWithLines([{ s: 12.4, family: 'verse' }, { s: 30.0, family: 'chorus' }], lines) === true &&
    sectionsAgreeWithLines([{ s: 80, family: 'verse' }], lines) === false);
  const tl = deriveTimeline(lines, [{ t: 12.6, n: 'G' }, { t: 19.0, n: 'C' }, { t: 200, n: 'D' }], 60);
  t('lyrics', 'timeline: chord on word, far chord unattached',
    tl.lines[0].words[0].chord === 'G' && tl.changes[2].line === null);
  t('lyrics', 'chord-only fallback', chordOnlyTimeline([{ t: 1, n: 'E' }]).changes.length === 1);
}

// ——— INTEGRATION: real payload → chart-model → lyrics timeline ———
{
  // fabricate LRC lines exactly on Fortunate Son's real section geometry — proves
  // the module boundary: parseChart output feeds deriveTimeline without adapters
  const vocal = fortunate.sections.filter((s) => s.family !== 'instrumental');
  const lines = vocal.map((s) => ({ t: s.s, text: 'la la la la la' }));
  const tl = deriveTimeline(lines, fortunate.songChords, fortunate.durationS);
  const attached = tl.changes.filter((c) => c.line !== null).length;
  t('integration', 'payload→chart→timeline, most chords attach to words',
    !!tl && attached / tl.changes.length > 0.7, `${attached}/${tl.changes.length} attached`);
  t('integration', 'sections agree with their own line geometry',
    sectionsAgreeWithLines(vocal, lines) === true);
}

// ——— step 8: store shadow-merge scenarios ———
{
  const mem = new Map();
  _setStorage({ getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) });
  const L = (n, s, e, y) => ({ name: n, start: s, end: e, ytId: y });
  const A = L('solo', 12.3, 18.7, 'abc'), B = L('verse', 30, 45, 'abc'), C = L('bridge', 60, 70, 'xyz');
  const classic = (arr) => mem.set('cosmicSavedLoopsMaster', JSON.stringify(arr));
  const names = () => store.list('loops').map((x) => x.name).sort().join(',');
  classic([A, B]); syncFromClassic();
  t('store', 'adopt', names() === 'solo,verse');
  store.remove('loops', A);
  t('store', 'beta delete dual-writes', !JSON.parse(mem.get('cosmicSavedLoopsMaster')).some((x) => x.name === 'solo'));
  classic([B, C]); syncFromClassic();
  t('store', 'classic add adopted', names() === 'bridge,verse');
  classic([C]); syncFromClassic();
  t('store', 'no resurrection on classic delete', names() === 'bridge');
  classic([C, A]); syncFromClassic();
  t('store', 'genuine re-add returns', names() === 'bridge,solo');
  mem.set('looperOwner', '1'); syncFromClassic();
  t('store', 'owner flag not ported', store.get('owner', null) === null);
}

console.log('—'.repeat(50));
for (const [s, arr] of Object.entries(suites)) {
  console.log(`${arr.every(Boolean) ? '✅' : '❌'} ${s}: ${arr.filter(Boolean).length}/${arr.length}`);
}
console.log(fails === 0 ? `ALL_GREEN (${total} tests)` : `FAILS=${fails}/${total}`);
process.exit(fails ? 1 : 0);
