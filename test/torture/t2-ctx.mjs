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
