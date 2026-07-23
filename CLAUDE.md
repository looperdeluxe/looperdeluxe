# CLAUDE.md — Looper Deluxe (looperdeluxe.com)

Guitar practice web app: song lookup, chord charts, looping/slowdown playback. Static site on
GitHub Pages (this repo), custom domain via Cloudflare. Audio/search served by a separate engine
at engine.looperdeluxe.com.

## Current state of play
- `index.html` = the LIVE production app. Treat as precious; no experimental edits.
- `beta.html` = the active REBUILD target (started from the frozen v40 prototype spec:
  one-clock architecture — a single time source drives chart scroll, chord highlight, and strum).
  New work happens here first; promotion to index.html only when Brooks signs off.
- `bench-*.html` = on-device test pages (iPhone quirks are the #1 source of bugs — see below).

## Hard-won iOS/browser rules — do not relearn these
- **Request-and-verify beats documentation:** YouTube embeds accept 0.05-step playbackRates on
  iPhone (0.95/0.9/0.85 stick) even though the API advertises [0.25..1]. Always set, then read
  back, and trust only the read-back.
- **iOS requires a user gesture PER PLAYER** to start playback — a bench/page with two players
  needs two taps. Design flows accordingly.
- Unicode arrow/glyph characters render low/small on iOS buttons — use SVG icons, geometrically
  centered.

## Conventions
- Single-file pages (inline CSS/JS) — this is a static Pages site, no build step, no framework.
- Commit messages: short, step-numbered like the existing log (e.g. "rebuild step 18: ...").
- Small commits, one working change each; `git pull` before starting (multiple machines edit
  this repo).
- **This repo is PUBLIC and every committed file is served on the live domain.** No secrets,
  no keys, no private notes, no test data you wouldn't publish.
- After pushing: verify the change is actually live on looperdeluxe.com (Pages builds can wedge);
  hard-refresh or curl the file — do not claim "deployed" from a successful push alone.
