# Changelog

All notable changes to `@zakkster/lite-snow` are documented here. The format
follows Keep a Changelog, and the project adheres to Semantic Versioning.

## [1.3.0] - 2026-08-21

Session S6. Accumulation and friction. `accumulate: true` builds a persistent
`Uint16Array` heightmap (`pack`) that settled flakes land ON and that decays over
time. It is **opt-in and OFF by default**: with `accumulate: false` the pre-1.3.0
melt ellipse is the default behaviour and `spawn()`/`updateAndDraw()` are
BYTE-IDENTICAL to 1.2.0 -- proven both by the committed 12-column determinism hash
`f2e3ccef...ef15` AND by a new ORDERED ctx-call-sequence digest
`0886e3df...2ca2d` (opcode + f64 argument bits, so a reordering that preserves
sums cannot hide). See `decisions/0003-accumulation.md`.

### Added

- **`accumulate` (default false)** -- CONSTRUCTION-TIME only: arms strictly on
  `=== true`; a runtime flip of `config.accumulate` is inert (no allocation, no
  behaviour change). When off, `pack === null`.
- **The `pack` heightmap** -- `Uint16Array(maxPackWidth / packResolution)`,
  allocated once and only when armed, a SEPARATE fixed cost (not per-particle;
  default 1024 cols = 2 KB). Never reallocated; a resize truncates in place;
  nulled by `destroy()`.
- **`packResolution` (4)**, **`maxPackWidth` (4096)**, **`maxPackHeight` (200)**
  -- when armed, each must be an integer in its range (`[1,256]`,
  `[packResolution,16384]`, `[1,65535]`) or the constructor throws `RangeError`
  naming the value.
- **`packDecay` (2.0 packUnits/s)** -- integer-stepped decay; the whole integer
  part of the accumulator drains each frame, over all pack columns -- a fixed
  bound that covers the full raise domain, never the particle pool. Non-finite
  fails closed to the default; negative coerces to 0.
- **`floorY` (null)** -- settle floor; `null` tracks the per-frame `h`, a finite
  value is used raw (e.g. an overlay HUD bar). Non-finite fails closed to `null`.
- **`friction` (0)** -- contact-frame `vx` damp applied once at the settle
  transition; clamped to `[0,1]`, negative coerces to 0 (never anti-friction).

### Design

- **Exact integer conservation.** `packSum === _packLanded * PACK_GAIN -
  _packDecayed - _packCapped - _packTruncated` holds every frame with NO epsilon
  -- an f32 "to within rounding" identity was rejected as flaky.
- **Fail closed by SKIPPING, not clamping.** An out-of-domain column (spawn
  overhang, wind past `w`) settles at `floorY` and raises nothing; clamping to an
  edge column would build a false wall.
- **No new state, no new SoA column.** Accumulation reuses state 2; the pack
  height is raised ONCE, at the `1 -> 2` transition, so the flake's contribution
  outlives its recycled slot. The melt ellipse is still drawn, on top of the pack.
- **One extra fill.** The pack renders as a single closed-path fill, before the
  melt bands, only when non-empty: `3 depth-bucket fills + [0..1] pack + up to 8
  melt-band fills` per frame.
- **`settle` REJECTED.** Snow settles on first contact and has no rebound `vy`, so
  a rest-velocity threshold would be a global on/off dressed as a threshold.

## [1.2.0] - 2026-08-21

Session S5. Living air: `gust`, `turbulence` and `drag`. All three are OFF by
default, and with them off `spawn()` and `updateAndDraw()` are BYTE-IDENTICAL to
1.1.1 -- proven by reproducing the committed determinism hash
`f2e3ccef...ef15` (12 v1.1.1 columns, `makeRng(0x5EED1234)`, 2000 slots, 3000
frames at dt 1/60 over 1280x720) before and after the change. See
`decisions/0002-living-air.md`.

### Added

- **`gust` (default 0)** -- a GLOBAL sinusoidal horizontal acceleration in
  px/s^2, its phase riding the shared `_elapsedTime` clock at `gustFreq`.
- **`gustFreq` (default TAU/3)** -- gust angular frequency in rad/s.
- **`turbulence` (default 0)** -- a PER-FLAKE rotating acceleration in px/s^2
  that reuses each flake's `driftPhase`/`driftSpeed` (zero new rng, zero new
  phase column); `cos(tp)` drives `vx`, `sin(tp)` drives `vy` for the single
  `tp = et*driftSpeed[i] + driftPhase[i]` already computed for sway.
