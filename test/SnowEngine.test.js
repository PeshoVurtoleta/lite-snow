/**
 * @zakkster/lite-snow -- unit tests (Node built-in test runner).
 *
 *   npm test            # node --expose-gc --test test/*.test.js
 *
 * Ported to node:test (S0). Two things changed and nothing else: the runner is
 * now `node:test` + `node:assert/strict`, and the SN-25 case
 * (`destroy nulls all 12 arrays`) now loops all twelve SoA column names instead
 * of spot-checking four. Every original assertion is preserved.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SnowEngine, SNOW_PRESETS, VERSION } from '../SnowEngine.js';

const ctx = {
    clearRect() {}, beginPath() {}, moveTo() {},
    arc() {}, ellipse() {}, fill() {},
    globalAlpha: 1, fillStyle: '',
};

describe('SnowEngine', () => {
    test('constructs with defaults', () => {
        const e = new SnowEngine();
        assert.equal(e.max, 10000);
        assert.equal(e.config.gravity, 40);
        assert.equal(e.config.wind, 30);
        assert.equal(e.config.density, 10.0);
        assert.equal(e.config.driftAmplitude, 15);
    });

    test('pre-parses OKLCH color', () => {
        const e = new SnowEngine(100, { color: { l: 0.98, c: 0.02, h: 250 } });
        assert.equal(typeof e.colorStr, 'string');
        assert.ok(e.colorStr.includes('oklch'), 'colorStr should contain "oklch"');
    });

    test('spawn creates flakes (state=1)', () => {
        const e = new SnowEngine(200, { density: 100 });
        e.spawn(0.016, 800, 600);
        let count = 0;
        for (let i = 0; i < 200; i++) if (e.state[i] === 1) count++;
        assert.ok(count > 0, 'spawn should create at least one falling flake');
    });

    test('spawn precomputes gz, wz, radius, driftAmp, bucket', () => {
        const e = new SnowEngine(100, { density: 200, rng: () => 0.6 });
        e.spawn(0.016, 800, 600);
        let idx = -1;
        for (let i = 0; i < 100; i++) { if (e.state[i] === 1) { idx = i; break; } }
        assert.ok(idx >= 0, 'at least one flake should be spawned');
        assert.ok(e.gz[idx] > 0, 'gz should be positive');
        assert.ok(e.wz[idx] > 0, 'wz should be positive');
        assert.ok(e.radius[idx] > 0, 'radius should be positive');
        assert.ok(e.driftAmp[idx] > 0, 'driftAmp should be positive');
        assert.ok(e.bucket[idx] <= 2, 'bucket should be <= 2');
    });

    test('z-depth in range [0.2, 1.0]', () => {
        const e = new SnowEngine(500, { density: 300 });
        e.spawn(0.016, 800, 600);
        for (let i = 0; i < 500; i++) {
            if (e.state[i] === 1) {
                assert.ok(e.z[i] >= 0.2, 'z should be >= 0.2');
                assert.ok(e.z[i] <= 1.0, 'z should be <= 1.0');
            }
        }
    });

    test('dimension cache only recalculates on size change', () => {
        const e = new SnowEngine(100, { density: 50 });
        e.spawn(0.016, 800, 600);
        const mod1 = e._areaModifier;
        e.spawn(0.016, 800, 600); // same size
        assert.equal(e._areaModifier, mod1); // not recalculated
        e.spawn(0.016, 1024, 768); // different size
        assert.notEqual(e._areaModifier, mod1); // recalculated
    });

    test('updateAndDraw runs without error', () => {
        const e = new SnowEngine(100, { density: 100 });
        e.spawn(0.016, 800, 600);
        assert.doesNotThrow(() => e.updateAndDraw(ctx, 0.016, 800, 600));
    });

    test('flakes become melt state on floor hit', () => {
        const e = new SnowEngine(100, { gravity: 5000, density: 200 });
        e.spawn(0.016, 800, 600);
        for (let i = 0; i < 120; i++) e.updateAndDraw(ctx, 0.016, 800, 600);
        let melting = 0;
        for (let i = 0; i < 100; i++) if (e.state[i] === 2) melting++;
        assert.ok(melting > 0, 'some flakes should be melting after 120 frames');
    });

    test('off-screen X culling kills wind-blown flakes', () => {
        const e = new SnowEngine(100, { wind: 50000, density: 200 });
        e.spawn(0.016, 800, 600);
        // Run frames -- extreme wind should blow flakes off screen
        for (let i = 0; i < 30; i++) e.updateAndDraw(ctx, 0.016, 800, 600);
        let alive = 0;
        for (let i = 0; i < 100; i++) if (e.state[i] !== 0) alive++;
        // Most should be culled by now
        assert.ok(alive < 50, 'most wind-blown flakes should be culled');
    });

    test('dt clamping in spawn', () => {
        const e = new SnowEngine(500, { density: 2 });
        e.spawn(10.0, 800, 600);
        let count = 0;
        for (let i = 0; i < 500; i++) if (e.state[i] !== 0) count++;
        assert.ok(count < 500, 'clamped dt should not fill the whole pool');
    });

    test('dt clamping in updateAndDraw', () => {
        const e = new SnowEngine(100, { density: 100 });
        e.spawn(0.016, 800, 600);
        assert.doesNotThrow(() => e.updateAndDraw(ctx, 5.0, 800, 600));
    });

    test('clear kills all', () => {
        const e = new SnowEngine(100, { density: 200 });
        e.spawn(0.016, 800, 600);
        e.clear();
        let alive = 0;
        for (let i = 0; i < 100; i++) if (e.state[i] !== 0) alive++;
        assert.equal(alive, 0);
    });

    test('destroy nulls all 12 arrays', () => {
        // SN-25: this test is named for twelve arrays and must exercise all
        // twelve. The pre-S0 version asserted only x, gz, driftPhase and state,
        // leaving eight columns (y, z, wz, bucket, radius, driftSpeed, driftAmp,
        // life) as a green light over a hole. Loop every SoA column name from
        // llms.txt:15 so the coverage cannot be trimmed back to four.
        const SOA_NAMES = [
            'x', 'y', 'z', 'gz', 'wz', 'bucket',
            'radius', 'driftPhase', 'driftSpeed', 'driftAmp', 'life', 'state',
        ];
        const e = new SnowEngine(100);
        e.destroy();
        for (const name of SOA_NAMES) {
            assert.equal(e[name], null, `destroy() must null e.${name}`);
        }
    });

    test('destroy is idempotent', () => {
        const e = new SnowEngine(100);
        e.destroy();
        assert.doesNotThrow(() => e.destroy());
    });
});

describe('SNOW_PRESETS', () => {
    test('has 3 presets', () => {
        assert.equal(Object.keys(SNOW_PRESETS).length, 3);
    });

    test('flurry has low density', () => {
        assert.equal(SNOW_PRESETS.flurry.density, 10.0);
    });

    test('blizzard has high wind', () => {
        assert.equal(SNOW_PRESETS.blizzard.wind, 400);
    });

    test('presets work as constructor config', () => {
        const e = new SnowEngine(1000, SNOW_PRESETS.heavy);
        assert.equal(e.config.density, 24.0);
        assert.equal(e.config.wind, 150);
    });
});

/**
 * S0 boundary suite (QA). These pin behaviour that ALREADY holds today -- they
 * are not a wish list. Nothing here may assert on SN-01..SN-05, which are live
 * known issues until S1; a failing case here would break the S0 gate.
 */
