/**
 * T12 -- S7 preset / reducedMotion / spawn-shaping tier.
 *
 * Sections, in order (plan task 18 / assertions A1-A9, A11, A12, A15):
 *
 *   1. preset digests        A1: three committed per-preset digests + counts
 *                             (flurry/heavy/blizzard, UNCHANGED from v1.3.0),
 *                             re-derived cross-process via this file's own
 *                             `--preset-digest <name>` standalone entry (A15);
 *                             the newly-captured calm digest, proven distinct
 *                             from all three.
 *   2. flurry-is-default      A2: the non-tautology companion to A1 -- flurry
 *                             names the exact 21-key set, a flurry-built
 *                             engine's config deep-equals a {}-built engine's
 *                             on all 21 keys, AND flurry's digest reproduces
 *                             BASELINE_DIGEST over SOA_NAMES_V111 (an
 *                             INDEPENDENTLY committed constant, not derived
 *                             from PRESET_DIGESTS.flurry).
 *   3. spawnBand/spawnMargin  A3/A4: the mirrored-parameterization trap.
 *                             {min:-100,max:-50} reproduces BASELINE_DIGEST
 *                             bit-for-bit (the subtractive form's fixed point);
 *                             {spawnMargin:null} likewise; a NON-default band
 *                             moves the digest AND every spawned y lands in
 *                             (min, max].
 *   4. reducedMotion override A5/A6/A7: {...blizzard, reducedMotion:true}
 *                             equals calm's digest and config key-by-key (21
 *                             keys, excluding color/rng/reducedMotion); the
 *                             flag beats an explicit knob (gust discarded); a
 *                             Math.sin-counting shim proves the gust guard
 *                             evaluates ZERO times under the flag and > 0
 *                             without it (BOTH directions, so a shim frozen at
 *                             0 cannot slip through); strict arming plus a
 *                             mid-run flip inert on the 3000-frame baseline.
 *   5. calmness metric        A8: per-particle mean |dx|/|dy| over slots that
 *                             stay in state 1 across the step, 300 warm-up
 *                             frames discarded, strict chain calm < flurry <
 *                             heavy < blizzard on BOTH metrics plus the two
 *                             ratio bounds, sampled-slot non-vacuity.
 *   6. DOM-free proof          A9: a CHILD PROCESS with every DOM global poisoned
 *                             as a throwing getter, engine imported AFTER the
 *                             poison, 200 armed frames, destroy(), exit 0.
 *   7. alloc gate               A11: all four presets + a reducedMotion lane,
 *                             each with accumulate armed, at ~95% occupancy.
 *   8. retention               A12: tracker.size()===0 over 4096 cycles with
 *                             calm + accumulate + reducedMotion armed.
 *
 * Per the S5/S7 carry-forward: the T5 oracle is NOT extended with preset or
 * reducedMotion logic (it never needed to change -- the subtractive spawn form
 * S7 keeps is the one it already mirrors). The frozen T9 control classes are
 * untouched for the same reason.
 *
 * @license MIT
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLeakTracker } from '@zakkster/lite-leak';
import { SnowEngine, SNOW_PRESETS } from '../../SnowEngine.js';
import {
    makeRng, check, die, note, makeMockCtx, occupancy, runOpsGate, SOA_NAMES, SOA_NAMES_V111,
} from './harness.mjs';
import {
    BASELINE, BASELINE_DIGEST,
    PRESET_SCENARIO, PRESET_DIGESTS, PRESET_COUNTS,
    runPreset, digestEngine,
} from './armed-scenario.mjs';

const SELF_PATH = fileURLToPath(import.meta.url);
const ENGINE_URL = new URL('../../SnowEngine.js', import.meta.url).href;

/** The 21 scene keys a preset names (decisions/0004 (e)) -- excludes color,
 * rng (injection/appearance, never scene) and reducedMotion (LOAD-BEARING
 * HAZARD if a preset named it, decisions/0004 (e)). */
const PRESET_KEYS_21 = Object.freeze([
    'gravity', 'wind', 'density', 'baseRadius', 'driftAmplitude', 'driftFreq',
    'meltTimeMin', 'meltTimeMax', 'gust', 'gustFreq', 'turbulence', 'drag',
    'spawnBand', 'spawnMargin', 'accumulate', 'packResolution', 'maxPackWidth',
    'maxPackHeight', 'packDecay', 'floorY', 'friction',
]);

