/**
 * T5 -- differential fuzz against a plain-object oracle.
 *
 * `SnowOracle` is an independent, array-of-structs reimplementation of the
 * engine's spawn + physics: one plain object per slot, the SAME seeded rng
 * schedule, the SAME ring cursor, and `Math.fround` at every store so its f32
 * arithmetic matches the engine's typed arrays bit-for-bit. It contains NONE of
 * the S3 rewrite -- no SoA columns, no render bins, no melt batching -- so if the
 * binning/hoisting/ring-cursor rewrite ever changes an answer, the sorted live
 * (x, y, radius, state) tuples diverge and this tier prints seed + frame + slot.
 *
 * The comparison is SORTED: the ring cursor places a flake in a different slot
 * than a scan-from-zero would, but it gives that flake the SAME rng draws, so
 * the live MULTISET is invariant. `tuplesMatch` is the shared comparator; T9
 * control 2 corrupts an oracle slot and proves this same comparator flags it.
 *
 * The melt-alpha quantization and the SN-08 y-clamp are mirrored: the y-clamp
 * enters the (x, y) tuple, so the oracle applies it in its melt branch; the
 * alpha quantization does NOT enter the tuple, so the oracle ignores it.
 *
 * S5 living air: the oracle also mirrors gust/turbulence/drag and the vx/vy
 * perturbation velocity -- the positional base branch, the SEPARATE drag
 * integration model, and the ACCEL_MAX clamp are all reproduced verbatim
 * (decisions/0002-living-air.md). `run()` re-rolls SIGNED gust/turbulence and a
 * damped drag on BOTH engine and oracle configs periodically (an independent
 * rng stream, so the existing degenerate-input schedule below is untouched),
 * so the differential fuzz actually exercises dragOn/gustOn/turbOn instead of
 * silently agreeing because neither side ever arms them. `tuplesMatch` now
 * compares vx/vy too, so a bug in the perturbation columns diverges the tuple
 * the same way a bug in x/y would.
 *
 * @license MIT
 */

import { SnowEngine } from '../../SnowEngine.js';
import { SEED, makeRng, die } from './harness.mjs';

const DT_MAX = 0.1;
const MIN_RADIUS = 0.01;
const TAU = Math.PI * 2;
const fr = Math.fround;
// Mirrors SnowEngine.js's GUST_FREQ_DEF / ACCEL_MAX exactly (decisions/0002).
// FROZEN to those literal values -- if the engine's constants ever change,
// this oracle must be updated deliberately, not silently drift out of sync.
const GUST_FREQ_DEF = TAU / 3;
const ACCEL_MAX = 10000;

/**
 * Array-of-structs oracle. Structurally unrelated to the SoA engine, but
 * arithmetically identical: every f32 store goes through Math.fround, and the
 * spawn/physics/ring-cursor control flow mirrors SnowEngine exactly.
 */
export class SnowOracle {
    constructor(max, config) {
        this.max = max;
        this.config = config;
        this._elapsedTime = 0;
        this._lastW = 0;
        this._lastH = 0;
        this._areaModifier = 0;
        this._spawnCursor = 0;
        // One plain object per slot. state 0 = free.
        this.slots = new Array(max);
        for (let i = 0; i < max; i++) {
            this.slots[i] = {
                state: 0, x: 0, y: 0, z: 0, gz: 0, wz: 0,
                bucket: 0, radius: 0, driftPhase: 0, driftSpeed: 0,
                driftAmp: 0, life: 0, vx: 0, vy: 0,
            };
        }
    }

    _sane(dt, w, h) {
        if (!Number.isFinite(dt) || dt < 0) return -1;
        if (!Number.isFinite(w) || w <= 0) return -1;
        if (!Number.isFinite(h) || h <= 0) return -1;
        return dt > DT_MAX ? DT_MAX : dt;
    }

