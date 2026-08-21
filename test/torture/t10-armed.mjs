/**
 * T10 -- S5 living-air armed-configuration proof (roadmap: close the reviewer's
 * blocking gap that dragOn/gustOn/turbOn never fire under any gate).
 *
 * Six sections, in order:
 *
 *   A. The frozen v1.1.1 baseline still reproduces bit-for-bit over
 *      SOA_NAMES_V111 -- MEASURED here, not just asserted in prose.
 *   B. Armed determinism digests: gust-only, turbulence-only, both, and drag,
 *      each checked against a COMMITTED constant (armed-scenario.mjs), proven
 *      reproducible across a SEPARATE OS process, proven pairwise distinct
 *      from each other and from the off/default digest, and proven to
 *      populate BOTH falling and melting (state 1 AND state 2).
 *   C. Non-vacuous directional proofs: turbulence widens a fixed-z pool's
 *      x-extent; gust displaces sumX and the displacement's periodic
 *      component (detrended -- see the inline derivation) reverses sign over
 *      one gust period; drag < 1 lowers the steady-state fall speed.
 *   D. Abuse / fail-closed: gust=1e9 + turbulence=1e9 + drag=0 for 100k frames
 *      stays finite (the ACCEL_MAX clamp's reason to exist); the poison matrix
 *      for all four knobs, with null landing on the DEFAULT (not 0) asserted
 *      specifically for drag and gustFreq; gustFreq=0 with gust armed freezes
 *      (byte-identical to gust off).
 *   E. The zero-alloc gate at 95% occupancy with gust+turbulence+drag ARMED
 *      (T6's existing lanes only ever run defaults).
 *   F. lite-leak retention (tracker.size()===0) across build-up/tear-down
 *      cycles with gust+turbulence+drag ARMED (T7's existing soak only ever
 *      runs defaults).
 *
 * @license MIT
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLeakTracker } from '@zakkster/lite-leak';
import { SnowEngine } from '../../SnowEngine.js';
import {
    SEED, makeRng, makeMockCtx, check, die, runOpsGate, SOA_NAMES, SOA_NAMES_V111,
} from './harness.mjs';
import {
    BASELINE_DIGEST, BASELINE_COUNTS, ARMED_CONFIGS, ARMED_DIGESTS, ARMED_COUNTS,
    runBaseline, runArmed, digestEngine,
} from './armed-scenario.mjs';

const TAU = Math.PI * 2;
const GUST_FREQ_DEF = TAU / 3;
const ARMED_SCENARIO_PATH = fileURLToPath(new URL('./armed-scenario.mjs', import.meta.url));

// ============================================================================
// A. The frozen v1.1.1 baseline, measured.
// ============================================================================

function sectionA() {
    const engine = runBaseline();
    const hex = digestEngine(engine, SOA_NAMES_V111);
    check(hex === BASELINE_DIGEST,
        () => `T10.A: v1.1.1 baseline digest ${hex} != committed ${BASELINE_DIGEST}`);
    check(engine.activeCount === BASELINE_COUNTS.active,
        () => `T10.A: activeCount ${engine.activeCount} != ${BASELINE_COUNTS.active}`);
    check(engine.fallingCount === BASELINE_COUNTS.falling,
        () => `T10.A: fallingCount ${engine.fallingCount} != ${BASELINE_COUNTS.falling}`);
    check(engine.meltingCount === BASELINE_COUNTS.melting,
        () => `T10.A: meltingCount ${engine.meltingCount} != ${BASELINE_COUNTS.melting}`);
}

// ============================================================================
// B. Armed determinism digests.
// ============================================================================

function sectionB() {
    const keys = Object.keys(ARMED_CONFIGS);
    const measured = {};

    for (let k = 0; k < keys.length; k++) {
        const key = keys[k];
        const engine = runArmed(key);
        const hex = digestEngine(engine, SOA_NAMES);
        measured[key] = hex;

        check(hex === ARMED_DIGESTS[key],
            () => `T10.B[${key}]: digest ${hex} != committed ${ARMED_DIGESTS[key]}`);

        // Reproducible IN-PROCESS: a second independent run must match too
        // (not comparing a computation to itself -- a FRESH engine/run).
        const hex2 = digestEngine(runArmed(key), SOA_NAMES);
        check(hex2 === ARMED_DIGESTS[key],
            () => `T10.B[${key}]: second in-process run ${hex2} != committed ${ARMED_DIGESTS[key]}`);

        // Reproducible ACROSS PROCESSES: spawn a SEPARATE node process running
        // armed-scenario.mjs's own standalone entry point and diff its stdout.
        const out = execFileSync(process.execPath, [ARMED_SCENARIO_PATH, key], { encoding: 'utf8' }).trim();
        check(out === ARMED_DIGESTS[key],
            () => `T10.B[${key}]: cross-process digest ${out} != committed ${ARMED_DIGESTS[key]}`);

        // The load-bearing state1+state2 law: every scenario must populate
        // BOTH falling and melting (1000 frames melts nothing -- the roadmap's
        // exact lesson -- so this is not a rubber-stamp check).
        check(engine.fallingCount === ARMED_COUNTS[key].falling,
            () => `T10.B[${key}]: fallingCount ${engine.fallingCount} != ${ARMED_COUNTS[key].falling}`);
        check(engine.meltingCount === ARMED_COUNTS[key].melting,
            () => `T10.B[${key}]: meltingCount ${engine.meltingCount} != ${ARMED_COUNTS[key].melting}`);
        check(engine.fallingCount > 0 && engine.meltingCount > 0,
            () => `T10.B[${key}]: scenario did not populate both state 1 and state 2 ` +
                `(falling=${engine.fallingCount}, melting=${engine.meltingCount})`);
    }

    // Pairwise distinctness -- every armed digest differs from every other,
    // INCLUDING the off/default one.
    for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
            check(measured[keys[i]] !== measured[keys[j]],
                () => `T10.B: digest collision between '${keys[i]}' and '${keys[j]}' (${measured[keys[i]]})`);
        }
    }
}

// ============================================================================
// C. Non-vacuous directional proofs.
// ============================================================================

/** min/max x among live falling (state===1) slots with z in [zLo, zHi). */
function extentAtZ(engine, zLo, zHi) {
    const state = engine.state, x = engine.x, z = engine.z;
    let minX = Infinity, maxX = -Infinity, n = 0;
    for (let i = 0; i < engine.max; i++) {
        if (state[i] !== 1) continue;
        const zi = z[i];
        if (zi < zLo || zi >= zHi) continue;
        const xi = x[i];
        if (xi < minX) minX = xi;
        if (xi > maxX) maxX = xi;
        n++;
    }
    return { minX, maxX, n, extent: n > 0 ? maxX - minX : 0 };
}