- **`drag` (default 1 = off)** -- terminal-velocity damping in `[0, 1]`. `drag`
  is a SEPARATE integration model, not the default times a factor: its guarded
  branch folds gravity/wind into `vx`/`vy` and damps toward a terminal fall
  speed, so a smaller `drag` lowers the steady-state fall speed. Off by default,
  so it never touches the default path.
- **Two SoA columns, `vx`/`vy`** (`Float32Array`). The layout grows from 12
  columns to 14, 58 -> 66 bytes/particle (+8 B, +80 KB at max 10000). Additive
  under the layout contract. `vx`/`vy` are zeroed on every spawn so a recycled
  ring slot never inherits a dead flake's velocity, and nulled by `destroy()`.

### Design

- Every living-air knob **fails closed**: a non-finite value, including `null`,
  lands on its DEFAULT, not on 0. null is not zero.
- An **ACCEL_MAX = 10000 px/s^2** component clamp bounds every acceleration fed
  into `vx`/`vy`, so velocity growth stays linear and positions stay finite for
  ANY finite input (`gust: 1e9 + turbulence: 1e9 + drag: 0` over 100k frames
  leaves every live position finite).

## [1.1.1] - 2026-08-15

Session S4. No physics or rendering change: `spawn()` and `updateAndDraw()` are
byte-identical to 1.1.0, proven by diff. This session closes the last suite-law
breaches -- a runtime dependency carried for one string template, missing
metadata, and non-ASCII source -- and makes the demo exercise the local build
without leaking.

### Changed

- **SN-19 -- zero runtime dependencies.** The lone runtime dep,
  `@zakkster/lite-color`, was used for exactly one constructor call
  (`toCssOklch`, only when `color` is an `{ l, c, h }` object). That call is now a
  six-line private formatter, `_cssOklch`, whose output is byte-identical to
  `toCssOklch` for a valid object and fails closed to `'oklch(0.98 0.02 250)'` on
  a null/non-object input or a non-finite channel -- never `"oklch(NaN NaN NaN)"`,
  which canvas silently ignores. `@zakkster/lite-color` stays a devDependency so
  the byte-identity is provable across a 64-color corpus. See
  `decisions/0001-zero-deps.md`.
- **SN-21 -- `"sideEffects": false`** added; a `LICENSE` file (MIT) added and
  listed in `files[]`.
- **SN-22 -- dropped the `"webgl"` keyword.** The engine touches
  `CanvasRenderingContext2D` and nothing else.
- **SN-24 -- ASCII pass.** Fixed the real non-ASCII breaches in `SnowEngine.d.ts`
  and `llms.txt` (`->`, `--`, `+/-`, `^2`); the permitted U+00D7 is left alone.
- **Dependency-count claims corrected.** The amputation made "one dependency"
  false: the `llms.txt` tagline and Dependencies section and the `README.md`
  badge and tagline now state zero runtime deps.

### Added

- **Importable demo controller `demo/SnowDemo.js`** (SN-27/SN-28):
  `createSnowDemo({ window, document, engine }) -> { destroy }`. All wiring is
  dependency-injected, so the leak-safe lifecycle is testable under house law
  without a DOM library. `demo.html` is now a thin shell over it.

### Fixed

- **SN-27 -- the demo resize leak.** The synchronous `window.addEventListener
  ('resize', ...)` is replaced by an rAF-batched `ResizeObserver`, and every
  listener plus the observer plus the rAF is torn down in `destroy()`, wired to
  `pagehide`. `devicePixelRatio` is re-read on every resize instead of captured
  once.
- **SN-28 -- the demo ran stale, remote code.** It imported
  `esm.run/@zakkster/lite-snow@1.0.0`; it now imports the local `../SnowEngine.js`
  and drives the preset buttons off the shipped `SNOW_PRESETS`, with a telemetry
  readout over the 1.1.0 `activeCount`/`fallingCount`/`meltingCount` getters. The
  dead `// --- INLINED CORE ENGINE ---` comment and `const TAU` are gone.

## [1.1.0] - 2026-08-15

Session S3, the headline render session. Six findings, one root cause: the frame
did four full-pool scans and then threw away the batching those scans exist to
enable. The README promised "3 draw calls for all 10,000 flakes" while the melt
loop issued a `beginPath` + `ellipse` + `fill` **per melting particle**. This
session makes the render bin-driven and the performance claim true.

