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
        assert.equal(VERSION, '1.0.1');
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