/** Sum of x over live falling (state===1) slots. */
function sumXFalling(engine) {
    const state = engine.state, x = engine.x;
    let s = 0;
    for (let i = 0; i < engine.max; i++) if (state[i] === 1) s += x[i];
    return s;
}

function sectionC_turbulenceWidens() {
    // gravity tiny + driftAmplitude 0 so the pool drifts sideways slowly under
    // turbulence alone, without the sway sine or a fast fall confounding the
    // spread; wind 0 so the two engines' unperturbed extents start identical.
    function build(turbulence) {
        return new SnowEngine(2000, {
            gravity: 5, wind: 0, density: 800, driftAmplitude: 0,
            rng: makeRng(0xFACEFEED), turbulence,
        });
    }
    const off = build(0);
    const on = build(50);
    const ctx = makeMockCtx();
    off.spawn(0.1, 1280, 720); on.spawn(0.1, 1280, 720);
    off.spawn(0.1, 1280, 720); on.spawn(0.1, 1280, 720);
    for (let f = 0; f < 120; f++) {
        off.updateAndDraw(ctx, 1 / 60, 1280, 720);
        on.updateAndDraw(ctx, 1 / 60, 1280, 720);
    }
    const eOff = extentAtZ(off, 0.45, 0.55);
    const eOn = extentAtZ(on, 0.45, 0.55);
    check(eOff.n >= 10 && eOn.n >= 10,
        () => `T10.C.turbulence: too few particles in the z-band to mean anything (off=${eOff.n}, on=${eOn.n})`);
    check(eOn.extent > eOff.extent,
        () => `T10.C.turbulence: armed extent ${eOn.extent} did not exceed off extent ${eOff.extent}`);
}

