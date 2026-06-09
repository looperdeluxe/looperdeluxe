// stem-mixer.js — LEAN "mute one instrument" stem engine (low RAM, free, client-side).
// Idea (from swarm research): don't store 6 stems. Separate, KEEP ONLY the one muted stem + the original mix,
// and play  mix  +  (mutedStem × −1)  as SAMPLE-LOCKED Web Audio sources → the muted instrument cancels acoustically.
//   - backing  : mix(+1) + target(−1)  = everything except the target  (the true residual — more faithful than summing 5 stems)
//   - original : mix(+1) + target(0)
//   - solo     : mix(0)  + target(+1)
// RAM: ~1 stem + the mix (~150-300MB) instead of ~900MB. Chunk-parallel separation (workers per core) keeps it fast.
// Engine: demucs-ggml-worker.js → demucs_free.js → demucs_free.wasm (MIT, audited). Weights: same-origin .bin.
(function () {
  const SR = 44100;
  const STEM_ORDER = ['Bass', 'Drums', 'Other', 'Vocals', 'Guitar', 'Piano']; // demucs-6s worker output order
  const MODEL_CACHE = 'looper-stem-model-v1';
  const CHUNK_SEC = 25, PAD_SEC = 3;

  let ctx = null, mixAB = null, targetAB = null, ready = false;
  let mixGain = null, targetGain = null, master = null, mixSrc = null, tgtSrc = null;
  let playing = false, curRate = 1.0, duration = 0, segOffset = 0, mode = 'backing', mutedName = 'Guitar';

  function audioCtx() { if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)(); return ctx; }

  async function loadModelBuffer(url, onStatus) {
    let resp;
    try {
      const cache = await caches.open(MODEL_CACHE);
      resp = await cache.match(url);
      if (!resp) { if (onStatus) onStatus('Downloading the AI model (one time, ~52MB)…'); const net = await fetch(url); if (!net.ok) throw new Error('model HTTP ' + net.status); await cache.put(url, net.clone()); resp = net; }
      else if (onStatus) onStatus('Loading cached AI model…');
    } catch (e) { if (onStatus) onStatus('Downloading the AI model (one time, ~52MB)…'); resp = await fetch(url); if (!resp.ok) throw new Error('model HTTP ' + resp.status); }
    const raw = await resp.arrayBuffer();
    if (url.endsWith('.gz')) { if (typeof DecompressionStream === 'undefined') throw new Error('Browser lacks DecompressionStream.'); const s = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip')); return await new Response(s).arrayBuffer(); }
    return raw;
  }

  async function toModelChannels(buf) {
    let src = buf;
    if (buf.sampleRate !== SR) { const off = new OfflineAudioContext(2, Math.ceil(buf.duration * SR), SR); const n = off.createBufferSource(); n.buffer = buf; n.connect(off.destination); n.start(); src = await off.startRendering(); }
    return { L: src.getChannelData(0), R: src.numberOfChannels > 1 ? src.getChannelData(1) : src.getChannelData(0), length: src.length };
  }

  // Run ONE chunk; keep ONLY the target stem's 2 channels (discard the other 5 → big RAM save).
  function runChunk(worker, left, right, length, ci, targetIdx) {
    return new Promise((resolve, reject) => {
      const s = ci * CHUNK_SEC * SR, e = Math.min(length, s + CHUNK_SEC * SR);
      const ps = Math.max(0, s - PAD_SEC * SR), pe = Math.min(length, e + PAD_SEC * SR);
      const keepStart = s - ps, keepLen = e - s;
      const L = Float32Array.from(left.subarray(ps, pe)), R = Float32Array.from(right.subarray(ps, pe));
      const handler = (ev) => {
        const d = ev.data || {};
        if (d.msg === 'PROCESSING_DONE') {
          worker.removeEventListener('message', handler);
          const tl = d.waveforms[targetIdx * 2], tr = d.waveforms[targetIdx * 2 + 1];
          resolve({ start: s, len: keepLen, L: tl.subarray(keepStart, keepStart + keepLen), R: tr.subarray(keepStart, keepStart + keepLen) });
        } else if (d.msg === 'WASM_ERROR') { worker.removeEventListener('message', handler); reject(new Error('The separation engine errored (song may be too large for this device).')); }
      };
      worker.addEventListener('message', handler);
      worker.postMessage({ msg: 'PROCESS_AUDIO', leftChannel: L, rightChannel: R, originalLength: pe - ps }, [L.buffer, R.buffer]);
    });
  }

  function buildGraph() {
    const c = audioCtx();
    master = c.createGain(); master.gain.value = 1; master.connect(c.destination);
    mixGain = c.createGain(); mixGain.connect(master);
    targetGain = c.createGain(); targetGain.connect(master);
    applyMode();
  }
  function applyMode() {
    if (!mixGain) return;
    if (mode === 'solo') { mixGain.gain.value = 0; targetGain.gain.value = 1; }
    else if (mode === 'original') { mixGain.gain.value = 1; targetGain.gain.value = 0; }
    else { mixGain.gain.value = 1; targetGain.gain.value = -1; }   // backing (mute the target)
  }

  // PUBLIC: separate, keeping only the muted stem. opts: {modelUrl, mutedStem, mixBuffer, playheadTime, onStatus, onPhase, workers}
  async function separate(audioBuffer, opts) {
    opts = opts || {};
    const onStatus = opts.onStatus || function () {}; const onPhase = opts.onPhase || function () {};
    mutedName = opts.mutedStem || 'Guitar';
    const targetIdx = Math.max(0, STEM_ORDER.indexOf(mutedName));
    if (!opts.modelUrl) throw new Error('No stem-model URL configured.');
    const modelBuf = await loadModelBuffer(opts.modelUrl, onStatus);
    onStatus('Preparing audio…');
    const { L: left, R: right, length } = await toModelChannels(audioBuffer);
    const chunkSamp = CHUNK_SEC * SR;
    const nChunks = Math.max(1, Math.ceil(length / chunkSamp));
    const prChunk = Math.min(nChunks - 1, Math.max(0, Math.floor(((opts.playheadTime || 0) * SR) / chunkSamp)));

    // RAM safety (only 1 stem now, so budget is generous) — still window very long songs on low-RAM devices.
    const estMB = (length / 1e6) * 4 * 2 * 2;   // mix + 1 target stem, float stereo
    const devGB = navigator.deviceMemory || 8;
    const sectionMode = estMB > devGB * 1024 * 0.22;
    let fromChunk = 0, toChunk = nChunks;
    if (sectionMode) { const win = Math.max(1, Math.ceil(90 / CHUNK_SEC)); fromChunk = Math.max(0, Math.min(prChunk - (win >> 1), nChunks - win)); toChunk = Math.min(nChunks, fromChunk + win); }
    const spanStart = fromChunk * chunkSamp, spanLen = Math.min(length, toChunk * chunkSamp) - spanStart;

    const order = []; if (prChunk >= fromChunk && prChunk < toChunk) order.push(prChunk);
    for (let i = fromChunk; i < toChunk; i++) if (i !== prChunk) order.push(i);
    const total = order.length;

    const c = audioCtx();
    targetAB = c.createBuffer(2, spanLen, SR);
    // mix buffer for the same span (sample-locked with the stem so subtraction cancels cleanly)
    mixAB = c.createBuffer(2, spanLen, SR);
    mixAB.copyToChannel(left.subarray(spanStart, spanStart + spanLen), 0);
    mixAB.copyToChannel(right.subarray(spanStart, spanStart + spanLen), 1);

    let K = Math.min(opts.workers || (navigator.hardwareConcurrency || 4), total, 6);
    if (devGB <= 4) K = Math.min(K, 2); else if (devGB <= 8) K = Math.min(K, 3);
    K = Math.max(1, K);
    const workers = [];
    for (let k = 0; k < K; k++) { const w = new Worker('stem-engine/demucs-ggml-worker.js'); const mb = modelBuf.slice(0); w.postMessage({ msg: 'LOAD_WASM', model: 'demucs-6s', modelBuffers: [mb] }, [mb]); workers.push(w); }

    let qi = 0, done = 0, firstReady = false;
    onStatus(sectionMode ? 'Limited-RAM device — isolating a 90s window safely…' : 'Isolating ' + mutedName + ' — your section first…');
    duration = spanLen / SR; segOffset = spanStart / SR;

    async function writeResult(r) {
      targetAB.copyToChannel(r.L, 0, r.start - spanStart);
      targetAB.copyToChannel(r.R, 1, r.start - spanStart);
      done++;
      if (!firstReady) { firstReady = true; ready = true; buildGraph(); onPhase('section', { sectionMode, mutedName }); }
      onStatus(done >= total ? '' : 'Playing — isolating the rest… ' + Math.round(done / total * 100) + '%');
    }
    async function pump(w) { while (qi < order.length) { const ci = order[qi++]; const r = await runChunk(w, left, right, length, ci, targetIdx); await writeResult(r); } }
    try { await Promise.all(workers.map(w => pump(w))); }
    finally { workers.forEach(w => { try { w.terminate(); } catch (e) {} }); }
    ready = true; if (!mixGain) buildGraph();
    onPhase('full', { sectionMode, mutedName, spanSec: Math.round(spanLen / SR) });
    return { mutedName };
  }

  // ---- Playback: mix + target, sample-locked, mode via gains ----
  function stopSources() { [mixSrc, tgtSrc].forEach(s => { if (s) try { s.stop(); } catch (e) {} }); mixSrc = tgtSrc = null; playing = false; }
  function play(songTime) {
    if (!ready) return;
    const c = audioCtx(); if (c.state === 'suspended') c.resume();
    stopSources();
    let offset = (songTime || 0) - segOffset;
    if (offset < -0.05 || offset > duration + 0.05) return;
    offset = Math.max(0, Math.min(offset, duration - 0.01));
    const t0 = c.currentTime + 0.03;
    mixSrc = c.createBufferSource(); mixSrc.buffer = mixAB; mixSrc.playbackRate.value = curRate; mixSrc.connect(mixGain); mixSrc.start(t0, offset);
    tgtSrc = c.createBufferSource(); tgtSrc.buffer = targetAB; tgtSrc.playbackRate.value = curRate; tgtSrc.connect(targetGain); tgtSrc.start(t0, offset);
    playing = true;
  }
  function pause() { stopSources(); }
  function seek(t) { if (playing) play(t); }
  function setRate(r) { curRate = r || 1.0; [mixSrc, tgtSrc].forEach(s => { if (s) try { s.playbackRate.value = curRate; } catch (e) {} }); }
  function setMode(m) { mode = (m === 'solo' || m === 'original') ? m : 'backing'; applyMode(); }
  function getMode() { return mode; }
  function setMaster(g) { if (master) master.gain.value = g; }
  function isReady() { return ready; }
  function teardown() { stopSources(); ready = false; mixAB = targetAB = null; mixGain = targetGain = master = null; segOffset = 0; mode = 'backing'; }

  // Load pre-separated cloud stems (Music.ai result) instead of running the local model.
  // stemUrls = {vocals:url, drums:url, bass:url, guitars:url, other:url, ...} from Music.ai result.
  // mixBuffer = the original full-song AudioBuffer (from ws.getDecodedData()).
  // Same mix−stem cancellation trick as separate() — no model download needed.
  async function loadCloudStems(stemUrls, mutedStemName, opts) {
    opts = opts || {};
    const onStatus = opts.onStatus || function () {};
    mutedName = mutedStemName || 'Guitar';
    // Map our UI choices to Music.ai result keys (in priority order)
    const keyMap = {
      'Guitar': ['guitars', 'guitar', 'other'],
      'Bass':   ['bass'],
      'Drums':  ['drums', 'drum'],
      'Vocals': ['vocals', 'vocal'],
      'Piano':  ['piano', 'keys'],
      'Other':  ['other', 'guitars']
    };
    const candidates = keyMap[mutedName] || ['other'];
    const stemKey = candidates.find(k => stemUrls[k]) || candidates[0];
    const stemUrl = stemUrls[stemKey];
    if (!stemUrl) throw new Error('No ' + mutedName + ' stem in Music.ai result (tried: ' + candidates.join(', ') + ')');
    const mixBuffer = opts.mixBuffer;
    if (!mixBuffer) throw new Error('No mix buffer provided — load the song first');
    const c = audioCtx();
    onStatus('Downloading ' + mutedName + ' stem…');
    const resp = await fetch(stemUrl);
    if (!resp.ok) throw new Error('Stem download failed (' + resp.status + ')');
    const arrBuf = await resp.arrayBuffer();
    onStatus('Decoding…');
    let decoded = await c.decodeAudioData(arrBuf);
    // Resample stem to 44100 if needed
    if (decoded.sampleRate !== SR) {
      const off = new OfflineAudioContext(2, Math.ceil(decoded.duration * SR), SR);
      const n = off.createBufferSource(); n.buffer = decoded; n.connect(off.destination); n.start();
      decoded = await off.startRendering();
    }
    // Align lengths to the shorter of mix vs stem (they should be ~equal for the same song)
    const mixLen = Math.min(mixBuffer.length, decoded.length);
    mixAB = c.createBuffer(2, mixLen, SR);
    for (let ch = 0; ch < Math.min(mixBuffer.numberOfChannels, 2); ch++)
      mixAB.copyToChannel(mixBuffer.getChannelData(ch).subarray(0, mixLen), ch);
    targetAB = c.createBuffer(2, mixLen, SR);
    for (let ch = 0; ch < Math.min(decoded.numberOfChannels, 2); ch++)
      targetAB.copyToChannel(decoded.getChannelData(ch).subarray(0, mixLen), ch);
    duration = mixLen / SR; segOffset = 0;
    ready = true; buildGraph();
    onStatus('');
    return { mutedName };
  }

  window.StemMixer = { separate, loadCloudStems, play, pause, seek, setRate, setMode, getMode, setMaster, isReady, teardown,
    get duration() { return duration; }, get segmentStart() { return segOffset; }, get mutedName() { return mutedName; },
    STEM_CHOICES: ['Guitar', 'Bass', 'Drums', 'Vocals', 'Piano', 'Other'] };
})();
