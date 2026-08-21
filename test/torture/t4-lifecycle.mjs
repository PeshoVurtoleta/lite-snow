/**
 * T4 -- lifecycle and hostile input.
 *
 * S2 fills this tier: every method is a safe no-op after destroy(), destroy()
 * releases config/colorStr and the four render-bin lists as well as the fourteen
 * SoA columns, a null or
 * malformed ctx is a no-op frame that never advances the clock, a draw call that
 * throws mid-render restores globalAlpha and RETHROWS while leaving the engine
 * usable, the render section writes only fillStyle and globalAlpha, spawn works
 * before any updateAndDraw, and the hostile maxParticles corpus throws a
 * RangeError BEFORE any typed-array is allocated.
 */

import { SnowEngine } from '../../SnowEngine.js';
import {
    SEED, makeRng, check, makeMockCtx, ThrowingCtx, makeProxyCtx,
    destroyReleasesAll, countersAgree, conservation,
} from './harness.mjs';

const W = 800;
const H = 600;
const DT = 0.016;

function liveCount(e) {
    const state = e.state;
    let n = 0;
    for (let i = 0; i < e.max; i++) if (state[i] !== 0) n++;
    return n;
}

export function run() {
    // ---- destroy() releases everything, and every method is a no-op after ----
    {
        const e = new SnowEngine(100, { density: 200, rng: makeRng(SEED) });
        e.spawn(DT, W, H);
        e.updateAndDraw(makeMockCtx(), DT, W, H);
        check(destroyReleasesAll(e),
            () => 'T4: destroyReleasesAll false -- destroy() did not release the full surface');
        check(countersAgree(e),
            () => 'T4: counters disagree after destroy (state null, counters must be 0)');

        // Every method a no-op now; none may throw, none may draw.
        const ctx = makeMockCtx();
        let threw = false;
        try {
            e.spawn(DT, W, H);
            e.updateAndDraw(ctx, DT, W, H);
            e.clear();     // clear() after destroy is a no-op
            e.destroy();   // double destroy is a no-op
        } catch (err) {
            threw = true;
        }
        check(!threw, () => 'T4: a method threw after destroy()');
        check(ctx.nFill === 0, () => `T4: updateAndDraw drew ${ctx.nFill} fills after destroy()`);
        check(e.state === null, () => 'T4: state resurrected after a post-destroy call');
    }

    // ---- updateAndDraw(null, ...) is a no-op frame: no throw, clock unmoved ----
    {
        const e = new SnowEngine(100, { density: 100, rng: makeRng(SEED) });
        e.spawn(DT, W, H);
        const ctx = makeMockCtx();
        e.updateAndDraw(ctx, DT, W, H); // one good frame to advance the clock
        const t = e._elapsedTime;
        ctx.reset();
        let threw = false;
        try { e.updateAndDraw(null, DT, W, H); } catch (err) { threw = true; }
        check(!threw, () => 'T4: updateAndDraw(null, ...) threw');
        check(e._elapsedTime === t, () => 'T4: updateAndDraw(null, ...) advanced the clock');
        check(ctx.nFill === 0, () => `T4: updateAndDraw(null, ...) drew ${ctx.nFill} fills (want 0)`);
    }

    // ---- a ctx missing ellipse, or missing arc, is a no-op frame -------------
    {
        const noEllipse = { arc() {}, beginPath() {}, moveTo() {}, fill() {}, fillStyle: '', globalAlpha: 1 };
        const noArc = { ellipse() {}, beginPath() {}, moveTo() {}, fill() {}, fillStyle: '', globalAlpha: 1 };
        for (const ctx of [noEllipse, noArc]) {
            const e = new SnowEngine(100, { density: 100, rng: makeRng(SEED) });
            e.spawn(DT, W, H);
            const t0 = e._elapsedTime;
            let threw = false;
            try { e.updateAndDraw(ctx, DT, W, H); } catch (err) { threw = true; }
            check(!threw, () => 'T4: a ctx missing ellipse/arc threw');
            check(e._elapsedTime === t0, () => 'T4: a malformed ctx advanced the clock');
        }
    }

    // ---- a draw that throws mid-render: alpha 1.0, engine usable next frame ---
    for (const throwOn of [1, 7]) {
        const e = new SnowEngine(200, { gravity: 40, wind: 0, density: 400, rng: makeRng(SEED) });
        e.spawn(DT, W, H); // fill densely so bucket 0 has well over 7 arcs
        const ctx = new ThrowingCtx(throwOn);
        let threw = false;
        try { e.updateAndDraw(ctx, DT, W, H); } catch (err) { threw = true; }
        check(threw, () => `T4: ThrowingCtx(${throwOn}) did not propagate -- engine swallowed the throw`);
        check(ctx.globalAlpha === 1.0,
            () => `T4: globalAlpha left at ${ctx.globalAlpha} after a thrown arc() on call ${throwOn}`);
        // The engine must still run a clean frame afterwards.
        const good = makeMockCtx();
        let threw2 = false;
        try { e.updateAndDraw(good, DT, W, H); } catch (err) { threw2 = true; }
        check(!threw2, () => `T4: engine unusable after a thrown arc() on call ${throwOn}`);
        check(good.nFill > 0, () => `T4: the recovery frame drew nothing after throwOn=${throwOn}`);
        check(countersAgree(e), () => `T4: counters disagree after a mid-render throw (throwOn=${throwOn})`);
    }

    // ---- Proxy ctx: the engine writes EXACTLY fillStyle and globalAlpha -------
    {
        const e = new SnowEngine(200, { gravity: 40, wind: 0, density: 400, rng: makeRng(SEED) });
        e.spawn(DT, W, H);
        const { ctx, setKeys } = makeProxyCtx();
        e.updateAndDraw(ctx, DT, W, H);
        check(setKeys.size === 2 && setKeys.has('fillStyle') && setKeys.has('globalAlpha'),
            () => `T4: render set-key set is {${[...setKeys].join(',')}} (want exactly fillStyle, globalAlpha)`);
    }

    // ---- spawn() before any updateAndDraw() ---------------------------------
    {
        const e = new SnowEngine(100, { density: 200, rng: makeRng(SEED) });
        e.spawn(DT, W, H);
        check(liveCount(e) > 0, () => 'T4: spawn() before any frame produced no live flakes');
        check(countersAgree(e), () => 'T4: counters disagree after a bare spawn()');
        check(conservation(e), () => 'T4: pool not conserved after a bare spawn()');
    }

    // ---- hostile maxParticles: each throws RangeError with the value in msg ---
    {
        const bad = [0, -1, 2.5, NaN, Infinity, 1e9, '100'];
        const t0 = performance.now();
        for (let k = 0; k < bad.length; k++) {
            const v = bad[k];
            let isRange = false, msg = '';
            try {
                new SnowEngine(v, {});
            } catch (err) {
                isRange = err instanceof RangeError;
                msg = err && err.message ? err.message : '';
            }
            check(isRange, () => `T4: maxParticles=${String(v)} did not throw a RangeError`);
            check(msg.indexOf(String(v)) !== -1,
                () => `T4: maxParticles=${String(v)} message omits the value: "${msg}"`);
        }
        const elapsed = performance.now() - t0;
        // 1e9 must be rejected by the integer guard BEFORE any typed-array of
        // that size is allocated. The whole corpus is well under 50 ms if so.
        check(elapsed < 50,
            () => `T4: hostile maxParticles corpus took ${elapsed.toFixed(1)} ms (want < 50 -- 1e9 allocated before throwing?)`);

        const one = new SnowEngine(1, {});
        check(one.state.length === 1, () => `T4: SnowEngine(1) state.length ${one.state.length} (want 1)`);
    }

    // ---- SN-07: a jitter that drives radius negative is clamped, not drawn ----
    //
    // ORDER IS LOAD-BEARING. rng()=0 puts every flake at x = -windOffset = -450,
    // which S1's own positive-liveness cull kills on the first frame. Asserting
    // the radii AFTER a frame therefore iterated over an empty pool and passed
    // no matter what the engine did -- a mutation that deleted the clamp
    // outright survived. Assert on the pool the spawn produced, and pin the live
    // count first so this can never go vacuous again.
    {
        const e = new SnowEngine(200, { baseRadius: 0.1, density: 500, rng: () => 0 });
        e.spawn(DT, W, H); // rng()=0 -> jitter -0.4, base+jitter -0.3 -> r<0 pre-clamp
        const radius = e.radius, state = e.state;
        let live = 0;
        for (let i = 0; i < e.max; i++) {
            if (state[i] !== 0) {
                live++;
                check(radius[i] > 0, () => `T4: SN-07 radius[${i}]=${radius[i]} not > 0`);
            }
        }
        check(live > 0, () => 'T4: SN-07 spawned nothing -- the radius assertion was vacuous');

        // Now the frame. makeMockCtx() throws IndexSizeError on a negative
        // radius exactly as a real canvas does, so this has teeth.
        const ctx = makeMockCtx();
        let threw = false;
        try { e.updateAndDraw(ctx, DT, W, H); } catch (err) { threw = true; }
        check(!threw, () => 'T4: SN-07 full frame threw (negative radius reached ctx.arc)');
    }

    // ---- SN-18: the cull transition maintains fallingCount ----
    //
    // The counter suite drove everything to SETTLE (high gravity), so the
    // 1 -> 0 cull decrement was never exercised with counters watching and a
    // mutation deleting it survived. Strong wind walks flakes off the right
    // edge instead, which is the cull path and nothing else.
    {
        const e = new SnowEngine(256, {
            gravity: 5, wind: 6000, density: 400, rng: makeRng(SEED),
        });
        const ctx = makeMockCtx();
        e.spawn(DT, W, H);
        const spawned = liveCount(e);
        check(spawned > 0, () => 'T4: SN-18 cull case spawned nothing');

        let culled = 0;
        for (let f = 0; f < 40; f++) {
            const before = liveCount(e);
            e.updateAndDraw(ctx, DT, W, H);
            culled += before - liveCount(e);
            check(countersAgree(e),
                () => `T4: SN-18 counters disagree after cull frame ${f}`);
        }
        check(culled > 0,
            () => 'T4: SN-18 no flake was culled -- the cull-counter assertion was vacuous');
        check(e.meltingCount === 0,
            () => `T4: SN-18 cull case settled ${e.meltingCount} flakes -- not a pure cull path`);
    }
}
