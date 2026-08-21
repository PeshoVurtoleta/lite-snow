/**
 * T9 -- controls. Every gate must be provably able to fail.
 *
 * This tier runs deliberately-broken variants IN PROCESS and asserts that the
 * corresponding gate flags each one. If a control slips through, T9 itself fails
 * the run -- a gate that cannot fail is decorative.
 *
 * Controls 3 and 4 (S1) run the pre-fix engine variants in process and prove the
 * fail-closed door's two gates bite. The remaining controls from roadmap section
 * 3 arrive with the gates they guard:
 *   - control 2 (T5 oracle divergence)          -> S3 (T5 fuzz)
 *   - control 5 (melt batching removed fails T2) -> S3
 *   - control 7 (clear skips _elapsedTime)       -> S2
 *   - control 8 (destroy order inverted)         -> S2
 *
 * There is also a whole-suite control: `SNOW_TORTURE_BREAK=1 npm run torture`
 * injects retained allocations into the T6 hot loop, so the alloc gate rejects
 * and the process exits non-zero. Control 1 below exercises the same alloc lane
 * from a plain `npm run torture`, so the gate is proven to bite either way.
 */

import { SnowEngine } from '../../SnowEngine.js';
import {
    SEED, makeRng, runOpsGate, conservation, occupancy, die, makeMockCtx,
    nanDtSurvived, spawnBoundHolds, clearIsFullReset, destroyReleasesAll,
    countersAgree, spawnCapNoWrap,
} from './harness.mjs';
import { SnowOracle, tuplesMatch } from './t5-fuzz.mjs';
import { digestEngine, SOA_NAMES } from './armed-scenario.mjs';

const TAU = Math.PI * 2; // the frozen spawn-body copies below read TAU
const MELT_BINS = 8;

/** Retained sink so the control's allocations survive GC (arrayBuffers grows). */
const leak = [];

/** Distinct melt alpha bands + raw melter count for the CURRENT pool state. */
function meltBins(e) {
    const invMeltMax = 1 / e.config.meltTimeMax;
    const seen = [0, 0, 0, 0, 0, 0, 0, 0];
    let used = 0, melt = 0;
    for (let i = 0; i < e.max; i++) {
        if (e.state[i] !== 2) continue;
        melt++;
        let b = (e.life[i] * invMeltMax * e.z[i] * MELT_BINS) | 0;
        if (b < 0) b = 0; else if (b > 7) b = 7;
        if (seen[b] === 0) { seen[b] = 1; used++; }
    }
    return { used, melt };
}

/**
 * A SnowEngine whose melt render is the PRE-S3 one-beginPath/fill-per-melter
 * loop -- the batching removed. FROZEN: never update this to track the engine.
 * On a scene with more than MELT_BINS melters its fill count is 3 + meltCount,
 * which blows past the 3 + MELT_BINS ceiling the batched engine holds to.
 */
class UnbatchedMeltEngine extends SnowEngine {
    updateAndDraw(ctx, dt, w, h) {
        if (this._destroyed) return;
        if (!ctx || typeof ctx.ellipse !== 'function' || typeof ctx.arc !== 'function') return;
        dt = this._sane(dt, w, h); if (dt < 0) return;
        this._elapsedTime += dt;
        const invMeltMax = 1.0 / this.config.meltTimeMax;

        for (let i = 0; i < this.max; i++) {
            if (this.state[i] === 0) continue;
            if (this.state[i] === 1) {
                const sway = Math.sin(this._elapsedTime * this.driftSpeed[i] + this.driftPhase[i]) * this.driftAmp[i];
                this.x[i] += (this.wz[i] + sway) * dt;
                this.y[i] += this.gz[i] * dt;
                if (!(this.x[i] >= -200 && this.x[i] <= w + 200 && this.y[i] >= -200)) {
                    this.state[i] = 0; this._nFalling--; continue;
                }
                if (this.y[i] >= h) {
                    this.y[i] = h; this.state[i] = 2;
                    this._nFalling--; this._nMelting++;
                    this.life[i] = this.config.meltTimeMin + this.config.rng() * (this.config.meltTimeMax - this.config.meltTimeMin);
                }
            } else if (this.state[i] === 2) {
                this.life[i] -= dt;
                if (this.life[i] <= 0) { this.state[i] = 0; this._nMelting--; }
            }
        }

        try {
            ctx.fillStyle = this.colorStr;
            const alphas = [0.24, 0.44, 0.72];
            for (let bk = 0; bk < 3; bk++) {
                ctx.globalAlpha = alphas[bk];
                ctx.beginPath();
                for (let i = 0; i < this.max; i++) {
                    if (this.state[i] === 1 && this.bucket[i] === bk) {
                        ctx.moveTo(this.x[i] + this.radius[i], this.y[i]);
                        ctx.arc(this.x[i], this.y[i], this.radius[i], 0, TAU);
                    }
                }
                ctx.fill();
            }
            // FROZEN pre-S3: one beginPath/fill per melter (batching removed).
            for (let i = 0; i < this.max; i++) {
                if (this.state[i] === 2) {
                    ctx.globalAlpha = (this.life[i] * invMeltMax) * this.z[i];
                    ctx.beginPath();
                    ctx.ellipse(this.x[i], this.y[i], this.radius[i] * 2.5, this.radius[i] * 0.5, 0, 0, TAU);
                    ctx.fill();
                }
            }
        } finally {
            ctx.globalAlpha = 1.0;
        }
    }
}

function meltSceneConfig(seed) {
    return {
        gravity: 8000, wind: 0, density: 300,
        meltTimeMin: 4.0, meltTimeMax: 8.0, rng: makeRng(seed),
    };
}