    spawn(dt, w, h) {
        dt = this._sane(dt, w, h); if (dt < 0) return;

        if (this._lastW !== w || this._lastH !== h) {
            this._lastW = w;
            this._lastH = h;
            this._areaModifier = (w * h) / 100000;
        }

        const raw = Math.floor(this._areaModifier * this.config.density * (dt * 60));
        const cap = Number.isFinite(raw) && raw > 0 ? (raw > this.max ? this.max : raw) : 0;
        if (cap <= 0) return;
        const g = this.config.gravity;
        let windOffset = g === 0 ? 0 : (h / g) * Math.abs(this.config.wind);
        if (!Number.isFinite(windOffset)) windOffset = 0;

        const rng = this.config.rng;
        const gravity = this.config.gravity;
        const wind = this.config.wind;
        const baseRadius = this.config.baseRadius;
        const driftAmplitude = this.config.driftAmplitude;
        const driftFreq = this.config.driftFreq;
        const max = this.max;
        const slots = this.slots;

        let cursor = this._spawnCursor;
        let spawned = 0;
        let scanned = 0;
        while (scanned < max) {
            const i = cursor;
            cursor = cursor + 1 === max ? 0 : cursor + 1;
            scanned++;
            const p = slots[i];
            if (p.state !== 0) continue;

            p.state = 1;
            // Load-bearing (decisions/0002): a recycled slot must not inherit a
            // dead flake's perturbation velocity. Mirrors SnowEngine.js spawn().
            p.vx = 0;
            p.vy = 0;
            p.x = fr(rng() * (w + windOffset * 2) - windOffset);
            p.y = fr(-50 - rng() * 50);
            p.z = fr(0.2 + rng() * 0.8);
            const zi = p.z;
            p.gz = fr(gravity * zi);
            p.wz = fr(wind * zi);
            const jitter = (rng() - 0.5) * 0.8;
            const r = (baseRadius + jitter) * zi;
            p.radius = fr(r > MIN_RADIUS ? r : MIN_RADIUS);
            p.driftAmp = fr(driftAmplitude * zi);
            p.bucket = zi < 0.4 ? 0 : zi < 0.7 ? 1 : 2;
            p.driftPhase = fr(rng() * TAU);
            p.driftSpeed = fr(driftFreq + (rng() - 0.5) * 0.5);

            if (++spawned >= cap) break;
        }
        this._spawnCursor = cursor;
    }