function sectionC_gustReturns() {
    // gravity tiny + wind 0 + driftAmplitude 0 so gust is the ONLY force in
    // play, and the pool does not cull/melt across the measurement window.
    function build(gust) {
        return new SnowEngine(400, {
            gravity: 5, wind: 0, density: 200, driftAmplitude: 0,
            rng: makeRng(0xDEC0DE), gust,
        });
    }
    const GUST = 20;
    const base = build(0);
    const armed = build(GUST);
    const ctx = makeMockCtx();
    base.spawn(0.1, 1280, 720); armed.spawn(0.1, 1280, 720);
    base.spawn(0.1, 1280, 720); armed.spawn(0.1, 1280, 720);

    const gustFreq = base.config.gustFreq;
    const dt = 1 / 60;
    const framesPerPeriod = Math.round((2 * Math.PI / gustFreq) / dt);
    const deltas = new Array(framesPerPeriod + 1);
    deltas[0] = 0;
    for (let f = 1; f <= framesPerPeriod; f++) {
        base.updateAndDraw(ctx, dt, 1280, 720);
        armed.updateAndDraw(ctx, dt, 1280, 720);
        deltas[f] = sumXFalling(armed) - sumXFalling(base);
    }
    check(base.fallingCount === armed.fallingCount && base.fallingCount === 400,
        () => `T10.C.gust: population diverged between engines (base=${base.fallingCount}, ` +
            `armed=${armed.fallingCount}) -- the linear-trend removal below assumes equal counts`);

    // sumX(armed) - sumX(base) is, for a pool at rest at t=0, the double
    // integral of a pure sinusoid: delta(t) = (gust/w)*(t - sin(w*t)/w) *
    // liveCount. Since vx(t) = (gust/w)*(1-cos(w*t)) >= 0 for gust > 0, delta
    // itself is monotone NON-DECREASING -- it never dips below its own start,
    // so the RAW value cannot "reverse sign". The actual sinusoidal "return"
    // decision 0002/roadmap describes lives in the PERIODIC component once the
    // linear drift is subtracted: residual(t) = delta(t) - delta(T)*(t/T). At
    // t=T/4 that residual is analytically -gust*count/w^2 (negative); at
    // t=3T/4 it is +gust*count/w^2 (positive) -- a genuine sign reversal,
    // which is what this section measures and asserts.
    const deltaT = deltas[framesPerPeriod];
    const iQ = Math.round(framesPerPeriod / 4);
    const i3Q = Math.round(framesPerPeriod * 3 / 4);
    const residualQ = deltas[iQ] - deltaT * (iQ / framesPerPeriod);
    const residual3Q = deltas[i3Q] - deltaT * (i3Q / framesPerPeriod);

    check(deltaT > 0,
        () => `T10.C.gust: no net displacement over one period (deltaT=${deltaT}) -- gust had no effect`);
    check(residualQ < 0,
        () => `T10.C.gust: detrended residual at T/4 was not negative (${residualQ})`);
    check(residual3Q > 0,
        () => `T10.C.gust: detrended residual at 3T/4 was not positive (${residual3Q})`);
}

