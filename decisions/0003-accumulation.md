# 0003 -- Accumulation and friction: a persistent Uint16 heightmap flakes land on (SN, brief "accumulation / friction")

Status: accepted (S6, v1.3.0)
Date: 2026-08-21
Session: S6

## Context

Through v1.2.0 a settled flake (`state === 2`) is drawn as a flat melt ellipse
and ages out; it leaves no lasting mark on the canvas. The S6 brief asks for
`accumulate`: snow that piles up. The naive reading -- a float heightmap with a
fractional per-frame decay and a `maxPackHeight` cap "conserved to within f32
rounding" -- cannot hold: on an integer column a slow fractional decay truncates
to zero (decay never happens) and a landing on a capped column adds nothing
(volume drifts below `landed - decayed`). This record resolves that and the five
other contradictions the pre-flight named, BEFORE the code.

## Decisions

### (a) The heightmap is an EXACT integer ledger, not an f32 identity

`pack` is a `Uint16Array` of columns in units of one `packUnit`. A landing adds
exactly `PACK_GAIN` (integer, default 1). Decay is integer-stepped through an
accumulator (`_packDecayAcc += packDecay * dt`); the integer part is drained each
frame. Every term is an integer, so the invariant is EXACT -- no epsilon:

    packSum === _packLanded * PACK_GAIN - _packDecayed - _packCapped - _packTruncated

- `_packLanded` counts only landings whose column passed the (d) domain filter.
- `_packCapped` accumulates, per capped landing, `prev + PACK_GAIN - maxPackHeight`.
- `_packDecayed` accumulates the ACTUAL decrement summed over columns each tick.
- `_packTruncated` accumulates the exact volume zeroed by the SN-08 resize policy.
- `_packSkipped` counts out-of-domain landings (excluded from `_packLanded`).

The brief's "to within f32 rounding" is VOID -- written for a float heightmap it
would have made a flaky test. An exact integer invariant fails loudly and cannot
be tuned into passing.

### (b) No new state and no new column -- reuse state 2, redefined as "settled"

When `accumulate: true`, a flake reaching the pack surface still goes
`state 1 -> 2` and still gets `life[i] = meltTimeMin + rng()*meltRange`. It does
NOT keep falling and ages out exactly as today -- precisely Confetti's `landed`
contract (frozen but keeps aging, so the slot recycles). Snow already has that in
state 2; a third state would duplicate it and cost bytes in the hot body for no
behavioural difference. The pack height is raised ONCE, at the `1 -> 2`
transition, not per frame -- so the flake's contribution outlives its slot, which
is what makes `tracker.size()` able to return to 0.

The melt ellipse is STILL DRAWN, unchanged, ON TOP of the pack. The pack is an
ADDITIONAL fill emitted BEFORE the melt bands (melting flakes render over the
pile). Draw-call contract: `3 + [1 if pack non-empty] + up to 8`. `landedCount`
is NOT a new getter in S6 -- `meltingCount` answers it. Recorded so S7 does not
add a redundant one.

### (c) `floorY` sentinel: `null` means "track the per-frame h"

`floorY` defaults to `null`; `null` is the ONLY value meaning "track `h`".
Everything else coerces fail-closed: `Number.isFinite(floorY) ? floorY : null`,
so `NaN`, `Infinity`, `undefined`, `'400'`, `{}` all land on `null` = track `h` =
today's exact behaviour. `const fy = floorCfg === null ? h : floorCfg` is one
comparison per FRAME, zero per flake. A finite `floorY` is used RAW, not clamped
to `h`: an overlay HUD bar is the stated use case, and a `floorY` outside
`[0, h]` is legal and documented, not an error.

### (d) Column-index domain: fail closed by SKIPPING, never by clamping

