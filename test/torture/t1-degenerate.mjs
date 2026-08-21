/**
 * T1 -- degenerate values.
 *
 * S1 SCOPE: the five silent-corruption findings (SN-01..SN-05) are now FIXED by
 * the fail-closed door, so this tier PROMOTES their exact documented repros to
 * live, FATAL assertions -- the bug reproducing again fails the run. It then adds
 * the full degenerate-value matrix (roadmap section 3): dt / w / h / gravity /
 * wind / density each pinned to the door's documented policy, all via check().
 *
 * The remaining config oddities (driftFreq, meltTimeMax, baseRadius, a hostile
 * rng, a garbage color, maxParticles) are S2's findings (SN-07, SN-15, SN-16).
 * T1 DOCUMENTS them here with note() and asserts ONLY conservation + no overfill.
 * It does NOT add a fatal gate S1 has not earned -- do not promote these.
 */

import { SnowEngine } from '../../SnowEngine.js';
import {
    SEED, makeRng, check, note, makeMockCtx,
    occupancy, conservation, spawnBoundHolds, spawnCapNoWrap, SOA_NAMES,
} from './harness.mjs';

const DT_MAX = 0.1; // must mirror SnowEngine.js DT_MAX

function liveCount(e) {
    const state = e.state;
    let n = 0;
    for (let i = 0; i < e.max; i++) if (state[i] !== 0) n++;
    return n;
}

/** Snapshot the fourteen SoA columns + the clock. Test-only; allocates freely. */
function snapshot(e) {
    const s = { _t: e._elapsedTime };
    for (let n = 0; n < SOA_NAMES.length; n++) s[SOA_NAMES[n]] = e[SOA_NAMES[n]].slice();
    return s;
}

/** True iff every column and the clock are Object.is-identical to the snapshot. */
function unchanged(e, snap) {
    if (!Object.is(e._elapsedTime, snap._t)) return false;
    for (let n = 0; n < SOA_NAMES.length; n++) {
        const name = SOA_NAMES[n];
        const a = snap[name], b = e[name];
        for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    }
    return true;
}

/** True iff every live x/y is finite. Test-only. */
function allLiveFinite(e) {
    for (let i = 0; i < e.max; i++) {
        if (e.state[i] !== 0 && (!Number.isFinite(e.x[i]) || !Number.isFinite(e.y[i]))) return false;
    }
    return true;
}

