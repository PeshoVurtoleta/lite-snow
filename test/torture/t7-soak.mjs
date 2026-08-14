/**
 * T7 -- soak and conservation.
 *
 * `leak_cycles` build-up / tear-down cycles on ONE reused engine. Each cycle:
 * fill to ~60% occupancy, verify conservation and finiteness, then alternate the
 * two drain paths -- clear() on even cycles, run-to-empty with density:0 on odd
 * cycles -- and assert the pool is fully empty afterwards. Both drains must
 * satisfy the same post-condition, so clear()'s reset is soaked ~2048 times.
 *
 * A second, independent witness (lite-leak) tracks one resource per cycle and
 * must return to size 0 -- so a slot leak and a JS-object leak cannot hide behind
 * each other. Heap is sampled ACROSS cycles, after globalThis.gc(), never within
 * one; the budget is < 512 KB over the whole run.
 */

import { SnowEngine } from '../../SnowEngine.js';
import { createLeakTracker } from '@zakkster/lite-leak';
import { SEED, makeRng, check, conservation, occupancy, makeMockCtx } from './harness.mjs';

const CYCLES = 4096;
const MAX = 256;
const W = 100;
const H = 100;
const FILL_DT = 0.05;
const STEP_DT = 0.1;
const DRAIN_CAP = 500;
const NOOP = function () {};

/** Count non-free slots (falling + melting). Scalar -- allocates nothing. */
function liveCount(engine) {
    const state = engine.state;
    let n = 0;
    for (let i = 0; i < engine.max; i++) if (state[i] !== 0) n++;
    return n;
}

export function run() {
    const engine = new SnowEngine(MAX, {
        gravity: 2000, wind: 40, density: 40,
        driftAmplitude: 15, driftFreq: 1.0,
        meltTimeMin: 0.1, meltTimeMax: 0.2,
        rng: makeRng(SEED),
    });
    const ctx = makeMockCtx();
    const tracker = createLeakTracker({ name: 'snow-soak' });
    const target = Math.floor(0.6 * MAX);

    // Sample heap only at cycle boundaries, after settling.
    globalThis.gc();
    const heapBefore = process.memoryUsage().heapUsed;

    for (let c = 0; c < CYCLES; c++) {
        // Build up to ~60% by spawning (monotonic -- no update between spawns).
        let guard = 0;
        while (liveCount(engine) < target && guard < 1000) {
            engine.spawn(FILL_DT, W, H);
            guard++;
        }

        // A tracked external resource modelling a per-cycle allocation.
        const h = tracker.track({ cycle: c }, NOOP, c);

        // Conservation and finiteness while the pool is full.
        check(conservation(engine), () => `T7: cycle ${c} conservation violated after fill`);
        for (let i = 0; i < MAX; i++) {
            if (engine.state[i] !== 0) {
                check(Number.isFinite(engine.x[i]) && Number.isFinite(engine.y[i]),
                    () => `T7: cycle ${c} non-finite live particle at slot ${i}`);
            }
        }

        // Tear down. Alternate the two drain paths.
        if ((c & 1) === 0) {
            engine.clear();
        } else {
            engine.config.density = 0; // run-to-empty: no new spawns
            let f = 0;
            while (liveCount(engine) > 0 && f < DRAIN_CAP) {
                engine.updateAndDraw(ctx, STEP_DT, W, H);
                f++;
            }
            engine.config.density = 40; // restore for the next cycle
        }
        tracker.untrack(h);

        // Cheap scalar check, same code path as the drain loop condition.
        check(liveCount(engine) === 0,
            () => `T7: cycle ${c} pool not empty after drain (live=${liveCount(engine)})`);
        // INDEPENDENT WITNESS (roadmap law 7). `liveCount` is BOTH the drain-loop
        // condition and the assertion above, so a lying liveCount would skip the
        // loop AND pass that line in the same breath -- a gate that cannot fail
        // for the reason it claims. `occupancy` is a separate array walk, so it
        // catches a still-full pool the scalar oracle would have missed. Applies
        // to BOTH drain branches: the assertion runs after the if/else.
        const occ = occupancy(engine);
        check(occ.free === engine.max,
            () => `T7: cycle ${c} drain incomplete -- occupancy free=${occ.free} != max=${engine.max} (falling=${occ.falling} melting=${occ.melting})`);
        check(conservation(engine), () => `T7: cycle ${c} conservation violated after drain`);
    }

    check(tracker.size() === 0, () => `T7: lite-leak tracker leaked ${tracker.size()} resources`);

    globalThis.gc();
    const heapAfter = process.memoryUsage().heapUsed;
    const grewKB = (heapAfter - heapBefore) / 1024;
    check(grewKB < 512, () => `T7: heap grew ${grewKB.toFixed(1)} KB over ${CYCLES} cycles`);
}