`const c = Math.floor(x[i] * invPackRes); if (c >= 0 && c < nCols) { ...pack... }`.
An out-of-range `x` (spawn overhang puts `x` at `-windOffset`; wind puts it past
`w`) settles normally at `fy` and raises NO column, incrementing `_packSkipped`.
NOT clamped to an edge column -- clamping would pile every overhang flake onto the
two edge columns and build a false wall, a visible artifact that also corrupts
(a). `Math.floor`, not `| 0`: `|0` truncates toward zero, so `x` in `(-1, 0)`
would map to column 0; `Math.floor(-0.5) === -1` is correctly rejected.

### (e) `accumulate` is construction-time only; a runtime flip is INERT

`this._packOn = config.accumulate === true` (strict `true` -- `'yes'`/`1`/`{}` do
not arm it). When false, `this.pack === null` and every pack field is null/0. The
frame loop reads the CONSTRUCTION-time `this._packOn`, never `config.accumulate`.
Setting `engine.config.accumulate = true` after construction does nothing -- no
allocation, no behaviour change, no throw. Setting it `false` on an armed engine
is likewise inert. Both directions inert; no half-state. This is the only policy
that keeps "allocates nothing after construction, no asterisk" literally true.

### maxPackWidth over-width policy: accept the brief's recommendation

`maxPackWidth` default 4096 px; at `packResolution` 4 that is `nCols = 1024`.
Validated at construction (ONLY when armed): `packResolution` integer in
`[1, 256]`, `maxPackWidth` integer in `[packResolution, 16384]`, `maxPackHeight`
integer in `[1, 65535]` (AD-2). Violations throw `RangeError` naming the value
(SN-15 precedent). `nCols = Math.floor(maxPackWidth / packResolution)`. A canvas
wider than `maxPackWidth` accumulates ONLY across the first `maxPackWidth` px;
beyond that `c >= nCols` and the (d) skip fires. Degrades VISIBLY (a pile that
stops at a hard edge) rather than silently reallocating. Grow-on-resize is
REJECTED: it would put one allocation on a path a user reaches by dragging a
window.

### SN-08 resize policy: TRUNCATE, do not rescale

On a `w`/`h` change the pack is zeroed (`pack.fill(0)`) and the zeroed volume is
added to `_packTruncated`. This runs on the path that already recomputes
`_areaModifier` (in `spawn()`), so it is one `fill(0)` on an existing cold hook.
Rescaling would need a second pass and an interpolation whose conservation term is
not exactly integral -- breaking (a). "The drift is lost when the window resizes"
is honest and documentable. Truncation is exact.

### The decay loop covers the FULL raise domain (all nCols), NOT particle count

The per-frame decay runs over all `nCols` columns -- a FIXED bound (1024 at
defaults), NOT over the particle pool. A loop over 10000 particles to melt 1024
columns is the obvious wrong implementation: it would make decay cost scale with
occupancy for no reason.

REJECTED (and it shipped as a bug in the first coder pass -- recorded so it is not
re-attempted): bounding decay to the VISIBLE window `min(nCols, ceil(w *
invPackRes))`. The settle branch raises ANY column in `[0, nCols)` -- off-screen
culling admits `x` out to `w + 200`, so at defaults (w 1280, packRes 4) landings
reach column ~370, past a visible bound of 320. A visible-only decay therefore
leaves columns in `[visible, nCols)` WRITE-ONLY: raised forever, never decayed --
a permanent pile that stopping the snow never melts. That is a fail-open. The
decay domain MUST equal the raise domain. All `nCols` is the smallest fixed bound
that does, and it is independent of `w`, so it is resize-stable (a visible bound
whose edge moved with the canvas would reintroduce the same class of bug on the
next resize).

CRITICAL LESSON: the exact-integer conservation identity (a) DID NOT catch this.
`_packDecayed` counts only what the decay loop actually decremented, so the ledger
stayed exact while the pile was permanent. The identity proves BOOKKEEPING (no
volume is invented or lost in the accounting), NOT PHYSICS (that decay reaches
every raised column). The physics claim is proven separately by
`packMeltsToZero`: fill a pack, drain every live flake, run with no spawn, and
require `packSum` to reach 0. It is RED on the visible-bound engine
(`packSum` plateaus above 0) and GREEN on the full-nCols engine.