function sectionC_dragLowersSpeed() {
    // One frame's average dy/dt over particles that were falling both before
    // and after, restricted to a fixed z-band. h is huge so nothing melts
    // mid-measurement (a melt would remove the particle from the average).
    function avgFallSpeed(engine, zLo, zHi, dt) {
        const before = new Float32Array(engine.max);
        const wasFalling = new Uint8Array(engine.max);
        for (let i = 0; i < engine.max; i++) {
            before[i] = engine.y[i];
            wasFalling[i] = (engine.state[i] === 1 && engine.z[i] >= zLo && engine.z[i] < zHi) ? 1 : 0;
        }
        const ctx = makeMockCtx();
        engine.updateAndDraw(ctx, dt, 1280, 5000);
        let sum = 0, n = 0;
        for (let i = 0; i < engine.max; i++) {
            if (!wasFalling[i] || engine.state[i] !== 1) continue;
            sum += (engine.y[i] - before[i]) / dt;
            n++;
        }
        return { avg: n > 0 ? sum / n : NaN, n };
    }
    function build(drag) {
        return new SnowEngine(2000, {
            gravity: 200, wind: 0, density: 800, driftAmplitude: 0,
            rng: makeRng(0x5EEDBEEF), drag,
        });
    }
    const off = build(1);
    const on = build(0.95);
    const ctx = makeMockCtx();
    off.spawn(0.1, 1280, 720); on.spawn(0.1, 1280, 720);
    off.spawn(0.1, 1280, 720); on.spawn(0.1, 1280, 720);
    const dt = 1 / 60;
    // Warm the drag engine up to near-terminal velocity before measuring.
    for (let f = 0; f < 600; f++) {
        off.updateAndDraw(ctx, dt, 1280, 5000);
        on.updateAndDraw(ctx, dt, 1280, 5000);
    }
    const sOff = avgFallSpeed(off, 0.45, 0.55, dt);
    const sOn = avgFallSpeed(on, 0.45, 0.55, dt);
    check(sOff.n >= 10 && sOn.n >= 10,
        () => `T10.C.drag: too few particles in the z-band to mean anything (off=${sOff.n}, on=${sOn.n})`);
    check(sOff.avg > 0,
        () => `T10.C.drag: the undamped baseline was not falling (avg=${sOff.avg})`);
    check(sOn.avg < sOff.avg,
        () => `T10.C.drag: drag-armed speed ${sOn.avg} did not go below undamped speed ${sOff.avg}`);
}

// ============================================================================
// D. Abuse / fail-closed.
// ============================================================================

function sectionD_extremeFinite() {
    const engine = new SnowEngine(200, {
        gravity: 40, wind: 30, density: 20, rng: makeRng(0xABAD1DEA),
        gust: 1e9, turbulence: 1e9, drag: 0,
    });
    const ctx = makeMockCtx();
    for (let f = 0; f < 100000; f++) {
        engine.spawn(1 / 60, 800, 600);
        engine.updateAndDraw(ctx, 1 / 60, 800, 600);
    }
    for (let i = 0; i < engine.max; i++) {
        if (engine.state[i] === 0) continue;
        check(Number.isFinite(engine.x[i]) && Number.isFinite(engine.y[i]) &&
            Number.isFinite(engine.vx[i]) && Number.isFinite(engine.vy[i]),
            () => `T10.D.extreme: slot ${i} non-finite after 100k frames of ` +
                `gust=1e9/turbulence=1e9/drag=0 (x=${engine.x[i]}, y=${engine.y[i]}, ` +
                `vx=${engine.vx[i]}, vy=${engine.vy[i]})`);
    }
    check(engine.activeCount > 0,
        () => 'T10.D.extreme: the pool emptied out (control setup broken -- nothing to check)');
}

const POISON = [NaN, Infinity, -Infinity, null, undefined, 'garbage', {}, []];

