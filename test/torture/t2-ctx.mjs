/**
 * T2 -- the canvas-state contract (snow's aliasing matrix).
 *
 * S2 rows only (SN-06 fill-pairing is S3). The fixture is deliberately narrow:
 * three depth buckets populated, ZERO melting slots -- the state one frame right
 * after a spawn. Against it the tier pins the render section's contract with the
 * canvas:
 *
 *   1. globalAlpha is 1.0 on a normal return (the finally always runs).
 *   2. globalAlpha is 1.0 even when a draw call throws mid-render: the engine
 *      restores alpha in a finally and RETHROWS (SN-10). The tier catches it.
 *   3. fillStyle is written exactly once per frame.
 *   4. globalAlpha writes = 3 buckets + 0 melters + 1 finally = 4. This is the
 *      row that catches leaving BOTH the bare pre-S2 write and the finally (5).
 *   5. the next good frame writes the bucket alphas 0.24, 0.44, 0.72 in order.
 *   6. the engine never calls clearRect / save / restore / setTransform / scale.
 */

import { SnowEngine } from '../../SnowEngine.js';
import { SEED, makeRng, check, makeMockCtx, MockCtx, ThrowingCtx } from './harness.mjs';

const W = 800;
const H = 600;
const DT = 0.016;

/** A MockCtx that records the ORDER of globalAlpha writes. Test-only. */
class RecordingCtx extends MockCtx {
    constructor() {
        super();
        this.alphaSeq = [];
    }
    get globalAlpha() { return this._globalAlpha; }
    set globalAlpha(v) { this.alphaSeq.push(v); this._globalAlpha = v; this.nGlobalAlpha++; }
}

/** A fresh engine spawned once: three buckets populated, zero melting. */
function makeFixture() {
    const e = new SnowEngine(300, {
        gravity: 40, wind: 0, density: 300,
        driftAmplitude: 15, driftFreq: 1.0,
        meltTimeMin: 2.0, meltTimeMax: 5.0,
        rng: makeRng(SEED),
    });
    e.spawn(DT, W, H);
    return e;
}

function bucketCounts(e) {
    const c = [0, 0, 0];
    for (let i = 0; i < e.max; i++) if (e.state[i] === 1) c[e.bucket[i]]++;
    return c;
}
function meltingCount(e) {
    let n = 0;
    for (let i = 0; i < e.max; i++) if (e.state[i] === 2) n++;
    return n;
}

/**
 * The distinct melt alpha bands (and raw melter count) a render pass would see
 * for the CURRENT pool state. Uses the engine's own quantization so the S3
 * fill-count contract (fill count === 3 buckets + populated melt bands) is
 * checked against the same rule the engine renders by. O(max) -- test only.
 */
function meltBins(e) {
    const invMeltMax = 1 / e.config.meltTimeMax;
    const seen = [0, 0, 0, 0, 0, 0, 0, 0];
    let used = 0, melt = 0;
    for (let i = 0; i < e.max; i++) {
        if (e.state[i] !== 2) continue;
        melt++;
        let b = (e.life[i] * invMeltMax * e.z[i] * 8) | 0;
        if (b < 0) b = 0; else if (b > 7) b = 7;
        if (seen[b] === 0) { seen[b] = 1; used++; }
    }
    return { used, melt };
}

/**
 * The per-band occupancy a correct render sees for the CURRENT pool: p[b] is 1
 * iff some melter quantizes into band b. The engine's _meltAlphaCount must equal
 * this after EVERY frame -- it is zeroed each frame and re-set only for bands a
 * current melter lands in. A dropped per-band reset leaves a stuck flag, which
 * costs a phantom empty beginPath/fill on a later frame -- invisible to the
 * single-frame fill-count row, which never drives a band from populated to
 * empty. Uses the engine's own quantization. O(max) -- test only.
 */
function bandPresence(e) {
    const invMeltMax = 1 / e.config.meltTimeMax;
    const p = [0, 0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < e.max; i++) {
        if (e.state[i] !== 2) continue;
        let b = (e.life[i] * invMeltMax * e.z[i] * 8) | 0;
        if (b < 0) b = 0; else if (b > 7) b = 7;
        p[b] = 1;
    }
    return p;
}

function approxEq(a, b) { return Math.abs(a - b) < 1e-9; }