describe('boundary', () => {
    test('VERSION is exported and agrees with package.json (three-place sync)', () => {
        const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        assert.equal(typeof VERSION, 'string');
        assert.equal(VERSION, '1.1.0');
        assert.equal(VERSION, pkg.version, 'VERSION const and package.json disagree');
    });

    test('bucket[i] agrees with the z thresholds for every live slot', () => {
        // Pins the <0.4 / <0.7 / else split at SnowEngine.js:92 so a refactor
        // cannot silently re-tier the depth buckets.
        const e = new SnowEngine(500, { density: 300 });
        e.spawn(0.016, 800, 600);
        let checked = 0;
        for (let i = 0; i < 500; i++) {
            if (e.state[i] !== 1) continue;
            const z = e.z[i];
            const expected = z < 0.4 ? 0 : z < 0.7 ? 1 : 2;
            assert.equal(e.bucket[i], expected, `slot ${i} z=${z}`);
            checked++;
        }
        assert.ok(checked > 0, 'no live slots were checked -- test would be vacuous');
    });

    test('density 0 spawns nothing', () => {
        const e = new SnowEngine(100, { density: 0 });
        e.spawn(0.016, 800, 600);
        let alive = 0;
        for (let i = 0; i < 100; i++) if (e.state[i] !== 0) alive++;
        assert.equal(alive, 0);
    });

    test('clear() then spawn() repopulates the pool', () => {
        const e = new SnowEngine(100, { density: 200 });
        e.spawn(0.016, 800, 600);
        e.clear();
        let alive = 0;
        for (let i = 0; i < 100; i++) if (e.state[i] !== 0) alive++;
        assert.equal(alive, 0, 'clear() did not empty the pool');
        e.spawn(0.016, 800, 600);
        for (let i = 0; i < 100; i++) if (e.state[i] !== 0) alive++;
        assert.ok(alive > 0, 'pool did not repopulate after clear()');
    });

    test('every method is a safe no-op after destroy()', () => {
        const e = new SnowEngine(100, { density: 200 });
        e.spawn(0.016, 800, 600);
        e.destroy();
        assert.doesNotThrow(() => e.spawn(0.016, 800, 600));
        assert.doesNotThrow(() => e.updateAndDraw(ctx, 0.016, 800, 600));
        assert.doesNotThrow(() => e.clear());
        assert.doesNotThrow(() => e.destroy());
        assert.equal(e.state, null, 'destroy() should leave the SoA columns released');
    });

    test('preset fields are exactly the documented values', () => {
        assert.deepEqual(SNOW_PRESETS.flurry,
            { density: 10.0, wind: 30, gravity: 40, driftAmplitude: 15, baseRadius: 2.5 });
        assert.deepEqual(SNOW_PRESETS.heavy,
            { density: 24.0, wind: 150, gravity: 80, driftAmplitude: 25, baseRadius: 3.5 });
        assert.deepEqual(SNOW_PRESETS.blizzard,
            { density: 40.0, wind: 400, gravity: 250, driftAmplitude: 50, baseRadius: 2.0 });
    });
});