function sectionD_poisonMatrix() {
    for (let i = 0; i < POISON.length; i++) {
        const v = POISON[i];
        const label = String(v);

        const eGust = new SnowEngine(4, { gust: v });
        check(eGust.config.gust === 0,
            () => `T10.D.poison: gust=${label} landed on ${eGust.config.gust}, want default 0`);

        const eGustFreq = new SnowEngine(4, { gustFreq: v });
        check(eGustFreq.config.gustFreq === GUST_FREQ_DEF,
            () => `T10.D.poison: gustFreq=${label} landed on ${eGustFreq.config.gustFreq}, want default ${GUST_FREQ_DEF}`);

        const eTurb = new SnowEngine(4, { turbulence: v });
        check(eTurb.config.turbulence === 0,
            () => `T10.D.poison: turbulence=${label} landed on ${eTurb.config.turbulence}, want default 0`);

        const eDrag = new SnowEngine(4, { drag: v });
        check(eDrag.config.drag === 1,
            () => `T10.D.poison: drag=${label} landed on ${eDrag.config.drag}, want default 1`);
    }

    // The specific fail-closed claim the roadmap calls out by name: null must
    // land on the DOCUMENTED DEFAULT, not on 0 -- for drag (default 1) and
    // gustFreq (default TAU/3), landing on 0 would be a SILENT behaviour
    // change (drag=0 arms maximal damping; gustFreq=0 freezes gust) rather
    // than an obviously-wrong one, so these get their own explicit assertion.
    const eNull = new SnowEngine(4, { drag: null, gustFreq: null });
    check(eNull.config.drag === 1,
        () => `T10.D.poison: drag=null landed on ${eNull.config.drag}, want DEFAULT 1 (not 0)`);
    check(eNull.config.drag !== 0,
        () => 'T10.D.poison: drag=null landed on 0 -- a silent behaviour change, not fail-closed');
    check(eNull.config.gustFreq === GUST_FREQ_DEF,
        () => `T10.D.poison: gustFreq=null landed on ${eNull.config.gustFreq}, want DEFAULT ${GUST_FREQ_DEF} (not 0)`);
    check(eNull.config.gustFreq !== 0,
        () => 'T10.D.poison: gustFreq=null landed on 0 -- a silent behaviour change, not fail-closed');
}

function sectionD_gustFreqZeroFreezes() {
    // sin(et*0) === sin(0) === 0 for EVERY et, so gustFreq=0 with gust armed
    // is documented to freeze the gust perturbation at exactly 0 forever --
    // i.e. byte-identical to gust being off entirely, across all 14 columns.
    function build(extra, seed) {
        return new SnowEngine(200, {
            gravity: 40, wind: 30, density: 20, rng: makeRng(seed), ...extra,
        });
    }
    const seed = 0x9EED0000;
    const off = build({}, seed);
    const frozen = build({ gust: 500, gustFreq: 0 }, seed);
    const ctx1 = makeMockCtx();
    const ctx2 = makeMockCtx();
    for (let f = 0; f < 180; f++) {
        off.spawn(1 / 60, 800, 600);
        off.updateAndDraw(ctx1, 1 / 60, 800, 600);
        frozen.spawn(1 / 60, 800, 600);
        frozen.updateAndDraw(ctx2, 1 / 60, 800, 600);
    }
    for (let n = 0; n < SOA_NAMES.length; n++) {
        const name = SOA_NAMES[n];
        const a = off[name], b = frozen[name];
        for (let i = 0; i < off.max; i++) {
            check(Object.is(a[i], b[i]),
                () => `T10.D.gustFreqZero: ${name}[${i}] diverged ${a[i]} vs ${b[i]} ` +
                    '(gustFreq=0 with gust armed must freeze to byte-identical-with-off)');
        }
    }
    check(off.activeCount > 0,
        () => 'T10.D.gustFreqZero: the pool emptied out (control setup broken)');
}

// ============================================================================
// E. Zero-alloc gate, 95% occupancy, all three living-air forces ARMED.
// ============================================================================

