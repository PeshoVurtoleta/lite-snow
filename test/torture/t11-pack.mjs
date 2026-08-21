/**
 * T11 -- S6 accumulation/friction pack tier.
 *
 * Sections, in order (plan task 12 / assertions A3-A17):
 *
 *   1. off-path digest      A1 restated + A3: weird-but-UNARMED pack knobs,
 *                            truthy (non-strict) accumulate, and a mid-run
 *                            accumulate=true flip must not move the default
 *                            ctx-sequence digest or the v1.1.1 SoA digest.
 *   2. pack digests          A10: a committed PACK_DIGEST for an accumulating
 *                            scenario, distinct from BASELINE_DIGEST and every
 *                            ARMED_DIGESTS entry, reproducible in-process and
 *                            cross-process, populating both falling+melting.
 *   3. conservation          A4: the exact-integer (a) identity, every frame,
 *                            over a 10000-frame armed run.
 *   4. cap                   A5: maxPackHeight never exceeded under 1e6+
 *                            landings on a single column.
 *   5. fill count             A6: exactly one extra fill() when the pack is
 *                            non-empty, at 200 AND 2000 columns, plus the
 *                            armed-but-EMPTY non-vacuity companion.
 *   6. resize churn           A7 + reviewer item 6: zero reallocation across
 *                            5000 resizes; the deferred-truncate path (a
 *                            resize seen only by updateAndDraw does NOT
 *                            touch the pack; the next spawn() truncates it
 *                            exactly); the never-spawn path (no self-heal
 *                            without a spawn() call).
 *   7. over-width             A16 + reviewer item 3: a canvas wider than
 *                            maxPackWidth degrades visibly, never reallocates,
 *                            and _packSkipped > 0 -- the domain guard actually
 *                            fires on a normal frame.
 *   8. throw matrix           A13/AD-2 (light mirror of the node:test matrix
 *                            in SnowEngine.test.js -- see the reviewer's
 *                            binding item 8 for the primary matrix location).
 *   9. alloc gate              A8: zero bytes/op with accumulate+friction+
 *                            gust+turbulence+drag ALL armed.
 *  10. retention              A9: tracker.size() returns to 0 over 4096
 *                            cycles with the pack live.
 *  11. friction               A15: friction is directional (vx drops, vy
 *                            unchanged) under an ARMED gust/turbulence/drag
 *                            scenario (reviewer's binding correction -- on
 *                            the plain positional-wind path vx stays 0 at
 *                            settle and the assertion is vacuously false).
 *
 * Per the S5 carry-forward and the reviewer's "Do NOT" list: the T5 oracle is
 * NOT extended with pack logic. The pack is pinned by committed digests,
 * exact-integer conservation, directional proofs and controls that must FAIL
 * when a guard is disabled (A11/A12 live in t9-controls.mjs, not here).
 *
 * @license MIT
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLeakTracker } from '@zakkster/lite-leak';
import { SnowEngine } from '../../SnowEngine.js';
import {
    SEED, makePrng, makeRng, check, die, note, makeMockCtx, CtxSeqRecorder,
    packConservation, runOpsGate, occupancy, SOA_NAMES,
} from './harness.mjs';
import {
    BASELINE, BASELINE_DIGEST,
    CTX_SEQ_DIGEST_DEFAULT, CTX_SEQ_COUNTS_DEFAULT,
    ARMED_DIGESTS, digestEngine,
} from './armed-scenario.mjs';

const SELF_PATH = fileURLToPath(import.meta.url);
const MELT_BINS = 8;

// ============================================================================
// The committed accumulating scenario (A10). Captured once on the shipped
// tree (SnowEngine.js as reviewed and approved for S6); regenerate ONLY by
// deliberate, documented re-derivation of the SCENARIO itself, never to make
// a failing assertion pass.
// ============================================================================

const PACK_SCENARIO = Object.freeze({
    MAX: 2000, SEED: 0x5EED1234, DT: 1 / 60, W: 1280, H: 720, FRAMES: 3000,
    CONFIG: Object.freeze({ gravity: 200, wind: 30, density: 10, accumulate: true }),
});

export const PACK_DIGEST = 'c6bee7006f951c98f56e924aa232b784bc3444d69dcd9afa43a8a9d03f817cec';
export const PACK_COUNTS = Object.freeze({ falling: 1380, melting: 617 });

function buildPackEngine() {
    return new SnowEngine(PACK_SCENARIO.MAX, { rng: makeRng(PACK_SCENARIO.SEED), ...PACK_SCENARIO.CONFIG });
}

function runPackScenario() {
    const e = buildPackEngine();
    const ctx = makeMockCtx();
    for (let f = 0; f < PACK_SCENARIO.FRAMES; f++) {
        e.spawn(PACK_SCENARIO.DT, PACK_SCENARIO.W, PACK_SCENARIO.H);
        e.updateAndDraw(ctx, PACK_SCENARIO.DT, PACK_SCENARIO.W, PACK_SCENARIO.H);
    }
    return e;
}

/** Distinct melt alpha bands + raw melter count, engine's own quantization. */
function meltBinsFor(e) {
    const invMeltMax = 1 / e.config.meltTimeMax;
    const seen = [0, 0, 0, 0, 0, 0, 0, 0];
    let used = 0, melt = 0;
    for (let i = 0; i < e.max; i++) {
        if (e.state[i] !== 2) continue;
        melt++;
        let b = (e.life[i] * invMeltMax * e.z[i] * MELT_BINS) | 0;
        if (b < 0) b = 0; else if (b >= MELT_BINS) b = MELT_BINS - 1;
        if (seen[b] === 0) { seen[b] = 1; used++; }
    }
    return { used, melt };
}