/**
 * S1 fail-closed door. Promotes SN-01..SN-05 from known-issue reproductions to
 * fatal assertions. Each asserts on the SoA arrays / clock, never on a return
 * value: the door draws NOTHING on a rejected frame, so a return value carries
 * no signal.
 */
describe('S1 fail-closed door', () => {
    const SOA = [
        'x', 'y', 'z', 'gz', 'wz', 'bucket',
        'radius', 'driftPhase', 'driftSpeed', 'driftAmp', 'life', 'state',
    ];

    // Seeded xorshift32 -> [0,1). Deterministic across runs.
    function seeded(seed) {
        let s = (seed >>> 0) || 1;
        return function rng() {
            s ^= s << 13; s >>>= 0;
            s ^= s >> 17;
            s ^= s << 5; s >>>= 0;
            return s / 4294967296;
        };
    }

    function liveCount(e) {
        let n = 0;
        for (let i = 0; i < e.max; i++) if (e.state[i] !== 0) n++;
        return n;
    }

    function conserv(e) {
        let free = 0, falling = 0, melting = 0;
        for (let i = 0; i < e.max; i++) {
            const s = e.state[i];
            if (s === 0) free++;
            else if (s === 1) falling++;
            else if (s === 2) melting++;
            else return false;
        }
        return free + falling + melting === e.max;
    }

    test('SN-01: a NaN dt neither advances the clock nor poisons the pool', () => {
        const e = new SnowEngine(200, { density: 100, rng: seeded(0x1234) });
        e.spawn(0.016, 800, 600);
        e.updateAndDraw(ctx, NaN, 800, 600);
        for (let f = 0; f < 100; f++) e.updateAndDraw(ctx, 0.016, 800, 600);
        assert.ok(Number.isFinite(e._elapsedTime), '_elapsedTime must stay finite');
        for (let i = 0; i < e.max; i++) {
            if (e.state[i] !== 0) {
                assert.ok(Number.isFinite(e.x[i]), `x[${i}] must be finite`);
                assert.ok(Number.isFinite(e.y[i]), `y[${i}] must be finite`);
            }
        }
    });

    test('SN-02: degenerate w/h cannot overfill the pool', () => {
        const e = new SnowEngine(10000, { density: 100, rng: seeded(0x5678) });
        e.spawn(0.016, NaN, 600);
        assert.equal(liveCount(e), 0, 'NaN w must spawn nothing');
        e.spawn(0.016, 0, 600);
        assert.equal(liveCount(e), 0, 'zero w must spawn nothing');
    });

    test('SN-03: gravity 0 spawns finite x within [0, w]', () => {
        const e = new SnowEngine(10, { gravity: 0, density: 200, rng: seeded(0x9abc) });
        e.spawn(1, 800, 600);
        let checked = 0;
        for (let i = 0; i < e.max; i++) {
            if (e.state[i] === 1) {
                assert.ok(Number.isFinite(e.x[i]), `x[${i}] must be finite`);
                assert.ok(e.x[i] >= 0 && e.x[i] <= 800, `x[${i}]=${e.x[i]} must be in [0,800]`);
                checked++;
            }
        }
        assert.ok(checked > 0, 'no live slots checked -- assertion would be vacuous');

        // gravity:-1 must render bit-identically to v1.0.1. The finite-gravity
        // windOffset formula is unchanged, so recompute the exact old value and
        // assert Object.is equality on every spawned x (f32-stored).
        const rec = [];
        const base = seeded(0xdef0);
        const recRng = () => { const v = base(); rec.push(v); return v; };
        const en = new SnowEngine(10, { gravity: -1, density: 200, rng: recRng });
        en.spawn(1, 800, 600);
        const windOffset = (600 / -1) * Math.abs(en.config.wind); // v1.0.1 formula
        let k = 0;
        for (let i = 0; i < en.max; i++) {
            if (en.state[i] === 1) {
                const expected = Math.fround(rec[6 * k] * (800 + windOffset * 2) - windOffset);
                assert.ok(Object.is(en.x[i], expected),
                    `slot ${i}: x=${en.x[i]} != v1.0.1 expected ${expected}`);
                assert.ok(Number.isFinite(en.x[i]), `x[${i}] must be finite`);
                k++;
            }
        }
        assert.ok(k > 0, 'no negative-gravity slots checked -- assertion would be vacuous');
    });

    test('SN-04: a hand-poisoned NaN slot recycles in one frame', () => {
        const e = new SnowEngine(8, { density: 400, rng: seeded(0x0f0f) });
        e.spawn(0.016, 800, 600); // high cap fills the whole 8-slot pool
        assert.equal(liveCount(e), 8, 'the pool should be full for a deterministic reuse test');
        e.x[0] = NaN; // hand-poison one live slot
        e.updateAndDraw(ctx, 0.016, 800, 600);
        assert.equal(e.state[0], 0, 'the NaN slot must recycle to free in one frame');
        assert.ok(conserv(e), 'pool conservation must hold after the cull');
        e.spawn(0.016, 800, 600); // only slot 0 is free -> it must be reused
        assert.notEqual(e.state[0], 0, 'the freed slot must be reused by the next spawn');
    });

    test('SN-05: negative dt is a total no-op', () => {
        const e = new SnowEngine(200, { density: 100, rng: seeded(0x2468) });
        e.spawn(0.016, 800, 600);
        e.updateAndDraw(ctx, 0.05, 800, 600); // advance to a non-trivial state
        // Twelve pre-allocated snapshots, taken once before the rejected frame.
        const snap = {};
        for (const name of SOA) snap[name] = e[name].slice();
        const elapsedBefore = e._elapsedTime;
        // A counting ctx: a rejected frame must never reach the render section.
        const cctx = {
            clearRect() {}, beginPath() {}, moveTo() {},
            arc() {}, ellipse() {}, fill() { this.nFill++; },
            globalAlpha: 1, fillStyle: '', nFill: 0,
        };
        e.updateAndDraw(cctx, -1, 800, 600);
        for (const name of SOA) {
            const before = snap[name];
            const after = e[name];
            for (let i = 0; i < e.max; i++) {
                assert.ok(Object.is(before[i], after[i]),
                    `${name}[${i}] changed on a negative-dt frame: ${before[i]} -> ${after[i]}`);
            }
        }
        assert.ok(Object.is(e._elapsedTime, elapsedBefore), '_elapsedTime must not move');
        assert.equal(cctx.nFill, 0, 'a rejected frame must draw nothing');
    });
});