    // Physics only -- rendering consumes no rng and touches no tuple field.
    step(dt, w, h) {
        dt = this._sane(dt, w, h); if (dt < 0) return;
        this._elapsedTime += dt;
        const et = this._elapsedTime;
        const meltTimeMin = this.config.meltTimeMin;
        const meltRange = this.config.meltTimeMax - this.config.meltTimeMin;
        const rng = this.config.rng;
        const max = this.max;
        const slots = this.slots;

        // Living-air knobs, mirrored verbatim from SnowEngine.js updateAndDraw
        // (decisions/0002). Fail-closed defaults match the engine's door exactly
        // so an oracle config that never touched these fields behaves like an
        // unarmed engine.
        const gust = Number.isFinite(this.config.gust) ? this.config.gust : 0;
        const gustFreq = Number.isFinite(this.config.gustFreq) ? this.config.gustFreq : GUST_FREQ_DEF;
        const turbulence = Number.isFinite(this.config.turbulence) ? this.config.turbulence : 0;
        const drag = Number.isFinite(this.config.drag) ? this.config.drag : 1;
        const gustOn = gust !== 0;
        const turbOn = turbulence !== 0;
        const dragOn = drag !== 1;
        const gustAccel = gustOn ? Math.sin(et * gustFreq) * gust : 0;

        for (let i = 0; i < max; i++) {
            const p = slots[i];
            const s = p.state;
            if (s === 0) continue;

            if (s === 1) {
                const tp = et * p.driftSpeed + p.driftPhase;
                const sway = Math.sin(tp) * p.driftAmp;

                if (dragOn) {
                    // SEPARATE integration model (decisions/0002): fold base
                    // gravity/wind and any perturbation into velocity, damp by
                    // drag, then integrate position.
                    let ax = p.wz + sway;
                    let ay = p.gz;
                    if (gustOn) ax += gustAccel;
                    if (turbOn) { ax += Math.cos(tp) * turbulence; ay += Math.sin(tp) * turbulence; }
                    if (ax > ACCEL_MAX) ax = ACCEL_MAX; else if (ax < -ACCEL_MAX) ax = -ACCEL_MAX;
                    if (ay > ACCEL_MAX) ay = ACCEL_MAX; else if (ay < -ACCEL_MAX) ay = -ACCEL_MAX;
                    p.vx = fr((p.vx + ax * dt) * drag);
                    p.vy = fr((p.vy + ay * dt) * drag);
                    p.x = fr(p.x + p.vx * dt);
                    p.y = fr(p.y + p.vy * dt);
                } else {
                    // POSITIONAL base, byte-identical to v1.1.1 when unarmed.
                    p.x = fr(p.x + (p.wz + sway) * dt);
                    p.y = fr(p.y + p.gz * dt);
                    if (gustOn || turbOn) {
                        let ax = gustOn ? gustAccel : 0;
                        let ay = 0;
                        if (turbOn) { ax += Math.cos(tp) * turbulence; ay += Math.sin(tp) * turbulence; }
                        if (ax > ACCEL_MAX) ax = ACCEL_MAX; else if (ax < -ACCEL_MAX) ax = -ACCEL_MAX;
                        if (ay > ACCEL_MAX) ay = ACCEL_MAX; else if (ay < -ACCEL_MAX) ay = -ACCEL_MAX;
                        p.vx = fr(p.vx + ax * dt);
                        p.vy = fr(p.vy + ay * dt);
                        p.x = fr(p.x + p.vx * dt);
                        p.y = fr(p.y + p.vy * dt);
                    }
                }

                if (!(p.x >= -200 && p.x <= w + 200 && p.y >= -200)) {
                    p.state = 0;
                    continue;
                }
                if (p.y >= h) {
                    p.y = fr(h);
                    p.state = 2;
                    p.life = fr(meltTimeMin + rng() * meltRange);
                }
            } else { // s === 2
                p.life = fr(p.life - dt);
                if (p.life <= 0) { p.state = 0; continue; }
                if (p.y > h) p.y = fr(h); // SN-08 clamp, melt branch only
            }
        }
    }

    clear() {
        const slots = this.slots;
        for (let i = 0; i < this.max; i++) slots[i].state = 0;
        this._elapsedTime = 0;
        this._lastW = 0;
        this._lastH = 0;
        this._areaModifier = 0;
        this._spawnCursor = 0;
    }
}

// --- comparison scratch, allocated once ------------------------------------
const CAP = 4096; // >= any MAX used here
const exX = new Float64Array(CAP), exY = new Float64Array(CAP);
const exR = new Float64Array(CAP), exS = new Float64Array(CAP);
const exVX = new Float64Array(CAP), exVY = new Float64Array(CAP);
const oxX = new Float64Array(CAP), oxY = new Float64Array(CAP);
const oxR = new Float64Array(CAP), oxS = new Float64Array(CAP);
const oxVX = new Float64Array(CAP), oxVY = new Float64Array(CAP);
const permE = new Uint32Array(CAP);
const permO = new Uint32Array(CAP);

// vx/vy join the sort key (S5) so two tuples that share x/y/radius/state but
// differ only in the living-air perturbation velocity still sort identically
// on both sides instead of landing in an arbitrary relative order.
function cmpE(a, b) {
    if (exX[a] !== exX[b]) return exX[a] < exX[b] ? -1 : 1;
    if (exY[a] !== exY[b]) return exY[a] < exY[b] ? -1 : 1;
    if (exR[a] !== exR[b]) return exR[a] < exR[b] ? -1 : 1;
    if (exS[a] !== exS[b]) return exS[a] < exS[b] ? -1 : 1;
    if (exVX[a] !== exVX[b]) return exVX[a] < exVX[b] ? -1 : 1;
    if (exVY[a] !== exVY[b]) return exVY[a] < exVY[b] ? -1 : 1;
    return 0;
}
function cmpO(a, b) {
    if (oxX[a] !== oxX[b]) return oxX[a] < oxX[b] ? -1 : 1;
    if (oxY[a] !== oxY[b]) return oxY[a] < oxY[b] ? -1 : 1;
    if (oxR[a] !== oxR[b]) return oxR[a] < oxR[b] ? -1 : 1;
    if (oxS[a] !== oxS[b]) return oxS[a] < oxS[b] ? -1 : 1;
    if (oxVX[a] !== oxVX[b]) return oxVX[a] < oxVX[b] ? -1 : 1;
    if (oxVY[a] !== oxVY[b]) return oxVY[a] < oxVY[b] ? -1 : 1;
    return 0;
}