function driveBaseline(config) {
    const e = new SnowEngine(BASELINE.MAX, { rng: makeRng(BASELINE.SEED), ...config });
    const ctx = makeMockCtx();
    for (let f = 0; f < BASELINE.FRAMES; f++) {
        e.spawn(BASELINE.DT, BASELINE.W, BASELINE.H);
        e.updateAndDraw(ctx, BASELINE.DT, BASELINE.W, BASELINE.H);
    }
    return e;
}

function drivePresetScenario(config) {
    const e = new SnowEngine(PRESET_SCENARIO.MAX, { rng: makeRng(PRESET_SCENARIO.SEED), ...config });
    const ctx = makeMockCtx();
    for (let f = 0; f < PRESET_SCENARIO.FRAMES; f++) {
        e.spawn(PRESET_SCENARIO.DT, PRESET_SCENARIO.W, PRESET_SCENARIO.H);
        e.updateAndDraw(ctx, PRESET_SCENARIO.DT, PRESET_SCENARIO.W, PRESET_SCENARIO.H);
    }
    return e;
}

// ============================================================================
// 1. preset digests -- A1, A15.
// ============================================================================

function sectionPresetDigests() {
    const measured = {};
    for (const name of Object.keys(PRESET_DIGESTS)) {
        const e = runPreset(name);
        const hex = digestEngine(e, SOA_NAMES);
        measured[name] = hex;
        check(hex === PRESET_DIGESTS[name],
            () => `T12.presetDigest[${name}]: digest ${hex} != committed ${PRESET_DIGESTS[name]}`);
        check(e.fallingCount === PRESET_COUNTS[name].falling,
            () => `T12.presetDigest[${name}]: fallingCount ${e.fallingCount} != ${PRESET_COUNTS[name].falling}`);
        check(e.meltingCount === PRESET_COUNTS[name].melting,
            () => `T12.presetDigest[${name}]: meltingCount ${e.meltingCount} != ${PRESET_COUNTS[name].melting}`);
        check(e.fallingCount > 0 && e.meltingCount > 0,
            () => `T12.presetDigest[${name}]: scenario did not populate both state 1 and state 2`);

        // Reproducible IN-PROCESS: a second, independent run must match too.
        const hex2 = digestEngine(runPreset(name), SOA_NAMES);
        check(hex2 === PRESET_DIGESTS[name],
            () => `T12.presetDigest[${name}]: second in-process run ${hex2} != committed ${PRESET_DIGESTS[name]}`);

        // Reproducible ACROSS PROCESSES (A15): this file's own standalone entry.
        const out = execFileSync(process.execPath, [SELF_PATH, '--preset-digest', name], { encoding: 'utf8' }).trim();
        check(out === PRESET_DIGESTS[name],
            () => `T12.presetDigest[${name}]: cross-process digest ${out} != committed ${PRESET_DIGESTS[name]}`);
    }

    // calm distinct from all three others (the fourth-preset non-collision proof).
    check(measured.calm !== measured.flurry, () => 'T12.presetDigest: calm collapsed onto flurry');
    check(measured.calm !== measured.heavy, () => 'T12.presetDigest: calm collapsed onto heavy');
    check(measured.calm !== measured.blizzard, () => 'T12.presetDigest: calm collapsed onto blizzard');
}

// ============================================================================
// 2. flurry is proven to be the default scene -- A2 (non-tautology companion).
// ============================================================================