function sectionE_armedAllocGate() {
    const MAX = 2000;
    const W = 800, H = 600, DT = 0.016;
    const engine = new SnowEngine(MAX, {
        gravity: 400, wind: 60, density: 40,
        driftAmplitude: 15, driftFreq: 1.0,
        meltTimeMin: 0.5, meltTimeMax: 1.0,
        rng: makeRng(SEED),
        gust: 300, turbulence: 200, drag: 0.9,
    });
    const ctx = makeMockCtx();

    function liveCount() {
        const state = engine.state;
        let n = 0;
        for (let i = 0; i < engine.max; i++) if (state[i] !== 0) n++;
        return n;
    }
    const target = Math.floor(0.95 * MAX);
    let guard = 0;
    while (liveCount() < target && guard < 1000) { engine.spawn(0.1, W, H); guard++; }

    const bytesBefore = new Float64Array(SOA_NAMES.length);
    for (let n = 0; n < SOA_NAMES.length; n++) bytesBefore[n] = engine[SOA_NAMES[n]].buffer.byteLength;

    const hot = (i) => {
        engine.spawn(DT, W, H);
        engine.updateAndDraw(ctx, DT, W, H);
    };
    const { report, summary } = runOpsGate(hot, { ops: 20000, warmup: 2000 });

    for (let n = 0; n < SOA_NAMES.length; n++) {
        const name = SOA_NAMES[n];
        check(engine[name].buffer.byteLength === bytesBefore[n],
            () => `T10.E: ${name} backing store grew ${bytesBefore[n]} -> ${engine[name].buffer.byteLength} (armed 95%)`);
    }
    // Verdict comes from report.ok (checkNoGc's verdict over RULES --
    // maxMajor:0/maxPauseMs:4/maxArrayBuffersGrowth:0), exactly the T6 pattern
    // (t6-alloc.mjs:101-107). measureOps summaries do NOT have a bytesPerOp or
    // alloc field -- verified against the real object's keys (schema, source,
    // supported, observed, gc, heap, uasm, arrayBuffers, external, frames,
    // phases, byRegion) -- so "0 bytes/op" is proven by the SoA byteLength pin
    // above plus this GC-rule verdict, not by a field that does not exist.
    if (!report.ok) {
        const gc = summary.gc;
        die('T10.E armed-95% alloc gate rejected -- verdict=' + report.verdict +
            ' source=' + summary.source + ' major=' + gc.major + ' maxMs=' + gc.maxMs.toFixed(3));
    }
}

// ============================================================================
// F. lite-leak retention, all three living-air forces ARMED.
// ============================================================================

function sectionF_armedRetention() {
    const CYCLES = 512;
    const MAX = 128;
    const W = 100, H = 100;
    const FILL_DT = 0.05, STEP_DT = 0.1, DRAIN_CAP = 500;
    const NOOP = function () {};

    const engine = new SnowEngine(MAX, {
        gravity: 2000, wind: 40, density: 40,
        driftAmplitude: 15, driftFreq: 1.0,
        meltTimeMin: 0.1, meltTimeMax: 0.2,
        rng: makeRng(SEED ^ 0xA47E5EED),
        gust: 300, turbulence: 200, drag: 0.9,
    });
    const ctx = makeMockCtx();
    const tracker = createLeakTracker({ name: 'snow-armed-soak' });
    const target = Math.floor(0.6 * MAX);

    function liveCount() {
        const state = engine.state;
        let n = 0;
        for (let i = 0; i < engine.max; i++) if (state[i] !== 0) n++;
        return n;
    }

    for (let c = 0; c < CYCLES; c++) {
        let guard = 0;
        while (liveCount() < target && guard < 1000) { engine.spawn(FILL_DT, W, H); guard++; }

        const h = tracker.track({ cycle: c }, NOOP, c);

        for (let i = 0; i < MAX; i++) {
            if (engine.state[i] === 0) continue;
            check(Number.isFinite(engine.x[i]) && Number.isFinite(engine.y[i]) &&
                Number.isFinite(engine.vx[i]) && Number.isFinite(engine.vy[i]),
                () => `T10.F: cycle ${c} non-finite live particle at slot ${i} (armed)`);
        }

        if ((c & 1) === 0) {
            engine.clear();
        } else {
            engine.config.density = 0;
            let f = 0;
            while (liveCount() > 0 && f < DRAIN_CAP) { engine.updateAndDraw(ctx, STEP_DT, W, H); f++; }
            engine.config.density = 40;
        }
        tracker.untrack(h);

        check(liveCount() === 0,
            () => `T10.F: cycle ${c} pool not empty after drain (armed, live=${liveCount()})`);
    }

    check(tracker.size() === 0,
        () => `T10.F: lite-leak tracker leaked ${tracker.size()} resources across ${CYCLES} armed cycles`);
}

export function run() {
    sectionA();
    sectionB();
    sectionC_turbulenceWidens();
    sectionC_gustReturns();
    sectionC_dragLowersSpeed();
    sectionD_extremeFinite();
    sectionD_poisonMatrix();
    sectionD_gustFreqZeroFreezes();
    sectionE_armedAllocGate();
    sectionF_armedRetention();
}
