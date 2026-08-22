# 0004 -- Presets, reduced motion, spawn shaping (SN, brief "presets / reduced motion / settle")

Status: accepted (S7, v1.4.0)
Date: 2026-08-22
Session: S7

## Context

Through v1.3.0 the three `SNOW_PRESETS` (`flurry`, `heavy`, `blizzard`) each name
only FIVE keys (`density`, `wind`, `gravity`, `driftAmplitude`, `baseRadius`).
S5 added the living-air knobs and S6 added the accumulation knobs, so a preset
now describes a much smaller engine than the one that ships: spread a preset and
every unnamed key silently takes a constructor default. The S7 brief asks for a
fourth preset (`calm`), a `reducedMotion` accessibility flag, and (implicitly)
spawn shaping. It also asks for a `landedCount` getter and a `settle` knob -- both
already rejected by shipped decisions. This record resolves every contradiction
BEFORE the code, so no arithmetic and no committed digest moves by accident.

The void line anchors in the brief were re-derived (all pre-S3, S3-S6 moved the
file): `SNOW_PRESETS` is at `:626-647` not `:179-201`; the spawn y band is at
`:285` (`y[i] = -50 - rng() * 50`) not `:81`; the windOffset derivation is at
`:248-249` not `:79-80`.

## Decisions

### (a) `landedCount` is NOT added -- state 2 is the settled state

The brief asks to add and document `landedCount`. `decisions/0003 (b)` rejected
it in S6 and named S7 explicitly: a flake reaching the pack surface (floor, or
pack top when `accumulate: true`) goes `state 1 -> 2` and stays frozen while it
ages out -- exactly Confetti's `landed` contract. `meltingCount` already returns
that number. A second getter over the same `_nMelting` scalar would be a second
name for one counter, kept in sync forever for zero information.

Documented instead: `llms.txt` and `SnowEngine.d.ts` state that `meltingCount` is
the landed count -- state 2 IS the SETTLED state, there is no separate
`landedCount`. A node:test anti-drift guard asserts
`'landedCount' in SnowEngine.prototype === false`.

### (b) There is no `settle` knob

The brief's PURPOSE line lists `settle` among knobs the presets fail to name. It
does not exist and never shipped: `decisions/0003` rejected it because snow has no
bounce, so a rest threshold would gate on a value that is always terminal
velocity -- a global on/off dressed as a threshold. "Name every knob" must not
invent it. `friction` shipped instead in S6.

### (c) `spawnBand` keeps the SUBTRACTIVE arithmetic form

Today (`:285`): `y[i] = -50 - rng() * 50`. The natural config form
`min + rng() * (max - min)` is the MIRROR of today's draw for the same rng value
(`{min:-100, max:-50}`: `r=0` gives `-100` where today gives `-50`) -- same
distribution, different per-draw value, so every committed digest breaks while the
snow still "looks right". This is the S5 lesson in a new costume: preserve the
EXPRESSION, not the intent.

The engine keeps the subtractive form. Two plain-number locals resolve ONCE at
construction:

- `spawnBand === null` (default) -> `_spawnY0 = -50`, `_spawnYSpan = 50` -- the
  LITERAL constants, not derived from anything. Byte-identity by construction.
- `spawnBand = { min, max }`, both finite, `max >= min` -> `_spawnY0 = max`,
  `_spawnYSpan = max - min`.
- Anything else (non-object, null-proto garbage, non-finite bound, `max < min`)
  FAILS CLOSED to the two literal constants, no throw. A negative span would flip
  the sign of the rng term; an unverified band is not a band.

`spawn()` writes `y[i] = spawnY0 - rng() * spawnYSpan` (`spawnY0`/`spawnYSpan`
hoisted above the per-slot loop). Consequence used as a test:
`{ spawnBand: { min: -100, max: -50 } }` yields `_spawnY0 = -50`,
`_spawnYSpan = 50` -- BIT-IDENTICAL to the default, so it reproduces
`BASELINE_DIGEST` exactly. Under the mirrored parameterization it would not. That
single assertion catches the whole trap.

### (c') `spawnMargin` keeps the derived wind-offset expression verbatim

Today (`:248-249`):

    const g = this.config.gravity;
    let windOffset = g === 0 ? 0 : (h / g) * Math.abs(this.config.wind);
    if (!Number.isFinite(windOffset)) windOffset = 0;

The default path keeps THAT EXPRESSION VERBATIM, including the `g === 0`
short-circuit and the `Number.isFinite` guard. Parameterization is ONE branch in
`spawn()`'s per-call prologue (once per frame, zero per slot): when
`_spawnMargin === null` the expression above runs unchanged; otherwise
`windOffset = this._spawnMargin`. `_spawnMargin` resolves at construction: a
finite `spawnMargin >= 0` used raw, non-finite or negative -> `null` (= derive).
`null` is the ONLY value meaning "derive" -- the same sentinel discipline as
`floorY`. The `x[i] = rng() * (w + windOffset * 2) - windOffset` line is untouched.

### (d) `reducedMotion` is a HARD OVERRIDE, resolved once at construction

