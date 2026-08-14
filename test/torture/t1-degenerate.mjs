/**
 * T1 -- degenerate values.
 *
 * S0 SCOPE: this tier REGISTERS the five S1 silent-corruption findings
 * (SN-01..SN-05) as non-fatal known-issue reproductions. Each runs its exact
 * documented repro against today's engine, confirms the bug is present, and
 * records it on stderr WITHOUT failing the run -- S0 makes the bugs visible and
 * reproducible; S1 fixes them and promotes these to live, fatal assertions.
 *
 * The full degenerate-value matrix (the nasty dt / w / h / gravity / rng / color
 * / maxParticles cross-product from roadmap section 3) lands in S1 alongside the
 * door that closes these holes. Do NOT add fatal degenerate gates here: the S0
 * contract is that `npm run torture` prints "ok" and exits 0 against the buggy
 * engine.
 */

import { SnowEngine } from '../../SnowEngine.js';
import { SEED, makeRng, note, makeMockCtx, occupancy } from './harness.mjs';

/**
 * Record a known-issue reproduction. Never fatal in S0. When `reproduced` is
 * true the bug is present as documented; when it flips false a later session
 * has healed it and the case should be promoted to a live gate.
 */
function known(id, reproduced, desc) {
    if (reproduced) {
        note(id + ' reproduced (known S1 issue): ' + desc);
    } else {
        note(id + ' no longer reproduces -- promote to a live gate: ' + desc);
    }
}

export function run() {
    const ctx = makeMockCtx();

    // --- SN-01: a NaN dt permanently poisons the whole engine ---------------
    // NaN > 0.1 is false, so the clamp is a hole; _elapsedTime += NaN is NaN
    // forever, and no later good frame heals it.
    let sn01 = false;
    try {
        const e = new SnowEngine(200, { density: 100, rng: makeRng(SEED) });
        e.spawn(0.016, 800, 600);
        e.updateAndDraw(ctx, NaN, 800, 600);
        e.updateAndDraw(ctx, 0.016, 800, 600); // a "good" frame cannot heal it
        sn01 = !Number.isFinite(e._elapsedTime);
    } catch (err) {
        note('SN-01 repro threw: ' + (err && err.message));
    }
    known('SN-01', sn01,
        'updateAndDraw(ctx,NaN,w,h) leaves _elapsedTime NaN; every live x/y NaN thereafter');

    // --- SN-02: a NaN w/h makes one spawn() fill the entire pool -------------
    // areaModifier -> NaN -> targetSpawns NaN; neither the <=0 guard nor the
    // cap fires, so the loop runs to `max`.
    let sn02 = false;
    try {
        const e = new SnowEngine(); // default max 10000
        e.spawn(0.016, NaN, 600);
        sn02 = occupancy(e).falling === e.max;
    } catch (err) {
        note('SN-02 repro threw: ' + (err && err.message));
    }
    known('SN-02', sn02,
        'spawn(0.016,NaN,600) sets all max slots to state 1 in a single call');

    // --- SN-03: gravity:0 NaN-poisons every flake at spawn ------------------
    // windOffset = (h/0)*|wind| = Infinity; x = rng()*(w+Inf) - Inf = NaN.
    let sn03 = false;
    try {
        const e = new SnowEngine(10, { gravity: 0, density: 200, rng: makeRng(SEED) });
        e.spawn(1, 800, 600);
        let idx = -1;
        for (let i = 0; i < e.max; i++) { if (e.state[i] === 1) { idx = i; break; } }
        sn03 = idx >= 0 && Number.isNaN(e.x[idx]);
    } catch (err) {
        note('SN-03 repro threw: ' + (err && err.message));
    }
    known('SN-03', sn03,
        'new SnowEngine(10,{gravity:0}).spawn(1,800,600) leaves spawned x NaN');

    // --- SN-04: a NaN particle is immortal and its slot is leaked forever ---
    // The cull (x<-200||x>w+200||y<-200) is false for NaN, and y>=h is false,
    // so the slot never recycles.
    let sn04 = false;
    try {
        const e = new SnowEngine(100, { density: 200, rng: makeRng(SEED) });
        e.spawn(0.016, 800, 600);
        let idx = -1;
        for (let i = 0; i < e.max; i++) { if (e.state[i] === 1) { idx = i; break; } }
        if (idx >= 0) {
            e.x[idx] = NaN; // hand-poison one live slot
            for (let f = 0; f < 200; f++) e.updateAndDraw(ctx, 0.016, 800, 600);
            sn04 = e.state[idx] === 1; // still falling after 200 frames = immortal
        }
    } catch (err) {
        note('SN-04 repro threw: ' + (err && err.message));
    }
    known('SN-04', sn04,
        'a hand-poisoned e.x[i]=NaN slot stays state 1 after 200 frames (slot leaked)');

    // --- SN-05: negative dt is unclamped and runs the simulation backwards --
    // dt > 0.1 bounds only the top; dt = -1 walks _elapsedTime and positions
    // backwards.
    let sn05 = false;
    try {
        const e = new SnowEngine(200, { density: 100, rng: makeRng(SEED) });
        e.spawn(0.016, 800, 600);
        const before = occupancy(e).falling;
        e.updateAndDraw(ctx, -1, 800, 600);
        const after = occupancy(e).falling;
        sn05 = e._elapsedTime < 0; // the clock ran backwards
        note('SN-05 detail: live falling ' + before + ' -> ' + after +
            ', _elapsedTime=' + e._elapsedTime);
    } catch (err) {
        note('SN-05 repro threw: ' + (err && err.message));
    }
    known('SN-05', sn05,
        'updateAndDraw(ctx,-1,800,600) drives _elapsedTime negative (simulation runs backwards)');
}