/**
 * Two behaviours that the S1 mutation matrix proved NOTHING asserted on. Both
 * mutations ran green across the whole suite and every torture tier, which is
 * the definition of an untested behaviour:
 *
 *   - moving the spawn door BELOW the dimension-cache write survived, so the
 *     ordering the door depends on was load-bearing but unpinned;
 *   - deleting the cull's `y >= -200` term survived, so the y-axis leak guard
 *     (the negative-gravity path) was never exercised. That hole predates S1.
 *
 * Each test below is proven non-vacuous by the mutation it was written against.
 */
describe('S1 mutation-matrix holes', () => {
    function seeded(seed) {
        let s = (seed >>> 0) || 1;
        return function rng() {
            s ^= s << 13; s >>>= 0;
            s ^= s >> 17;
            s ^= s << 5; s >>>= 0;
            return s / 4294967296;
        };
    }

    function liveCount(e) {
        let n = 0;
        for (let i = 0; i < e.max; i++) if (e.state[i] !== 0) n++;
        return n;
    }

    test('a rejected spawn() cannot poison the dimension cache', () => {
        // The door must sit ABOVE the _lastW/_lastH/_areaModifier write. If it
        // sits below, a NaN w writes _areaModifier = NaN before the rejection.
        const e = new SnowEngine(100, { density: 50, rng: seeded(0x1111) });
        e.spawn(0.016, 800, 600); // prime the cache
        const w0 = e._lastW, h0 = e._lastH, m0 = e._areaModifier;
        assert.ok(Number.isFinite(m0) && m0 > 0,
            'the cache must be primed for this test to mean anything');

        e.spawn(0.016, NaN, 600);
        assert.ok(Object.is(e._lastW, w0), '_lastW moved on a NaN-w spawn');
        assert.ok(Object.is(e._lastH, h0), '_lastH moved on a NaN-w spawn');
        assert.ok(Object.is(e._areaModifier, m0), '_areaModifier poisoned by a NaN-w spawn');

        e.spawn(0.016, 800, 0);
        assert.ok(Object.is(e._areaModifier, m0), '_areaModifier moved on a zero-h spawn');

        // The cache still works: a genuine resize must still recompute.
        e.spawn(0.016, 1024, 768);
        assert.notEqual(e._areaModifier, m0, 'a real resize must still recompute the cache');
    });

    test('a flake that rises off the top is culled (y-axis leak)', () => {
        // Negative gravity makes gz negative, so y walks upward past -200. The
        // cull's `y >= -200` term is the only thing that recycles these slots;
        // without it they rise forever and the pool leaks.
        const e = new SnowEngine(64, {
            gravity: -400, wind: 0, density: 400, rng: seeded(0x2222),
        });
        e.spawn(0.016, 800, 600);
        assert.ok(liveCount(e) > 0, 'need live flakes for this test to mean anything');
        for (let i = 0; i < 200; i++) e.updateAndDraw(ctx, 0.016, 800, 600);
        assert.equal(liveCount(e), 0, 'every rising flake must be culled above y = -200');
    });
});

