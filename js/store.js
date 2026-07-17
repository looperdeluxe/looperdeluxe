// store.js — user data with a SHADOW-SNAPSHOT three-way merge (build step 8).
// beta.html and the classic site share one localStorage origin, and users will
// alternate between them for the whole beta period. Live items carry no ids and
// no timestamps, so a naive union RESURRECTS deletions (round-2 review). The fix:
// remember the last image we wrote to each classic key (the shadow); on every
// load, diff classic-vs-shadow to learn what classic did while we were away:
//   in shadow, gone from classic  -> classic deleted it  -> delete here too
//   in classic, not in shadow     -> classic added it    -> adopt it
// Then dual-write our state back to the classic key and refresh the shadow.
// Deletions round-trip in both directions; nothing resurrects; nothing is lost.

const S = () => globalThis.localStorage; // injectable for tests via _setStorage

let _store = null;
export function _setStorage(s) { _store = s; } // tests only
const st = () => _store || S();

const J = {
  get(k, fallback) {
    try { const v = st().getItem(k); return v == null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
  },
  set(k, v) { try { st().setItem(k, JSON.stringify(v)); } catch (e) { /* full/blocked */ } },
  raw(k) { try { return st().getItem(k); } catch (e) { return null; } },
  setRaw(k, v) { try { st().setItem(k, v); } catch (e) {} },
};

// Synthesized identity — the only stable thing classic items have is their content.
export function itemKey(kind, it) {
  switch (kind) {
    case 'loops': return [it.name, it.start, it.end, it.ytId || ''].join('|');
    case 'songs': return it.ytId || it.id || JSON.stringify(it);
    case 'setlists': return it.name;
    case 'myversions': return it.id || JSON.stringify(it);
    default: return JSON.stringify(it);
  }
}

// kind -> classic key. Collections merge; scalars adopt-then-dual-write.
const COLLECTIONS = {
  loops: 'cosmicSavedLoopsMaster',
  setlists: 'looperSetlists',
  songs: 'looperYtSaved',
  myversions: 'looperMyVersions',
};
const SCALARS = {
  licenseKey: 'looperLicenseKey',
  license: 'looperLicense',
  instanceId: 'looperInstanceId',
  instanceName: 'looperInstanceName',
  latency: 'looperLatencyMs',
  quantize: 'looperQuantize',
  author: 'looperAuthor',
  instrument: 'looperInstrument',
  strum: 'looperStrumIdx',
  stemUse: 'looperStemUse',
  stemModel: 'looperStemModel',
  stepUse: 'looperStepUse',
  autoChords: 'prefAutoChords',
  autoBpm: 'prefAutoBpm',
};
// Deliberately NOT ported: looperOwner (DevTools-settable owner flag — owner status
// must be server-validated; security review 2026-07-17), looperLastKey,
// looperSetlistOpen (view state), looperApi (dev override — step 9 owns it).
// Spotify sp_token/sp_refresh/sp_expires stay UNDER THEIR OLD NAMES on purpose:
// the registered OAuth redirect lands on the classic page during beta, which
// writes sp_* — sharing the names means the bounce just works (round-2 review).

function mergeCollection(kind) {
  const classicKey = COLLECTIONS[kind];
  const ours = J.get('ld.' + kind, null);
  const classic = J.get(classicKey, []) || [];
  const shadow = J.get('ld.shadow.' + classicKey, null);

  let merged;
  if (ours == null) {
    merged = [...classic]; // first adoption
  } else {
    const classicKeys = new Set(classic.map((it) => itemKey(kind, it)));
    const shadowKeys = new Set((shadow || []).map((it) => itemKey(kind, it)));
    const ourKeys = new Set(ours.map((it) => itemKey(kind, it)));
    merged = ours.filter((it) => {
      const k = itemKey(kind, it);
      // classic deleted it while we were away -> honor the deletion
      return !(shadowKeys.has(k) && !classicKeys.has(k));
    });
    for (const it of classic) {
      const k = itemKey(kind, it);
      if (!ourKeys.has(k) && !shadowKeys.has(k)) merged.push(it); // classic added
    }
  }
  J.set('ld.' + kind, merged);
  J.set(classicKey, merged);              // dual-write
  J.set('ld.shadow.' + classicKey, merged); // refresh shadow
  return merged;
}

function mergeScalar(name) {
  const classicKey = SCALARS[name];
  const ours = J.raw('ld.' + name);
  const classic = J.raw(classicKey);
  const shadow = J.raw('ld.shadow.' + classicKey);
  let value;
  if (ours == null) value = classic;                 // first adoption
  else if (classic !== shadow) value = classic;      // classic changed it while away
  else value = ours;                                 // ours is authoritative
  if (value != null) {
    J.setRaw('ld.' + name, value);
    J.setRaw(classicKey, value);
    J.setRaw('ld.shadow.' + classicKey, value);
  }
  return value;
}

// Call ONCE per page load, before any reads. Idempotent.
export function syncFromClassic() {
  const out = {};
  for (const kind of Object.keys(COLLECTIONS)) out[kind] = mergeCollection(kind);
  for (const name of Object.keys(SCALARS)) out[name] = mergeScalar(name);
  return out;
}

// ——— app-facing API (always dual-writes) ———
function writeCollection(kind, items) {
  J.set('ld.' + kind, items);
  J.set(COLLECTIONS[kind], items);
  J.set('ld.shadow.' + COLLECTIONS[kind], items);
}

export const store = {
  list: (kind) => J.get('ld.' + kind, []),
  add(kind, item) {
    const items = J.get('ld.' + kind, []);
    const k = itemKey(kind, item);
    if (!items.some((it) => itemKey(kind, it) === k)) items.push(item);
    writeCollection(kind, items);
    return items;
  },
  remove(kind, item) {
    const k = itemKey(kind, item);
    writeCollection(kind, J.get('ld.' + kind, []).filter((it) => itemKey(kind, it) !== k));
  },
  get: (name, fallback) => { const v = J.raw('ld.' + name); return v == null ? fallback : v; },
  set(name, value) {
    J.setRaw('ld.' + name, String(value));
    if (SCALARS[name]) { J.setRaw(SCALARS[name], String(value)); J.setRaw('ld.shadow.' + SCALARS[name], String(value)); }
  },
  // pure-new keys (no classic counterpart): tour state, settings, lrc cache handled elsewhere
  getJSON: (name, fallback) => J.get('ld.' + name, fallback),
  setJSON: (name, v) => J.set('ld.' + name, v),
};