function sectionFlurryIsDefault() {
    const flurryKeys = Object.keys(SNOW_PRESETS.flurry).slice().sort();
    const expected = PRESET_KEYS_21.slice().sort();
    check(JSON.stringify(flurryKeys) === JSON.stringify(expected),
        () => `T12.flurryIsDefault: flurry keys ${JSON.stringify(flurryKeys)} != expected 21-key set ${JSON.stringify(expected)}`);

    const eDefault = new SnowEngine(10, {});
    const eFlurry = new SnowEngine(10, SNOW_PRESETS.flurry);
    for (const k of PRESET_KEYS_21) {
        check(Object.is(eDefault.config[k], eFlurry.config[k]),
            () => `T12.flurryIsDefault: config.${k} diverged (default=${eDefault.config[k]}, flurry=${eFlurry.config[k]})`);
    }

    // A1 alone cannot distinguish flurry from {} because their digests are
    // equal BY CONSTRUCTION -- assert that equality against an INDEPENDENTLY
    // committed constant (BASELINE_DIGEST, over SOA_NAMES_V111, from the
    // frozen v1.1.1 scenario) so this is a claim, not a self-comparison.
    const eFlurryRun = new SnowEngine(BASELINE.MAX, { rng: makeRng(BASELINE.SEED), ...SNOW_PRESETS.flurry });
    const ctx = makeMockCtx();
    for (let f = 0; f < BASELINE.FRAMES; f++) {
        eFlurryRun.spawn(BASELINE.DT, BASELINE.W, BASELINE.H);
        eFlurryRun.updateAndDraw(ctx, BASELINE.DT, BASELINE.W, BASELINE.H);
    }
    const hex = digestEngine(eFlurryRun, SOA_NAMES_V111);
    check(hex === BASELINE_DIGEST,
        () => `T12.flurryIsDefault: flurry-built engine over the baseline scenario ${hex} != BASELINE_DIGEST ${BASELINE_DIGEST}`);
}

// ============================================================================
// 3. spawnBand / spawnMargin -- A3, A4.
// ============================================================================

function sectionSpawnBandMargin() {
    // A3: the mirrored-form trap. {min:-100,max:-50} resolves to the SAME two
    // literal constants (-50/50) the default path uses -- bit-identical.
    const eBand = driveBaseline({ spawnBand: { min: -100, max: -50 } });
    const hexBand = digestEngine(eBand, SOA_NAMES_V111);
    check(hexBand === BASELINE_DIGEST,
        () => `T12.spawnBand: {min:-100,max:-50} digest ${hexBand} != BASELINE_DIGEST ${BASELINE_DIGEST} -- the subtractive form broke`);

    const eMargin = driveBaseline({ spawnMargin: null });
    const hexMargin = digestEngine(eMargin, SOA_NAMES_V111);
    check(hexMargin === BASELINE_DIGEST,
        () => `T12.spawnMargin: {spawnMargin:null} digest ${hexMargin} != BASELINE_DIGEST ${BASELINE_DIGEST}`);

    // A4: a NON-default band actually moves the sim -- without this, A3 alone
    // would still pass on an engine that silently ignores spawnBand entirely.
    const probeCfg = { rng: makeRng(BASELINE.SEED), spawnBand: { min: -400, max: -300 } };
    const eProbe = new SnowEngine(BASELINE.MAX, probeCfg);
    eProbe.spawn(BASELINE.DT, BASELINE.W, BASELINE.H);
    let nSpawned = 0, allInRange = true;
    for (let i = 0; i < eProbe.max; i++) {
        if (eProbe.state[i] !== 1) continue;
        nSpawned++;
        const y = eProbe.y[i];
        if (!(y > -400 && y <= -300)) allInRange = false;
    }
    check(nSpawned > 0, () => 'T12.spawnBand: the probe spawn produced no live slots -- setup broken');
    check(allInRange,
        () => 'T12.spawnBand: at least one spawned y fell outside the configured band (-400, -300]');

    const eMoved = driveBaseline({ spawnBand: { min: -400, max: -300 } });
    const hexMoved = digestEngine(eMoved, SOA_NAMES_V111);
    check(hexMoved !== BASELINE_DIGEST,
        () => 'T12.spawnBand: a non-default band collapsed onto BASELINE_DIGEST -- spawnBand is being silently ignored');
}

// ============================================================================
// 4. reducedMotion override -- A5, A6, A7.
// ============================================================================

/** Count of state===1 slots -- test-only, O(max). */
function countFalling(e) {
    let n = 0;
    for (let i = 0; i < e.max; i++) if (e.state[i] === 1) n++;
    return n;
}