### Fixed

- **SN-06 -- the melt pass is batched.** It used to issue one
  `beginPath`/`ellipse`/`fill` per melting particle, so the true draw-call count
  was `3 + meltCount`, not 3. Melting particles are now quantized into at most 8
  alpha bands and drawn in one `fill()` per populated band. Draw calls per frame
  are now exactly `3 + populatedMeltBands`, bounded at `3 + 8` and independent of
  the melt population. The visible cost is that the melt fade now bands into 8
  steps instead of being continuous; at 8 bands it is not perceptible in motion.
- **SN-13 / SN-11 -- one full-pool scan per frame, down from five.** The render
  used to scan all `max` slots four times (three depth-bucket passes plus the
  melt pass) on top of the physics pass -- five full scans, most of them over
  free slots. The bin push is now folded into the physics pass: as each live
  slot's final state is computed it is written into one of four preallocated
  `Uint32Array(max)` index lists (three depth buckets plus melt), and the render
  iterates only those live indices. The `for...of` over three object literals
  (`_buckets`) in the hot body is gone; the three bucket alphas are module
  constants.
- **SN-12 -- spawn uses a ring cursor.** The old spawn scanned for a free slot
  from index 0 on every call, so under steady snowfall it walked thousands of
  live slots per spawn. A persistent `_spawnCursor` now wraps, and a full wrap
  that finds no free slot fails closed (it stops -- it never spins). `clear()`
  resets the cursor so a cleared engine reproduces a fresh one bit-for-bit.
- **SN-14 -- loop-invariant loads are hoisted.** Config reads (`rng`, `gravity`,
  `wind`, `baseRadius`, `driftAmplitude`, `driftFreq`, `meltTimeMin/Max`) and the
  twelve SoA column references are read once into locals above both loops instead
  of being re-resolved per iteration.
- **SN-08 -- melt puddles follow a resize.** A melting particle's `y` is now
  clamped to the current height in the melt branch only, so after the canvas
  shrinks the puddles stay on-screen instead of rendering below the floor.

### Changed

- Render is bin-driven; `_buckets` and its iterator are removed. No public API,
  signature, or SoA-column change -- `spawn()` and `updateAndDraw()` keep their
  exact shapes (the update/draw split remains S9).
- **The README render claim is corrected** from "3 draw calls for all 10,000
  flakes" to "3 depth-bucket fills plus up to 8 melt-band fills".
- **Bytes per particle: 42 -> 58.** The four `Uint32Array(max)` bin lists add 16
  bytes per slot. They are allocated once at construction; T6 pins each bin's
  `.buffer.byteLength` constant across a 60000-frame window, so binning is never
  a per-frame allocation. The per-frame reset is four scalar writes plus eight
  band-flag writes -- never a `.fill()` or a realloc.

### Performance

Frame cost (`updateAndDraw` at a pinned occupancy, 2000-slot pool, non-settling
flakes so occupancy holds) measured interleaved in alternating pairs on an
**Apple M4 Pro (arm64), Node v26.3.1**. Median of 41 trials x 100-frame batches,
500-frame warmup; two full runs agreed within a few points. Block-ordering was
avoided deliberately -- it measures thermal drift, not the diff.

| Occupancy | v1.0.3 | v1.1.0 | Delta |
| --- | --- | --- | --- |
| 20% | ~9.4 us | ~6.2 us | **-34%** |
| 60% | ~18.4 us | ~13.6 us | **-26%** |
| 95% | ~26.2 us | ~19.6 us | **-25%** |

No regression at any occupancy. The win is largest at low occupancy because the
old render scanned the full pool regardless of how many slots were live; the
bin-driven render touches only live indices.

### Tests

- **T5 differential fuzz** (new): a plain-object AoS oracle driven by the same
  seeded rng and frame schedule; sorted `(x, y, radius, state)` tuples must match
  the SoA engine exactly over 100000 mixed spawn/update/clear/resize frames. This
  is the safety net for the hot-path rewrite -- a rewrite changes cost, never
  answers. T9 control 2 corrupts the oracle to prove the comparator can fail.
- **T3 adversarial** (new): resize churn including `1x1` and `8000x8000` and a
  shrink with a full melt population live (SN-08), density ramp `0 -> 40 -> 0`,
  wind sign flips, gravity flipped negative mid-run, call-order abuse, and
  run-to-saturation.