/** A seeded rng in [lo, hi) -- test-only, restricts x-landings to a known
 * sub-range for the fill-count non-vacuity companion. */
function makeRestrictedRng(seed, lo, hi) {
    const p = makePrng(seed);
    return () => lo + (p() / 4294967296) * (hi - lo);
}

// ============================================================================
// 1. off-path digest -- A1 restated + A3.
// ============================================================================

function sectionOffPath() {
    // Weird-but-UNARMED pack knobs must not be read at all (decisions/0003 (e)
    // -- validated and used ONLY when accumulate === true).
    const e1 = new SnowEngine(BASELINE.MAX, {
        rng: makeRng(BASELINE.SEED),
        accumulate: false, packResolution: 0, maxPackWidth: -1,
        maxPackHeight: 1e9, packDecay: -50,
    });
    const rec = new CtxSeqRecorder();
    for (let f = 0; f < BASELINE.FRAMES; f++) {
        e1.spawn(BASELINE.DT, BASELINE.W, BASELINE.H);
        e1.updateAndDraw(rec, BASELINE.DT, BASELINE.W, BASELINE.H);
    }
    const hex = rec.digest();
    check(hex === CTX_SEQ_DIGEST_DEFAULT,
        () => `T11.offPath: weird-but-unarmed pack knobs moved the ctx digest ${hex} != ${CTX_SEQ_DIGEST_DEFAULT}`);
    check(rec.nArc === CTX_SEQ_COUNTS_DEFAULT.arcs, () => `T11.offPath: arcs ${rec.nArc} != ${CTX_SEQ_COUNTS_DEFAULT.arcs}`);
    check(rec.nEllipse === CTX_SEQ_COUNTS_DEFAULT.ellipses, () => `T11.offPath: ellipses ${rec.nEllipse} != ${CTX_SEQ_COUNTS_DEFAULT.ellipses}`);
    check(rec.nFill === CTX_SEQ_COUNTS_DEFAULT.fills, () => `T11.offPath: fills ${rec.nFill} != ${CTX_SEQ_COUNTS_DEFAULT.fills}`);
    check(rec.nBeginPath === CTX_SEQ_COUNTS_DEFAULT.beginPaths, () => `T11.offPath: beginPaths ${rec.nBeginPath} != ${CTX_SEQ_COUNTS_DEFAULT.beginPaths}`);
    check(rec.nLineTo === 0, () => `T11.offPath: lineTo fired ${rec.nLineTo} times on an unarmed engine`);
    check(rec.nClosePath === 0, () => `T11.offPath: closePath fired ${rec.nClosePath} times on an unarmed engine`);
    check(e1.pack === null, () => 'T11.offPath: pack must be null when accumulate stays false');

    // accumulate arms strictly on === true -- a truthy-but-not-true value must
    // leave the v1.1.1 SoA digest unchanged too (cheaper witness than a full
    // ctx-sequence re-hash for this second and third case).
    function digestV111(extra) {
        const e = new SnowEngine(BASELINE.MAX, { rng: makeRng(BASELINE.SEED), ...extra });
        const ctx = makeMockCtx();
        for (let f = 0; f < BASELINE.FRAMES; f++) {
            e.spawn(BASELINE.DT, BASELINE.W, BASELINE.H);
            e.updateAndDraw(ctx, BASELINE.DT, BASELINE.W, BASELINE.H);
        }
        return { e, hex: digestEngine(e, ['x', 'y', 'z', 'gz', 'wz', 'bucket', 'radius', 'driftPhase', 'driftSpeed', 'driftAmp', 'life', 'state']) };
    }
    const { e: e2, hex: hex2 } = digestV111({ accumulate: 'yes' });
    check(hex2 === BASELINE_DIGEST, () => `T11.offPath: accumulate:'yes' (truthy, not strict true) moved the digest ${hex2}`);
    check(e2.pack === null, () => "T11.offPath: accumulate:'yes' must not arm the pack");

    // A3: a mid-run flip to accumulate:true is INERT.
    const e3 = new SnowEngine(BASELINE.MAX, { rng: makeRng(BASELINE.SEED) });
    const ctx3 = makeMockCtx();
    const half = BASELINE.FRAMES >> 1;
    for (let f = 0; f < half; f++) {
        e3.spawn(BASELINE.DT, BASELINE.W, BASELINE.H);
        e3.updateAndDraw(ctx3, BASELINE.DT, BASELINE.W, BASELINE.H);
    }
    e3.config.accumulate = true; // mid-run flip
    for (let f = half; f < BASELINE.FRAMES; f++) {
        e3.spawn(BASELINE.DT, BASELINE.W, BASELINE.H);
        e3.updateAndDraw(ctx3, BASELINE.DT, BASELINE.W, BASELINE.H);
    }
    const hex3 = digestEngine(e3, ['x', 'y', 'z', 'gz', 'wz', 'bucket', 'radius', 'driftPhase', 'driftSpeed', 'driftAmp', 'life', 'state']);
    check(hex3 === BASELINE_DIGEST,
        () => `T11.offPath: a mid-run accumulate=true flip moved the digest ${hex3} != ${BASELINE_DIGEST}`);
    check(e3.pack === null, () => 'T11.offPath: a mid-run accumulate=true flip must not allocate a pack');
}