/**
 * S2 constructor validation, frozen presets, lifecycle release and telemetry.
 * Each case is written against a specific mutation from the S2 plan: relaxing
 * the maxParticles integer guard, deleting the baseRadius guard, freezing the
 * table but not its members, dropping clear()'s `_elapsedTime = 0`, re-inverting
 * destroy()'s flag/clear order, deleting any one counter update, or restoring the
 * em dash in the source.
 */
describe('S2 constructor, freeze, lifecycle, telemetry', () => {
    const SOA = [
        'x', 'y', 'z', 'gz', 'wz', 'bucket',
        'radius', 'driftPhase', 'driftSpeed', 'driftAmp', 'life', 'state',
    ];

    function seeded(seed) {
        let s = (seed >>> 0) || 1;
        return function rng() {
            s ^= s << 13; s >>>= 0;
            s ^= s >> 17;
            s ^= s << 5; s >>>= 0;
            return s / 4294967296;
        };
    }

    test('maxParticles: hostile values throw RangeError naming the value', () => {
        const bad = [0, -1, 2.5, NaN, Infinity, 1e9, '100'];
        for (const v of bad) {
            assert.throws(
                () => new SnowEngine(v, {}),
                (err) => err instanceof RangeError && err.message.includes(String(v)),
                `maxParticles=${String(v)} must throw a RangeError naming the value`);
        }
        const one = new SnowEngine(1);
        assert.equal(one.state.length, 1, 'SnowEngine(1) must allocate a 1-slot pool');
        assert.equal(new SnowEngine().max, 10000, 'the default max must stay 10000');
    });

    test('baseRadius: non-finite or <= 0 throws, 0.1 constructs', () => {
        for (const v of [0, -1, NaN, Infinity]) {
            assert.throws(
                () => new SnowEngine(100, { baseRadius: v }),
                (err) => err instanceof RangeError && err.message.includes(String(v)),
                `baseRadius=${String(v)} must throw`);
        }
        assert.doesNotThrow(() => new SnowEngine(100, { baseRadius: 0.1 }));
    });

    test('SNOW_PRESETS and every preset member are frozen', () => {
        assert.ok(Object.isFrozen(SNOW_PRESETS), 'the table must be frozen');
        assert.ok(Object.isFrozen(SNOW_PRESETS.flurry), 'flurry must be frozen');
        assert.ok(Object.isFrozen(SNOW_PRESETS.heavy), 'heavy must be frozen');
        assert.ok(Object.isFrozen(SNOW_PRESETS.blizzard), 'blizzard must be frozen');
        assert.throws(() => { SNOW_PRESETS.flurry.density = 999; }, TypeError);
    });

    test('clear() is a full reset: a cleared engine reproduces a fresh one bit-for-bit', () => {
        // gravity is huge so every flake settles in one frame -> all 12 columns
        // are written for all 8 slots, leaving no stale free-slot data to differ.
        // x depends on _elapsedTime through the drift sway, so a clear() that does
        // not reset the clock diverges here (the named mutation).
        const cfg = () => ({
            gravity: 100000, wind: 0, density: 1000, baseRadius: 2.5,
            driftAmplitude: 15, driftFreq: 1.0, meltTimeMin: 2.0, meltTimeMax: 5.0,
            rng: seeded(0xC0FFEE),
        });
        const A = new SnowEngine(8, cfg());
        A.spawn(0.1, 400, 10);
        A.updateAndDraw(ctx, 0.1, 400, 10);

        const B = new SnowEngine(8, cfg());
        for (let f = 0; f < 5; f++) { B.spawn(0.1, 400, 10); B.updateAndDraw(ctx, 0.1, 400, 10); }
        B.config.rng = seeded(0xC0FFEE); // realign the stream to A's position
        B.clear();
        B.spawn(0.1, 400, 10);
        B.updateAndDraw(ctx, 0.1, 400, 10);

        for (const name of SOA) {
            for (let i = 0; i < 8; i++) {
                assert.ok(Object.is(A[name][i], B[name][i]),
                    `${name}[${i}]: fresh ${A[name][i]} != cleared ${B[name][i]}`);
            }
        }
        assert.ok(Object.is(A._elapsedTime, B._elapsedTime), '_elapsedTime must match');
    });

    test('destroy() releases config, colorStr and the render bins and zeroes the clock', () => {
        const e = new SnowEngine(100, { density: 200 });
        e.spawn(0.016, 800, 600);
        e.updateAndDraw(ctx, 0.016, 800, 600);
        e.destroy();
        assert.equal(e.config, null, 'destroy() must null config');
        assert.equal(e.colorStr, null, 'destroy() must null colorStr');
        assert.equal(e._bin0, null, 'destroy() must null _bin0');
        assert.equal(e._bin1, null, 'destroy() must null _bin1');
        assert.equal(e._bin2, null, 'destroy() must null _bin2');
        assert.equal(e._binMelt, null, 'destroy() must null _binMelt');
        assert.equal(e._meltAlphaCount, null, 'destroy() must null _meltAlphaCount');
        assert.equal(e._elapsedTime, 0, 'destroy() must reset the clock via clear()');
        assert.equal(e._destroyed, true, 'destroy() must set the flag');
        assert.doesNotThrow(() => e.destroy(), 'double destroy() must be a no-op');
    });

    test('fallingCount / meltingCount / activeCount track the pool', () => {
        const e = new SnowEngine(200, {
            gravity: 5000, density: 300, meltTimeMin: 0.5, meltTimeMax: 1.0, rng: seeded(0x33),
        });
        e.spawn(0.016, 800, 600);
        assert.ok(e.fallingCount > 0, 'a bare spawn must raise fallingCount');
        assert.equal(e.meltingCount, 0, 'no flake has settled yet');
        assert.equal(e.activeCount, e.fallingCount + e.meltingCount);

        for (let i = 0; i < 80; i++) { e.spawn(0.016, 800, 600); e.updateAndDraw(ctx, 0.016, 800, 600); }
        let f = 0, m = 0;
        for (let i = 0; i < e.max; i++) {
            if (e.state[i] === 1) f++;
            else if (e.state[i] === 2) m++;
        }
        assert.equal(e.fallingCount, f, 'fallingCount must match a fresh recount');
        assert.equal(e.meltingCount, m, 'meltingCount must match a fresh recount');
        assert.equal(e.activeCount, f + m, 'activeCount must be the sum');

        e.clear();
        assert.equal(e.fallingCount, 0, 'clear() must zero fallingCount');
        assert.equal(e.meltingCount, 0, 'clear() must zero meltingCount');
        assert.equal(e.activeCount, 0, 'clear() must zero activeCount');
    });

    test('SnowEngine.js source is ASCII-only (U+00D7 and U+00B5 excepted)', () => {
        const src = readFileSync(new URL('../SnowEngine.js', import.meta.url), 'utf8');
        for (let i = 0; i < src.length; i++) {
            const cp = src.codePointAt(i);
            if (cp > 127 && cp !== 0x00D7 && cp !== 0x00B5) {
                assert.fail(`non-ASCII U+${cp.toString(16).toUpperCase()} at index ${i}`);
            }
        }
    });
});
