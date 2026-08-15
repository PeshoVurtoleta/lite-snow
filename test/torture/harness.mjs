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
    // arc() and ellipse() reproduce the ONE input the real
    // CanvasRenderingContext2D rejects: a negative radius is an IndexSizeError.
    // Without this the mock silently accepts geometry a real canvas refuses, and
    // "a full frame does not throw" becomes an assertion about the mock rather
    // than about the engine. SN-07's regression test was vacuous for exactly
    // this reason. Zero (a degenerate but legal arc) is accepted, as in a browser.
    arc(x, y, r, a0, a1) {
        if (r < 0) throw new RangeError('IndexSizeError: negative radius ' + r);
        this.nArc++;
        this.sumX += x;
        if (x < this.minX) this.minX = x;
        if (y > this.maxY) this.maxY = y;
    }
    ellipse(x, y, rx, ry, rot, a0, a1) {
        if (rx < 0 || ry < 0) throw new RangeError('IndexSizeError: negative radius ' + rx + ',' + ry);
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
 * The spawn-bound law as a BOOLEAN predicate (not check-wrapped) so T0 Law 4 and
 * T9 control 4 share ONE implementation. Runs a single spawn and asserts the live
 * delta is within floor(areaModifier*density*dt*60). The fail-closed `bound = 0`
 * for degenerate input is the law statement, not a fudge: a degenerate frame the
 * door rejects moves nothing, so its bound is exactly zero. O(max) -- test only.
 * @returns {boolean}
 */
export function spawnBoundHolds(engine, dt, w, h) {
    const state = engine.state;
    const max = engine.max;
    let before = 0;
    for (let i = 0; i < max; i++) if (state[i] !== 0) before++;
    engine.spawn(dt, w, h);
    let after = 0;
    for (let i = 0; i < max; i++) if (state[i] !== 0) after++;
    const delta = after - before;
    const raw = Math.floor(engine._areaModifier * engine.config.density * (dt * 60));
    const bound = Number.isFinite(raw) && raw > 0 ? raw : 0;
    return delta >= 0 && delta <= bound;
}

/**
 * The telemetry-counter law as a BOOLEAN predicate. Recounts the pool by state
 * (O(max)) and returns true iff the engine's cached `_nFalling` / `_nMelting`
 * agree with the live counts. On a destroyed engine (state === null) the only
 * consistent answer is both counters at 0. Shared by T1, T4, T7 and T9 control
 * 10 so the oracle and its control exercise one implementation. Test-only.
 * @returns {boolean}
 */
export function countersAgree(engine) {
    const state = engine.state;
    if (state === null) return engine._nFalling === 0 && engine._nMelting === 0;
    const max = engine.max;
    let falling = 0, melting = 0;
    for (let i = 0; i < max; i++) {
        const s = state[i];
        if (s === 1) falling++;
        else if (s === 2) melting++;
    }
    return engine._nFalling === falling && engine._nMelting === melting;
}

/**
 * clear() must be a FULL simulation reset, not just `state.fill(0)`. Dirties the
 * engine (one spawn + one frame), calls clear(), and returns true iff the clock,
 * both dimension-cache fields, the area modifier, both counters and every state
 * slot are back to their fresh-construction values. A clear() that skips the
 * clock (T9 control 7) fails the `_elapsedTime` check. Mutates `engine`. Test-only.
 * @returns {boolean}
 */
export function clearIsFullReset(engine, ctx) {
    engine.spawn(0.05, 100, 100);
    engine.updateAndDraw(ctx, 0.05, 100, 100);
    engine.clear();
    if (engine._elapsedTime !== 0) return false;
    if (engine._lastW !== 0 || engine._lastH !== 0) return false;
    if (engine._areaModifier !== 0) return false;
    if (engine._nFalling !== 0 || engine._nMelting !== 0) return false;
    const state = engine.state;
    for (let i = 0; i < engine.max; i++) if (state[i] !== 0) return false;
    return true;
}

/**
 * destroy() must release EVERYTHING: the twelve SoA columns, `config`,
 * `colorStr` and `_buckets` all null, the clock and both dimension-cache fields
 * and both counters zeroed (via the clear() it runs FIRST, before the flag), and
 * `_destroyed` true. Calls destroy() on `engine`, so pass a live one. A destroy
 * that sets the flag before clear() (T9 control 8) leaves `_elapsedTime` non-zero
 * and `config` non-null and fails here. Test-only.
 * @returns {boolean}
 */
export function destroyReleasesAll(engine) {
    engine.destroy();
    for (let n = 0; n < SOA_NAMES.length; n++) {
        if (engine[SOA_NAMES[n]] !== null) return false;
    }
    if (engine.config !== null) return false;
    if (engine.colorStr !== null) return false;
    if (engine._buckets !== null) return false;
    if (engine._elapsedTime !== 0) return false;
    if (engine._lastW !== 0 || engine._lastH !== 0 || engine._areaModifier !== 0) return false;
    if (engine._nFalling !== 0 || engine._nMelting !== 0) return false;
    return engine._destroyed === true;
}

/**
 * The SN-32 spawn-cap law as a BOOLEAN predicate: a spawn whose raw cap would
 * overflow a 32-bit `| 0` coercion (area 1e7 x 5e6 with any positive density)
 * must still fill the pool to EXACTLY `max` -- never wrap to a negative count and
 * spawn nothing. Returns true iff every slot is live afterwards. A frozen `| 0`
 * cap (T9 control 9) wraps 3e10 to a negative and spawns 0, so this returns false
 * for it and true for the fixed engine. Mutates `engine`. Test-only.
 * @returns {boolean}
 */
export function spawnCapNoWrap(engine) {
    engine.spawn(0.1, 1e7, 5e6);
    const state = engine.state;
    let live = 0;
    for (let i = 0; i < engine.max; i++) if (state[i] !== 0) live++;
    return live === engine.max;
}

/**
 * A MockCtx whose arc() throws on the Nth call (1-based, settable). Everything
 * else is inherited unchanged, so it still counts and digests. Used by T2/T4 to
 * prove updateAndDraw restores globalAlpha and RETHROWS when a draw call throws
 * mid-render (SN-10). Not a hot-path object -- test only.
 */
export class ThrowingCtx extends MockCtx {
    constructor(throwOn) {
        super();
        this.throwOn = throwOn; // 1-based arc() call index at which to throw
        this._arcCalls = 0;
    }
    arc(x, y, r, a0, a1) {
        this._arcCalls++;
        if (this._arcCalls === this.throwOn) {
            throw new Error('ThrowingCtx: arc() threw on call ' + this._arcCalls);
        }
        super.arc(x, y, r, a0, a1);
    }
}

/**
 * A Proxy-wrapped MockCtx that records every property KEY assigned on it. Method
 * accesses are returned bound to the underlying MockCtx so their internal counter
 * writes land on the target, not the proxy -- the recorded set-key set is then
 * exactly the properties the engine itself writes. Used by T4 to prove the render
 * section touches only `fillStyle` and `globalAlpha`. Test only.
 * @returns {{ctx: object, setKeys: Set<string>}}
 */
export function makeProxyCtx() {
    const base = new MockCtx();
    const setKeys = new Set();
    const ctx = new Proxy(base, {
        get(target, key) {
            const v = target[key];
            return typeof v === 'function' ? v.bind(target) : v;
        },
        set(target, key, value) {
            setKeys.add(key);
            target[key] = value;
            return true;
        },
    });
    return { ctx, setKeys };
}

/**
 * The SN-01 survival law as a BOOLEAN predicate. One good spawn, one poisoned
 * updateAndDraw(ctx, NaN, ...), then 100 good frames; returns true iff the clock
 * stayed finite AND every live particle is finite. Shared by T9 control 3 and the
 * SN-01 gate. O(max) -- test only.
 * @returns {boolean}
 */
export function nanDtSurvived(engine, ctx) {
    engine.spawn(0.016, 800, 600);
    engine.updateAndDraw(ctx, NaN, 800, 600);
    for (let f = 0; f < 100; f++) engine.updateAndDraw(ctx, 0.016, 800, 600);
    if (!Number.isFinite(engine._elapsedTime)) return false;
    const state = engine.state;
    for (let i = 0; i < engine.max; i++) {
        if (state[i] !== 0) {
            if (!Number.isFinite(engine.x[i]) || !Number.isFinite(engine.y[i])) return false;
        }
    }
    return true;
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