/**
 * The gust-guard counting shim (A6): monkeypatches the GLOBAL Math.sin for the
 * duration of exactly one updateAndDraw call and counts invocations beyond the
 * expected per-particle sway term (one Math.sin(tp) per LIVE falling slot,
 * unconditional -- see SnowEngine.js's physics loop). The engine's gustAccel
 * line calls Math.sin EXACTLY ONCE MORE per frame, and ONLY when gustOn (=
 * `gust !== 0`) is true -- so the "extra" count above the live-falling
 * baseline is 1 when the guard fires and 0 when it does not. This measures
 * the REAL production code path (SnowEngine.js is never duplicated or
 * touched), not an inference from config -- turbulence stays at its default
 * (0) so the guard's `if (turbOn) ... Math.sin(tp) ...` branch never adds a
 * second confound.
 */
function gustEvalExtra(engine, dt, w, h) {
    const before = countFalling(engine);
    let calls = 0;
    const origSin = Math.sin;
    Math.sin = function (x) { calls++; return origSin(x); };
    try {
        engine.updateAndDraw(gustEvalExtra._ctx, dt, w, h);
    } finally {
        Math.sin = origSin;
    }
    return calls - before;
}
gustEvalExtra._ctx = makeMockCtx();

function runGustEvalTotal(config, frames) {
    const engine = new SnowEngine(300, {
        gravity: 5, wind: 0, density: 200, driftAmplitude: 10,
        meltTimeMin: 1000, meltTimeMax: 2000, turbulence: 0,
        rng: makeRng(0xABCDEF01),
        ...config,
    });
    engine.spawn(0.1, 1280, 720);
    engine.spawn(0.1, 1280, 720);
    let total = 0;
    for (let f = 0; f < frames; f++) total += gustEvalExtra(engine, 1 / 60, 1280, 720);
    return total;
}

function sectionReducedMotion() {
    // A5: {...blizzard, reducedMotion:true} equals calm's committed digest.
    const eOverride = drivePresetScenario({ ...SNOW_PRESETS.blizzard, reducedMotion: true });
    const hexOverride = digestEngine(eOverride, SOA_NAMES);
    check(hexOverride === PRESET_DIGESTS.calm,
        () => `T12.reducedMotion: {...blizzard, reducedMotion:true} digest ${hexOverride} != calm's ${PRESET_DIGESTS.calm}`);

    // Config deep-equal on all 21 keys (excludes color/rng/reducedMotion --
    // decisions/0004 (e)/(d)), against a freshly-built calm engine.
    const eOverrideCfg = new SnowEngine(10, { ...SNOW_PRESETS.blizzard, reducedMotion: true });
    const eCalmCfg = new SnowEngine(10, SNOW_PRESETS.calm);
    for (const k of PRESET_KEYS_21) {
        check(Object.is(eOverrideCfg.config[k], eCalmCfg.config[k]),
            () => `T12.reducedMotion: config.${k} diverged from calm (override=${eOverrideCfg.config[k]}, calm=${eCalmCfg.config[k]})`);
    }

    // A6: the flag beats an explicit knob -- gust is discarded, not blended.
    const eGustDiscarded = new SnowEngine(10, { reducedMotion: true, gust: 500 });
    check(eGustDiscarded.config.gust === 0,
        () => `T12.reducedMotion: {reducedMotion:true, gust:500}.config.gust = ${eGustDiscarded.config.gust}, want 0`);

    // A6 counting shim, BOTH directions.
    const FRAMES = 600;
    const evalsArmed = runGustEvalTotal({ reducedMotion: true, gust: 500 }, FRAMES);
    check(evalsArmed === 0,
        () => `T12.reducedMotion.gustGuardShim: reducedMotion armed still recorded ${evalsArmed} gust-accel evaluations over ${FRAMES} frames, want exactly 0`);
    const evalsOmitted = runGustEvalTotal({ gust: 500 }, FRAMES);
    check(evalsOmitted > 0,
        () => `T12.reducedMotion.gustGuardShim: reducedMotion omitted recorded ${evalsOmitted} gust-accel evaluations, want > 0 (a shim frozen at 0 must be caught here)`);
    note(`T12.reducedMotion.gustGuardShim: armed=${evalsArmed} evaluations, omitted=${evalsOmitted} evaluations over ${FRAMES} frames`);

    // A7: strict arming ('yes'/1 do not arm it) + a mid-run flip on the
    // 3000-frame BASELINE is inert (no frame-loop read of _reducedMotion).
    const eYes = new SnowEngine(10, { ...SNOW_PRESETS.blizzard, reducedMotion: 'yes' });
    const eOne = new SnowEngine(10, { ...SNOW_PRESETS.blizzard, reducedMotion: 1 });
    const eBlizzard = new SnowEngine(10, SNOW_PRESETS.blizzard);
    for (const k of PRESET_KEYS_21) {
        check(Object.is(eYes.config[k], eBlizzard.config[k]),
            () => `T12.reducedMotion.strictArm: reducedMotion:'yes' moved config.${k}`);
        check(Object.is(eOne.config[k], eBlizzard.config[k]),
            () => `T12.reducedMotion.strictArm: reducedMotion:1 moved config.${k}`);
    }

    const eFlip = new SnowEngine(BASELINE.MAX, { rng: makeRng(BASELINE.SEED) });
    const ctxFlip = makeMockCtx();
    const half = BASELINE.FRAMES >> 1;
    for (let f = 0; f < half; f++) {
        eFlip.spawn(BASELINE.DT, BASELINE.W, BASELINE.H);
        eFlip.updateAndDraw(ctxFlip, BASELINE.DT, BASELINE.W, BASELINE.H);
    }
    eFlip.config.reducedMotion = true; // mid-run flip, frame 1500 of 3000
    for (let f = half; f < BASELINE.FRAMES; f++) {
        eFlip.spawn(BASELINE.DT, BASELINE.W, BASELINE.H);
        eFlip.updateAndDraw(ctxFlip, BASELINE.DT, BASELINE.W, BASELINE.H);
    }
    const hexFlip = digestEngine(eFlip, SOA_NAMES_V111);
    check(hexFlip === BASELINE_DIGEST,
        () => `T12.reducedMotion.runtimeFlip: a mid-run reducedMotion=true flip moved the digest ${hexFlip} != ${BASELINE_DIGEST}`);
}