function collectEngine(engine) {
    const state = engine.state, x = engine.x, y = engine.y, radius = engine.radius;
    const vx = engine.vx, vy = engine.vy;
    const max = engine.max;
    let n = 0;
    for (let i = 0; i < max; i++) {
        if (state[i] === 0) continue;
        exX[n] = x[i]; exY[n] = y[i]; exR[n] = radius[i]; exS[n] = state[i];
        exVX[n] = vx[i]; exVY[n] = vy[i];
        permE[n] = n; n++;
    }
    return n;
}

function collectOracle(oracle) {
    const slots = oracle.slots, max = oracle.max;
    let n = 0;
    for (let i = 0; i < max; i++) {
        const p = slots[i];
        if (p.state === 0) continue;
        oxX[n] = p.x; oxY[n] = p.y; oxR[n] = p.radius; oxS[n] = p.state;
        oxVX[n] = p.vx; oxVY[n] = p.vy;
        permO[n] = n; n++;
    }
    return n;
}

/**
 * Sorted-tuple comparator shared with T9 control 2. Returns { ok, reason, k }.
 * `ok` false means the engine and oracle live sets diverge. Reads only the
 * module scratch, so it is side-effect free between calls. Compares vx/vy
 * (S5) alongside x/y/radius/state, so a perturbation-velocity bug diverges the
 * tuple exactly like a position bug would.
 */
export function tuplesMatch(engine, oracle) {
    const ne = collectEngine(engine);
    const no = collectOracle(oracle);
    if (ne !== no) return { ok: false, reason: 'count ' + ne + ' vs ' + no, k: -1 };
    const pe = permE.subarray(0, ne);
    const po = permO.subarray(0, no);
    pe.sort(cmpE);
    po.sort(cmpO);
    for (let k = 0; k < ne; k++) {
        const ie = pe[k], io = po[k];
        if (exX[ie] !== oxX[io] || exY[ie] !== oxY[io] ||
            exR[ie] !== oxR[io] || exS[ie] !== oxS[io] ||
            exVX[ie] !== oxVX[io] || exVY[ie] !== oxVY[io]) {
            return {
                ok: false, k,
                reason: 'tuple ' + k + ' engine(' + exX[ie] + ',' + exY[ie] + ',' +
                    exR[ie] + ',' + exS[ie] + ',' + exVX[ie] + ',' + exVY[ie] +
                    ') != oracle(' + oxX[io] + ',' + oxY[io] + ',' + oxR[io] + ',' +
                    oxS[io] + ',' + oxVX[io] + ',' + oxVY[io] + ')',
            };
        }
    }
    return { ok: true, k: -1, reason: '' };
}

const MAX = 400;
const FRAMES = 100000;

// A palette of dimensions, including a 1x1 and a shrink, so resize churn and the
// SN-08 melt clamp are both exercised inside the differential.
const DIMS = [
    [800, 600], [1024, 768], [400, 300], [1, 1], [1920, 1080], [200, 900],
];

function makeConfig(seed) {
    return {
        gravity: 800, wind: 120, density: 30, baseRadius: 2.5,
        driftAmplitude: 20, driftFreq: 1.0, meltTimeMin: 0.3, meltTimeMax: 0.8,
        rng: makeRng(seed),
    };
}