// ============================================================================
// 2. pack digests -- A10.
// ============================================================================

function sectionPackDigests() {
    const e = runPackScenario();
    const hex = digestEngine(e, SOA_NAMES);
    check(hex === PACK_DIGEST, () => `T11.packDigest: digest ${hex} != committed ${PACK_DIGEST}`);
    check(e.fallingCount === PACK_COUNTS.falling, () => `T11.packDigest: fallingCount ${e.fallingCount} != ${PACK_COUNTS.falling}`);
    check(e.meltingCount === PACK_COUNTS.melting, () => `T11.packDigest: meltingCount ${e.meltingCount} != ${PACK_COUNTS.melting}`);
    check(e.fallingCount > 0 && e.meltingCount > 0,
        () => `T11.packDigest: scenario did not populate both state 1 and state 2 (falling=${e.fallingCount}, melting=${e.meltingCount})`);
    check(hex !== BASELINE_DIGEST, () => 'T11.packDigest: collapsed onto BASELINE_DIGEST -- the pack silently did not fire');
    for (const key of Object.keys(ARMED_DIGESTS)) {
        check(hex !== ARMED_DIGESTS[key], () => `T11.packDigest: collapsed onto ARMED_DIGESTS.${key}`);
    }

    // Reproducible IN-PROCESS: a second, independent run must match too.
    const hex2 = digestEngine(runPackScenario(), SOA_NAMES);
    check(hex2 === PACK_DIGEST, () => `T11.packDigest: second in-process run ${hex2} != committed ${PACK_DIGEST}`);

    // Reproducible ACROSS PROCESSES: this file's own standalone entry point.
    const out = execFileSync(process.execPath, [SELF_PATH, '--pack-digest'], { encoding: 'utf8' }).trim();
    check(out === PACK_DIGEST, () => `T11.packDigest: cross-process digest ${out} != committed ${PACK_DIGEST}`);
}

