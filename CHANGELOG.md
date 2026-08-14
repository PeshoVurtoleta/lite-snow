# Changelog

All notable changes to `@zakkster/lite-snow` are documented here. The format
follows Keep a Changelog, and the project adheres to Semantic Versioning.

## [1.0.1] - 2026-08-15

Session S0. Makes the test suite runnable and stands up the torture gate that
every later session leans on. No engine behaviour changed.

### Added

- `VERSION` export in `SnowEngine.js` (`'1.0.1'`), so the version now lives in
  three places at once (`package.json`, the `VERSION` const, `llms.txt`).
- `test/torture.mjs` plus `test/torture/` -- a ten-tier gate copied from the
  LiteBvh harness. T0 (metamorphic laws + determinism), T1 (degenerate values,
  with SN-01..SN-05 registered as reproducible known issues), T6 (the zero-alloc
  gate over 20% / 60% / 95% occupancy), T7 (soak + conservation + a lite-leak
  witness over 4096 cycles) and T9 (controls) are wired live; T2, T3, T4, T5 and
  T8 are registered as placeholders that later sessions fill.
  `node --expose-gc test/torture.mjs` prints `ok` and exits 0;
  `SNOW_TORTURE_BREAK=1` exits non-zero.
- `engines.node >= 18` (required by `node --test`).
- `CHANGELOG.md` (this file), added to `package.json` `files[]`.
- Type declarations for the six previously-undeclared private members
  (`_elapsedTime`, `_destroyed`, `_lastW`, `_lastH`, `_areaModifier`, `_buckets`)
  and the `VERSION` export in `SnowEngine.d.ts` (SN-31).

### Changed

- Ported `test/SnowEngine.test.js` from vitest to `node:test` +
  `node:assert/strict` (SN-20). 18 tests, all preserved.
- A `boundary` suite of 6 QA cases alongside the ported 18 (24 total): the
  three-place version sync, `bucket[i]` agreement with the z thresholds,
  `density: 0`, `clear()` then respawn, post-`destroy()` no-ops, and the exact
  preset field values. Each was proven non-vacuous by mutation -- perturbing
  the bucket threshold in `SnowEngine.js` fails exactly one of them.
- `package.json` scripts are now `test`, `test:watch`, `torture`, `verify`
  (the LiteBvh shape). Removed the vitest devDependency; added
  `@zakkster/lite-gc-profiler` and `@zakkster/lite-leak` as devDependencies.

### Fixed

- SN-25: `'destroy nulls all 12 arrays'` now loops all twelve SoA column names
  and asserts each is null, instead of spot-checking four. A comment names what
  it protects so it cannot be trimmed back.

### Removed

- `vitest.config.js`, whose aliases pointed at an absolute
  `/mnt/user-data/outputs/` path from another machine and made `npm test`
  unable to resolve the engine's own import.

### Known Issues

Five silent-corruption paths are reproducible as of this release and are fixed in
session S1 (v1.0.2). They are registered in `test/torture/t1-degenerate.mjs` as
non-fatal known-issue reproductions so they are visible on every run.

- **SN-01 -- a NaN `dt` permanently poisons the whole engine.** `if (dt > 0.1)`
  does not clamp NaN (`NaN > 0.1` is `false`), so `_elapsedTime += NaN` is NaN
  forever and no later good frame heals it.
  Repro: `e.spawn(0.016,800,600); e.updateAndDraw(ctx,NaN,800,600); e.updateAndDraw(ctx,0.016,800,600)`
  -> `e._elapsedTime` is NaN, every live `e.x[i]` is NaN.
- **SN-02 -- a NaN or zero `w`/`h` makes one `spawn()` fill the entire pool.**
  `_areaModifier` -> NaN -> `targetSpawns` NaN; neither the `<= 0` guard nor the
  cap fires, so the loop runs to `max` (10000 by default).
  Repro: `new SnowEngine().spawn(0.016,NaN,600)` -> all `max` slots at `state===1`.
- **SN-03 -- `gravity:0` NaN-poisons every flake at spawn.**
  `windOffset = (h/0)*|wind|` is `Infinity`; `x = rng()*(w+Infinity) - Infinity`
  is NaN.
  Repro: `new SnowEngine(10,{gravity:0}).spawn(1,800,600)` -> `e.x[0]` is NaN.
- **SN-04 -- a NaN particle is immortal and its slot is leaked forever.** The
  cull (`x<-200 || x>w+200 || y<-200`) and the settle test (`y>=h`) are all
  `false` for NaN, so the slot never recycles.
  Repro: poison one `e.x[i]=NaN`, run 200 frames -> `e.state[i]` is still `1`.
- **SN-05 -- negative `dt` is unclamped and runs the simulation backwards.**
  `dt > 0.1` bounds only the top; `dt = -1` walks `_elapsedTime` and positions
  backwards.
  Repro: `e.spawn(0.016,800,600); e.updateAndDraw(ctx,-1,800,600)` ->
  `e._elapsedTime` is negative and the live count drops.

[1.0.1]: https://github.com/PeshoVurtoleta/lite-snow/releases/tag/v1.0.1