- **T2** gains a draw-completeness contract -- every falling flake emits exactly
  one `arc()` and every melter exactly one `ellipse()`, so a dropped bin push is
  caught (the fill count alone cannot see it) -- and a band-reset contract that
  drives a top alpha band from populated to empty and checks the per-band flags
  follow a fresh recount, catching a stuck band.
- **T6** pins the four bin backing-store byte lengths; **T9** adds the melt-batch
  and oracle controls (control 5 both directions: unbatched melt fails the
  fill-count ceiling, a batched no-melt scene still passes).
- Gates proven non-decorative by both law-7 detectors: an 8-mutation matrix over
  the S3 guards (7 caught; the 1 survivor is the ring cursor's finite termination
  bound, whose value cannot change spawn output -- benign, documented) and a
  fired-site census (110 sites, 109 fired, the 1 miss a comment).

## [1.0.3] - 2026-08-15

Session S2. S1 shut the per-frame door; this shuts the per-object one --
construction, destruction, the shared preset table, and the fact that a caller
could not see how full the pool was.

### Fixed

- **SN-15 -- `maxParticles` is validated instead of trusted.** Must be an
  integer in `1..10000000`; anything else throws a `RangeError` naming the
  value. `new SnowEngine(0)` used to build a dead engine that silently spawned
  nothing, `2.5` truncated to a two-slot pool, and `1e9` attempted a 42 GB
  allocation and died inside the typed-array allocator. The ceiling is stated
  in bytes: the pool costs 42 bytes per particle, so 10000000 is 420 MB.
- **SN-07 -- a negative flake radius can no longer reach `ctx.arc`.** Both ends
  are closed, because `config` is live-mutable and a constructor check alone is
  not sufficient: `baseRadius` must be finite and `> 0` at construction, and the
  jittered per-flake radius is clamped to `MIN_RADIUS` (0.01) at spawn. A
  `baseRadius` under 0.4 could previously produce a negative radius, and
  `ctx.arc` throws `IndexSizeError` from inside the bucket loop -- leaving the
  path open and `globalAlpha` at the bucket value.
- **SN-10 -- a throwing draw call no longer corrupts the caller's canvas
  state.** `ctx` is validated once per frame, above the clock write, and a
  missing or malformed context is a no-op frame on the same terms as a bad `dt`.
  The render section is wrapped so `ctx.globalAlpha = 1.0` always runs. The
  error is **rethrown**, not swallowed. Physics settles before the render
  section opens, so a mid-frame throw leaves the engine intact and the next
  frame renders normally.
- **SN-09 -- `destroy()`'s `clear()` was dead code.** The old order set
  `_destroyed = true` and then called `clear()`, whose first line returns when
  that flag is set, so `state.fill(0)` never executed. Harmless only because the
  next line nulled `state` -- invisible, and live the moment a step appeared
  between them. `clear()` now runs first. `destroy()` also releases `config`,
  `colorStr` and `_buckets`, so a destroyed engine retains nothing but its flag.
- **SN-17 -- `clear()` is a full simulation reset.** It now zeroes
  `_elapsedTime` and invalidates the dimension cache
  (`_lastW`, `_lastH`, `_areaModifier`) as well as the pool. A cleared engine
  previously resumed mid-sine and kept a stale area modifier until the canvas
  dimensions happened to change again.
- **SN-16 -- `SNOW_PRESETS` and every preset object are frozen.** The README and
  the test suite both spread presets into constructors; one assignment into a
  preset silently reconfigured every engine built from it afterwards.
- **SN-32 -- the spawn cap no longer wraps at int32.** S1 trapped NaN with
  `Math.floor(...) | 0` and accepted the int32 coercion knowingly. It is now a
  clamp, which traps NaN identically (`NaN > 0` is false) and cannot wrap.
  Additionally guarded with `Number.isFinite`: without it, `density: Infinity`
  drives the raw cap to `Infinity`, which is greater than `max`, so the clamp
  would fill the entire pool in one call -- an SN-02 regression through a config
  path the frame door does not validate.

### Added

- **SN-18 -- pool telemetry.** `fallingCount`, `meltingCount` and `activeCount`
  as O(1) integer reads maintained by the four existing state transitions. No
  new scan, no new branch, no new loop. This is what makes SN-02-class overfill
  observable from outside, which is why it went a whole release unseen.
- Torture T2 (canvas-state contract) and T4 (lifecycle and hostile input),
  previously empty placeholders.