// ============================================================================
// 3. conservation -- A4.
// ============================================================================

function sectionConservation() {
    const e = new SnowEngine(2000, { rng: makeRng(0x5EED1234), gravity: 200, wind: 30, density: 10, accumulate: true });
    const ctx = makeMockCtx();
    const FRAMES = 10000, DT = 1 / 60, W = 1280, H = 720;
    for (let f = 0; f < FRAMES; f++) {
        e.spawn(DT, W, H);
        e.updateAndDraw(ctx, DT, W, H);
        const r = packConservation(e);
        check(r.ok, () => `T11.conservation: frame ${f} lhs=${r.lhs} != rhs=${r.rhs} ` +
            `(_packLanded=${e._packLanded} _packDecayed=${e._packDecayed} _packCapped=${e._packCapped} _packTruncated=${e._packTruncated})`);
    }
    check(e._packLanded > 0 && e._packDecayed > 0,
        () => `T11.conservation: ledger never moved (landed=${e._packLanded} decayed=${e._packDecayed}) -- vacuous`);
}

// ============================================================================
// 4. cap -- A5.
// ============================================================================

function sectionCap() {
    const MAXP = 200, W = 4, H = 10, DT = 0.02;
    const e = new SnowEngine(MAXP, {
        rng: makeRng(0xCA9CAF), accumulate: true, packResolution: 4, maxPackWidth: 4,
        maxPackHeight: 200, packDecay: 0,
        gravity: 1e6, wind: 0, density: 1e6,
        meltTimeMin: 0.001, meltTimeMax: 0.002,
    });
    const ctx = makeMockCtx();
    const FRAMES = 10600;
    let maxSeen = 0;
    for (let f = 0; f < FRAMES; f++) {
        e.spawn(DT, W, H);
        e.updateAndDraw(ctx, DT, W, H);
        const v = e.pack[0];
        if (v > maxSeen) maxSeen = v;
        check(v <= 200, () => `T11.cap: pack[0]=${v} exceeded maxPackHeight=200 at frame ${f}`);
    }
    check(e._packLanded >= 1e6, () => `T11.cap: only ${e._packLanded} landings driven, need >= 1e6`);
    check(e.pack[0] === 200, () => `T11.cap: pack[0]=${e.pack[0]} != 200 after ${e._packLanded} landings`);
    check(maxSeen === 200, () => `T11.cap: pack[0] never reached 200 (maxSeen=${maxSeen}) -- cap undertested`);
    check(e._packCapped > 0, () => 'T11.cap: _packCapped never moved -- the capped-landing accounting is untested');
}

// ============================================================================
// 5. fill count -- A6.
// ============================================================================

function fillCountNonEmpty(w, maxPackWidth, label) {
    const e = new SnowEngine(300, {
        rng: makeRng(0xF111C0), accumulate: true, packResolution: 4, maxPackWidth,
        gravity: 400, wind: 60, density: 80, meltTimeMin: 1.0, meltTimeMax: 2.0,
    });
    const ctx = makeMockCtx();
    for (let f = 0; f < 200; f++) { e.spawn(1 / 60, w, 600); e.updateAndDraw(ctx, 1 / 60, w, 600); }
    check(e._packActive > 0, () => `T11.fillCount[${label}]: pack never populated -- setup broken`);
    const ctxA = makeMockCtx();
    e.updateAndDraw(ctxA, 1 / 60, w, 600);
    const mb = meltBinsFor(e);
    check(ctxA.nFill === 3 + 1 + mb.used,
        () => `T11.fillCount[${label}]: nFill ${ctxA.nFill} != 3 + 1 + ${mb.used} melt bands`);
}