// ============================================================================
// S5 living-air per-guard controls (roadmap: "every new entry point... unguard
// that branch and the DEFAULT digest must move").
//
// The drag guard selects a whole SEPARATE integration model (decisions/0002
// decision 3), so forcing it on at the DEFAULT config (drag===1) genuinely
// changes the trajectory -- a double integration of wz+sway through vx instead
// of the single positional add -- and the digest measurably moves.
//
// The gust/turbulence guards are different in kind: `gustAccel` and the
// turbulence terms are literally `... * gust` / `... * turbulence`, so at the
// DEFAULT value (0) ANY unguarded branch still adds exactly zero -- forcing
// `gustOn`/`turbOn` true at gust=0/turbulence=0 cannot move the default digest,
// full stop (0 times anything is 0, in IEEE-754 as much as in algebra). The
// failure mode those guards actually protect against is the opposite one: the
// guard stuck OFF while the knob IS armed, silently discarding a configured
// force. That is what these two controls prove -- an ARMED gust/turbulence
// digest collapses onto the (correctly-guarded) OFF digest when the guard is
// broken closed, and stays properly DISTINCT from it when the guard is fixed.
// ============================================================================

const S5_CTRL_MAX = 300;
const S5_CTRL_FRAMES = 400;
const S5_CTRL_W = 800, S5_CTRL_H = 600;
const S5_CTRL_DT = 1 / 60;
function s5CtrlBaseConfig(seed) {
    return { gravity: 200, wind: 30, density: 10, rng: makeRng(seed) };
}

/** Runs `EngineClass` for S5_CTRL_FRAMES frames under `extraConfig` layered on
 * the shared base config, and returns its sha256 digest over SOA_NAMES. */
function runS5Control(EngineClass, extraConfig, seed) {
    const engine = new EngineClass(S5_CTRL_MAX, { ...s5CtrlBaseConfig(seed), ...extraConfig });
    const ctx = makeMockCtx();
    for (let f = 0; f < S5_CTRL_FRAMES; f++) {
        engine.spawn(S5_CTRL_DT, S5_CTRL_W, S5_CTRL_H);
        engine.updateAndDraw(ctx, S5_CTRL_DT, S5_CTRL_W, S5_CTRL_H);
    }
    return digestEngine(engine, SOA_NAMES);
}

/** FROZEN verbatim copy of updateAndDraw with `dragOn` hardcoded true -- the
 * drag guard removed. Never update this to track the engine; a tracking edit
 * defeats the control (it must reproduce the PRE-fix bug shape exactly). */
class DragAlwaysOnEngine extends SnowEngine {
    updateAndDraw(ctx, dt, w, h) {
        if (this._destroyed) return;
        if (!ctx || typeof ctx.ellipse !== 'function' || typeof ctx.arc !== 'function') return;
        dt = this._sane(dt, w, h); if (dt < 0) return;
        this._elapsedTime += dt;
        const et = this._elapsedTime;
        const meltTimeMin = this.config.meltTimeMin;
        const meltRange = this.config.meltTimeMax - this.config.meltTimeMin;
        const rng = this.config.rng;
        const max = this.max;
        const state = this.state, x = this.x, y = this.y, z = this.z;
        const gz = this.gz, wz = this.wz, bucket = this.bucket, radius = this.radius;
        const driftPhase = this.driftPhase, driftSpeed = this.driftSpeed;
        const driftAmp = this.driftAmp, life = this.life;
        const vx = this.vx, vy = this.vy;
        const gust = this.config.gust;
        const turbulence = this.config.turbulence;
        const drag = this.config.drag;
        const gustOn = gust !== 0;
        const turbOn = turbulence !== 0;
        const dragOn = true; // MUTATED: was `drag !== 1` -- guard removed
        const gustAccel = gustOn ? Math.sin(et * this.config.gustFreq) * gust : 0;
        const ACCEL_MAX = 10000;

        for (let i = 0; i < max; i++) {
            const s = state[i];
            if (s === 0) continue;
            if (s === 1) {
                const tp = et * driftSpeed[i] + driftPhase[i];
                const sway = Math.sin(tp) * driftAmp[i];
                if (dragOn) {
                    let ax = wz[i] + sway;
                    let ay = gz[i];
                    if (gustOn) ax += gustAccel;
                    if (turbOn) { ax += Math.cos(tp) * turbulence; ay += Math.sin(tp) * turbulence; }
                    if (ax > ACCEL_MAX) ax = ACCEL_MAX; else if (ax < -ACCEL_MAX) ax = -ACCEL_MAX;
                    if (ay > ACCEL_MAX) ay = ACCEL_MAX; else if (ay < -ACCEL_MAX) ay = -ACCEL_MAX;
                    vx[i] = (vx[i] + ax * dt) * drag;
                    vy[i] = (vy[i] + ay * dt) * drag;
                    x[i] += vx[i] * dt;
                    y[i] += vy[i] * dt;
                } else {
                    x[i] += (wz[i] + sway) * dt;
                    y[i] += gz[i] * dt;
                }
                if (!(x[i] >= -200 && x[i] <= w + 200 && y[i] >= -200)) {
                    state[i] = 0; this._nFalling--; continue;
                }
                if (y[i] >= h) {
                    y[i] = h; state[i] = 2;
                    this._nFalling--; this._nMelting++;
                    life[i] = meltTimeMin + rng() * meltRange;
                }
            } else {
                life[i] -= dt;
                if (life[i] <= 0) { state[i] = 0; this._nMelting--; continue; }
                if (y[i] > h) y[i] = h;
            }
        }
        try {
            ctx.fillStyle = this.colorStr;
            ctx.globalAlpha = 1;
            ctx.beginPath();
            for (let i = 0; i < max; i++) if (state[i] !== 0) { ctx.moveTo(x[i], y[i]); ctx.arc(x[i], y[i], radius[i], 0, TAU); }
            ctx.fill();
        } finally {
            ctx.globalAlpha = 1.0;
        }
    }
}

/** FROZEN verbatim copy of updateAndDraw with `gustOn` hardcoded false -- the
 * gust guard stuck permanently OFF, even when config.gust is armed. */
