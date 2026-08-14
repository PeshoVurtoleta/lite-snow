/**
 * @zakkster/lite-snow -- torture harness.
 *
 * Shared scratch, a seeded PRNG, the snow-specific mock canvas, the pool
 * conservation helpers, and the lite-gc-profiler gate wrapper. Every tier
 * imports from here so the discipline is enforced in one place -- the shape is
 * copied from LiteBvh/test/torture/harness.mjs, not reinvented:
 *
 *   - All scratch (engines, the mock ctx, index buffers) is allocated ONCE, by
 *     the tier, outside every loop. This module hands out helpers, never
 *     per-call allocations on a hot path.
 *   - `check()` builds its message string only on failure -- a template literal
 *     per iteration is an allocation and would fail the T6 gate.
 *   - The PRNG is a seeded xorshift32. On any failure a tier prints the seed so
 *     the case replays with `TORTURE_SEED=... npm run torture`.
 *   - lite-gc-profiler is one-measurement-at-a-time; tiers run sequentially,
 *     never nested. `runOpsGate` opens and closes a single window per call.
 *   - Unknown rule keys throw. There is no maxExternalGrowth. RULES is the whole
 *     vocabulary.
 *
 * @license MIT
 */

import { measureOps, checkNoGc } from '@zakkster/lite-gc-profiler';

/** Seed for every PRNG in the run. Override with TORTURE_SEED for replay. */
export const SEED = (() => {
    const raw = process.env.TORTURE_SEED;
    if (raw === undefined) return 0x9e3779b9;
    const n = Number(raw) >>> 0;
    return n === 0 ? 1 : n; // xorshift32 must not be seeded with 0
})();

/** Deliberately-broken control mode: injects a retained allocation into T6. */
export const BREAK = process.env.SNOW_TORTURE_BREAK === '1';

/** Base zero-GC rules. maxArrayBuffersGrowth needs measureOps `stabilize:'deep'`. */
export const RULES = { maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0 };

/** The twelve parallel SoA columns published by llms.txt:15. The layout contract. */
export const SOA_NAMES = [
    'x', 'y', 'z', 'gz', 'wz', 'bucket',
    'radius', 'driftPhase', 'driftSpeed', 'driftAmp', 'life', 'state',
];

/** Seeded xorshift32. Returns a function yielding a uint32 each call. */
export function makePrng(seed) {
    let x = (seed >>> 0) || 1;
    return function next() {
        x ^= x << 13; x >>>= 0;
        x ^= x >> 17;
        x ^= x << 5; x >>>= 0;
        return x >>> 0;
    };
}

/**
 * A seeded floating-point rng in [0, 1) suitable for SnowEngine's `config.rng`.
 * Built once per tier at setup; the returned closure allocates nothing per call.
 */
export function makeRng(seed) {
    const p = makePrng(seed);
    return function rng() {
        return p() / 4294967296; // 2**32
    };
}

/** Fail the whole gate. stdout stays clean; the reason goes to stderr. */
export function die(msg) {
    process.stderr.write('torture: FAIL -- ' + msg + '\n');
    process.exit(1);
}

/** A non-fatal note (known-issue reproductions, promotions). Never exits. */
export function note(msg) {
    process.stderr.write('torture: note -- ' + msg + '\n');
}

/**
 * Assertion whose message is built ONLY on failure. Pass a thunk, not a string,
 * so the happy path allocates nothing.
 * @param {boolean} cond
 * @param {() => string} msgThunk
 */
export function check(cond, msgThunk) {
    if (!cond) die(msgThunk());
}

/**
 * Snow-specific mock CanvasRenderingContext2D. Implements every member
 * SnowEngine's render section touches (fillStyle, globalAlpha, beginPath,
 * moveTo, arc, ellipse, fill) and counts each one. A missing method would throw
 * inside the melt loop and read as a fake tier failure, so all seven are real.
 *
 * It also keeps hash-neutral position accumulators (sumX / minX / maxY) so a
 * tier can prove direction and containment a bare draw-count cannot see. Every
 * member allocates NOTHING per call -- counters and accumulators are plain
 * fields mutated in place.
 */