// ============================================================================
// 5. calmness metric -- A8.
// ============================================================================

function calmnessMetric(preset) {
    const MAX = PRESET_SCENARIO.MAX, DT = PRESET_SCENARIO.DT;
    const W = PRESET_SCENARIO.W, H = PRESET_SCENARIO.H;
    const WARMUP = 300, FRAMES = PRESET_SCENARIO.FRAMES;
    const e = new SnowEngine(MAX, { rng: makeRng(PRESET_SCENARIO.SEED), ...preset });
    const ctx = makeMockCtx();
    const beforeX = new Float32Array(MAX), beforeY = new Float32Array(MAX);
    const wasState1 = new Uint8Array(MAX);
    let sumDX = 0, sumDY = 0, n = 0;
    for (let f = 0; f < FRAMES; f++) {
        e.spawn(DT, W, H);
        const state = e.state, x = e.x, y = e.y;
        const measure = f >= WARMUP;
        if (measure) {
            for (let i = 0; i < MAX; i++) {
                beforeX[i] = x[i]; beforeY[i] = y[i];
                wasState1[i] = state[i] === 1 ? 1 : 0;
            }
        }
        e.updateAndDraw(ctx, DT, W, H);
        if (measure) {
            for (let i = 0; i < MAX; i++) {
                if (wasState1[i] === 1 && state[i] === 1) {
                    sumDX += Math.abs(x[i] - beforeX[i]);
                    sumDY += Math.abs(y[i] - beforeY[i]);
                    n++;
                }
            }
        }
    }
    return { meanDX: n > 0 ? sumDX / n : NaN, meanDY: n > 0 ? sumDY / n : NaN, n };
}