- Harness predicates `countersAgree`, `clearIsFullReset`, `destroyReleasesAll`
  and `spawnCapNoWrap`, shared by T1, T4, T7 and the T9 controls so a law and
  its control exercise one implementation.
- T9 controls 7-10: a `clear()` that skips the clock, a `destroy()` re-inverted
  to the frozen 1.0.2 body, a frozen `| 0` spawn cap, and a counter oracle.
  Each asserts both that the broken variant is caught and that the fixed engine
  is not, so none can pass for the wrong reason.

### Breaking for misuse

Two inputs that used to be accepted now throw. Neither was ever documented as
supported, but both are observable behaviour changes:

- `new SnowEngine(2.5)` (or `0`, `-1`, `NaN`, `Infinity`, `1e9`, `'100'`) now
  throws a `RangeError` instead of silently truncating or dying in the
  allocator.
- `SNOW_PRESETS.flurry.density = 999` now throws a `TypeError` in strict mode
  (ESM is always strict) instead of succeeding.

### Performance

The only hot-body change is SN-18's four counter updates at three existing
transition sites in the physics loop. The render section gained a `try` and a
`finally` around it and **zero** per-particle statements. Measured on the 60%
occupancy lane, 2000-slot pool, 20000 ops after 2000 warmup, seven trials per
run, five runs per build, uncontended:

    v1.0.2  41810 ns/frame (median of run medians)
    v1.0.3  41735 ns/frame (median of run medians)
    delta   -0.18%, inside run-to-run noise

**Methodology note, because it changed the answer.** Measuring the two builds in
blocks -- all of 1.0.2, then all of 1.0.3 -- reported +1.8%, which would have
tripped the budget and reverted the counters. Interleaving the runs in
alternating pairs reported -0.18%. In the interleaved data 1.0.2's own spread
(41197..43008) is *wider* than 1.0.3's (41592..42690), so the block-ordered
figure was measuring drift across the run, not the diff. Interleave, or do not
claim a sub-1% delta.

### Changed

- 38 unit tests across 6 suites, up from 31 across 5.
- `MockCtx.arc()` and `.ellipse()` now throw `IndexSizeError` on a negative
  radius, exactly as a real `CanvasRenderingContext2D` does. Without this the
  mock silently accepted geometry a real canvas refuses, which made "a full
  frame does not throw" an assertion about the mock rather than about the
  engine.

### Notes

A fourteen-mutation matrix was run against this release. Two mutations survived
the first pass, both genuine coverage holes rather than benign redundancy, and
both are now closed. They are recorded because each is a *class* of mistake, not
a one-off:

- **The SN-07 regression test was vacuous.** It asserted every live flake's
  radius was positive, but did so *after* a frame -- and its own
  `rng: () => 0` places every flake at `x = -windOffset = -450`, which S1's
  positive-liveness cull kills on that first frame. The assertion looped over an
  empty pool and passed no matter what the engine did; deleting the radius clamp
  outright survived it. The check now runs on the pool the spawn produced and
  pins the live count first, so it cannot go vacuous again. A test whose
  assertion sits inside a conditional needs a proof that the conditional fires.
- **The cull transition's counter decrement was never exercised.** The counter
  suite used high gravity, so every flake *settled*; nothing walked off-screen,
  so the `1 -> 0` cull path ran with no counter assertion watching and deleting
  its decrement survived. A dedicated high-wind case now forces pure culls with
  no settles, and asserts a cull actually happened. This is the same shape as
  the S1 hole where the `y >= -200` term was never exercised: the transition
  every fixture happens not to reach is the one nothing is asserting on.

After both fixes, all fourteen mutations are caught.

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

[1.3.0]: https://github.com/PeshoVurtoleta/lite-snow/releases/tag/v1.3.0
[1.2.0]: https://github.com/PeshoVurtoleta/lite-snow/releases/tag/v1.2.0
[1.1.1]: https://github.com/PeshoVurtoleta/lite-snow/releases/tag/v1.1.1
[1.1.0]: https://github.com/PeshoVurtoleta/lite-snow/releases/tag/v1.1.0
[1.0.3]: https://github.com/PeshoVurtoleta/lite-snow/releases/tag/v1.0.3
[1.0.2]: https://github.com/PeshoVurtoleta/lite-snow/releases/tag/v1.0.2
[1.0.1]: https://github.com/PeshoVurtoleta/lite-snow/releases/tag/v1.0.1