export class MockCtx {
    constructor() {
        this._fillStyle = '';
        this._globalAlpha = 1;
        // Draw-call counters.
        this.nBeginPath = 0;
        this.nMoveTo = 0;
        this.nArc = 0;
        this.nEllipse = 0;
        this.nFill = 0;
        // State-write counters.
        this.nFillStyle = 0;
        this.nGlobalAlpha = 0;
        // Forbidden-call counters (llms.txt promises none of these).
        this.nClearRect = 0;
        this.nSave = 0;
        this.nRestore = 0;
        this.nSetTransform = 0;
        this.nScale = 0;
        // Hash-neutral position digest.
        this.sumX = 0;
        this.minX = Infinity;
        this.maxY = -Infinity;
    }

    get fillStyle() { return this._fillStyle; }
    set fillStyle(v) { this._fillStyle = v; this.nFillStyle++; }

    get globalAlpha() { return this._globalAlpha; }
    set globalAlpha(v) { this._globalAlpha = v; this.nGlobalAlpha++; }

    beginPath() { this.nBeginPath++; }
    moveTo(x, y) { this.nMoveTo++; }
    arc(x, y, r, a0, a1) {
        this.nArc++;
        this.sumX += x;
        if (x < this.minX) this.minX = x;
        if (y > this.maxY) this.maxY = y;
    }
    ellipse(x, y, rx, ry, rot, a0, a1) {
        this.nEllipse++;
        this.sumX += x;
        if (x < this.minX) this.minX = x;
        if (y > this.maxY) this.maxY = y;
    }
    fill() { this.nFill++; }
    // Forbidden calls: recorded so a tier can assert they never happen.
    clearRect() { this.nClearRect++; }
    save() { this.nSave++; }
    restore() { this.nRestore++; }
    setTransform() { this.nSetTransform++; }
    scale() { this.nScale++; }

    /** Zero every counter and accumulator in place. No allocation. */
    reset() {
        this.nBeginPath = 0; this.nMoveTo = 0; this.nArc = 0;
        this.nEllipse = 0; this.nFill = 0;
        this.nFillStyle = 0; this.nGlobalAlpha = 0;
        this.nClearRect = 0; this.nSave = 0; this.nRestore = 0;
        this.nSetTransform = 0; this.nScale = 0;
        this.sumX = 0; this.minX = Infinity; this.maxY = -Infinity;
    }
}

/** Convenience factory so tiers can read as `makeMockCtx()`. */
export function makeMockCtx() {
    return new MockCtx();
}

/**
 * Occupancy of the pool by state. O(max) -- test only, never a hot body.
 * @returns {{free:number, falling:number, melting:number}}
 */
export function occupancy(engine) {
    const state = engine.state;
    const max = engine.max;
    let free = 0, falling = 0, melting = 0;
    for (let i = 0; i < max; i++) {
        const s = state[i];
        if (s === 0) free++;
        else if (s === 1) falling++;
        else if (s === 2) melting++;
    }
    return { free, falling, melting };
}

/**
 * The pool conservation invariant: free + falling + melting === max, and every
 * state[i] is in {0,1,2}. O(max) -- test only.
 */
export function conservation(engine) {
    const state = engine.state;
    const max = engine.max;
    let free = 0, falling = 0, melting = 0;
    for (let i = 0; i < max; i++) {
        const s = state[i];
        if (s === 0) free++;
        else if (s === 1) falling++;
        else if (s === 2) melting++;
        else return false; // a state outside {0,1,2} is corruption
    }
    return free + falling + melting === max;
}

/**
 * Run `fn(i)` under a single measured window and gate it against RULES.
 * Uses measureOps with `stabilize:'deep'` so the `maxArrayBuffersGrowth` rule
 * is resolvable (typed-array backing stores live OUTSIDE the V8 heap and are
 * invisible to a heapUsed gate -- measured 152x blind spot). Returns the
 * checkNoGc report plus the raw summary for diagnostics.
 *
 * @param {(i:number)=>void} fn      Sync, zero-alloc hot body.
 * @param {{ops:number, warmup?:number}} opts
 */
export function runOpsGate(fn, opts) {
    const res = measureOps(fn, {
        ops: opts.ops,
        warmup: opts.warmup === undefined ? 0 : opts.warmup,
        stabilize: 'deep',
    });
    return { report: checkNoGc(res.summary, RULES), summary: res.summary };
}