class GustStuckOffEngine extends SnowEngine {
    updateAndDraw(ctx, dt, w, h) {
        if (this._destroyed) return;
        if (!ctx || typeof ctx.ellipse !== 'function' || typeof ctx.arc !== 'function') return;
        dt = this._sane(dt, w, h); if (dt < 0) return;
        this._elapsedTime += dt;
        const et = this._elapsedTime;
        const meltTimeMin = this.config.meltTimeMin;
        const meltRange = this.config.meltTimeMax - this.config.meltTimeMin;
        const rng = this.config.rng;
        const max = this.max;
        const state = this.state, x = this.x, y = this.y, z = this.z;
        const gz = this.gz, wz = this.wz, bucket = this.bucket, radius = this.radius;
        const driftPhase = this.driftPhase, driftSpeed = this.driftSpeed;
        const driftAmp = this.driftAmp, life = this.life;
        const vx = this.vx, vy = this.vy;
        const gust = this.config.gust;
        const turbulence = this.config.turbulence;
        const drag = this.config.drag;
        const gustOn = false; // MUTATED: was `gust !== 0` -- guard stuck off
        const turbOn = turbulence !== 0;
        const dragOn = drag !== 1;
        const gustAccel = gustOn ? Math.sin(et * this.config.gustFreq) * gust : 0;
        const ACCEL_MAX = 10000;

        for (let i = 0; i < max; i++) {
            const s = state[i];
            if (s === 0) continue;
            if (s === 1) {
                const tp = et * driftSpeed[i] + driftPhase[i];
                const sway = Math.sin(tp) * driftAmp[i];
                if (dragOn) {
                    let ax = wz[i] + sway;
                    let ay = gz[i];
                    if (gustOn) ax += gustAccel;
                    if (turbOn) { ax += Math.cos(tp) * turbulence; ay += Math.sin(tp) * turbulence; }
                    if (ax > ACCEL_MAX) ax = ACCEL_MAX; else if (ax < -ACCEL_MAX) ax = -ACCEL_MAX;
                    if (ay > ACCEL_MAX) ay = ACCEL_MAX; else if (ay < -ACCEL_MAX) ay = -ACCEL_MAX;
                    vx[i] = (vx[i] + ax * dt) * drag;
                    vy[i] = (vy[i] + ay * dt) * drag;
                    x[i] += vx[i] * dt;
                    y[i] += vy[i] * dt;
                } else {
                    x[i] += (wz[i] + sway) * dt;
                    y[i] += gz[i] * dt;
                    if (gustOn || turbOn) {
                        let ax = gustOn ? gustAccel : 0;
                        let ay = 0;
                        if (turbOn) { ax += Math.cos(tp) * turbulence; ay += Math.sin(tp) * turbulence; }
                        if (ax > ACCEL_MAX) ax = ACCEL_MAX; else if (ax < -ACCEL_MAX) ax = -ACCEL_MAX;
                        if (ay > ACCEL_MAX) ay = ACCEL_MAX; else if (ay < -ACCEL_MAX) ay = -ACCEL_MAX;
                        vx[i] += ax * dt;
                        vy[i] += ay * dt;
                        x[i] += vx[i] * dt;
                        y[i] += vy[i] * dt;
                    }
                }
                if (!(x[i] >= -200 && x[i] <= w + 200 && y[i] >= -200)) {
                    state[i] = 0; this._nFalling--; continue;
                }
                if (y[i] >= h) {
                    y[i] = h; state[i] = 2;
                    this._nFalling--; this._nMelting++;
                    life[i] = meltTimeMin + rng() * meltRange;
                }
            } else {
                life[i] -= dt;
                if (life[i] <= 0) { state[i] = 0; this._nMelting--; continue; }
                if (y[i] > h) y[i] = h;
            }
        }
        try {
            ctx.fillStyle = this.colorStr;
            ctx.globalAlpha = 1;
            ctx.beginPath();
            for (let i = 0; i < max; i++) if (state[i] !== 0) { ctx.moveTo(x[i], y[i]); ctx.arc(x[i], y[i], radius[i], 0, TAU); }
            ctx.fill();
        } finally {
            ctx.globalAlpha = 1.0;
        }
    }
}

/** FROZEN verbatim copy of updateAndDraw with `turbOn` hardcoded false -- the
 * turbulence guard stuck permanently OFF, even when config.turbulence is
 * armed. */