export function run() {
    const ctx = makeMockCtx();

    // ====================================================================
    // Section 1 -- SN-01..SN-05 promoted to FATAL. The exact S0 repros.
    // ====================================================================

    // SN-01: a NaN dt neither advances the clock nor poisons the pool.
    {
        const e = new SnowEngine(200, { density: 100, rng: makeRng(SEED) });
        e.spawn(0.016, 800, 600);
        e.updateAndDraw(ctx, NaN, 800, 600);
        e.updateAndDraw(ctx, 0.016, 800, 600); // a good frame need not heal it
        check(Number.isFinite(e._elapsedTime),
            () => 'SN-01: updateAndDraw(ctx,NaN,..) left _elapsedTime non-finite');
        check(allLiveFinite(e),
            () => 'SN-01: a NaN dt poisoned a live particle');
    }

    // SN-02: degenerate w/h cannot overfill the pool.
    {
        const e = new SnowEngine(10000, { density: 100, rng: makeRng(SEED) });
        e.spawn(0.016, NaN, 600);
        check(occupancy(e).falling === 0,
            () => `SN-02: spawn(0.016,NaN,600) filled ${occupancy(e).falling} slots (want 0)`);
        e.spawn(0.016, 0, 600);
        check(occupancy(e).falling === 0,
            () => `SN-02: spawn(0.016,0,600) filled ${occupancy(e).falling} slots (want 0)`);
    }

    // SN-03: gravity 0 spawns finite x.
    {
        const e = new SnowEngine(10, { gravity: 0, density: 200, rng: makeRng(SEED) });
        e.spawn(1, 800, 600);
        let idx = -1;
        for (let i = 0; i < e.max; i++) { if (e.state[i] === 1) { idx = i; break; } }
        check(idx >= 0, () => 'SN-03: gravity 0 spawned nothing -- assertion would be vacuous');
        check(Number.isFinite(e.x[idx]) && e.x[idx] >= 0 && e.x[idx] <= 800,
            () => `SN-03: gravity 0 left x[${idx}]=${e.x[idx]} (want finite in [0,800])`);
    }

    // SN-04: a hand-poisoned NaN slot recycles in one frame.
    {
        const e = new SnowEngine(100, { density: 200, rng: makeRng(SEED) });
        e.spawn(0.016, 800, 600);
        let idx = -1;
        for (let i = 0; i < e.max; i++) { if (e.state[i] === 1) { idx = i; break; } }
        check(idx >= 0, () => 'SN-04: spawned nothing -- assertion would be vacuous');
        e.x[idx] = NaN; // hand-poison one live slot
        e.updateAndDraw(ctx, 0.016, 800, 600);
        check(e.state[idx] === 0,
            () => `SN-04: a NaN slot stayed state ${e.state[idx]} after one frame (want 0)`);
        check(conservation(e), () => 'SN-04: pool conservation broke after the cull');
    }

    // SN-05: negative dt is a total no-op.
    {
        const e = new SnowEngine(200, { density: 100, rng: makeRng(SEED) });
        e.spawn(0.016, 800, 600);
        e.updateAndDraw(ctx, 0.05, 800, 600); // advance to a non-trivial state
        const snap = snapshot(e);
        ctx.reset();
        e.updateAndDraw(ctx, -1, 800, 600);
        check(unchanged(e, snap),
            () => 'SN-05: a negative dt moved the pool or the clock');
        check(ctx.nFill === 0,
            () => `SN-05: a rejected frame drew ${ctx.nFill} fills (want 0)`);
    }

    // ====================================================================
    // Section 2 -- the degenerate dt / w / h / gravity / wind / density matrix.
    // ====================================================================

    // --- dt: clamp, run, and no-op policies ---------------------------------
    // Clamp: any dt above DT_MAX advances the clock by exactly DT_MAX.
    const clampDts = [0.1, 0.1000001, 1e9];
    for (let k = 0; k < clampDts.length; k++) {
        const e = new SnowEngine(50, { density: 20, rng: makeRng(SEED) });
        e.updateAndDraw(ctx, clampDts[k], 800, 600);
        check(e._elapsedTime === DT_MAX,
            () => `T1.dt: dt=${clampDts[k]} advanced clock to ${e._elapsedTime} (want ${DT_MAX})`);
    }
    // Run (no motion, still renders): dt 0 and -0 advance nothing but DRAW.
    const runDts = [0, -0, 1e-45];
    for (let k = 0; k < runDts.length; k++) {
        const e = new SnowEngine(200, { density: 200, rng: makeRng(SEED) });
        e.spawn(0.016, 800, 600);
        const before = e.x.slice();
        ctx.reset();
        const tBefore = e._elapsedTime;
        e.updateAndDraw(ctx, runDts[k], 800, 600);
        check(Number.isFinite(e._elapsedTime) && e._elapsedTime >= tBefore,
            () => `T1.dt: dt=${runDts[k]} moved the clock backwards or non-finite`);
        // dt=0/-0: no motion. 1e-45 underflows f32 add -> also no motion. Either
        // way the frame RENDERS (it is not rejected).
        check(ctx.nFill > 0,
            () => `T1.dt: dt=${runDts[k]} rendered nothing (a run frame must draw)`);
        let moved = false;
        for (let i = 0; i < e.max; i++) if (!Object.is(e.x[i], before[i])) moved = true;
        check(!moved || runDts[k] !== 0,
            () => `T1.dt: dt=0 moved a particle`);
    }
    // No-op: non-finite / negative / non-number dt leaves all fourteen arrays and
    // the clock byte-for-byte unchanged, and draws nothing.
    const noopDts = [-1, NaN, Infinity, -Infinity, undefined, null, '0.016'];
    for (let k = 0; k < noopDts.length; k++) {
        const e = new SnowEngine(200, { density: 200, rng: makeRng(SEED) });
        e.spawn(0.016, 800, 600);
        e.updateAndDraw(ctx, 0.02, 800, 600); // give it a non-trivial state first
        const snap = snapshot(e);
        ctx.reset();
        e.updateAndDraw(ctx, noopDts[k], 800, 600);
        check(unchanged(e, snap),
            () => `T1.dt: dt=${String(noopDts[k])} was not a no-op`);
        check(ctx.nFill === 0,
            () => `T1.dt: dt=${String(noopDts[k])} drew ${ctx.nFill} fills (want 0)`);
    }

    // --- w / h: run vs no-op door policy ------------------------------------
    const goodDims = [0.5, 1e9];
    for (let k = 0; k < goodDims.length; k++) {
        const e = new SnowEngine(50, { density: 20, rng: makeRng(SEED) });
        e.updateAndDraw(ctx, 0.016, goodDims[k], 600);
        check(e._elapsedTime === 0.016,
            () => `T1.w: w=${goodDims[k]} did not run (clock=${e._elapsedTime})`);
        const e2 = new SnowEngine(50, { density: 20, rng: makeRng(SEED) });
        e2.updateAndDraw(ctx, 0.016, 800, goodDims[k]);
        check(e2._elapsedTime === 0.016,
            () => `T1.h: h=${goodDims[k]} did not run (clock=${e2._elapsedTime})`);
    }
    const badDims = [0, -1, NaN, Infinity, undefined, null];
    for (let k = 0; k < badDims.length; k++) {
        const ew = new SnowEngine(200, { density: 200, rng: makeRng(SEED) });
        ew.spawn(0.016, 800, 600);
        const liveW = liveCount(ew);
        const snapW = snapshot(ew);
        ew.spawn(0.016, badDims[k], 600);
        ew.updateAndDraw(ctx, 0.016, badDims[k], 600);
        check(liveCount(ew) === liveW && unchanged(ew, snapW),
            () => `T1.w: w=${String(badDims[k])} was not a no-op (live ${liveW} -> ${liveCount(ew)})`);
        const eh = new SnowEngine(200, { density: 200, rng: makeRng(SEED) });
        eh.spawn(0.016, 800, 600);
        const liveH = liveCount(eh);
        const snapH = snapshot(eh);
        eh.spawn(0.016, 800, badDims[k]);
        eh.updateAndDraw(ctx, 0.016, 800, badDims[k]);
        check(liveCount(eh) === liveH && unchanged(eh, snapH),
            () => `T1.h: h=${String(badDims[k])} was not a no-op (live ${liveH} -> ${liveCount(eh)})`);
    }

    // --- gravity: spawned x must be finite in every case --------------------
    const gravities = [0, -1, NaN, Infinity];
    for (let k = 0; k < gravities.length; k++) {
        const e = new SnowEngine(10, { gravity: gravities[k], density: 200, rng: makeRng(SEED) });
        e.spawn(1, 800, 600);
        check(allLiveFinite(e),
            () => `T1.gravity: gravity=${String(gravities[k])} produced a non-finite particle`);
    }

    // --- wind: spawned x must be finite in every case -----------------------
    const winds = [0, -Infinity, NaN, 1e9];
    for (let k = 0; k < winds.length; k++) {
        const e = new SnowEngine(10, { wind: winds[k], density: 200, rng: makeRng(SEED) });
        e.spawn(1, 800, 600);
        check(allLiveFinite(e),
            () => `T1.wind: wind=${String(winds[k])} produced a non-finite particle`);
    }

    // --- density: cap|0 forbids overfill ------------------------------------
    const densities = [0, -1, NaN, Infinity];
    for (let k = 0; k < densities.length; k++) {
        const e = new SnowEngine(500, { density: densities[k], rng: makeRng(SEED) });
        check(spawnBoundHolds(e, 0.016, 800, 600),
            () => `T1.density: density=${String(densities[k])} overfilled the pool`);
    }

    // --- SN-32: an overflowing raw cap clamps to max, it does not wrap ------
    // area 1e7 x 5e6, density 10 -> raw = 3e10, which `| 0` would wrap to a
    // negative and spawn nothing. D7 clamps to min(raw, max), so the 64-slot
    // pool fills exactly. Fixed in S2 (was a note in S1's territory).
    {
        const e = new SnowEngine(64, { density: 10, rng: makeRng(SEED) });
        check(spawnCapNoWrap(e),
            () => `T1.SN-32: overflowing raw cap did not fill the 64-slot pool (live=${liveCount(e)})`);
    }

    // ====================================================================
    // Section 3 -- S2's findings (SN-07, SN-15, SN-16). DOCUMENTED, not fixed.
    // note() the observed answer; assert ONLY conservation + no overfill.
    // ====================================================================
    documentFinding('driftFreq', [NaN, Infinity], (v) => ({ driftFreq: v }));
    documentFinding('meltTimeMax', [0, NaN, 1.0], (v) => ({ meltTimeMin: 2.0, meltTimeMax: v }));
    documentFinding('baseRadius', [0, 0.1, -1, NaN], (v) => ({ baseRadius: v }));
    documentRng([0, 1, NaN, -1, 2, undefined]);
    documentColor([null, {}, 'garbage']);
    documentMaxParticles([0, 1, -1, 2.5, NaN, Infinity]);
}