export function run() {
    // Two rng instances from ONE seed: identical streams that stay in lockstep
    // as long as both consume the same draws per op -- which the shared action
    // schedule guarantees.
    const engine = new SnowEngine(MAX, makeConfig(SEED));
    const oracle = new SnowOracle(MAX, makeConfig(SEED));

    // Independent driver rng chooses the mixed action schedule.
    const drng = makeRng(SEED ^ 0xa5a5a5a5);
    // A SEPARATE stream for the living-air reroll (S5), so it neither perturbs
    // nor is perturbed by the existing degenerate-input schedule below -- the
    // pre-S5 frame-by-frame action sequence is otherwise unchanged.
    const lrng = makeRng(SEED ^ 0x1ee1ee11);

    let w = 800, h = 600;
    for (let f = 0; f < FRAMES; f++) {
        const d = drng();

        // ~2% of frames resize (some to 1x1 / smaller, exercising the clamp).
        if (d < 0.02) {
            const dim = DIMS[(drng() * DIMS.length) | 0];
            w = dim[0]; h = dim[1];
        }

        // ~3% of frames re-roll SIGNED gust/turbulence and a damped drag on
        // BOTH engine and oracle configs identically (deliverable 4: without
        // this the oracle and engine silently agree only because neither ever
        // arms dragOn/gustOn/turbOn). Config objects are plain and mutable
        // (T7 soak already mutates config.density this way), so writing the
        // fields directly is in-house style, not a new pattern.
        if (lrng() < 0.03) {
            const gust = (lrng() - 0.5) * 800;       // signed, (-400, 400)
            const turbulence = (lrng() - 0.5) * 600; // signed, (-300, 300)
            const drag = 0.6 + lrng() * 0.4;         // (0.6, 1.0]
            engine.config.gust = gust; oracle.config.gust = gust;
            engine.config.turbulence = turbulence; oracle.config.turbulence = turbulence;
            engine.config.drag = drag; oracle.config.drag = drag;
        }

        // Degenerate dt/dims on a slice of frames: both sides must reject in
        // lockstep (the door consumes no rng), so sync is preserved.
        let dt = 0.016 + drng() * 0.05;
        let sw = w, sh = h;
        if (d >= 0.02 && d < 0.05) dt = -dt;            // negative dt -> reject
        else if (d >= 0.05 && d < 0.07) sw = NaN;       // NaN w -> reject
        else if (d >= 0.07 && d < 0.09) { dt = 10; }    // huge dt -> clamped to DT_MAX

        const act = d;
        if (act < 0.01) {
            engine.clear();
            oracle.clear();
        } else if (act < 0.30) {
            // spawn only
            engine.spawn(dt, sw, sh);
            oracle.spawn(dt, sw, sh);
        } else if (act < 0.55) {
            // update only (let the pool drain / melt)
            engine.updateAndDraw(NOOP_CTX, dt, sw, sh);
            oracle.step(dt, sw, sh);
        } else {
            // the common case: spawn then update
            engine.spawn(dt, sw, sh);
            oracle.spawn(dt, sw, sh);
            engine.updateAndDraw(NOOP_CTX, dt, sw, sh);
            oracle.step(dt, sw, sh);
        }

        const m = tuplesMatch(engine, oracle);
        if (!m.ok) {
            die('T5 fuzz: divergence at frame ' + f + ' (seed=' + SEED + ', w=' + w +
                ', h=' + h + ') -- ' + m.reason);
        }
    }
}

// Zero-alloc mock ctx implementing exactly what updateAndDraw touches. Melt
// batching moveTo/ellipse and the bucket arc are all no-ops here -- T5 tests the
// physics answer, not the draw counts (that is T2).
const NOOP_CTX = {
    _fillStyle: '', _globalAlpha: 1,
    set fillStyle(v) { this._fillStyle = v; },
    get fillStyle() { return this._fillStyle; },
    set globalAlpha(v) { this._globalAlpha = v; },
    get globalAlpha() { return this._globalAlpha; },
    beginPath() {}, moveTo() {}, arc() {}, ellipse() {}, fill() {},
};
