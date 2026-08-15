# Changelog

All notable changes to `@zakkster/lite-snow` are documented here. The format
follows Keep a Changelog, and the project adheres to Semantic Versioning.

## [1.0.2] - 2026-08-15

Session S1. Closes the five silent-corruption paths that were reproducible in
1.0.1. One bad number can no longer kill the scene permanently.

### Fixed

- **SN-01 -- a NaN `dt` no longer poisons the engine.** `if (dt > 0.1)` was a
  comparison guard, and every comparison guard is transparent to NaN. Replaced
  by a single `_sane(dt, w, h)` door called once at the top of `spawn()` and
  once at the top of `updateAndDraw()`, above every state touch.
- **SN-02 -- a NaN or zero `w`/`h` can no longer fill the pool from one call.**
  The door rejects the frame, and independently the spawn cap is now coerced
  with `Math.floor(...) | 0` (`NaN | 0` is `0`), so a NaN cannot reach either
  the `<= 0` test or the loop bound.
- **SN-03 -- `gravity: 0` no longer NaN-poisons every flake at spawn.**
  `windOffset` is hoisted out of the spawn loop and made finite by
  construction; `rng() * Infinity - Infinity` is unreachable.
- **SN-04 -- a non-finite particle no longer leaks its slot forever.** The cull
  is inverted to a positive liveness test, so a NaN fails it and the slot
  recycles on the next frame instead of never.
- **SN-05 -- a negative `dt` is now a total no-op.** The door sits above
  `_elapsedTime += dt`, so a rejected frame leaves the clock and all twelve SoA
  columns bit-identical.

### Decisions

- **Skip the frame; do not substitute a default `dt`.** A substituted `dt`
  silently fabricates motion the caller never asked for. A frame the engine
  cannot trust is a frame it does not run.
- **`gravity === 0` yields `windOffset = 0`, not a clamped quotient.** One
  comparison, and it is the value continuous with "no vertical travel, so no
  lateral pre-spread to compensate for". A clamp would need an arbitrary
  ceiling nobody can justify, and at gravity 0 nothing falls, so the spread it
  would preserve is decorative. Finite negative gravity keeps its sign, so the
  negative-gravity/embers recipe renders bit-identically to 1.0.1.
- **A rejected frame renders nothing.** The early return skips the render
  section, so the caller sees a one-frame gap. Drawing the previous positions
  instead would need a second entry point into the render section; that is the
  update/draw split scoped to a later session. `ctx.globalAlpha` is never
  touched on a rejected frame, so there is no aliasing damage.

### Performance

The only change inside either `updateAndDraw` loop is the SN-04 cull inversion
-- three comparisons and a negation in place of three comparisons. The spawn
loop's per-particle body also lost a line (the SN-03 `windOffset` hoist), which
is a reduction: one division and one `Math.abs` per flake become one of each
per call. Measured on the
60% occupancy lane, 2000-slot pool, 20000 ops after 2000 warmup, seven trials
per run and three runs per build, uncontended:

    v1.0.1  42602 ns/frame (median of run medians)
    v1.0.2  42766 ns/frame (median of run medians)
    delta   +0.4%, inside run-to-run noise

An earlier single-run baseline of 41366 ns was a fast sample rather than a
stable figure; the numbers above are like-for-like on the same machine and
methodology, which is the only comparison that supports the claim.

### Added

- `_sane(dt, w, h)` internal frame door, declared `@internal` in
  `SnowEngine.d.ts`. Two calls per frame, never per particle.
- Torture T1 filled in per the roadmap: the five SN-01..SN-05 reproductions are
  promoted from non-fatal notes to fatal assertions, plus a degenerate-value
  matrix over `dt`, `w`/`h`, `gravity`, `wind` and `density`. Cases belonging to
  a later session (`baseRadius`, `rng` range, `color`, `maxParticles`) are
  recorded with `note()` and gated only on conservation and no-overfill -- T1
  documents them here, it does not fix them.
- Torture T9 controls 3 and 4: a subclass whose `_sane` is reverted to the 1.0.1
  comparison guard, and a subclass carrying a frozen verbatim copy of the 1.0.1
  `spawn` body. Each asserts both that the broken variant is caught and that the
  fixed engine is not, so neither control can pass for the wrong reason.
- `spawnBoundHolds()` and `nanDtSurvived()` in the torture harness, shared by
  T0, T1 and the T9 controls so the law and its control exercise one
  implementation.

### Changed

- Five named regression tests in `test/SnowEngine.test.js` (31 total, up from
  24). Each was proven in both directions: reverting the `_sane` body fails
  SN-01; reverting `updateAndDraw`'s door to the literal 1.0.1 line fails SN-01
  and SN-05; restoring the cull disjunction fails SN-04; removing the
  `windOffset` finite guard fails SN-03; and the frozen 1.0.1 `spawn` copy in
  T9 control 4 fails the SN-02 spawn bound. A regression test that has never
  failed is decoration.
- Two further tests closing holes that an eleven-mutation matrix proved nothing
  asserted on: a rejected `spawn()` cannot poison the dimension cache (the door
  must sit above the `_lastW`/`_lastH`/`_areaModifier` write, an ordering that
  was load-bearing but unpinned), and a flake rising off the top of the screen
  is culled (the cull's `y >= -200` term, the negative-gravity leak guard, was
  never exercised -- a hole that predates this release). Each is proven
  non-vacuous by the mutation it was written against.

### Notes

Two guards in the new code are deliberately redundant, and a mutation matrix
cannot distinguish redundant from dead. Do not "simplify" either away:

- `_sane`'s `dt < 0` test is masked by the call sites' own `if (dt < 0) return;`,
  which reject the negative value `_sane` would hand back. Either alone closes
  SN-05.
- The `gravity === 0 -> windOffset = 0` branch is masked by the
  `!Number.isFinite(windOffset)` fallback: at `gravity === 0` the quotient is
  `Infinity` (or `NaN` for a zero/NaN wind), so the fallback already yields 0.
  The explicit branch states the intent and skips a division.

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

[1.0.2]: https://github.com/PeshoVurtoleta/lite-snow/releases/tag/v1.0.2
[1.0.1]: https://github.com/PeshoVurtoleta/lite-snow/releases/tag/v1.0.1
