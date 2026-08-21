# 0002 -- Living air: gust, turbulence, drag on a positional base (SN-23, wind capability gap)

Status: accepted (S5, v1.2.0)
Date: 2026-08-21
Session: S5

## Context

Through v1.1.1 the entire force model is two constants and one per-particle
sine (`SnowEngine.js`, the `s === 1` arm of `updateAndDraw`):

    const sway = Math.sin(et * driftSpeed[i] + driftPhase[i]) * driftAmp[i];
    x[i] += (wz[i] + sway) * dt;
    y[i] += gz[i] * dt;

Every flake in a depth bucket falls at exactly the same speed forever and the
wind never changes. LiteConfetti closed the same gap at its v1.8.0 with `gust`
(a global time-varying horizontal acceleration), `turbulence` (a per-particle
rotating acceleration that reuses phases already seeded, drawing zero new rng),
and `drag` (damping toward a terminal velocity). S5 ports those three, exactly.

The port hits a load-bearing contradiction. The S5 brief asks for two things at
once:

  (a) with every new knob at its default, the SoA columns after N seeded frames
      are BIT-IDENTICAL to v1.1.1 -- the guards must be provably inert; and
  (b) `drag < 1` must lower the steady-state fall speed.

Today's integration is POSITIONAL, not integrated: `x += (wz[i] + sway) * dt`
re-derives the horizontal force every frame and there is no velocity state to
damp. A naive velocity port cannot satisfy both. A genuine `vx/vy` model that
accumulates (`vx += a*dt`) reproduces (a) only if the base term stays positional,
and satisfies (b) only if drag reaches the gravity term -- which the positional
base owns. Drag therefore cannot be a plain multiply over one unified velocity
without breaking byte-identity.

## Decisions

1. **The positional base stays EXACTLY as-is on the default path.** The two
   position-update statements above are executed unchanged whenever no force is
   armed. Byte-identity with v1.1.1 is then true BY CONSTRUCTION, not by
   measurement. The only rewrite to those lines is hoisting
   `const tp = et * driftSpeed[i] + driftPhase[i]` and writing sway as
   `Math.sin(tp) * driftAmp[i]` -- the same operands in the same order, so the
   default determinism hash does not move.

2. **`vx`/`vy` carry ONLY the perturbation on the default path.** Gust and
   turbulence accumulate into `vx`/`vy` and are added on top of the positional
   base. Both columns are zero by default and are zeroed on every spawn (a
   recycled ring slot must not inherit a dead flake's velocity), so an unarmed
   engine adds `+ vx[i]*dt` nowhere -- the perturbation apply is itself behind a
   `gust !== 0 || turbulence !== 0` guard and never runs unarmed.

3. **`drag !== 1` is a SEPARATE integration model, not the default times a
   damping factor.** When drag is armed, its guarded branch folds `gz[i]` and
   `wz[i] + sway` into `vy`/`vx` as accelerations, damps the velocity by `drag`,
   and integrates position from the velocity. Terminal velocity is
   `drag*g*dt/(1-drag)`, so a smaller `drag` yields a lower steady-state fall
   speed -- satisfying (b). Drag is off by default (`drag === 1`), so this branch
   never runs unarmed and never touches the default hash. We state the cost
   honestly: the drag-on hash is NOT the drag-off hash plus a factor; it is a
   different model. Because drag is a distinct integration path, its output
   cannot ride the v1.1.1 baseline digest -- it needs coverage in its own right.
   The proof obligation is therefore: the default/unarmed path is pinned by the
   frozen v1.1.1 baseline digest (`f2e3ccef...ef15`, taken over `SOA_NAMES_V111`
   in `test/torture/harness.mjs`), and each armed configuration -- gust-only,
   turbulence-only, both, and drag -- is pinned by its own committed digest in
   the torture suite, each proven distinct from the default and reproducible
   across processes. QA owns landing those armed digests and the per-guard
   controls; this record names the gate each must answer to. LANDED in S5:
   the five digests live in `test/torture/armed-scenario.mjs` (ARMED_DIGESTS)
   and are asserted distinct, count-checked and re-derived in a separate OS
   process by `test/torture/t10-armed.mjs`; the per-guard controls are in
   `test/torture/t9-controls.mjs`.

4. **Every new knob coerces non-finite to its DEFAULT at the door, once per
   construction.** `gust` -> 0, `gustFreq` -> TAU/3, `turbulence` -> 0,
   `drag` -> 1 (off). Fail closed: null is not zero -- a null lands on the
   default, never on 0. Each knob is read once into a hoisted local above the
   frame loop; the three armed blocks are guarded by `gust !== 0`,
   `turbulence !== 0` and `drag !== 1` on those locals, so an unarmed engine
   pays only the branch bytes, not the work.

5. **Turbulence reuses `tp`; it computes sin and cos of the SAME argument.**
   `Math.cos(tp)` drives `vx`, `Math.sin(tp)` drives `vy`, where `tp` is the one
   value already computed for sway. Computing sin/cos of the same value twice is
   exactly the byte-in-a-hot-body the house law forbids, so `tp` is computed once
   and used twice. Turbulence draws zero new rng and adds zero new phase column;
   it rides `driftPhase[i]` and `driftSpeed[i]`, already seeded and advanced.

6. **An ACCEL_MAX component clamp bounds velocity growth to linear.** Every
   acceleration component fed into `vx`/`vy` is clamped to `[-ACCEL_MAX,
   ACCEL_MAX]` before integration, so for ANY finite input velocity grows at most
   linearly and positions stay finite over any finite run. This is the
   fail-closed force cap (LiteConfetti's `VORTEX_MAX_ACCEL` pattern) that earns
   its place under `gust: 1e9 + turbulence: 1e9 + drag: 0` abuse.

7. **Cost: +2 SoA columns, +8 B/particle.** The layout grows from 12 columns to
   14 (both new columns `Float32Array`), from 58 to 66 bytes/particle: +8 B, or
   +80 KB at the default max of 10000. Additive under the layout contract (law 1);
   recorded in `llms.txt`, `SnowEngine.d.ts` and the README allocation table, and
   in `destroy()`'s null list.

## Deferred

- **Vortex / attractor (a point force with a center).** Deferred, not rejected.
  Confetti's vortex has a natural center: the burst origin every piece was thrown
  from. Snow has no burst origin -- flakes spawn along the whole top edge and fall
  independently, so a point force has no natural center to anchor to. Adding one
  would mean inventing a center the model does not otherwise have, which is a
  design question, not a port. It waits until there is a real use for it.