function fillCountEmptyPack() {
    // A restricted rng keeps every spawn x well outside the pack's tiny domain
    // ([0,4)) while still letting z/driftPhase/etc draw normally -- so this
    // engine is ARMED (accumulate:true) but its pack stays EMPTY by
    // construction, not by chance.
    const rng = makeRestrictedRng(0xABCDEE, 0.5, 0.999);
    const e = new SnowEngine(300, {
        rng, accumulate: true, packResolution: 4, maxPackWidth: 4, maxPackHeight: 200,
        gravity: 1e6, wind: 0, density: 200, meltTimeMin: 0.3, meltTimeMax: 0.6,
    });
    const ctx = makeMockCtx();
    for (let f = 0; f < 5; f++) { e.spawn(1 / 60, 800, 600); e.updateAndDraw(ctx, 1 / 60, 800, 600); }
    check(e._packActive === 0, () => 'T11.fillCount.empty: pack unexpectedly non-empty -- setup broken');
    const ctxA = makeMockCtx();
    e.updateAndDraw(ctxA, 1 / 60, 800, 600);
    const mb = meltBinsFor(e);
    check(mb.melt > 0, () => 'T11.fillCount.empty: no melt bands present -- non-vacuity broken (nothing to distinguish from "renders nothing")');
    check(e._packActive === 0, () => 'T11.fillCount.empty: pack became non-empty during the measured frame -- setup broken');
    check(ctxA.nFill === 3 + mb.used,
        () => `T11.fillCount.empty: nFill ${ctxA.nFill} != 3 + ${mb.used} (an armed-but-EMPTY pack must NOT add +1)`);
}

function sectionFillCount() {
    fillCountNonEmpty(800, 800, '200cols');
    fillCountNonEmpty(8000, 8000, '2000cols');
    fillCountEmptyPack();
}

// ============================================================================
// 6. resize churn -- A7 + reviewer item 6.
// ============================================================================

function sectionResizeChurn() {
    // A7: zero reallocation across 5000 resizes.
    const e = new SnowEngine(500, { rng: makeRng(0xC0FFEE), accumulate: true, gravity: 300, wind: 40, density: 80 });
    const ctx = makeMockCtx();
    const before = e.pack.buffer.byteLength;
    const dims = [[800, 600], [1920, 1080], [1, 1]];
    for (let i = 0; i < 5000; i++) {
        const d = dims[i % 3];
        e.spawn(1 / 60, d[0], d[1]);
        e.updateAndDraw(ctx, 1 / 60, d[0], d[1]);
        check(e.pack.buffer.byteLength === before,
            () => `T11.resize: pack byteLength changed at iter ${i} (${before} -> ${e.pack.buffer.byteLength})`);
    }

    // Reviewer item 6: an updateAndDraw-only resize does NOT truncate the
    // pack (the SN-08 check lives in spawn() only); the pack self-heals on
    // the NEXT spawn() that sees the new dims; without any spawn() at the new
    // dims, it never self-heals.
    const e2 = new SnowEngine(500, { rng: makeRng(0xDEAD10CC), accumulate: true, gravity: 5000, wind: 0, density: 200, packDecay: 0 });
    const ctx2 = makeMockCtx();
    for (let f = 0; f < 100; f++) { e2.spawn(1 / 60, 1280, 720); e2.updateAndDraw(ctx2, 1 / 60, 1280, 720); }
    let preSum = 0;
    for (let c = 0; c < e2._packCols; c++) preSum += e2.pack[c];
    check(preSum > 0, () => 'T11.resize.deferred: pack must be non-empty before the resize -- setup broken');

    for (let f = 0; f < 20; f++) {
        e2.spawn(1 / 60, 1280, 720); // spawn STILL sees the OLD dims
        e2.updateAndDraw(ctx2, 1 / 60, 640, 400); // updateAndDraw sees the NEW dims
    }
    let midSum = 0;
    for (let c = 0; c < e2._packCols; c++) midSum += e2.pack[c];
    check(midSum === preSum,
        () => `T11.resize.deferred: an updateAndDraw-only resize touched the pack (${preSum} -> ${midSum}) -- SN-08 truncate must live in spawn() only`);
    check(e2._packTruncated === 0, () => 'T11.resize.deferred: _packTruncated moved without spawn() ever seeing the new dims');

    // never-spawn path: keep driving updateAndDraw-only -- no self-heal ever.
    for (let f = 0; f < 500; f++) e2.updateAndDraw(ctx2, 1 / 60, 640, 400);
    check(e2._packTruncated === 0, () => 'T11.resize.neverSpawn: pack truncated without any spawn() call at the new dims');
    let stillSum = 0;
    for (let c = 0; c < e2._packCols; c++) stillSum += e2.pack[c];
    check(stillSum === preSum, () => `T11.resize.neverSpawn: pack changed (${preSum} -> ${stillSum}) with no spawn() ever seeing the new dims`);

    // now let spawn() see the new dims -- the deferred truncate fires exactly
    // once, booking the FULL pre-resize volume to _packTruncated.
    e2.spawn(1 / 60, 640, 400);
    let postSum = 0;
    for (let c = 0; c < e2._packCols; c++) postSum += e2.pack[c];
    check(postSum === 0, () => `T11.resize.selfHeal: pack did not truncate to 0 on the first spawn() at new dims (postSum=${postSum})`);
    check(e2._packTruncated === preSum,
        () => `T11.resize.selfHeal: _packTruncated ${e2._packTruncated} != pre-resize volume ${preSum}`);
    note(`T11.resize.selfHeal: measured ${preSum} packUnits deferred-truncated on the first ` +
        'spawn() to see the new dims (self-verifying against this run\'s own before/after sums, not a hardcoded constant)');
}