/**
 * Build an engine with `cfgFactory(v)` for each `v`, spawn + update once, and
 * assert ONLY that the pool stays conserved and does not overfill. The observed
 * behaviour is recorded, not gated -- S2 owns the fix.
 */
function documentFinding(label, values, cfgFactory) {
    const ctx = makeMockCtx();
    for (let k = 0; k < values.length; k++) {
        const v = values[k];
        let e;
        try {
            e = new SnowEngine(100, { density: 100, rng: makeRng(SEED), ...cfgFactory(v) });
        } catch (err) {
            note(`T1.${label}=${String(v)} threw at construction: ${err && err.message} (S2 decided: throws)`);
            continue;
        }
        const held = spawnBoundHolds(e, 0.016, 800, 600);
        e.updateAndDraw(ctx, 0.016, 800, 600);
        check(conservation(e), () => `T1.${label}=${String(v)}: pool conservation broke`);
        check(held, () => `T1.${label}=${String(v)}: spawn overfilled the pool`);
        note(`T1.${label}=${String(v)}: conserved, live=${occupancyFalling(e)} (S2 finding)`);
    }
}

/** A hostile config.rng returning values outside [0,1). Conservation only. */
function documentRng(values) {
    const ctx = makeMockCtx();
    for (let k = 0; k < values.length; k++) {
        const v = values[k];
        const e = new SnowEngine(100, { density: 100, rng: () => v });
        const held = spawnBoundHolds(e, 0.016, 800, 600);
        e.updateAndDraw(ctx, 0.016, 800, 600);
        check(conservation(e), () => `T1.rng->${String(v)}: pool conservation broke`);
        check(held, () => `T1.rng->${String(v)}: spawn overfilled the pool`);
        note(`T1.rng->${String(v)}: conserved (S2 finding)`);
    }
}