export function run() {
    // Fixture sanity: three buckets populated, zero melting. A row against an
    // empty bucket or a stray melter would be vacuous.
    const probe = makeFixture();
    const pc = bucketCounts(probe);
    check(pc[0] > 0 && pc[1] > 0 && pc[2] > 0,
        () => `T2 fixture: not all three buckets populated -- [${pc[0]},${pc[1]},${pc[2]}]`);
    check(meltingCount(probe) === 0,
        () => `T2 fixture: ${meltingCount(probe)} melting slots (want 0)`);

    // Rows 1, 3, 4, 6 -- one normal frame against a plain MockCtx.
    {
        const e = makeFixture();
        const ctx = makeMockCtx();
        e.updateAndDraw(ctx, DT, W, H);
        check(ctx.globalAlpha === 1.0,
            () => `T2 row 1: globalAlpha ${ctx.globalAlpha} on normal return (want 1.0)`);
        check(ctx.nFillStyle === 1,
            () => `T2 row 3: fillStyle written ${ctx.nFillStyle} times (want 1)`);
        check(ctx.nGlobalAlpha === 4,
            () => `T2 row 4: globalAlpha written ${ctx.nGlobalAlpha} times (want 4 = 3 buckets + 0 melters + 1 finally)`);
        check(ctx.nClearRect === 0 && ctx.nSave === 0 && ctx.nRestore === 0 &&
              ctx.nSetTransform === 0 && ctx.nScale === 0,
            () => `T2 row 6: forbidden call made -- clearRect=${ctx.nClearRect} save=${ctx.nSave} restore=${ctx.nRestore} setTransform=${ctx.nSetTransform} scale=${ctx.nScale}`);
        // S3 fill-count contract on a zero-melt frame: exactly 3 depth-bucket
        // fills and no melt-band fill. The bucket fills are unconditional (an
        // empty bucket still opens and closes its path), so this is 3 even when
        // a bucket is empty -- but the fixture has all three populated.
        const mb0 = meltBins(e);
        check(mb0.melt === 0,
            () => `T2 fill-count: fixture is not zero-melt (${mb0.melt} melters)`);
        check(ctx.nFill === 3,
            () => `T2 fill-count: ${ctx.nFill} fills on a zero-melt frame (want 3 = 3 buckets + 0 melt bands)`);
        // Draw-COMPLETENESS, not just fill-count. The bucket fills are
        // unconditional, so nFill cannot see a dropped bin push -- an unpushed
        // bucket renders zero arcs but still opens and closes its path. Count the
        // PRIMITIVES: every falling flake must emit exactly one arc(), none an
        // ellipse(). A dropped push in ANY bucket shows here as an arc shortfall.
        const fc = bucketCounts(e);
        check(ctx.nArc === fc[0] + fc[1] + fc[2],
            () => `T2 draw-completeness: ${ctx.nArc} arc() calls != ${fc[0] + fc[1] + fc[2]} falling flakes -- a bucket push was dropped`);
        check(ctx.nEllipse === 0,
            () => `T2 draw-completeness: ${ctx.nEllipse} ellipse() calls on a zero-melt frame (want 0)`);
    }

    // S3 fill-count contract on a MELT scene: fill count is EXACTLY
    // 3 + meltBinsUsed and never exceeds 3 + 8. This is the assertion the pre-S3
    // one-fill-per-melter render fails (T9 control 5 proves both directions). We
    // force many melters so the batch actually collapses a large population into
    // <= 8 bands -- otherwise the bound would be vacuous.
    {
        const e = new SnowEngine(300, {
            gravity: 8000, wind: 0, density: 300,
            meltTimeMin: 4.0, meltTimeMax: 8.0, // long life -> melters persist
            rng: makeRng(SEED ^ 0x13572468),
        });
        for (let f = 0; f < 12; f++) { e.spawn(DT, W, H); e.updateAndDraw(makeMockCtx(), DT, W, H); }
        const ctx = makeMockCtx();
        e.updateAndDraw(ctx, DT, W, H);
        const mb = meltBins(e);
        check(mb.melt > 8,
            () => `T2 melt fill-count: only ${mb.melt} melters -- batch bound would be vacuous`);
        check(ctx.nFill === 3 + mb.used,
            () => `T2 melt fill-count: ${ctx.nFill} fills != 3 + ${mb.used} melt bands (${mb.melt} melters batched)`);
        check(ctx.nFill <= 3 + 8,
            () => `T2 melt fill-count: ${ctx.nFill} fills exceeds the 3 + 8 ceiling`);
        // Draw-completeness on a MELT scene: every falling flake one arc(), every
        // melter one ellipse(). Batching collapses the FILLS to <= 8 bands, but the
        // primitive count still equals the live population -- a dropped bucket or
        // melt push shows as a shortfall the fill-count row cannot.
        const fcm = bucketCounts(e);
        check(ctx.nArc === fcm[0] + fcm[1] + fcm[2],
            () => `T2 draw-completeness: ${ctx.nArc} arc() calls != ${fcm[0] + fcm[1] + fcm[2]} falling flakes`);
        check(ctx.nEllipse === mb.melt,
            () => `T2 draw-completeness: ${ctx.nEllipse} ellipse() calls != ${mb.melt} melters`);
    }

    // SN-06 per-band reset. _meltAlphaCount must reflect ONLY the current frame's
    // occupied bands. A dropped per-band reset survives the single-frame fill-count
    // row because that row never drives a band from populated to empty -- so drive
    // exactly that: settle a high-z population into the top band, then let life
    // decay so those melters fall to a lower band and the top band vacates. The
    // band flags must follow a fresh recount every frame; a stuck flag is caught
    // the first frame its band is recomputed empty.
    {
        const DRAIN_DT = 0.05;
        const e = new SnowEngine(400, {
            gravity: 80000, wind: 0, density: 400,
            // range 0 -> life == meltTimeMax at settle, so alpha == z: high-z
            // flakes land in the top bands and then descend as life decays.
            meltTimeMin: 5.0, meltTimeMax: 5.0,
            rng: makeRng(SEED ^ 0x0badf00d),
        });
        e.spawn(DT, W, H);
        // Settle the pool -- a few frames carry every depth from the spawn line
        // (y ~ -100) past the floor (h). No re-spawn: the melt population only ages.
        for (let f = 0; f < 4; f++) e.updateAndDraw(makeMockCtx(), DT, W, H);

        // Non-vacuity: the top band must actually be occupied now, else a dropped
        // top-band reset could never be exercised by this fixture.
        const p0 = bandPresence(e);
        check(p0[7] === 1,
            () => `T2 band-reset: top band unoccupied after settle -- fixture is vacuous (bands ${p0.join('')})`);

        let sawVacate = false;
        for (let f = 0; f < 60 && e.meltingCount > 0; f++) {
            e.updateAndDraw(makeMockCtx(), DRAIN_DT, W, H);
            const want = bandPresence(e);
            if (want[7] === 0) sawVacate = true;
            for (let b = 0; b < 8; b++) {
                check(e._meltAlphaCount[b] === want[b],
                    () => `T2 band-reset: _meltAlphaCount[${b}]=${e._meltAlphaCount[b]} != recount ${want[b]} at drain frame ${f} (want bands ${want.join('')})`);
            }
        }
        check(sawVacate,
            () => `T2 band-reset: band 7 never vacated across the drain -- stuck-flag path unexercised`);
    }

    // Row 2 -- a draw call throws mid-render; alpha is restored and rethrown.
    {
        const e = makeFixture();
        const ctx = new ThrowingCtx(1); // throw on the first arc()
        let threw = false;
        try {
            e.updateAndDraw(ctx, DT, W, H);
        } catch (err) {
            threw = true;
        }
        check(threw,
            () => 'T2 row 2: a throwing arc() did not propagate -- the engine swallowed it');
        check(ctx.globalAlpha === 1.0,
            () => `T2 row 2: globalAlpha left at ${ctx.globalAlpha} after a thrown draw call (want 1.0)`);
    }

    // Row 5 -- the next good frame writes the bucket alphas in tier order.
    {
        const e = makeFixture();
        const ctx = new RecordingCtx();
        e.updateAndDraw(ctx, DT, W, H);
        check(ctx.alphaSeq.length >= 3,
            () => `T2 row 5: only ${ctx.alphaSeq.length} alpha writes recorded`);
        check(approxEq(ctx.alphaSeq[0], 0.24) && approxEq(ctx.alphaSeq[1], 0.44) && approxEq(ctx.alphaSeq[2], 0.72),
            () => `T2 row 5: bucket alphas [${ctx.alphaSeq[0]}, ${ctx.alphaSeq[1]}, ${ctx.alphaSeq[2]}] (want 0.24, 0.44, 0.72 in order)`);
    }
}