// ============================================================================
// 7. over-width -- A16 + reviewer item 3.
// ============================================================================

function sectionOverWidth() {
    const e = new SnowEngine(2000, {
        rng: makeRng(0x0FF5E7), accumulate: true, packResolution: 4, maxPackWidth: 400,
        maxPackHeight: 2000, packDecay: 0,
        gravity: 300, wind: 0, density: 300, meltTimeMin: 3.0, meltTimeMax: 4.0,
    });
    const W = 1600, H = 500, DT = 1 / 60;
    const ctx = makeMockCtx();
    const before = e.pack.buffer.byteLength;
    for (let f = 0; f < 400; f++) { e.spawn(DT, W, H); e.updateAndDraw(ctx, DT, W, H); }
    check(e.pack.buffer.byteLength === before, () => 'T11.overWidth: pack reallocated');
    check(e._packSkipped > 0, () => 'T11.overWidth: _packSkipped stayed 0 -- the over-width domain guard never fired (control setup broken)');
    let nonZero = 0;
    for (let c = 0; c < e._packCols; c++) if (e.pack[c] > 0) nonZero++;
    check(nonZero > 0, () => 'T11.overWidth: no column in [0, maxPackWidth) ever accumulated -- setup broken');
    // No spike at the edge column relative to its neighbours -- clamping
    // (rejected in decisions/0003 (d)) would pile every overhang flake onto
    // column nCols-1; SKIPPING must not.
    const edge = e._packCols - 1;
    const neighborAvg = (e.pack[edge - 1] + e.pack[edge - 2] + e.pack[edge - 3]) / 3;
    check(e.pack[edge] <= neighborAvg * 3 + 5,
        () => `T11.overWidth: edge column ${e.pack[edge]} spiked far above its neighbours' avg ${neighborAvg} -- looks clamped, not skipped`);
}

// ============================================================================
// 8. throw matrix -- A13/AD-2 (light mirror; primary matrix is the node:test
//    unit in SnowEngine.test.js per the reviewer's binding item 8).
// ============================================================================

function sectionThrowMatrix() {
    const cases = [
        ['packResolution', [0, -1, 2.5, NaN, 257]],
        ['maxPackWidth', [0, -1, 2.5, NaN, Infinity, null, '4096', 32768]],
        ['maxPackHeight', [0, -1, 2.5, NaN, Infinity, 65536, 1e9]],
    ];
    for (const [key, values] of cases) {
        for (const v of values) {
            let threw = false, msgOk = false, msg = '';
            try {
                // eslint-disable-next-line no-new
                new SnowEngine(4, { accumulate: true, [key]: v });
            } catch (err) {
                threw = err instanceof RangeError;
                msg = err && err.message || '';
                msgOk = threw && msg.includes(String(v));
            }
            check(threw, () => `T11.throwMatrix: ${key}=${String(v)} did not throw a RangeError`);
            check(msgOk, () => `T11.throwMatrix: ${key}=${String(v)} threw '${msg}' -- message omits the value`);
        }
    }
    try {
        // eslint-disable-next-line no-new
        new SnowEngine(4, { accumulate: true, packResolution: 4, maxPackWidth: 4096, maxPackHeight: 200 });
    } catch (err) {
        die('T11.throwMatrix: a valid pack config threw: ' + (err && err.message));
    }
}

