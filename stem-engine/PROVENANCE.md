# Vendored stem-separation engine (PINNED + AUDITED)

Engine: sevagh/free-music-demixer @ tag v0.7.0-alpha (MIT) — demucs.cpp (ggml) compiled to WASM.
Files: demucs-ggml-worker.js (was docs/worker.js), demucs_free.js, demucs_free.wasm, WavFileEncoder.js
Weights: ggml-model-htdemucs-6s-f16.bin (52MB) from huggingface datasets/Retrobear/demucs.cpp —
         Meta's MIT htdemucs_6s (6 stems: vocals/drums/bass/guitar/piano/other), served SAME-ORIGIN (no CORS).
Fetched 2026-06-06. PINNED — do not auto-update.
Audited: no external network (wasm loads same-origin), no eval, no storage/exfil.
Protocol: LOAD_WASM {model:'demucs-6s', modelBuffers:[binBytes]} then PROCESS_AUDIO {leftChannel,rightChannel}
          -> PROCESSING_DONE {waveforms:[L,R x6]} in order Bass,Drums,Other,Vocals,Guitar,Piano.
(Earlier ONNX engine demucs_onnx_simd.* was removed — its proprietary .ort weights weren't obtainable.)