THE FLAG WINS. Accessibility fails closed toward less motion; an explicit knob set
alongside the flag is discarded. There is no "reduced blizzard".

- `{ ...SNOW_PRESETS.blizzard, reducedMotion: true }` -- the twelve MOTION keys
  are overwritten with calm's values; reproduces calm's committed digest exactly.
- `{ reducedMotion: true, gust: 500 }` -- `gust` becomes 0; the user's 500 is
  discarded, not blended. `gustOn` is false and the gust guard provably never
  fires.
- `{ ...SNOW_PRESETS.calm, reducedMotion: true }` -- idempotent.

The MOTION set (12 keys, exhaustive): `gravity, wind, density, baseRadius,
driftAmplitude, driftFreq, gust, gustFreq, turbulence, drag, spawnBand,
spawnMargin`. NOT overridden, and why: `accumulate, packResolution, maxPackWidth,
maxPackHeight, packDecay, floorY, friction` -- accumulation is a PILE, not motion,
so `{ ...heavy, accumulate: true, reducedMotion: true }` keeps its pack;
`meltTimeMin`/`meltTimeMax` -- melt rate is not motion; `color`, `rng` -- never
scene. Because all four presets carry identical values for every non-MOTION
digest-affecting key, `{ ...anyPreset, reducedMotion: true }` equals calm on every
field the digest sees.

Mechanics (binding):

1. Strict arm: `this._reducedMotion = this.config.reducedMotion === true`.
   `'yes'`/`1`/`{}` do not arm it -- same discipline as `accumulate`.
2. Resolves IMMEDIATELY after the config spread and BEFORE `baseRadius` validation
   and before every fail-closed coercion. Under the flag the motion keys are not
   user-supplied at all, so validating a value the engine will never read would
   throw on discarded input. Consequence, tested BOTH ways (AD-2 asymmetry below).
3. TWELVE EXPLICIT ASSIGNMENTS from a module-level frozen `CALM` const, inside one
   `if (this._reducedMotion) { ... }` block. No loop over a key array, no
   `Object.assign` onto the caller's object.
4. NEVER READ AGAIN. No frame-loop reference to `_reducedMotion` or
   `config.reducedMotion`. A mid-run flip is INERT, exactly like `accumulate`.
5. ONE SOURCE OF TRUTH: `const CALM = Object.freeze({...})` above the class;
   `SNOW_PRESETS.calm` is `Object.freeze({ ...CALM })` and the override reads from
   CALM. They cannot drift.

### (d') The validation-ordering asymmetry is deliberate, and pinned both ways

Because reducedMotion resolves before `baseRadius` validation (mechanic 2), the
flag SILENTLY SWALLOWS an invalid input in the one place this package normally
throws. That is defensible -- the value is genuinely never read -- but it must be
pinned in both directions so a future reader is not left guessing:

- `{ baseRadius: 0 }` THROWS RangeError naming the value.
- `{ baseRadius: 0, reducedMotion: true }` constructs, and
  `config.baseRadius === 2.5` (calm's value).
- Same pair for a garbage `{ baseRadius: 'big' }`.

If a future reader thinks the second line is a bug, this record is the answer:
under the flag `baseRadius` is calm's, never the user's, so the user's `0` is
never a live value to reject.

### (e) A preset is a COMPLETE 21-key scene configuration

A preset names all 21 scene keys, each set to a value the engine would otherwise
supply as a default (except where the preset deliberately differs). Because the
constructor is `{ ...defaults, ...config }` and a preset is spread BEFORE the
user's own keys, completeness costs the user nothing:

- `{ ...SNOW_PRESETS.heavy, accumulate: true }` -> `accumulate` is true (user's
  key wins).
- `{ ...SNOW_PRESETS.blizzard, rng: seeded(1) }` -> works; presets do not name
  `rng`.
- `{ ...calm, ...heavy }` yields exactly `heavy` -- true ONLY BECAUSE both are
  complete. A partial preset would leave calm's leftovers behind. That is the
  point of the extension.

The 21 keys (= all 24 config keys minus `color`, `rng`, `reducedMotion`):
`gravity, wind, density, baseRadius, driftAmplitude, driftFreq, meltTimeMin,
meltTimeMax, gust, gustFreq, turbulence, drag, spawnBand, spawnMargin, accumulate,
packResolution, maxPackWidth, maxPackHeight, packDecay, floorY, friction`.

Excluded keys, reasons:

- `rng` -- injection, not scene. A frozen preset naming `Math.random` makes every
  preset non-deterministic-by-default, fixed by a user only by accident.
- `color` -- appearance, not scene; presets describe MOTION, and pinning a colour
  in "heavy" would fight a themed overlay.
- `reducedMotion` -- LOAD-BEARING HAZARD. If a preset named `reducedMotion: false`,
  then `{ reducedMotion: true, ...SNOW_PRESETS.blizzard }` (preset spread LAST -- a
  spelling users write) would SILENTLY CANCEL THE ACCESSIBILITY FLAG. A preset
  must never be able to turn reduced motion off. No preset names it.

Digest preservation: every key added to flurry/heavy/blizzard is set to the value
the constructor default already supplies, USING THE SAME CONSTANT --
`gustFreq: GUST_FREQ_DEF`, `packDecay: PACK_DECAY_DEF`, `floorY: null`,
`spawnBand: null`, `spawnMargin: null`, `accumulate: false`. A hand-typed `2.0944`
for `gustFreq` is FORBIDDEN -- it would move the byte pattern without changing the
value.

### (e') `calm`'s knobs, and why calmness is measured this way

`calm`'s non-default MOTION values (candidate from the roadmap S7 pre-flight,
measured to produce `meanDX 0.0795 / meanDY 0.1988`):

    density: 4, wind: 8, gravity: 20, driftAmplitude: 4, baseRadius: 2.5,
    gust: 0, turbulence: 0