// ============================================================================
// 9. alloc gate -- A8.
// ============================================================================

function sectionAllocGate() {
    const MAX = 2000, W = 800, H = 600, DT = 0.016;
    const e = new SnowEngine(MAX, {
        gravity: 400, wind: 60, density: 40,
        driftAmplitude: 15, driftFreq: 1.0,
        meltTimeMin: 0.5, meltTimeMax: 1.0,
        rng: makeRng(SEED),
        accumulate: true, friction: 0.5, gust: 300, turbulence: 200, drag: 0.9,
    });
    const ctx = makeMockCtx();

    function liveCount() {
        const state = e.state;
        let n = 0;
        for (let i = 0; i < e.max; i++) if (state[i] !== 0) n++;
        return n;
    }
    const target = Math.floor(0.95 * MAX);
    let guard = 0;
    while (liveCount() < target && guard < 1000) { e.spawn(0.1, W, H); guard++; }

    const bytesBefore = new Float64Array(SOA_NAMES.length);
    for (let n = 0; n < SOA_NAMES.length; n++) bytesBefore[n] = e[SOA_NAMES[n]].buffer.byteLength;
    const packBytesBefore = e.pack.buffer.byteLength;

    const hot = (i) => {
        e.spawn(DT, W, H);
        e.updateAndDraw(ctx, DT, W, H);
    };
    const { report, summary } = runOpsGate(hot, { ops: 20000, warmup: 2000 });

    for (let n = 0; n < SOA_NAMES.length; n++) {
        const name = SOA_NAMES[n];
        check(e[name].buffer.byteLength === bytesBefore[n],
            () => `T11.allocGate: ${name} backing store grew ${bytesBefore[n]} -> ${e[name].buffer.byteLength}`);
    }
    check(e.pack.buffer.byteLength === packBytesBefore,
        () => `T11.allocGate: pack backing store grew ${packBytesBefore} -> ${e.pack.buffer.byteLength}`);

    if (!report.ok) {
        const gc = summary.gc;
        die('T11.allocGate rejected -- verdict=' + report.verdict + ' source=' + summary.source +
            ' major=' + gc.major + ' maxMs=' + gc.maxMs.toFixed(3));
    }
}

// ============================================================================
// 10. retention -- A9.
// ============================================================================

function sectionRetention() {
    const CYCLES = 4096, MAXP = 256, W = 100, H = 100;
    const FILL_DT = 0.05, STEP_DT = 0.1, DRAIN_CAP = 500;
    const NOOP = function () {};

    const e = new SnowEngine(MAXP, {
        gravity: 2000, wind: 40, density: 40,
        driftAmplitude: 15, driftFreq: 1.0,
        meltTimeMin: 0.1, meltTimeMax: 0.2,
        rng: makeRng(SEED ^ 0xACC0FEED),
        accumulate: true, friction: 0.3,
    });
    const ctx = makeMockCtx();
    const tracker = createLeakTracker({ name: 'snow-pack-soak' });
    const target = Math.floor(0.6 * MAXP);

    function liveCount() {
        const state = e.state;
        let n = 0;
        for (let i = 0; i < e.max; i++) if (state[i] !== 0) n++;
        return n;
    }

    for (let c = 0; c < CYCLES; c++) {
        let guard = 0;
        while (liveCount() < target && guard < 1000) { e.spawn(FILL_DT, W, H); guard++; }

        const h = tracker.track({ cycle: c }, NOOP, c);

        if ((c & 1) === 0) {
            e.clear();
        } else {
            e.config.density = 0;
            let f = 0;
            while (liveCount() > 0 && f < DRAIN_CAP) { e.updateAndDraw(ctx, STEP_DT, W, H); f++; }
            e.config.density = 40;
        }
        tracker.untrack(h);

        check(liveCount() === 0, () => `T11.retention: cycle ${c} pool not empty after drain`);
        const occ = occupancy(e);
        check(occ.free === e.max, () => `T11.retention: cycle ${c} occupancy free=${occ.free} != max=${e.max}`);
    }

    check(tracker.size() === 0, () => `T11.retention: lite-leak tracker leaked ${tracker.size()} resources across ${CYCLES} cycles`);
    check(e.pack !== null, () => 'T11.retention: pack must still be armed at the end (control setup broken)');
}