### AD-1: multi-tick decay drains the WHOLE integer part in one pass

With `packDecay * dt > 1` a single-tick-per-frame accumulator would grow without
bound and the decay would silently lag forever -- a fail-open. Resolution: each
frame `_packDecayAcc += packDecay * dt`, then `ticks = Math.floor(_packDecayAcc)`
is drained in one pass (`_packDecayAcc -= ticks`), and each non-zero column loses
`min(ticks, pack[c])` -- the ACTUAL decrement, summed into `_packDecayed`, NOT an
assumed `ticks` per column (a nearly-empty column loses only what it has). (a)
therefore stays exact for ANY `packDecay`.

REJECTED alternative: clamp `packDecay` at construction so `packDecay * DT_MAX <=
1` (i.e. `packDecay <= 10`). Rejected because it caps a user-facing knob at an
arbitrary ceiling to work around an implementation shortcut; the drain-all pass
imposes no such ceiling and is the same bounded per-frame cost.

### AD-2: maxPackHeight is validated

`maxPackHeight` is the bound on a `Uint16` cell. An unvalidated `1e9`, `NaN`, `0`
or `-1` would either disable the cap or wrap the column past 65535 back to 0 --
the silent collapse the cap exists to prevent. It is validated in the same throw
block: integer, `>= 1`, `<= 65535`, `RangeError` naming the value.

### AD-3: packDecay and friction poison rows; negative packDecay coerces to 0

`packDecay` fails closed to its DEFAULT (2.0) on any non-finite value (`null`
included -- a null `packDecay` must NOT silently mean "never decay", which is a
different engine). A NEGATIVE `packDecay` -- a pack that would GROW from nothing --
COERCES TO 0 (no decay) rather than throwing: 0 is the safe, inert reading of "do
not remove volume", and a negative decay adding to columns would corrupt (a).
`friction` coerces non-finite to 0, clamps `< 0 -> 0` (never anti-friction, which
would AMPLIFY `vx`) and `> 1 -> 1`. `floorY` coerces non-finite to `null`.

## `settle` REJECTED; `friction` shipped

`settle` (a rest-velocity threshold) is REJECTED for S6. Snow has no bounce and no
rebound `vy` -- Confetti's settle test reads the POST-BOUNCE `|vy|`, which snow
does not have; a snow flake settles on first contact unconditionally. A `settle`
knob would be a threshold on a value that is always the terminal fall speed: a
global on/off dressed as a threshold.

`friction` IS shipped (`friction: 0` default). On the CONTACT FRAME only (the
`1 -> 2` transition) `vx[i] *= 1 - friction`, guarded by a hoisted `fricOn` flag,
clamped to `[0, 1]`. A CONTRACTION, so it needs no accel cap and finiteness is
free. It fires exactly once per flake lifetime -- which is why it needs S5's `vx`
column and costs nothing unarmed. Directional (damps `vx`, never `vy`).

## Cost

`pack` is a SEPARATE fixed cost, NOT per-particle: one `Uint16Array(nCols)`,
`nCols = maxPackWidth / packResolution` (default 1024 -> 2 KB), allocated ONCE and
only when `accumulate: true`. The 66 B/particle SoA layout is unchanged; the pack
does not grow it. `destroy()` nulls `this.pack`.

## Deferred / rejected

- No wind interaction with the pack (drifting snowdrifts). Parked.
- No `settle` knob (above).
- No 3D pack, no sprite flakes, no per-column colour or shading.
- No pack rescale on resize -- truncate-and-document (above).
- No grow-on-resize heightmap -- rejected (above).
- No `landedCount` getter -- `meltingCount` answers it under (b).