/** A garbage color: record whether construction survives and stays conserved. */
function documentColor(values) {
    const ctx = makeMockCtx();
    for (let k = 0; k < values.length; k++) {
        const v = values[k];
        let e;
        try {
            e = new SnowEngine(100, { density: 100, color: v, rng: makeRng(SEED) });
        } catch (err) {
            note(`T1.color=${String(v)} threw at construction: ${err && err.message} (S2 finding)`);
            continue;
        }
        const held = spawnBoundHolds(e, 0.016, 800, 600);
        e.updateAndDraw(ctx, 0.016, 800, 600);
        check(conservation(e), () => `T1.color=${String(v)}: pool conservation broke`);
        check(held, () => `T1.color=${String(v)}: spawn overfilled the pool`);
        note(`T1.color=${String(v)}: colorStr=${String(e.colorStr)} (S2 finding)`);
    }
}

/**
 * maxParticles oddities. A fractional or NaN max desyncs `this.max` from the SoA
 * array length (SN-16), which the conservation checker cannot survive -- that IS
 * the finding. S1 has not earned a fix, so this records the observed conservation
 * and sizing via note() rather than a fatal gate.
 */
function documentMaxParticles(values) {
    for (let k = 0; k < values.length; k++) {
        const v = values[k];
        let e;
        try {
            e = new SnowEngine(v, { density: 100, rng: makeRng(SEED) });
        } catch (err) {
            note(`T1.maxParticles=${String(v)} threw at construction: ${err && err.message} (S2 decided: throws)`);
            continue;
        }
        e.spawn(0.016, 800, 600);
        const okConserved = conservation(e);
        note(`T1.maxParticles=${String(v)}: max=${String(e.max)} len=${e.state.length} conserved=${okConserved} (S2 finding)`);
    }
}

function occupancyFalling(e) {
    return occupancy(e).falling;
}