function sectionCalmnessMetric() {
    const m = {};
    for (const name of ['calm', 'flurry', 'heavy', 'blizzard']) {
        m[name] = calmnessMetric(SNOW_PRESETS[name]);
        check(m[name].n >= 200,
            () => `T12.calmness[${name}]: only ${m[name].n} sampled slots -- non-vacuity requires >= 200`);
        check(Number.isFinite(m[name].meanDX) && m[name].meanDX > 0,
            () => `T12.calmness[${name}]: meanDX ${m[name].meanDX} is not finite/positive`);
        check(Number.isFinite(m[name].meanDY) && m[name].meanDY > 0,
            () => `T12.calmness[${name}]: meanDY ${m[name].meanDY} is not finite/positive`);
    }

    check(m.calm.meanDX < m.flurry.meanDX,
        () => `T12.calmness: chain broke, calm.meanDX ${m.calm.meanDX} !< flurry.meanDX ${m.flurry.meanDX}`);
    check(m.flurry.meanDX < m.heavy.meanDX,
        () => `T12.calmness: chain broke, flurry.meanDX ${m.flurry.meanDX} !< heavy.meanDX ${m.heavy.meanDX}`);
    check(m.heavy.meanDX < m.blizzard.meanDX,
        () => `T12.calmness: chain broke, heavy.meanDX ${m.heavy.meanDX} !< blizzard.meanDX ${m.blizzard.meanDX}`);

    check(m.calm.meanDY < m.flurry.meanDY,
        () => `T12.calmness: chain broke, calm.meanDY ${m.calm.meanDY} !< flurry.meanDY ${m.flurry.meanDY}`);
    check(m.flurry.meanDY < m.heavy.meanDY,
        () => `T12.calmness: chain broke, flurry.meanDY ${m.flurry.meanDY} !< heavy.meanDY ${m.heavy.meanDY}`);
    check(m.heavy.meanDY < m.blizzard.meanDY,
        () => `T12.calmness: chain broke, heavy.meanDY ${m.heavy.meanDY} !< blizzard.meanDY ${m.blizzard.meanDY}`);

    check(m.calm.meanDX < 0.5 * m.flurry.meanDX,
        () => `T12.calmness: calm.meanDX ${m.calm.meanDX} !< 0.5 * flurry.meanDX ${0.5 * m.flurry.meanDX}`);
    check(m.calm.meanDY < 0.75 * m.flurry.meanDY,
        () => `T12.calmness: calm.meanDY ${m.calm.meanDY} !< 0.75 * flurry.meanDY ${0.75 * m.flurry.meanDY}`);

    note(`T12.calmness: calm(${m.calm.meanDX.toFixed(4)},${m.calm.meanDY.toFixed(4)}) ` +
        `flurry(${m.flurry.meanDX.toFixed(4)},${m.flurry.meanDY.toFixed(4)}) ` +
        `heavy(${m.heavy.meanDX.toFixed(4)},${m.heavy.meanDY.toFixed(4)}) ` +
        `blizzard(${m.blizzard.meanDX.toFixed(4)},${m.blizzard.meanDY.toFixed(4)}) n=${m.calm.n}/${m.flurry.n}/${m.heavy.n}/${m.blizzard.n}`);
}

// ============================================================================
// 6. DOM-free proof -- A9. A CHILD PROCESS with every DOM global poisoned as a
//    throwing getter, defined BEFORE the engine is imported (a static
//    top-of-file import here would defeat the proof -- linking happens before
//    any of THIS file's code runs, so the poison must live in a separate
//    process whose FIRST executed statements are the poison itself).
// ============================================================================

const DOM_GLOBALS = ['window', 'document', 'matchMedia', 'ResizeObserver', 'requestAnimationFrame', 'navigator', 'screen', 'self'];

function domFreeChildScript() {
    return `
const names = ${JSON.stringify(DOM_GLOBALS)};
const touched = [];
for (const n of names) {
    Object.defineProperty(globalThis, n, {
        get() { touched.push(n); throw new Error('DOM global touched: ' + n); },
        configurable: true,
    });
}
const mod = await import(${JSON.stringify(ENGINE_URL)});
const e = new mod.SnowEngine(500, { accumulate: true, reducedMotion: true, rng: Math.random });
const ctx = {
    fillStyle: '', globalAlpha: 1,
    beginPath(){}, moveTo(){}, lineTo(){}, closePath(){}, arc(){}, ellipse(){}, fill(){},
};
for (let f = 0; f < 200; f++) {
    e.spawn(1 / 60, 800, 600);
    e.updateAndDraw(ctx, 1 / 60, 800, 600);
}
e.destroy();
if (touched.length > 0) {
    process.stderr.write('TOUCHED:' + touched.join(','));
    process.exit(1);
}
process.stdout.write('DOM-FREE-OK');
process.exit(0);
`;
}

