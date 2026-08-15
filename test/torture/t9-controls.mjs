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
    // then clear() (which then no-ops on the flag), then null the twelve columns
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
}
