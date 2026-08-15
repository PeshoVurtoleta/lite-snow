/**
 * T0 -- metamorphic laws and determinism.
 *
 * Properties that must hold for ANY well-formed scene, checked over a seeded
 * schedule. These are the invariants every later session must preserve:
 *
 *   - Determinism: two engines, same seed, same frame schedule -> all twelve
 *     SoA arrays bit-identical.
 *   - Precompute identities: gz[i]=gravity*z[i], wz[i]=wind*z[i],
 *     driftAmp[i]=driftAmplitude*z[i] (f32-exact) for every live slot.
 *   - z[i] in [0.2,1.0]; bucket[i] agrees with the <0.4/<0.7/else thresholds.
 *   - Conservation: free+falling+melting === max after every frame, every
 *     state[i] in {0,1,2}.
 *   - Monotonicity: a melting slot's life[i] strictly decreases.
 *   - Spawn bound: one spawn(dt,w,h) raises the live count by at most
 *     floor(areaModifier * density * dt * 60). This is the SN-02 detector
 *     stated as a law -- with VALID inputs it holds today; the degenerate
 *     inputs that break it live in T1.
 *
 * All inputs here are finite and in-range: T0 proves the engine is correct on
 * good data. Degenerate data is T1's job.
 */

import { SnowEngine } from '../../SnowEngine.js';
import { SEED, makeRng, check, makeMockCtx, conservation, spawnBoundHolds } from './harness.mjs';

const MAX = 400;
const FRAMES = 200;
const DT = 0.05;
const W = 800;
const H = 600;

function makeEngine(seed) {
    return new SnowEngine(MAX, {
        gravity: 40, wind: 30, density: 20,
        driftAmplitude: 15, driftFreq: 1.0,
        meltTimeMin: 0.5, meltTimeMax: 1.0,
        rng: makeRng(seed),
    });
}

export function run() {
    // --- Law 1: determinism + per-frame conservation -----------------------
    const a = makeEngine(SEED);
    const b = makeEngine(SEED);
    const ctxA = makeMockCtx();
    const ctxB = makeMockCtx();

    for (let f = 0; f < FRAMES; f++) {
        a.spawn(DT, W, H);
        a.updateAndDraw(ctxA, DT, W, H);
        b.spawn(DT, W, H);
        b.updateAndDraw(ctxB, DT, W, H);
        check(conservation(a),
            () => `T0.conservation: pool not conserved at frame ${f} (seed=${SEED})`);
    }

    // All twelve columns bit-identical between the two seeded engines.
    const names = ['x', 'y', 'z', 'gz', 'wz', 'bucket',
        'radius', 'driftPhase', 'driftSpeed', 'driftAmp', 'life', 'state'];
    for (let n = 0; n < names.length; n++) {
        const key = names[n];
        const arrA = a[key];
        const arrB = b[key];
        for (let i = 0; i < MAX; i++) {
            check(Object.is(arrA[i], arrB[i]),
                () => `T0.determinism: ${key}[${i}] diverged ${arrA[i]} vs ${arrB[i]} (seed=${SEED})`);
        }
    }

    // --- Law 2: precompute identities + z-range + bucket agreement ----------
    const g = a.config.gravity, wnd = a.config.wind, amp = a.config.driftAmplitude;
    for (let i = 0; i < MAX; i++) {
        if (a.state[i] === 0) continue;
        const z = a.z[i];
        check(z >= 0.2 && z <= 1.0,
            () => `T0.zrange: z[${i}]=${z} outside [0.2,1.0] (seed=${SEED})`);
        check(a.gz[i] === Math.fround(g * z),
            () => `T0.precompute: gz[${i}] != gravity*z (seed=${SEED})`);
        check(a.wz[i] === Math.fround(wnd * z),
            () => `T0.precompute: wz[${i}] != wind*z (seed=${SEED})`);
        check(a.driftAmp[i] === Math.fround(amp * z),
            () => `T0.precompute: driftAmp[${i}] != driftAmplitude*z (seed=${SEED})`);
        const wantBucket = z < 0.4 ? 0 : z < 0.7 ? 1 : 2;
        check(a.bucket[i] === wantBucket,
            () => `T0.bucket: bucket[${i}]=${a.bucket[i]} != ${wantBucket} for z=${z} (seed=${SEED})`);
    }

    // --- Law 3: melt-life monotonicity --------------------------------------
    // A slot that stays state 2 across a frame must have a strictly smaller
    // life afterwards (render alpha is life*const, so it is non-increasing too).
    const m = new SnowEngine(MAX, {
        gravity: 5000, wind: 0, density: 40,
        meltTimeMin: 1.0, meltTimeMax: 2.0,
        rng: makeRng(SEED ^ 0x55555555),
    });
    const ctxM = makeMockCtx();
    const stateBefore = new Uint8Array(MAX);
    const lifeBefore = new Float32Array(MAX);
    m.spawn(0.05, W, H);
    for (let f = 0; f < 8; f++) m.updateAndDraw(ctxM, 0.05, W, H); // settle some
    for (let f = 0; f < 20; f++) {
        stateBefore.set(m.state);
        lifeBefore.set(m.life);
        m.updateAndDraw(ctxM, 0.05, W, H);
        for (let i = 0; i < MAX; i++) {
            if (stateBefore[i] === 2 && m.state[i] === 2) {
                check(m.life[i] < lifeBefore[i],
                    () => `T0.monotone: life[${i}] did not decrease ${lifeBefore[i]} -> ${m.life[i]} (seed=${SEED})`);
            }
        }
    }

    // --- Law 4: spawn bound (the SN-02 detector, on VALID inputs) -----------
    // One spawn raises the live count by at most floor(areaModifier*density*dt*60).
    // Shares spawnBoundHolds with T9 control 4, so T0 and the control exercise the
    // same predicate on the same code path.
    const s = new SnowEngine(MAX, { density: 20, rng: makeRng(SEED ^ 0x0f0f0f0f) });
    check(spawnBoundHolds(s, 0.016, W, H),
        () => `T0.spawnbound: one spawn exceeded floor(areaModifier*density*dt*60) or dropped the live count (seed=${SEED})`);
}
