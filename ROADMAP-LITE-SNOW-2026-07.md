# ROADMAP-LITE-SNOW-2026-07 — @zakkster/lite-snow

**Current:** v1.0.0 (npm = HEAD) · 6.7 KB single-file ESM · dep: `lite-color` · devDep: vitest (to be removed)
**Verdict from audit:** the healthiest of the quintet. Snow already has the dimension cache, X+Y off-screen culling, per-flake drift speed, and SNOW_PRESETS — the fixes the others are missing. Its roadmap is mostly hardening + one flagship feature (real accumulation).

Shared recipes referenced below (A–I) live in `ROADMAP-FX-REVIVAL-2026-07.md`.

---

## Audit findings ledger

**F1 — Unbounded `_elapsedTime` feeds `Math.sin`.** `sway = sin(elapsed * driftSpeed + phase)`. On a multi-hour Twitch overlay session, elapsed grows into the tens of thousands; float64 sin argument-reduction precision degrades and drift becomes subtly wrong/steppy. Fix: hour-wrap guard (Recipe G). Severity: low visually, but overlays are exactly the multi-hour target.

**F2 — O(max) free-slot scan from index 0 on every spawn.** With default max=10 000 and continuous spawning, occupancy is permanently high and every spawn call walks thousands of live slots. Fix: ring cursor (Recipe D). Severity: measurable; this is snow's largest hot-path cost after rendering.

**F3 — Render pass scans the full pool 4×.** Three bucket passes over all `max` slots plus one melt pass = 40 000 state checks/frame at default max. Fix: single binning pass into three persistent `Uint32Array` index lists + counts (rebuilt each frame, zero-GC), then three tight draw loops over live indices only; melt indices collected in the same pass. Severity: the dominant JS-side frame cost at low occupancy.

**F4 — Loop-invariant property loads in hot bodies.** `this.config.rng`, `this.config.gravity`, `this.x[i]` etc. re-resolved per iteration. Fix: hoist to locals above loop (Recipe E).

**F5 — Melt puddles ignore resize.** A flake melting at `y = h_old` keeps drawing there after the canvas shrinks. Fix: clamp melt-state `y` to current `h` in the physics pass (one comparison, melt-branch only) or cull melts with `y > h + margin`. Severity: cosmetic.

**F6 — Metadata.** `"webgl"` keyword is inaccurate; no CHANGELOG; `lite-color` pinned `^1.0.5` (1.1.0 is out); vitest devDep. (Recipe I.)

**F7 — Test gaps.** No `--expose-gc` zero-GC proof, no soak, no determinism snapshot, no dt/dimension abuse cases. (Recipes B, C.)

**F8 — Description oversells "accumulation".** README/description say "ellipse-based accumulation" but the engine only draws transient melt puddles — nothing accumulates. Either soften the wording (W1) or ship the real feature (W3, planned below). Plan: both — wording fix now, feature later.

---

## v1.1.0 — Hardening + node:test *(target: session S5, ~half session)*

- Migrate `SnowEngine.test.js` to `node:test` per Recipe A; delete `vitest.config.js`; drop devDependencies to zero; `"test": "node --test"`.
- F1: elapsed-time hour-wrap.
- F5: melt clamp on resize.
- New config: `floorY` (default `h`) — snow line independent of canvas bottom, needed for overlay scenes where snow lands on a HUD bar rather than the viewport edge. Additive; `h` fallback preserves behavior.
- F6 wording pass on description/README ("melt puddles", not "accumulation"); keyword cleanup; `lite-color` → `^1.1.0`; add CHANGELOG.md.
- Gate: full suite green on Node 26 (M4) + Intel box.

## v1.2.0 — Hot-path wave *(sessions S5–S7, shared W2)*

- F2: ring-cursor allocator (Recipe D).
- F3: persistent bucket index lists + single binning pass.
- F4: hot-body hoisting pass (Recipe E) — ledger any rejection where hoisting bloats an inline candidate.
- Recipe B zero-GC suite (fall + melt branches), Recipe C torture suite (the soak + seeded determinism snapshot protect F2/F3 rewrites).
- Recipe F bench harness: `spawn` at 20/60/95 % occupancy, physics-only, full frame; VersionMatrix vs v1.1.0; publish gate ≤ 3 % regression on Intel.
- SPP probes via `lite-scope`: `snow.spawn`, `snow.physics`, `snow.render`.

## v1.3.0 — Features *(session S8)*

- **Accumulation heightmap (flagship).** Optional `accumulate: true`: a `Uint16Array` of column heights (1 entry per N px, N configurable, default 4), flakes land on `floorY - pack[col]` instead of `floorY`, raise the column (capped by `maxPackHeight`), pack rendered as a single closed path per frame; slow decay rate melts the pack down. Zero-GC: heightmap allocated at construct for a max width (re-alloc only on width growth — document as the one cold-path allocation). This makes the package's original promise true (F8) and is the visible headline of the release.
- **Wind gusts.** Time-varying wind via a tiny 1D value-noise (pre-allocated permutation table, shared implementation with rain — copy, don't depend): `windNow = wind * (1 + gustStrength * noise(t * gustFreq))`. Config: `gustStrength` (default 0, off = zero cost via branch at frame top, not per particle).
- **Reduced-motion preset.** `SNOW_PRESETS.calm` — low density, low drift, no gusts — plus a README note on wiring `prefers-reduced-motion` at the app layer (engine stays DOM-free).

## v1.4.0 — Integration + docs *(session S10)*

- Oscilloscope-blueprint demo: scenes for presets, gusts, accumulation, and a stress scene with live SPP readouts (all demo JS/CSS conventions apply; demo excluded from `files[]`).
- Worker + OffscreenCanvas recipe in README (Recipe H; snow is the simplest engine to demo it with).
- README refresh: Mermaid state diagram (idle → falling → melting → idle, plus the accumulation branch), regenerated llms.txt, bench provenance table.

## Non-goals

Flake sprites/rotation (circles + z-scaling read correctly at overlay sizes; revisit only on demand), WebGL path, wind interaction with accumulation (pack drift) — parked until the heightmap proves itself in Vikings ambient scenes.