class TurbStuckOffEngine extends SnowEngine {
    updateAndDraw(ctx, dt, w, h) {
        if (this._destroyed) return;
        if (!ctx || typeof ctx.ellipse !== 'function' || typeof ctx.arc !== 'function') return;
        dt = this._sane(dt, w, h); if (dt < 0) return;
        this._elapsedTime += dt;
        const et = this._elapsedTime;
        const meltTimeMin = this.config.meltTimeMin;
        const meltRange = this.config.meltTimeMax - this.config.meltTimeMin;
        const rng = this.config.rng;
        const max = this.max;
        const state = this.state, x = this.x, y = this.y, z = this.z;
        const gz = this.gz, wz = this.wz, bucket = this.bucket, radius = this.radius;
        const driftPhase = this.driftPhase, driftSpeed = this.driftSpeed;
        const driftAmp = this.driftAmp, life = this.life;
        const vx = this.vx, vy = this.vy;
        const gust = this.config.gust;
        const turbulence = this.config.turbulence;
        const drag = this.config.drag;
        const gustOn = gust !== 0;
        const turbOn = false; // MUTATED: was `turbulence !== 0` -- guard stuck off
        const dragOn = drag !== 1;
        const gustAccel = gustOn ? Math.sin(et * this.config.gustFreq) * gust : 0;
        const ACCEL_MAX = 10000;

        for (let i = 0; i < max; i++) {
            const s = state[i];
            if (s === 0) continue;
            if (s === 1) {
                const tp = et * driftSpeed[i] + driftPhase[i];
                const sway = Math.sin(tp) * driftAmp[i];
                if (dragOn) {
                    let ax = wz[i] + sway;
                    let ay = gz[i];
                    if (gustOn) ax += gustAccel;
                    if (turbOn) { ax += Math.cos(tp) * turbulence; ay += Math.sin(tp) * turbulence; }
                    if (ax > ACCEL_MAX) ax = ACCEL_MAX; else if (ax < -ACCEL_MAX) ax = -ACCEL_MAX;
                    if (ay > ACCEL_MAX) ay = ACCEL_MAX; else if (ay < -ACCEL_MAX) ay = -ACCEL_MAX;
                    vx[i] = (vx[i] + ax * dt) * drag;
                    vy[i] = (vy[i] + ay * dt) * drag;
                    x[i] += vx[i] * dt;
                    y[i] += vy[i] * dt;
                } else {
                    x[i] += (wz[i] + sway) * dt;
                    y[i] += gz[i] * dt;
                    if (gustOn || turbOn) {
                        let ax = gustOn ? gustAccel : 0;
                        let ay = 0;
                        if (turbOn) { ax += Math.cos(tp) * turbulence; ay += Math.sin(tp) * turbulence; }
                        if (ax > ACCEL_MAX) ax = ACCEL_MAX; else if (ax < -ACCEL_MAX) ax = -ACCEL_MAX;
                        if (ay > ACCEL_MAX) ay = ACCEL_MAX; else if (ay < -ACCEL_MAX) ay = -ACCEL_MAX;
                        vx[i] += ax * dt;
                        vy[i] += ay * dt;
                        x[i] += vx[i] * dt;
                        y[i] += vy[i] * dt;
                    }
                }
                if (!(x[i] >= -200 && x[i] <= w + 200 && y[i] >= -200)) {
                    state[i] = 0; this._nFalling--; continue;
                }
                if (y[i] >= h) {
                    y[i] = h; state[i] = 2;
                    this._nFalling--; this._nMelting++;
                    life[i] = meltTimeMin + rng() * meltRange;
                }
            } else {
                life[i] -= dt;
                if (life[i] <= 0) { state[i] = 0; this._nMelting--; continue; }
                if (y[i] > h) y[i] = h;
            }
        }
        try {
            ctx.fillStyle = this.colorStr;
            ctx.globalAlpha = 1;
            ctx.beginPath();
            for (let i = 0; i < max; i++) if (state[i] !== 0) { ctx.moveTo(x[i], y[i]); ctx.arc(x[i], y[i], radius[i], 0, TAU); }
            ctx.fill();
        } finally {
            ctx.globalAlpha = 1.0;
        }
    }
}

const MIN_RADIUS = 0.01; // mirrors SnowEngine.js's MIN_RADIUS, used by the class below

/** FROZEN verbatim copy of spawn() with the `vx[i] = 0; vy[i] = 0;` reset
 * REMOVED -- a recycled slot inherits whatever perturbation velocity the dead
 * flake that previously occupied it left behind. */
