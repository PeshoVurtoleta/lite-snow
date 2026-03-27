import { describe, it, expect } from 'vitest';
import { SnowEngine, SNOW_PRESETS } from './SnowEngine.js';

const ctx = {
    clearRect() {}, beginPath() {}, moveTo() {},
    arc() {}, ellipse() {}, fill() {},
    globalAlpha: 1, fillStyle: '',
};

describe('SnowEngine', () => {
    it('constructs with defaults', () => {
        const e = new SnowEngine();
        expect(e.max).toBe(10000);
        expect(e.config.gravity).toBe(40);
        expect(e.config.wind).toBe(30);
        expect(e.config.density).toBe(10.0);
        expect(e.config.driftAmplitude).toBe(15);
    });

    it('pre-parses OKLCH color', () => {
        const e = new SnowEngine(100, { color: { l: 0.98, c: 0.02, h: 250 } });
        expect(typeof e.colorStr).toBe('string');
        expect(e.colorStr).toContain('oklch');
    });

    it('spawn creates flakes (state=1)', () => {
        const e = new SnowEngine(200, { density: 100 });
        e.spawn(0.016, 800, 600);
        let count = 0;
        for (let i = 0; i < 200; i++) if (e.state[i] === 1) count++;
        expect(count).toBeGreaterThan(0);
    });

    it('spawn precomputes gz, wz, radius, driftAmp, bucket', () => {
        const e = new SnowEngine(100, { density: 200, rng: () => 0.6 });
        e.spawn(0.016, 800, 600);
        let idx = -1;
        for (let i = 0; i < 100; i++) { if (e.state[i] === 1) { idx = i; break; } }
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(e.gz[idx]).toBeGreaterThan(0);
        expect(e.wz[idx]).toBeGreaterThan(0);
        expect(e.radius[idx]).toBeGreaterThan(0);
        expect(e.driftAmp[idx]).toBeGreaterThan(0);
        expect(e.bucket[idx]).toBeLessThanOrEqual(2);
    });

    it('z-depth in range [0.2, 1.0]', () => {
        const e = new SnowEngine(500, { density: 300 });
        e.spawn(0.016, 800, 600);
        for (let i = 0; i < 500; i++) {
            if (e.state[i] === 1) {
                expect(e.z[i]).toBeGreaterThanOrEqual(0.2);
                expect(e.z[i]).toBeLessThanOrEqual(1.0);
            }
        }
    });

    it('dimension cache only recalculates on size change', () => {
        const e = new SnowEngine(100, { density: 50 });
        e.spawn(0.016, 800, 600);
        const mod1 = e._areaModifier;
        e.spawn(0.016, 800, 600); // same size
        expect(e._areaModifier).toBe(mod1); // not recalculated
        e.spawn(0.016, 1024, 768); // different size
        expect(e._areaModifier).not.toBe(mod1); // recalculated
    });

    it('updateAndDraw runs without error', () => {
        const e = new SnowEngine(100, { density: 100 });
        e.spawn(0.016, 800, 600);
        expect(() => e.updateAndDraw(ctx, 0.016, 800, 600)).not.toThrow();
    });

    it('flakes become melt state on floor hit', () => {
        const e = new SnowEngine(100, { gravity: 5000, density: 200 });
        e.spawn(0.016, 800, 600);
        for (let i = 0; i < 120; i++) e.updateAndDraw(ctx, 0.016, 800, 600);
        let melting = 0;
        for (let i = 0; i < 100; i++) if (e.state[i] === 2) melting++;
        expect(melting).toBeGreaterThan(0);
    });

    it('off-screen X culling kills wind-blown flakes', () => {
        const e = new SnowEngine(100, { wind: 50000, density: 200 });
        e.spawn(0.016, 800, 600);
        // Run frames — extreme wind should blow flakes off screen
        for (let i = 0; i < 30; i++) e.updateAndDraw(ctx, 0.016, 800, 600);
        let alive = 0;
        for (let i = 0; i < 100; i++) if (e.state[i] !== 0) alive++;
        // Most should be culled by now
        expect(alive).toBeLessThan(50);
    });

    it('dt clamping in spawn', () => {
        const e = new SnowEngine(500, { density: 2 });
        e.spawn(10.0, 800, 600);
        let count = 0;
        for (let i = 0; i < 500; i++) if (e.state[i] !== 0) count++;
        expect(count).toBeLessThan(500);
    });

    it('dt clamping in updateAndDraw', () => {
        const e = new SnowEngine(100, { density: 100 });
        e.spawn(0.016, 800, 600);
        expect(() => e.updateAndDraw(ctx, 5.0, 800, 600)).not.toThrow();
    });

    it('clear kills all', () => {
        const e = new SnowEngine(100, { density: 200 });
        e.spawn(0.016, 800, 600);
        e.clear();
        let alive = 0;
        for (let i = 0; i < 100; i++) if (e.state[i] !== 0) alive++;
        expect(alive).toBe(0);
    });

    it('destroy nulls all 12 arrays', () => {
        const e = new SnowEngine(100);
        e.destroy();
        expect(e.x).toBeNull();
        expect(e.gz).toBeNull();
        expect(e.driftPhase).toBeNull();
        expect(e.state).toBeNull();
    });

    it('destroy is idempotent', () => {
        const e = new SnowEngine(100);
        e.destroy();
        expect(() => e.destroy()).not.toThrow();
    });
});

describe('SNOW_PRESETS', () => {
    it('has 3 presets', () => {
        expect(Object.keys(SNOW_PRESETS).length).toBe(3);
    });

    it('flurry has low density', () => {
        expect(SNOW_PRESETS.flurry.density).toBe(10.0);
    });

    it('blizzard has high wind', () => {
        expect(SNOW_PRESETS.blizzard.wind).toBe(400);
    });

    it('presets work as constructor config', () => {
        const e = new SnowEngine(1000, SNOW_PRESETS.heavy);
        expect(e.config.density).toBe(24.0);
        expect(e.config.wind).toBe(150);
    });
});
