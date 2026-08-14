/**
 * T9 -- controls. Every gate must be provably able to fail.
 *
 * This tier runs deliberately-broken variants IN PROCESS and asserts that the
 * corresponding gate flags each one. If a control slips through, T9 itself fails
 * the run -- a gate that cannot fail is decorative.
 *
 * S0 SCOPE: only the gates that EXIST in S0 have controls here. The remaining
 * controls from roadmap section 3 arrive with the gates they guard:
 *   - control 2 (T5 oracle divergence)          -> S3 (T5 fuzz)
 *   - control 3 (dt door reverted fails SN-01)   -> S1
 *   - control 4 (spawn cap reverted fails T0)    -> S1
 *   - control 5 (melt batching removed fails T2) -> S3
 *   - control 7 (clear skips _elapsedTime)       -> S2
 *   - control 8 (destroy order inverted)         -> S2
 *
 * There is also a whole-suite control: `SNOW_TORTURE_BREAK=1 npm run torture`
 * injects retained allocations into the T6 hot loop, so the alloc gate rejects
 * and the process exits non-zero. Control 1 below exercises the same alloc lane
 * from a plain `npm run torture`, so the gate is proven to bite either way.
 */

import { SnowEngine } from '../../SnowEngine.js';
import { SEED, makeRng, runOpsGate, conservation, occupancy, die, makeMockCtx } from './harness.mjs';

/** Retained sink so the control's allocations survive GC (arrayBuffers grows). */
const leak = [];

export function run() {
    // Control 1 -- the alloc gate. A hot body that retains an allocation every
    // iteration MUST be rejected by runOpsGate (maxArrayBuffersGrowth:0).
    const { report } = runOpsGate((i) => { leak.push(new Float64Array(64)); }, {
        ops: 4000,
        warmup: 0,
    });
    if (report.ok) {
        die('T9 control 1: an allocating hot loop passed the zero-alloc gate');
    }
    leak.length = 0; // release the control's garbage

    // Control 6 -- the conservation checker. Prove it is BOTH sound on a valid
    // pool and able to flag a corrupted state. A checker that never fails is
    // blind to SN-02/SN-04 class overfill and slot corruption.
    const e = new SnowEngine(16, { density: 400, rng: makeRng(SEED) });
    e.spawn(0.016, 800, 600);
    if (!conservation(e)) {
        die('T9 control 6: conservation() reported false on a valid pool (checker is broken)');
    }
    e.state[0] = 7; // a state outside {0,1,2}
    if (conservation(e)) {
        die('T9 control 6: conservation() held despite a corrupted state[0]=7');
    }
    e.state[0] = 0; // heal it

    // Control -- the T7 drain gate. T7 drains the pool and asserts it is empty;
    // the drain LOOP uses the cheap scalar `liveCount`, so if that same function
    // were also the oracle a lying `liveCount() -> 0` would skip the loop (pool
    // stays full) AND pass the assertion vacuously. T7 guards against this with
    // an INDEPENDENT witness (`occupancy`, a separate array walk). Prove that
    // witness is load-bearing: fill a pool, DON'T drain it, and confirm occupancy
    // still reports it full -- so a drain that lied about being empty is rejected.
    const de = new SnowEngine(64, { density: 400, rng: makeRng(SEED) });
    de.spawn(0.016, 800, 600); // pool now has live slots; a lying liveCount()->0
                               // would make T7's drain loop a no-op
    const lyingLiveCount = () => 0; // the deliberately-broken scalar oracle
    if (lyingLiveCount() !== 0) {
        die('T9 control: the lying live-count did not return 0 (control setup broken)');
    }
    const docc = occupancy(de);
    if (docc.free === de.max) {
        die('T9 control: T7 drain witness reported a full pool as empty (free=' +
            docc.free + ' max=' + de.max + ') -- the soak drain gate cannot fail');
    }

    // Control -- the mock-ctx instrument. The T6/T2 draw-count and position
    // digest are load-bearing; prove they actually record, so a future fill()
    // assertion cannot be trivially satisfied by an inert stub.
    const ctx = makeMockCtx();
    ctx.beginPath();
    ctx.arc(5, 10, 1, 0, 6.2831853);
    ctx.ellipse(15, 20, 2, 1, 0, 0, 6.2831853);
    ctx.fill();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = 'white';
    if (ctx.nFill !== 1) die('T9 control: mock ctx did not count fill()');
    if (ctx.nBeginPath !== 1) die('T9 control: mock ctx did not count beginPath()');
    if (ctx.nArc !== 1) die('T9 control: mock ctx did not count arc()');
    if (ctx.nEllipse !== 1) die('T9 control: mock ctx did not count ellipse()');
    if (ctx.nGlobalAlpha !== 1) die('T9 control: mock ctx did not count a globalAlpha write');
    if (ctx.nFillStyle !== 1) die('T9 control: mock ctx did not count a fillStyle write');
    if (ctx.sumX !== 20) die('T9 control: mock ctx sumX digest wrong (expected 20)');
    if (ctx.minX !== 5) die('T9 control: mock ctx minX digest wrong (expected 5)');
    if (ctx.maxY !== 20) die('T9 control: mock ctx maxY digest wrong (expected 20)');
    ctx.reset();
    if (ctx.nFill !== 0 || ctx.sumX !== 0 || ctx.minX !== Infinity) {
        die('T9 control: mock ctx reset() left a stale counter or accumulator');
    }
}