class NoVelocityResetEngine extends SnowEngine {
    spawn(dt, w, h) {
        if (this._destroyed) return;
        dt = this._sane(dt, w, h); if (dt < 0) return;
        if (this._lastW !== w || this._lastH !== h) {
            this._lastW = w; this._lastH = h;
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
        const state = this.state, x = this.x, y = this.y, z = this.z;
        const gz = this.gz, wz = this.wz, bucket = this.bucket, radius = this.radius;
        const driftPhase = this.driftPhase, driftSpeed = this.driftSpeed, driftAmp = this.driftAmp;

        let cursor = this._spawnCursor;
        let spawned = 0;
        let scanned = 0;
        while (scanned < max) {
            const i = cursor;
            cursor = cursor + 1 === max ? 0 : cursor + 1;
            scanned++;
            if (state[i] !== 0) continue;

            state[i] = 1;
            this._nFalling++;
            // MUTATED: the vx[i] = 0; vy[i] = 0; reset from the real spawn() is
            // GONE -- a recycled slot keeps its previous occupant's velocity.

            x[i] = rng() * (w + windOffset * 2) - windOffset;
            y[i] = -50 - rng() * 50;
            z[i] = 0.2 + rng() * 0.8;
            const zi = z[i];
            gz[i] = gravity * zi;
            wz[i] = wind * zi;
            const jitter = (rng() - 0.5) * 0.8;
            const r = (baseRadius + jitter) * zi;
            radius[i] = r > MIN_RADIUS ? r : MIN_RADIUS;
            driftAmp[i] = driftAmplitude * zi;
            bucket[i] = zi < 0.4 ? 0 : zi < 0.7 ? 1 : 2;
            driftPhase[i] = rng() * TAU;
            driftSpeed[i] = driftFreq + (rng() - 0.5) * 0.5;

            if (++spawned >= cap) break;
        }
        this._spawnCursor = cursor;
    }
}

export function run() {
    // Control 1 -- the alloc gate. A hot body that retains an allocation every
    // iteration MUST be rejected by runOpsGate (maxArrayBuffersGrowth:0).
    const { report } = runOpsGate((i) => { leak.push(new Float64Array(64)); }, {
        ops: 4000,
        warmup: 0,
    });
    if (report.ok) {
        die('T9 control 1: an allocating hot loop passed the zero-alloc gate');
    }
    leak.length = 0; // release the control's garbage

    // Control 3 -- the dt door. A SnowEngine whose _sane is reverted to the
    // v1.0.1 comparison guard (dt > 0.1 ? 0.1 : dt) does NOT reject a NaN dt, so
    // nanDtSurvived must return false for it and true for the fixed engine. Both
    // subclass and instance live INSIDE run() so a second _sane receiver shape
    // never reaches the measured T6 lane and deopts it.
    class RevertedDoorEngine extends SnowEngine {
        _sane(dt, w, h) { return dt > 0.1 ? 0.1 : dt; } // verbatim v1.0.1 guard
    }
    if (nanDtSurvived(new RevertedDoorEngine(200, { density: 100, rng: makeRng(SEED) }), makeMockCtx())) {
        die('T9 control 3: the reverted v1.0.1 dt guard survived a NaN dt -- the SN-01 gate cannot fail');
    }
    if (!nanDtSurvived(new SnowEngine(200, { density: 100, rng: makeRng(SEED) }), makeMockCtx())) {
        die('T9 control 3: the fixed engine failed nanDtSurvived -- the SN-01 gate passes for the wrong reason');
    }

    // Control 4 -- the spawn cap. A SnowEngine whose spawn is a FROZEN VERBATIM
    // COPY of the v1.0.1 body overfills the pool on a NaN w, so spawnBoundHolds
    // must return false for it and true for the fixed engine.
    class RevertedCapEngine extends SnowEngine {
        // FROZEN v1.0.1 COPY -- never update this to track the engine.
        spawn(dt, w, h) {
            if (this._destroyed) return;
            if (dt > 0.1) dt = 0.1;

            // Only recompute area modifier on dimension change
            if (this._lastW !== w || this._lastH !== h) {
                this._lastW = w;
                this._lastH = h;
                this._areaModifier = (w * h) / 100000;
            }

            const targetSpawns = Math.floor(this._areaModifier * this.config.density * (dt * 60));
            let spawned = 0;
            if (targetSpawns <= 0) return;

            for (let i = 0; i < this.max; i++) {
                if (this.state[i] === 0) {
                    this.state[i] = 1;

                    const windOffset = (h / this.config.gravity) * Math.abs(this.config.wind);
                    this.x[i] = this.config.rng() * (w + windOffset * 2) - windOffset;
                    this.y[i] = -50 - this.config.rng() * 50;

                    this.z[i] = 0.2 + this.config.rng() * 0.8;

                    this.gz[i] = this.config.gravity * this.z[i];
                    this.wz[i] = this.config.wind * this.z[i];

                    const jitter = (this.config.rng() - 0.5) * 0.8;
                    this.radius[i] = (this.config.baseRadius + jitter) * this.z[i];
                    this.driftAmp[i] = this.config.driftAmplitude * this.z[i];

                    this.bucket[i] = this.z[i] < 0.4 ? 0 : this.z[i] < 0.7 ? 1 : 2;
                    this.driftPhase[i] = this.config.rng() * TAU;
                    this.driftSpeed[i] = this.config.driftFreq + (this.config.rng() - 0.5) * 0.5;

                    if (++spawned >= targetSpawns) return;
                }
            }
        }
    }
    if (spawnBoundHolds(new RevertedCapEngine(10000, { density: 100, rng: makeRng(SEED) }), 0.016, NaN, 600)) {
        die('T9 control 4: the reverted v1.0.1 spawn respected the bound on NaN w -- the SN-02 gate cannot fail');
    }
    if (!spawnBoundHolds(new SnowEngine(10000, { density: 100, rng: makeRng(SEED) }), 0.016, NaN, 600)) {
        die('T9 control 4: the fixed engine violated the spawn bound -- the SN-02 gate passes for the wrong reason');
    }

    // Control 6 -- the conservation checker. Prove it is BOTH sound on a valid
    // pool and able to flag a corrupted state. A checker that never fails is
    // blind to SN-02/SN-04 class overfill and slot corruption.
    const e = new SnowEngine(16, { density: 400, rng: makeRng(SEED) });
    e.spawn(0.016, 800, 600);
    if (!conservation(e)) {
        die('T9 control 6: conservation() reported false on a valid pool (checker is broken)');
    }
    e.state[0] = 7; // a state outside {0,1,2}
    if (conservation(e)) {
        die('T9 control 6: conservation() held despite a corrupted state[0]=7');
    }
    e.state[0] = 0; // heal it

    // Control -- the T7 drain gate. T7 drains the pool and asserts it is empty;
    // the drain LOOP uses the cheap scalar `liveCount`, so if that same function
    // were also the oracle a lying `liveCount() -> 0` would skip the loop (pool
    // stays full) AND pass the assertion vacuously. T7 guards against this with
    // an INDEPENDENT witness (`occupancy`, a separate array walk). Prove that
    // witness is load-bearing: fill a pool, DON'T drain it, and confirm occupancy
    // still reports it full -- so a drain that lied about being empty is rejected.
    const de = new SnowEngine(64, { density: 400, rng: makeRng(SEED) });
    de.spawn(0.016, 800, 600); // pool now has live slots; a lying liveCount()->0
                               // would make T7's drain loop a no-op
    const lyingLiveCount = () => 0; // the deliberately-broken scalar oracle
    if (lyingLiveCount() !== 0) {
        die('T9 control: the lying live-count did not return 0 (control setup broken)');
    }
    const docc = occupancy(de);
    if (docc.free === de.max) {
        die('T9 control: T7 drain witness reported a full pool as empty (free=' +
            docc.free + ' max=' + de.max + ') -- the soak drain gate cannot fail');
    }

    // Control -- the mock-ctx instrument. The T6/T2 draw-count and position
    // digest are load-bearing; prove they actually record, so a future fill()
    // assertion cannot be trivially satisfied by an inert stub.
    const ctx = makeMockCtx();
    ctx.beginPath();
    ctx.arc(5, 10, 1, 0, 6.2831853);
    ctx.ellipse(15, 20, 2, 1, 0, 0, 6.2831853);
    ctx.fill();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = 'white';
    if (ctx.nFill !== 1) die('T9 control: mock ctx did not count fill()');
    if (ctx.nBeginPath !== 1) die('T9 control: mock ctx did not count beginPath()');
    if (ctx.nArc !== 1) die('T9 control: mock ctx did not count arc()');
    if (ctx.nEllipse !== 1) die('T9 control: mock ctx did not count ellipse()');
    if (ctx.nGlobalAlpha !== 1) die('T9 control: mock ctx did not count a globalAlpha write');
    if (ctx.nFillStyle !== 1) die('T9 control: mock ctx did not count a fillStyle write');
    if (ctx.sumX !== 20) die('T9 control: mock ctx sumX digest wrong (expected 20)');
    if (ctx.minX !== 5) die('T9 control: mock ctx minX digest wrong (expected 5)');
    if (ctx.maxY !== 20) die('T9 control: mock ctx maxY digest wrong (expected 20)');
    ctx.reset();
    if (ctx.nFill !== 0 || ctx.sumX !== 0 || ctx.minX !== Infinity) {
        die('T9 control: mock ctx reset() left a stale counter or accumulator');
    }

    // Control 7 -- clear() must be a full reset. A clear() that zeroes the pool
    // and the counters but SKIPS the clock (and the dimension cache) fails
    // clearIsFullReset; the fixed clear() passes. Both live inside run().
    class ClearNoClockEngine extends SnowEngine {
        clear() {
            if (this._destroyed) return;
            this.state.fill(0);
            this._nFalling = 0;
            this._nMelting = 0;
        }
    }
    if (clearIsFullReset(new ClearNoClockEngine(64, { density: 400, rng: makeRng(SEED) }), makeMockCtx())) {
        die('T9 control 7: a clear() that skips the clock passed clearIsFullReset -- the D5 gate cannot fail');
    }
    if (!clearIsFullReset(new SnowEngine(64, { density: 400, rng: makeRng(SEED) }), makeMockCtx())) {
        die('T9 control 7: the fixed clear() failed clearIsFullReset -- the D5 gate passes for the wrong reason');
    }

    // Control 8 -- destroy() re-inverted to the FROZEN v1.0.2 body: flag first,
    // then clear() (which then no-ops on the flag), then null the fourteen columns
    // ONLY. It never releases config/colorStr/the render bins and leaves the clock
    // non-zero, so destroyReleasesAll rejects it; the fixed destroy passes.
    class RevertedDestroyEngine extends SnowEngine {
        destroy() {
            if (this._destroyed) return;
            this._destroyed = true;
            this.clear();
            this.x = null; this.y = null; this.z = null; this.gz = null;
            this.wz = null; this.bucket = null; this.radius = null;
            this.driftPhase = null; this.driftSpeed = null; this.driftAmp = null;
            this.life = null; this.state = null;
        }
    }
    const c8 = new RevertedDestroyEngine(64, { density: 400, rng: makeRng(SEED) });
    c8.spawn(0.016, 800, 600);
    c8.updateAndDraw(makeMockCtx(), 0.016, 800, 600);
    if (destroyReleasesAll(c8)) {
        die('T9 control 8: the re-inverted destroy passed destroyReleasesAll -- the D6 gate cannot fail');
    }
    const c8fixed = new SnowEngine(64, { density: 400, rng: makeRng(SEED) });
    c8fixed.spawn(0.016, 800, 600);
    c8fixed.updateAndDraw(makeMockCtx(), 0.016, 800, 600);
    if (!destroyReleasesAll(c8fixed)) {
        die('T9 control 8: the fixed destroy failed destroyReleasesAll -- the D6 gate passes for the wrong reason');
    }

    // Control 9 -- the spawn cap frozen as the pre-S2 `| 0` coercion. A VERBATIM
    // copy of the current spawn body with the cap line left as Math.floor(...)|0.
    // FROZEN -- never update this to track the engine. At (0.1, 1e7, 5e6) the raw
    // cap is 3e10, which `| 0` wraps to a negative -> 0 spawned; the fixed engine
    // clamps to min(raw, max) and fills all 64.
    class FrozenCapEngine extends SnowEngine {
        spawn(dt, w, h) {
            if (this._destroyed) return;
            dt = this._sane(dt, w, h); if (dt < 0) return;

            if (this._lastW !== w || this._lastH !== h) {
                this._lastW = w;
                this._lastH = h;
                this._areaModifier = (w * h) / 100000;
            }

            const cap = Math.floor(this._areaModifier * this.config.density * (dt * 60)) | 0; // FROZEN
            if (cap <= 0) return;
            const g = this.config.gravity;
            let windOffset = g === 0 ? 0 : (h / g) * Math.abs(this.config.wind);
            if (!Number.isFinite(windOffset)) windOffset = 0;
            let spawned = 0;

            for (let i = 0; i < this.max; i++) {
                if (this.state[i] === 0) {
                    this.state[i] = 1;
                    this._nFalling++;

                    this.x[i] = this.config.rng() * (w + windOffset * 2) - windOffset;
                    this.y[i] = -50 - this.config.rng() * 50;

                    this.z[i] = 0.2 + this.config.rng() * 0.8;

                    this.gz[i] = this.config.gravity * this.z[i];
                    this.wz[i] = this.config.wind * this.z[i];

                    const jitter = (this.config.rng() - 0.5) * 0.8;
                    const r = (this.config.baseRadius + jitter) * this.z[i];
                    this.radius[i] = r > 0.01 ? r : 0.01;
                    this.driftAmp[i] = this.config.driftAmplitude * this.z[i];

                    this.bucket[i] = this.z[i] < 0.4 ? 0 : this.z[i] < 0.7 ? 1 : 2;
                    this.driftPhase[i] = this.config.rng() * TAU;
                    this.driftSpeed[i] = this.config.driftFreq + (this.config.rng() - 0.5) * 0.5;

                    if (++spawned >= cap) return;
                }
            }
        }
    }
    if (spawnCapNoWrap(new FrozenCapEngine(64, { density: 10, rng: makeRng(SEED) }))) {
        die('T9 control 9: the frozen | 0 cap filled the pool on a 3e10 raw -- the SN-32 gate cannot fail');
    }
    if (!spawnCapNoWrap(new SnowEngine(64, { density: 10, rng: makeRng(SEED) }))) {
        die('T9 control 9: the fixed cap did not fill the pool -- the SN-32 gate passes for the wrong reason');
    }

    // Control 10 -- the counter oracle. countersAgree must hold on an untouched
    // engine after 50 frames AND flag a single hand-decremented counter. This
    // proves the T7 per-cycle counter assertion can actually fail.
    const c10 = new SnowEngine(64, {
        gravity: 5000, density: 200, meltTimeMin: 0.5, meltTimeMax: 1.0, rng: makeRng(SEED),
    });
    const ctx10 = makeMockCtx();
    for (let f = 0; f < 50; f++) {
        c10.spawn(0.016, 800, 600);
        c10.updateAndDraw(ctx10, 0.016, 800, 600);
    }
    if (!countersAgree(c10)) {
        die('T9 control 10: an untouched engine failed countersAgree after 50 frames -- the counter oracle passes for the wrong reason');
    }
    c10._nMelting -= 1; // hand-corrupt exactly one counter
    if (countersAgree(c10)) {
        die('T9 control 10: countersAgree held despite a hand-decremented _nMelting -- the T7 per-cycle counter assertion cannot fail');
    }

    // Control 2 -- the T5 differential comparator. tuplesMatch must HOLD on a
    // synced engine/oracle pair and FLAG a corrupted oracle. A comparator that
    // never diverges could not protect the S3 binning/ring-cursor rewrite.
    {
        const cfg = () => ({
            gravity: 800, wind: 120, density: 30, baseRadius: 2.5,
            driftAmplitude: 20, driftFreq: 1.0, meltTimeMin: 0.3, meltTimeMax: 0.8,
            rng: makeRng(SEED ^ 0x2b2b2b2b),
        });
        const eng = new SnowEngine(64, cfg());
        const ora = new SnowOracle(64, cfg());
        const cctx = makeMockCtx();
        for (let f = 0; f < 24; f++) {
            eng.spawn(0.05, 800, 600); ora.spawn(0.05, 800, 600);
            eng.updateAndDraw(cctx, 0.05, 800, 600); ora.step(0.05, 800, 600);
        }
        if (!tuplesMatch(eng, ora).ok) {
            die('T9 control 2: a synced engine/oracle diverged -- the T5 fuzz passes for the wrong reason');
        }
        let idx = -1;
        for (let i = 0; i < ora.max; i++) { if (ora.slots[i].state !== 0) { idx = i; break; } }
        if (idx < 0) die('T9 control 2: the oracle has no live slot to corrupt (control setup broken)');
        ora.slots[idx].x = ora.slots[idx].x + 1.5; // perturb one live tuple
        if (tuplesMatch(eng, ora).ok) {
            die('T9 control 2: tuplesMatch held despite a corrupted oracle slot -- the T5 comparator cannot fail');
        }
    }

    // Control 5 -- the melt fill-count batching. Both directions:
    //   (a) the batched engine on a >MELT_BINS-melter scene fills EXACTLY
    //       3 + meltBinsUsed and never exceeds 3 + MELT_BINS;
    //   (b) the SAME scene with batching removed (UnbatchedMeltEngine) fills
    //       3 + meltCount, which exceeds the ceiling -- so the assertion bites;
    //   (c) a batched NO-MELT scene fills exactly 3, so (a) is not vacuously
    //       satisfied by melt always being present.
    {
        // (a) batched, many melters
        const e = new SnowEngine(300, meltSceneConfig(SEED ^ 0x55aa55aa));
        for (let f = 0; f < 12; f++) { e.spawn(0.016, 800, 600); e.updateAndDraw(makeMockCtx(), 0.016, 800, 600); }
        const ctxA = makeMockCtx();
        e.updateAndDraw(ctxA, 0.016, 800, 600);
        const mb = meltBins(e);
        if (!(mb.melt > MELT_BINS)) {
            die('T9 control 5: batched scene has only ' + mb.melt + ' melters -- the ceiling would be vacuous');
        }
        if (ctxA.nFill !== 3 + mb.used) {
            die('T9 control 5: batched engine filled ' + ctxA.nFill + ' != 3 + ' + mb.used + ' melt bands');
        }
        if (ctxA.nFill > 3 + MELT_BINS) {
            die('T9 control 5: batched engine filled ' + ctxA.nFill + ' > 3 + ' + MELT_BINS + ' ceiling');
        }

        // (b) same scene, batching removed -> fill count blows the ceiling
        const u = new UnbatchedMeltEngine(300, meltSceneConfig(SEED ^ 0x55aa55aa));
        for (let f = 0; f < 12; f++) { u.spawn(0.016, 800, 600); u.updateAndDraw(makeMockCtx(), 0.016, 800, 600); }
        const ctxB = makeMockCtx();
        u.updateAndDraw(ctxB, 0.016, 800, 600);
        const umb = meltBins(u);
        if (ctxB.nFill !== 3 + umb.melt) {
            die('T9 control 5: unbatched engine filled ' + ctxB.nFill + ' != 3 + ' + umb.melt + ' melters (control setup broken)');
        }
        if (ctxB.nFill <= 3 + MELT_BINS) {
            die('T9 control 5: unbatched melt render stayed within the 3 + ' + MELT_BINS +
                ' ceiling (' + ctxB.nFill + ') -- the fill-count assertion cannot fail');
        }

        // (c) batched, zero melt -> exactly 3 fills (non-vacuity of (a))
        const z = new SnowEngine(300, { gravity: 40, wind: 0, density: 300, rng: makeRng(SEED ^ 0x0badf00d) });
        z.spawn(0.016, 800, 600);
        const ctxC = makeMockCtx();
        z.updateAndDraw(ctxC, 0.016, 800, 600);
        if (meltBins(z).melt !== 0) {
            die('T9 control 5: the no-melt scene had melters (control setup broken)');
        }
        if (ctxC.nFill !== 3) {
            die('T9 control 5: a no-melt frame filled ' + ctxC.nFill + ' != 3 -- the fill-count assertion is vacuous');
        }
    }

    // Control -- the DRAG guard (S5). Forcing `dragOn` true at the DEFAULT
    // config (drag===1) switches to the SEPARATE double-integration model, so
    // the digest MUST move away from the correctly-guarded default's.
    {
        const seed = SEED ^ 0xd4a90ff;
        const fixedDigest = runS5Control(SnowEngine, {}, seed);
        const mutantDigest = runS5Control(DragAlwaysOnEngine, {}, seed);
        process.stderr.write('torture: note -- T9 control drag: fixed-default digest ' +
            fixedDigest + ', dragOn-forced-true-at-default digest ' + mutantDigest + '\n');
        if (mutantDigest === fixedDigest) {
            die('T9 control drag: forcing dragOn true at the default config did not move the ' +
                'digest (' + mutantDigest + ') -- the drag guard cannot fail');
        }
    }

    // Control -- the GUST guard (S5). gust=0 makes ANY unguarded branch add
    // exactly zero (0*x===0), so the meaningful failure mode is the guard
    // stuck OFF while gust IS armed: prove that a gust-armed digest, under the
    // BROKEN guard, collapses onto the correctly-guarded OFF digest -- and that
    // the FIXED engine keeps the armed and off digests properly distinct.
    {
        const seed = SEED ^ 0x6357075e;
        const offDigest = runS5Control(SnowEngine, {}, seed);
        const armedFixedDigest = runS5Control(SnowEngine, { gust: 500 }, seed);
        const armedBrokenDigest = runS5Control(GustStuckOffEngine, { gust: 500 }, seed);
        process.stderr.write('torture: note -- T9 control gust: off digest ' + offDigest +
            ', armed+fixed digest ' + armedFixedDigest + ', armed+gustOn-stuck-false digest ' +
            armedBrokenDigest + '\n');
        if (armedFixedDigest === offDigest) {
            die('T9 control gust: an armed gust config produced the SAME digest as off on the ' +
                'fixed engine (control setup broken -- gust has no measurable effect here)');
        }
        if (armedBrokenDigest !== offDigest) {
            die('T9 control gust: gustOn stuck false on an ARMED config did not collapse onto ' +
                'the off digest (got ' + armedBrokenDigest + ') -- the gust guard cannot fail');
        }
    }

    // Control -- the TURBULENCE guard (S5). Same shape as the gust control
    // above, for turbulence=0's identical "0*x===0" reasoning.
    {
        const seed = SEED ^ 0x7b0b8175;
        const offDigest = runS5Control(SnowEngine, {}, seed);
        const armedFixedDigest = runS5Control(SnowEngine, { turbulence: 400 }, seed);
        const armedBrokenDigest = runS5Control(TurbStuckOffEngine, { turbulence: 400 }, seed);
        process.stderr.write('torture: note -- T9 control turbulence: off digest ' + offDigest +
            ', armed+fixed digest ' + armedFixedDigest + ', armed+turbOn-stuck-false digest ' +
            armedBrokenDigest + '\n');
        if (armedFixedDigest === offDigest) {
            die('T9 control turbulence: an armed turbulence config produced the SAME digest as ' +
                'off on the fixed engine (control setup broken)');
        }
        if (armedBrokenDigest !== offDigest) {
            die('T9 control turbulence: turbOn stuck false on an ARMED config did not collapse ' +
                'onto the off digest (got ' + armedBrokenDigest + ') -- the turbulence guard cannot fail');
        }
    }

    // Control -- the vx/vy spawn reset (S5, decisions/0002 decision 2). Arm
    // gust+turbulence so a flake accumulates nonzero vx/vy, force it to die
    // (a tiny meltTime), force the ring cursor to recycle the exact same
    // slots, and prove the reset is load-bearing: the FIXED engine's recycled
    // slot is (0,0); the mutant (reset removed) leaks the dead flake's
    // velocity into the new one.
    {
        const cfg = () => ({
            gravity: 20000, wind: 0, density: 4000,
            meltTimeMin: 0.001, meltTimeMax: 0.002,
            gust: 300, turbulence: 200,
            rng: makeRng(SEED ^ 0x5107ee5e),
        });
        const RESET_MAX = 8;

        function settleAndDie(engine) {
            const ctx = makeMockCtx();
            engine.spawn(0.1, 100, 50);
            engine.updateAndDraw(ctx, 0.05, 100, 50); // settle: state 1 -> 2, vx/vy nonzero
            engine.updateAndDraw(ctx, 0.05, 100, 50); // life expires: state 2 -> 0 (S5-tiny meltTime)
            return ctx;
        }

        // Fixed engine: precondition -- the pool actually died with nonzero
        // stale vx/vy (else this control would be proving nothing).
        const fixed = new SnowEngine(RESET_MAX, cfg());
        settleAndDie(fixed);
        let deadCount = 0, staleNonZero = 0;
        for (let i = 0; i < RESET_MAX; i++) {
            if (fixed.state[i] !== 0) continue;
            deadCount++;
            if (fixed.vx[i] !== 0 || fixed.vy[i] !== 0) staleNonZero++;
        }
        if (deadCount === 0 || staleNonZero === 0) {
            die('T9 control vx/vy reset: no dead slot with nonzero stale velocity to recycle ' +
                '(control setup broken -- deadCount=' + deadCount + ' staleNonZero=' + staleNonZero + ')');
        }
        const ctxRespawn = makeMockCtx();
        fixed.spawn(0.1, 100, 50); // recycle the dead slots
        for (let i = 0; i < RESET_MAX; i++) {
            if (fixed.state[i] !== 1) continue;
            if (fixed.vx[i] !== 0 || fixed.vy[i] !== 0) {
                die('T9 control vx/vy reset: the FIXED engine recycled slot ' + i +
                    ' with nonzero velocity (vx=' + fixed.vx[i] + ', vy=' + fixed.vy[i] +
                    ') -- the spawn reset is broken');
            }
        }

        // Mutant engine (reset removed): the SAME scenario must leak a
        // nonzero velocity into at least one recycled slot.
        const mutant = new NoVelocityResetEngine(RESET_MAX, cfg());
        settleAndDie(mutant);
        mutant.spawn(0.1, 100, 50);
        let leaked = 0;
        for (let i = 0; i < RESET_MAX; i++) {
            if (mutant.state[i] !== 1) continue;
            if (mutant.vx[i] !== 0 || mutant.vy[i] !== 0) leaked++;
        }
        process.stderr.write('torture: note -- T9 control vx/vy reset: mutant leaked nonzero ' +
            'velocity into ' + leaked + ' recycled slot(s) (fixed engine leaked 0)\n');
        if (leaked === 0) {
            die('T9 control vx/vy reset: removing the vx[i]=0/vy[i]=0 reset did NOT leak a ' +
                'nonzero velocity into any recycled slot -- the load-bearing claim cannot fail');
        }
    }
}