function sectionDomFree() {
    let out, status = 0;
    try {
        out = execFileSync(process.execPath, ['--input-type=module', '-e', domFreeChildScript()], { encoding: 'utf8' });
    } catch (err) {
        status = err.status === null || err.status === undefined ? 1 : err.status;
        out = (err.stdout || '') + '|' + (err.stderr || '');
    }
    check(status === 0, () => `T12.domFree: child process exited ${status} (${out})`);
    check(out === 'DOM-FREE-OK', () => `T12.domFree: child stdout was '${out}', want exactly 'DOM-FREE-OK'`);
}

// ============================================================================
// 7. alloc gate -- A11. All four presets + a reducedMotion lane, each armed
//    with accumulate:true, at ~95% occupancy.
// ============================================================================

function allocGateLane(label, config) {
    const MAX = 2000, W = 800, H = 600, DT = 0.016;
    const e = new SnowEngine(MAX, { rng: makeRng(0x5EED1234), accumulate: true, ...config });
    const ctx = makeMockCtx();

    function liveCount() {
        const state = e.state;
        let n = 0;
        for (let i = 0; i < e.max; i++) if (state[i] !== 0) n++;
        return n;
    }
    const target = Math.floor(0.95 * MAX);
    let guard = 0;
    while (liveCount() < target && guard < 2000) { e.spawn(0.1, W, H); guard++; }

    const bytesBefore = new Float64Array(SOA_NAMES.length);
    for (let n = 0; n < SOA_NAMES.length; n++) bytesBefore[n] = e[SOA_NAMES[n]].buffer.byteLength;
    const packBytesBefore = e.pack !== null ? e.pack.buffer.byteLength : null;

    const hot = (i) => {
        e.spawn(DT, W, H);
        e.updateAndDraw(ctx, DT, W, H);
    };
    const { report, summary } = runOpsGate(hot, { ops: 20000, warmup: 2000 });

    for (let n = 0; n < SOA_NAMES.length; n++) {
        const name = SOA_NAMES[n];
        check(e[name].buffer.byteLength === bytesBefore[n],
            () => `T12.allocGate[${label}]: ${name} backing store grew ${bytesBefore[n]} -> ${e[name].buffer.byteLength}`);
    }
    if (e.pack !== null) {
        check(e.pack.buffer.byteLength === packBytesBefore,
            () => `T12.allocGate[${label}]: pack backing store grew ${packBytesBefore} -> ${e.pack.buffer.byteLength}`);
    }

    if (!report.ok) {
        const gc = summary.gc;
        die(`T12.allocGate[${label}] rejected -- verdict=${report.verdict} source=${summary.source} major=${gc.major} maxMs=${gc.maxMs.toFixed(3)}`);
    }
}

function sectionAllocGate() {
    for (const name of ['flurry', 'heavy', 'blizzard', 'calm']) {
        allocGateLane(name, { ...SNOW_PRESETS[name], friction: 0.5 });
    }
    // The reducedMotion lane: an explicit knob set alongside the flag (gust,
    // spawnBand, spawnMargin) so the discarded values are exercised too --
    // RED WHEN reducedMotion builds a fresh config object per frame, or the
    // spawnBand/spawnMargin cold-path resolution leaks into the hot body.
    allocGateLane('reducedMotion', {
        reducedMotion: true, gust: 999, turbulence: 500,
        spawnBand: { min: -300, max: -100 }, spawnMargin: 50, friction: 0.4,
    });
}

// ============================================================================
// 8. retention -- A12.
// ============================================================================

