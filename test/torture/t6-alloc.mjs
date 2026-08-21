/**
 * T6 -- the zero-alloc gate.
 *
 * A steady-state spawn + updateAndDraw hot loop against the mock ctx, measured
 * with lite-gc-profiler and gated at maxMajor:0 / maxPauseMs:4 /
 * maxArrayBuffersGrowth:0. The last rule is the one that matters: the engine's
 * fourteen SoA columns are ArrayBuffer backing stores, which live OUTSIDE the V8
 * heap and are invisible to a heapUsed gate (measured 152x blind spot). It
 * requires `stabilize:'deep'`, which `runOpsGate` supplies.
 *
 * A heap gate cannot substitute for a direct structural assertion either, so we
 * also pin every SoA backing store's byteLength AND the four render-bin backing
 * stores' byteLength across the window: nothing may grow. The bins are the S3
 * addition -- 4 Uint32Array(max) allocated once in the constructor -- and their
 * counts reset with a scalar write, never a realloc, so their buffers are as
 * fixed as the SoA columns.
 *
 * Three lanes at 20% / 60% / 95% occupancy, so the gate covers a near-empty
 * pool, a busy pool, and a near-saturated one -- the last is where SN-12's
 * full-pool spawn scan does the most work, yet it must still allocate nothing.
 *
 * SNOW_TORTURE_BREAK=1 injects a retained allocation into the hot body: the gate
 * must then reject the window and the process exits non-zero. A gate that cannot
 * fail is decorative.
 */

import { SnowEngine } from '../../SnowEngine.js';
import { SEED, makeRng, runOpsGate, BREAK, check, die, makeMockCtx, SOA_NAMES } from './harness.mjs';

const MAX = 2000;
const OPS = 20000;
const WARMUP = 2000;
const W = 800;
const H = 600;
const DT = 0.016;

/** Retained sink for the BREAK control -- survives GC so arrayBuffers grows. */
const leak = [];

/** Count falling+melting slots. O(max) -- setup only, never inside the window. */
function liveCount(engine) {
    const state = engine.state;
    let n = 0;
    for (let i = 0; i < engine.max; i++) if (state[i] !== 0) n++;
    return n;
}

/** Fill the pool to ~frac occupancy by spawning without updating (monotonic). */
function fillTo(engine, frac) {
    const target = Math.floor(frac * engine.max);
    let guard = 0;
    while (liveCount(engine) < target && guard < 1000) {
        engine.spawn(0.1, W, H);
        guard++;
    }
}

function gateLane(frac, label) {
    const engine = new SnowEngine(MAX, {
        gravity: 400, wind: 60, density: 40,
        driftAmplitude: 15, driftFreq: 1.0,
        meltTimeMin: 0.5, meltTimeMax: 1.0,
        rng: makeRng(SEED),
    });
    const ctx = makeMockCtx();
    fillTo(engine, frac);

    // Backing-store sizes captured once, before the window (setup, not hot).
    const bytesBefore = new Float64Array(SOA_NAMES.length);
    for (let n = 0; n < SOA_NAMES.length; n++) {
        bytesBefore[n] = engine[SOA_NAMES[n]].buffer.byteLength;
    }
    const BIN_NAMES = ['_bin0', '_bin1', '_bin2', '_binMelt'];
    const binBytesBefore = new Float64Array(BIN_NAMES.length);
    for (let n = 0; n < BIN_NAMES.length; n++) {
        binBytesBefore[n] = engine[BIN_NAMES[n]].buffer.byteLength;
    }

    // Everything the hot body touches is already allocated. The engine allocates
    // nothing per frame; the mock ctx allocates nothing per call.
    const hot = (i) => {
        engine.spawn(DT, W, H);
        engine.updateAndDraw(ctx, DT, W, H);
        if (BREAK) leak.push(new Float64Array(64)); // control: retained growth
    };

    const { report, summary } = runOpsGate(hot, { ops: OPS, warmup: WARMUP });

    // Structural assertions no heap gate can make.
    for (let n = 0; n < SOA_NAMES.length; n++) {
        const name = SOA_NAMES[n];
        check(engine[name].buffer.byteLength === bytesBefore[n],
            () => `T6[${label}]: ${name} backing store grew ${bytesBefore[n]} -> ${engine[name].buffer.byteLength}`);
    }
    for (let n = 0; n < BIN_NAMES.length; n++) {
        const name = BIN_NAMES[n];
        check(engine[name].buffer.byteLength === binBytesBefore[n],
            () => `T6[${label}]: ${name} backing store grew ${binBytesBefore[n]} -> ${engine[name].buffer.byteLength}`);
    }

    if (!report.ok) {
        const gc = summary.gc;
        die('T6[' + label + '] alloc gate rejected -- verdict=' + report.verdict +
            ' source=' + summary.source + ' major=' + gc.major + ' maxMs=' + gc.maxMs.toFixed(3) +
            (BREAK ? ' (SNOW_TORTURE_BREAK control -- expected)' : ''));
    }

    // In BREAK mode the gate was SUPPOSED to reject; reaching here means the
    // control silently passed, which is itself a failure.
    if (BREAK) die('T6[' + label + ']: SNOW_TORTURE_BREAK injected allocations but the gate passed');
}

export function run() {
    gateLane(0.20, '20%');
    gateLane(0.60, '60%');
    gateLane(0.95, '95%');
}