// ============================================================================
// 11. friction -- A15 (reviewer's binding correction: gust/turbulence/drag
//     MUST be armed, or vx stays 0 at settle on the plain positional path and
//     the assertion is vacuously false for a CORRECT engine).
// ============================================================================

function sectionFriction() {
    const cfg = (friction) => ({
        rng: makeRng(0xF41C7104), gravity: 5000, wind: 120, density: 60,
        meltTimeMin: 2.0, meltTimeMax: 5.0,
        gust: 300, turbulence: 200, drag: 0.9, friction,
    });
    const FRICTION = 0.8;
    const off = new SnowEngine(1000, cfg(0));
    const on = new SnowEngine(1000, cfg(FRICTION));
    const ctxOff = makeMockCtx(), ctxOn = makeMockCtx();
    const W = 1280, H = 720, DT = 1 / 60;
    for (let f = 0; f < 400; f++) {
        off.spawn(DT, W, H); off.updateAndDraw(ctxOff, DT, W, H);
        on.spawn(DT, W, H); on.updateAndDraw(ctxOn, DT, W, H);
    }

    let n = 0, sumOff = 0, sumOn = 0, mismatchVy = 0, mismatchVxScale = 0;
    for (let i = 0; i < off.max; i++) {
        if (off.state[i] !== 2 || on.state[i] !== 2) continue;
        n++;
        sumOff += Math.abs(off.vx[i]);
        sumOn += Math.abs(on.vx[i]);
        if (!Object.is(off.vy[i], on.vy[i])) mismatchVy++;
        const expected = off.vx[i] * (1 - FRICTION);
        if (Math.abs(on.vx[i] - expected) > Math.abs(expected) * 1e-6 + 1e-9) mismatchVxScale++;
    }
    check(n >= 20, () => `T11.friction: only ${n} matching settled slots -- too few to mean anything`);
    const meanOff = sumOff / n, meanOn = sumOn / n;
    check(Number.isFinite(meanOff) && Number.isFinite(meanOn), () => 'T11.friction: non-finite mean|vx|');
    check(meanOn < meanOff, () => `T11.friction: mean|vx| did not drop under gust/turbulence/drag (off=${meanOff}, on=${meanOn})`);
    check(mismatchVy === 0, () => `T11.friction: vy diverged on ${mismatchVy}/${n} settled slots -- friction must be vx-only`);
    check(mismatchVxScale === 0, () => `T11.friction: vx did not scale by exactly (1-friction) on ${mismatchVxScale}/${n} slots`);
    note(`T11.friction: mean|vx| ${meanOff.toFixed(3)} -> ${meanOn.toFixed(3)} at friction=${FRICTION} ` +
        `(measured factor ${(meanOn / meanOff).toFixed(4)}, expected ${(1 - FRICTION).toFixed(4)}), n=${n}`);
}

export function run() {
    sectionOffPath();
    sectionPackDigests();
    sectionConservation();
    sectionCap();
    sectionFillCount();
    sectionResizeChurn();
    sectionOverWidth();
    sectionThrowMatrix();
    sectionAllocGate();
    sectionRetention();
    sectionFriction();
}

// --- standalone cross-process entry point -----------------------------------
// `node t11-pack.mjs --pack-digest` prints the sha256 digest for the
// committed accumulating scenario to stdout and nothing else. sectionPackDigests
// spawns this file as a SEPARATE OS process and diffs its stdout against the
// in-process digest (A10's cross-process reproducibility proof). Kept
// self-contained in this file rather than extending armed-scenario.mjs, which
// is outside this session's assigned file scope.
if (process.argv[1] && process.argv[1].endsWith('t11-pack.mjs')) {
    if (process.argv[2] === '--pack-digest') {
        process.stdout.write(digestEngine(runPackScenario(), SOA_NAMES) + '\n');
    }
}
