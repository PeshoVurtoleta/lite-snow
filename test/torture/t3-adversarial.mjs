/**
 * T3 -- adversarial sequences.
 *
 * One reused engine driven through hostile-but-legal schedules that a real
 * caller can produce: violent resize churn (1x1, 8000x8000, and a shrink with a
 * full melt population live -- the SN-08 case), a density ramp 0 -> 40 -> 0,
 * wind sign flips, gravity flipped negative mid-run (embers), call-order abuse
 * (draw before spawn, double spawn, clear mid-stream), and a run to saturation.
 *
 * After every step the pool invariants must hold: conservation
 * (free+falling+melting === max, every state in {0,1,2}), the cached counters
 * agree with a fresh recount, and every live particle is finite. The SN-08 lane
 * additionally asserts no melting particle sits below the (shrunken) floor.
 */

import { SnowEngine } from '../../SnowEngine.js';
import { SEED, makeRng, check, makeMockCtx, conservation, countersAgree } from './harness.mjs';

const MAX = 512;

function assertSane(e, ctx, where) {
    check(conservation(e), () => `T3 ${where}: conservation violated`);
    check(countersAgree(e), () => `T3 ${where}: counters disagree with a recount`);
    for (let i = 0; i < e.max; i++) {
        if (e.state[i] !== 0) {
            check(Number.isFinite(e.x[i]) && Number.isFinite(e.y[i]),
                () => `T3 ${where}: non-finite live particle at slot ${i} (x=${e.x[i]}, y=${e.y[i]})`);
        }
    }
}

/** Count melting slots and the number sitting below the floor h. */
function meltBelow(e, h) {
    let melt = 0, below = 0;
    for (let i = 0; i < e.max; i++) {
        if (e.state[i] === 2) { melt++; if (e.y[i] > h) below++; }
    }
    return { melt, below };
}

export function run() {
    const e = new SnowEngine(MAX, {
        gravity: 400, wind: 80, density: 20, baseRadius: 2.5,
        driftAmplitude: 20, driftFreq: 1.0, meltTimeMin: 1.0, meltTimeMax: 3.0,
        rng: makeRng(SEED),
    });
    const ctx = makeMockCtx();

    // --- Lane 1: resize churn across extremes -------------------------------
    const dims = [
        [800, 600], [1, 1], [8000, 8000], [1, 4000], [4000, 1],
        [1920, 1080], [2, 2], [800, 600],
    ];
    for (let r = 0; r < 6; r++) {
        for (let d = 0; d < dims.length; d++) {
            const w = dims[d][0], h = dims[d][1];
            e.spawn(0.016, w, h);
            e.updateAndDraw(ctx, 0.016, w, h);
            assertSane(e, ctx, 'resize-churn');
        }
    }

    // --- Lane 2: shrink with a full melt population live (SN-08) -------------
    // Saturate a tall canvas so a large melting population settles at y ~ H,
    // then collapse the floor. The melt-branch clamp must drag every melter up
    // to the new floor; none may sit below it.
    e.clear();
    e.config.gravity = 20000; // settle in a single frame
    e.config.density = 400;
    const BIGH = 2000;
    for (let f = 0; f < 6; f++) { e.spawn(0.05, 800, BIGH); e.updateAndDraw(ctx, 0.05, 800, BIGH); }
    let mb = meltBelow(e, BIGH);
    check(mb.melt > 8, () => `T3 SN-08: only ${mb.melt} melters before shrink -- lane would be vacuous`);
    // Shrink the floor hard. First frame after the shrink must clamp all melters.
    const SMALLH = 50;
    e.config.density = 0; // no new spawns; isolate the clamp
    e.updateAndDraw(ctx, 0.001, 800, SMALLH);
    mb = meltBelow(e, SMALLH);
    check(mb.melt > 0, () => 'T3 SN-08: the melt population vanished on the shrink frame -- lane is vacuous');
    check(mb.below === 0,
        () => `T3 SN-08: ${mb.below} of ${mb.melt} melters sit below the shrunken floor y=${SMALLH}`);
    assertSane(e, ctx, 'sn08-shrink');
    e.config.density = 20;
    e.config.gravity = 400;

    // --- Lane 3: density ramp 0 -> 40 -> 0 ----------------------------------
    e.clear();
    for (let step = 0; step <= 40; step++) {
        e.config.density = step;
        e.spawn(0.016, 800, 600);
        e.updateAndDraw(ctx, 0.016, 800, 600);
        assertSane(e, ctx, 'density-ramp-up');
    }
    for (let step = 40; step >= 0; step--) {
        e.config.density = step;
        e.spawn(0.016, 800, 600);
        e.updateAndDraw(ctx, 0.016, 800, 600);
        assertSane(e, ctx, 'density-ramp-down');
    }
    e.config.density = 20;

    // --- Lane 4: wind sign flips + negative gravity mid-run -----------------
    e.clear();
    for (let f = 0; f < 60; f++) {
        e.config.wind = (f & 1) === 0 ? 300 : -300;   // flip every frame
        if (f === 30) e.config.gravity = -600;        // embers: gravity flips up
        e.spawn(0.016, 800, 600);
        e.updateAndDraw(ctx, 0.016, 800, 600);
        assertSane(e, ctx, 'wind-gravity-flip');
    }
    e.config.wind = 80;
    e.config.gravity = 400;

    // --- Lane 5: call-order abuse -------------------------------------------
    e.clear();
    e.updateAndDraw(ctx, 0.016, 800, 600); // draw before any spawn
    assertSane(e, ctx, 'draw-before-spawn');
    e.spawn(0.016, 800, 600);
    e.spawn(0.016, 800, 600);              // double spawn, no update between
    assertSane(e, ctx, 'double-spawn');
    e.updateAndDraw(ctx, 0.016, 800, 600);
    e.clear();                              // clear mid-stream
    assertSane(e, ctx, 'clear-midstream');
    e.updateAndDraw(ctx, 0.016, 800, 600); // draw an empty pool
    assertSane(e, ctx, 'draw-empty');

    // --- Lane 6: run to saturation and hold ---------------------------------
    e.clear();
    e.config.density = 400;
    for (let f = 0; f < 200; f++) {
        e.spawn(0.05, 800, 600);
        e.updateAndDraw(ctx, 0.05, 800, 600);
        assertSane(e, ctx, 'saturation');
    }
    e.config.density = 20;
}