Every other key takes its constructor default, named with the same constant the
default uses. Calmness is proven by the PER-PARTICLE mean `|dx|` and `|dy|` per
frame over slots that stay in state 1 across the step (300 warm-up frames
discarded), which is monotonic (calm < flurry < heavy < blizzard on BOTH metrics)
and can both pass and fail.

The brief's two metrics were REJECTED, both measured on the untouched tree:

- x-extent is SATURATED -- flurry 1679.634, heavy 1679.687, blizzard 1679.924, all
  pinned to the +/-200 cull window (1280+400=1680), not to motion. It discriminates
  nothing.
- sumX variance is NON-MONOTONIC -- flurry 180114.9, heavy 163425.8, blizzard
  153752.9: the WINDIEST preset has the LOWEST variance (higher gravity drops
  flakes before they spread), so "calm < flurry" would be satisfied by blizzard too.

### (f) Freezing, and why no preset names a nested object

- `SNOW_PRESETS` frozen. All FOUR preset objects frozen, including every new key.
  The module-level `CALM` const frozen.
- NO NESTED MUTABLE VALUE in any preset. This is why every preset names
  `spawnBand: null` (the sentinel) rather than an object literal: a nested
  `{ min, max }` would need a deep freeze and `Object.isFrozen(preset)` would be a
  lie about its interior. Recorded as a decision, not an accident.
- A preset spread into TWO engines must not be mutable through either.
  Constructing `new SnowEngine(n, SNOW_PRESETS.heavy)` and
  `new SnowEngine(n, { ...SNOW_PRESETS.heavy, reducedMotion: true })` leaves
  `SNOW_PRESETS.heavy` byte-identical, because the override writes to `this.config`
  (a fresh object from the spread), never to the source. NAMED MUTATION: replacing
  the twelve assignments with `Object.assign(config, CALM)` mutates the caller's
  object and turns this red.

### (g) The throw-vs-coerce rule (AD-3), stated so it is not ad hoc

S7 adds knobs that COERCE (`spawnBand`, `spawnMargin`) while S6 added knobs that
THROW (`packResolution`, `maxPackWidth`, `maxPackHeight`). That is not
inconsistency; the reason is:

  **A parameter that SIZES AN ALLOCATION throws. A parameter that only shapes
  behaviour coerces to its default.**

`packResolution`/`maxPackWidth`/`maxPackHeight` determine a `Uint16Array` length
that can never be resized, so a bad value must fail loudly at construction.
`spawnBand`/`spawnMargin`/`floorY`/`friction`/`gust`/`drag` allocate nothing, so
they fail closed to the documented default. This is the principle every future
knob should be sorted by.

### (h) DOM-freedom is proven by RUNTIME, not by grep

The brief's grep assertion ("SnowEngine.js contains no `window`/`document`/...") is
VOID: `:201` contains "documented" and a comment contains "narrower window", so a
substring grep goes RED on the correct, DOM-free engine. Replaced by a RUNTIME
proof: in a child process, define every DOM global as a throwing getter, import
the engine, run 200 full `spawn` + `updateAndDraw` frames with `accumulate: true`
and `reducedMotion: true`, then `destroy()`. Zero globals touched, exit 0. This
proves absence of USE, not absence of a substring, and cannot be fooled by prose.
Reduced motion is an app-layer recipe (read `prefers-reduced-motion` in the app,
pass the flag) plus a config flag -- the engine does NO auto-detection, no
`matchMedia`, no module-level probe.

## Cost

None on the hot path. S7 adds no physics, no SoA column, no per-slot branch. The
only per-slot line touched in the entire package is `spawn()`'s `y[i]` line, which
reads two hoisted locals whose defaults are the literal `-50`/`50` constants, so
the machine arithmetic is unchanged. Both frame loops in `updateAndDraw` are
byte-identical to v1.3.0 (a `git diff` check, recorded in the CHANGELOG). The
constructor gains cold-path resolution only.

## Deferred / rejected

- No `landedCount` getter (above).
- No `settle` knob (above).
- No DOM access of any kind -- no `matchMedia`, no module-level
  `_prefersReducedMotion`, no auto-detection.
- No preset naming `rng`, `color`, or `reducedMotion` (above).
- No nested object in any preset -- `spawnBand` is the `null` sentinel (above).
- No T5-oracle extension with preset or reducedMotion logic -- it would be a
  tautology; the oracle's subtractive spawn form already matches the engine's, so
  it needs NO change.