function sectionRetention() {
    // H is small (not gravity:2000-style tuning) BECAUSE reducedMotion:true is
    // a HARD OVERRIDE (decisions/0004 (d)): gravity/wind/density here are
    // DISCARDED in favour of calm's own (much smaller) values the instant the
    // flag is armed -- the same override A5/A6 prove. A drain budget sized
    // for a fast-fall config a hard override then defeats is exactly the
    // class of bug this retention proof exists to catch, so the fall
    // DISTANCE is cut instead (H=20, not gravity=2000) and DRAIN_CAP is set
    // WELL clear of the worst case actually measured under calm's real
    // gravity (302 frames over 4096 cycles), never a two-frame margin.
    const CYCLES = 4096, MAXP = 256, W = 100, H = 20;
    const FILL_DT = 0.05, STEP_DT = 0.1, DRAIN_CAP = 2000;
    const NOOP = function () {};

    const e = new SnowEngine(MAXP, {
        ...SNOW_PRESETS.calm,
        gravity: 2000, wind: 40, density: 40, meltTimeMin: 0.1, meltTimeMax: 0.2,
        rng: makeRng(0x5EED1234 ^ 0xACC0FEED),
        accumulate: true, reducedMotion: true,
    });
    // Guard against exactly the bug that surfaced here: reducedMotion silently
    // discarding the gravity/wind/density set above. If a future engine
    // change stops overriding them, this scenario's drain timing assumptions
    // (sized for calm's SMALL gravity) go stale silently -- so the effective
    // config is asserted directly, not inferred from drain behaviour.
    check(e.config.gravity === SNOW_PRESETS.calm.gravity,
        () => `T12.retention: setup assumes reducedMotion overrides gravity to calm's ${SNOW_PRESETS.calm.gravity}, got ${e.config.gravity}`);
    check(e.config.wind === SNOW_PRESETS.calm.wind,
        () => `T12.retention: setup assumes reducedMotion overrides wind to calm's ${SNOW_PRESETS.calm.wind}, got ${e.config.wind}`);
    check(e.config.density === SNOW_PRESETS.calm.density,
        () => `T12.retention: setup assumes reducedMotion overrides density to calm's ${SNOW_PRESETS.calm.density}, got ${e.config.density}`);
    const ctx = makeMockCtx();
    const tracker = createLeakTracker({ name: 'snow-preset-soak' });
    const target = Math.floor(0.6 * MAXP);

    function liveCount() {
        const state = e.state;
        let n = 0;
        for (let i = 0; i < e.max; i++) if (state[i] !== 0) n++;
        return n;
    }

    let maxDrainSeen = 0;
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
            if (f > maxDrainSeen) maxDrainSeen = f;
            e.config.density = 40;
        }
        tracker.untrack(h);

        check(liveCount() === 0, () => `T12.retention: cycle ${c} pool not empty after drain (DRAIN_CAP=${DRAIN_CAP}, worst seen so far=${maxDrainSeen})`);
        const occ = occupancy(e);
        check(occ.free === e.max, () => `T12.retention: cycle ${c} occupancy free=${occ.free} != max=${e.max}`);
    }

    check(tracker.size() === 0, () => `T12.retention: lite-leak tracker leaked ${tracker.size()} resources across ${CYCLES} cycles`);
    check(e.pack !== null, () => 'T12.retention: pack must still be armed at the end (control setup broken -- reducedMotion must not silently disarm accumulate)');
    note(`T12.retention: worst-case drain took ${maxDrainSeen} frames over ${CYCLES} cycles (DRAIN_CAP=${DRAIN_CAP}, effective gravity=${e.config.gravity})`);
}

export function run() {
    sectionPresetDigests();
    sectionFlurryIsDefault();
    sectionSpawnBandMargin();
    sectionReducedMotion();
    sectionCalmnessMetric();
    sectionDomFree();
    sectionAllocGate();
    sectionRetention();
}

// --- standalone cross-process entry point -----------------------------------
// `node t12-presets.mjs --preset-digest <name>` prints the sha256 digest for
// the named SNOW_PRESETS member over PRESET_SCENARIO to stdout and nothing
// else (A15). sectionPresetDigests spawns this file as a SEPARATE OS process
// and diffs its stdout against the in-process digest.
if (process.argv[1] && process.argv[1].endsWith('t12-presets.mjs')) {
    if (process.argv[2] === '--preset-digest') {
        const name = process.argv[3];
        process.stdout.write(digestEngine(runPreset(name), SOA_NAMES) + '\n');
    }
}
