/**
 * @zakkster/lite-snow v1.2.0
 * Zero-GC, SoA Environmental Snow Engine
 * Drift physics, Z-depth parallax, ellipse accumulation, bin-driven rendering, 3 presets.
 */

export const VERSION = '1.2.0';

const TAU = Math.PI * 2;
const DT_MAX = 0.1;
const MAX_PARTICLES = 10000000;
const MIN_RADIUS = 0.01;

// Default global gust frequency (rad/s): one full horizontal swing every ~3s.
const GUST_FREQ_DEF = TAU / 3;
// Fail-closed force cap (px/s^2). Every acceleration component fed into vx/vy is
// clamped to +/- this before integration, so velocity growth stays LINEAR and
// positions stay finite for ANY finite gust/turbulence input (decisions/0002).
const ACCEL_MAX = 10000;

// Melt render is batched into MELT_BINS alpha bands: at most one beginPath/fill
// pair per band instead of one per particle (SN-06). Fill count per frame is
// exactly 3 depth buckets + the number of melt bands actually populated.
const MELT_BINS = 8;
const MELT_BIN_STEP = 1 / MELT_BINS; // 0.125; band b renders at (b + 0.5) * step
// A live slot index (< MAX_PARTICLES < 2**24) is packed into the low 24 bits of
// a melt-bin entry and its alpha band into the top bits, so render reads the
// band with a shift and the slot with a mask -- no per-entry alpha recompute.
const MELT_INDEX_MASK = 0xFFFFFF;
const MELT_BIN_SHIFT = 24;

// The three depth-bucket render alphas (bucket zAvg * 0.8, folded to constants
// now that the loop over descriptor objects is gone): 0.3*0.8, 0.55*0.8, 0.9*0.8.
const BUCKET0_ALPHA = 0.24;
const BUCKET1_ALPHA = 0.44;
const BUCKET2_ALPHA = 0.72;

export class SnowEngine {
    constructor(maxParticles = 10000, config = {}) {
        if (!Number.isInteger(maxParticles) || maxParticles < 1 || maxParticles > MAX_PARTICLES) {
            throw new RangeError('lite-snow: maxParticles must be an integer 1..10000000, got ' + String(maxParticles));
        }
        this.max = maxParticles;
        this.config = {
            gravity: 40,          
            wind: 30,             
            density: 10.0,        
            baseRadius: 2.5,      
            driftAmplitude: 15,   
            driftFreq: 1.0,       
            meltTimeMin: 2.0,
            meltTimeMax: 5.0,
            gust: 0,
            gustFreq: GUST_FREQ_DEF,
            turbulence: 0,
            drag: 1,
            color: 'oklch(0.98 0.02 250)',
            rng: Math.random,
            ...config
        };

        if (!Number.isFinite(this.config.baseRadius) || this.config.baseRadius <= 0) {
            throw new RangeError('lite-snow: baseRadius must be a finite number > 0, got ' + String(this.config.baseRadius));
        }

        // Fail closed at the door: each living-air knob coerces non-finite (incl.
        // null and undefined) to its DEFAULT, not to 0. null is not zero -- a null
        // gust must land on the inert default so the guards stay provably off.
        const cfg = this.config;
        cfg.gust = Number.isFinite(cfg.gust) ? cfg.gust : 0;
        cfg.gustFreq = Number.isFinite(cfg.gustFreq) ? cfg.gustFreq : GUST_FREQ_DEF;
        cfg.turbulence = Number.isFinite(cfg.turbulence) ? cfg.turbulence : 0;
        cfg.drag = Number.isFinite(cfg.drag) ? cfg.drag : 1;

        this.colorStr = typeof this.config.color === 'string' ? this.config.color : this._cssOklch(this.config.color);

        this.x = new Float32Array(this.max);
        this.y = new Float32Array(this.max);
        this.z = new Float32Array(this.max);
        
        this.gz = new Float32Array(this.max);    
        this.wz = new Float32Array(this.max);    
        this.bucket = new Uint8Array(this.max);  
        this.radius = new Float32Array(this.max); 
        this.driftPhase = new Float32Array(this.max); 
        this.driftSpeed = new Float32Array(this.max); 
        this.driftAmp = new Float32Array(this.max); 

        this.life = new Float32Array(this.max);
        this.state = new Uint8Array(this.max);

        // Living-air velocity (S5). On the default path vx/vy carry ONLY the
        // gust + turbulence perturbation, added on top of the positional base,
        // and are zero unless a force is armed. drag !== 1 takes a separate
        // branch that folds gz/wz into these and integrates from them
        // (decisions/0002). 14 columns now, 66 B/particle.
        this.vx = new Float32Array(this.max);
        this.vy = new Float32Array(this.max);
        
        this._elapsedTime = 0;
        this._nFalling = 0;
        this._nMelting = 0;
        this._destroyed = false;

        // Dimension cache -- recompute only on size change
        this._lastW = 0;
        this._lastH = 0;
        this._areaModifier = 0;

        // Render bins, allocated once. Each frame the physics pass folds every
        // live slot's FINAL state into one of these (SN-11/SN-13), so the render
        // pass iterates only live indices instead of scanning the whole pool
        // four times. Fill counts are frame-local and live as locals in
        // updateAndDraw -- these arrays are the only per-frame render state.
        this._bin0 = new Uint32Array(this.max);   // depth bucket 0 (near)
        this._bin1 = new Uint32Array(this.max);   // depth bucket 1 (mid)
        this._bin2 = new Uint32Array(this.max);   // depth bucket 2 (far)
        this._binMelt = new Uint32Array(this.max); // settled/melting slots (packed)
        this._meltAlphaCount = new Uint32Array(MELT_BINS); // per-band populate flags

        // Ring cursor for spawn: the next slot to probe, wrapping at max, so a
        // spawn is O(spawned) amortised instead of O(max)-from-zero (SN-12).
        this._spawnCursor = 0;
    }

    // Inlined OKLCH-object -> CSS-string formatter (SN-19: was toCssOklch from
    // @zakkster/lite-color, dropped to hold suite zero-runtime-dep law). Output is
    // BYTE-IDENTICAL to that function for a valid { l, c, h, a? } object. Fails
    // closed to the documented default string on a null/non-object input or any
    // non-finite channel -- it must never emit "oklch(NaN NaN NaN)", which canvas
    // silently ignores, stranding fillStyle at whatever it was set to before.
    _cssOklch(c) {
        if (c === null || typeof c !== 'object') return 'oklch(0.98 0.02 250)';
        const l = c.l, ch = c.c, h = c.h;
        if (!Number.isFinite(l) || !Number.isFinite(ch) || !Number.isFinite(h)) {
            return 'oklch(0.98 0.02 250)';
        }
        const a = c.a === undefined ? 1 : c.a;
        return 'oklch(' + l.toFixed(4) + ' ' + ch.toFixed(4) + ' ' + h.toFixed(2) + ' / ' + a + ')';
    }

    /** Fail-closed frame door. Returns the clamped dt, or -1 to reject the frame. */
    _sane(dt, w, h) {
        if (!Number.isFinite(dt) || dt < 0) return -1;
        if (!Number.isFinite(w) || w <= 0) return -1;
        if (!Number.isFinite(h) || h <= 0) return -1;
        return dt > DT_MAX ? DT_MAX : dt;
    }

    spawn(dt, w, h) {
        if (this._destroyed) return;
        dt = this._sane(dt, w, h); if (dt < 0) return;

        // Only recompute area modifier on dimension change
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

        // Hoisted config/columns -- read once, not per slot.
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
        const vx = this.vx, vy = this.vy;

        // Ring cursor: probe at most `max` slots starting where the last spawn
        // left off, filling free ones until the cap is met. A full wrap that
        // finds nothing free stops -- it never spins (SN-12, fail closed).
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

            // Load-bearing: slots recycle through the ring cursor, so a reused
            // slot must not inherit a dead flake's perturbation velocity.
            vx[i] = 0;
            vy[i] = 0;

            x[i] = rng() * (w + windOffset * 2) - windOffset;
            y[i] = -50 - rng() * 50;

            z[i] = 0.2 + rng() * 0.8;
            const zi = z[i]; // the f32-rounded store, as the derived params read it

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

    updateAndDraw(ctx, dt, w, h) {
        if (this._destroyed) return;
        if (!ctx || typeof ctx.ellipse !== 'function' || typeof ctx.arc !== 'function') return;
        dt = this._sane(dt, w, h); if (dt < 0) return;
        this._elapsedTime += dt;
        const et = this._elapsedTime;

        // Hoisted config/columns -- read once, above both loops (SN-14).
        const meltTimeMin = this.config.meltTimeMin;
        const meltRange = this.config.meltTimeMax - this.config.meltTimeMin;
        const rng = this.config.rng;
        const invMeltMax = 1.0 / this.config.meltTimeMax;
        const max = this.max;
        const state = this.state, x = this.x, y = this.y, z = this.z;
        const gz = this.gz, wz = this.wz, bucket = this.bucket, radius = this.radius;
        const driftPhase = this.driftPhase, driftSpeed = this.driftSpeed;
        const driftAmp = this.driftAmp, life = this.life;
        const vx = this.vx, vy = this.vy;

        // Living-air knobs, read ONCE above the loop (SN-14). Each armed block is
        // guarded by a hoisted flag so an unarmed engine pays only the branch
        // bytes. gust is GLOBAL, so its acceleration is computed once here, not
        // per particle -- its phase is the shared _elapsedTime clock.
        const gust = this.config.gust;
        const turbulence = this.config.turbulence;
        const drag = this.config.drag;
        const gustOn = gust !== 0;
        const turbOn = turbulence !== 0;
        const dragOn = drag !== 1;
        const gustAccel = gustOn ? Math.sin(et * this.config.gustFreq) * gust : 0;

        const bin0 = this._bin0, bin1 = this._bin1, bin2 = this._bin2, binMelt = this._binMelt;
        const meltAlphaCount = this._meltAlphaCount;
        let n0 = 0, n1 = 0, n2 = 0, nMelt = 0;
        meltAlphaCount[0] = 0; meltAlphaCount[1] = 0; meltAlphaCount[2] = 0; meltAlphaCount[3] = 0;
        meltAlphaCount[4] = 0; meltAlphaCount[5] = 0; meltAlphaCount[6] = 0; meltAlphaCount[7] = 0;

        // --- 1. GLOBAL PHYSICS PASS (folds the render bin push in, SN-13) ---
        for (let i = 0; i < max; i++) {
            const s = state[i];
            if (s === 0) continue;

            if (s === 1) {
                const tp = et * driftSpeed[i] + driftPhase[i];
                const sway = Math.sin(tp) * driftAmp[i];

                if (dragOn) {
                    // SEPARATE integration model (decisions/0002): fold the base
                    // gravity/wind and any perturbation into velocity, damp by
                    // drag toward a terminal velocity, then integrate position.
                    // Off by default (drag === 1), so this never runs unarmed.
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
                    // POSITIONAL base -- byte-identical to v1.1.1 when no force is
                    // armed. vx/vy carry ONLY the gust + turbulence perturbation,
                    // added on top; both are zero unless a force is armed.
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

                // Off-screen culling (X-axis wind leak AND Y-axis negative gravity leak)
                if (!(x[i] >= -200 && x[i] <= w + 200 && y[i] >= -200)) {
                    state[i] = 0;
                    this._nFalling--;
                    continue;
                }

                if (y[i] >= h) {
                    y[i] = h;
                    state[i] = 2;
                    this._nFalling--; this._nMelting++;
                    life[i] = meltTimeMin + rng() * meltRange;
                }
            } else { // s === 2
                life[i] -= dt;
                if (life[i] <= 0) { state[i] = 0; this._nMelting--; continue; }
                if (y[i] > h) y[i] = h; // resize-shrink clamp, melt branch only (SN-08)
            }

            // Push this live slot's FINAL state into its render bin.
            if (state[i] === 1) {
                const bk = bucket[i];
                if (bk === 0) bin0[n0++] = i;
                else if (bk === 1) bin1[n1++] = i;
                else bin2[n2++] = i;
            } else { // settled/melting -> quantized alpha band
                let b = (life[i] * invMeltMax * z[i] * MELT_BINS) | 0;
                if (b < 0) b = 0; else if (b >= MELT_BINS) b = MELT_BINS - 1;
                binMelt[nMelt++] = i | (b << MELT_BIN_SHIFT);
                meltAlphaCount[b] = 1;
            }
        }

        // --- 2. BIN-DRIVEN RENDER PIPELINE ---
        // Exactly 3 depth-bucket fills + one fill per populated melt band.
        try {
            ctx.fillStyle = this.colorStr;

            ctx.globalAlpha = BUCKET0_ALPHA;
            ctx.beginPath();
            for (let j = 0; j < n0; j++) {
                const i = bin0[j];
                ctx.moveTo(x[i] + radius[i], y[i]);
                ctx.arc(x[i], y[i], radius[i], 0, TAU);
            }
            ctx.fill();

            ctx.globalAlpha = BUCKET1_ALPHA;
            ctx.beginPath();
            for (let j = 0; j < n1; j++) {
                const i = bin1[j];
                ctx.moveTo(x[i] + radius[i], y[i]);
                ctx.arc(x[i], y[i], radius[i], 0, TAU);
            }
            ctx.fill();

            ctx.globalAlpha = BUCKET2_ALPHA;
            ctx.beginPath();
            for (let j = 0; j < n2; j++) {
                const i = bin2[j];
                ctx.moveTo(x[i] + radius[i], y[i]);
                ctx.arc(x[i], y[i], radius[i], 0, TAU);
            }
            ctx.fill();

            // Melt: one beginPath/fill per populated alpha band (SN-06). Each
            // band re-reads the packed melt bin; the band lives in the top bits.
            for (let b = 0; b < MELT_BINS; b++) {
                if (meltAlphaCount[b] === 0) continue;
                ctx.globalAlpha = (b + 0.5) * MELT_BIN_STEP;
                ctx.beginPath();
                for (let j = 0; j < nMelt; j++) {
                    const e = binMelt[j];
                    if ((e >>> MELT_BIN_SHIFT) !== b) continue;
                    const i = e & MELT_INDEX_MASK;
                    const rx = radius[i] * 2.5;
                    ctx.moveTo(x[i] + rx, y[i]);
                    ctx.ellipse(x[i], y[i], rx, radius[i] * 0.5, 0, 0, TAU);
                }
                ctx.fill();
            }
        } finally {
            ctx.globalAlpha = 1.0;
        }
    }

    clear() {
        if (this._destroyed) return;
        this.state.fill(0);
        this._elapsedTime = 0;
        this._lastW = 0;
        this._lastH = 0;
        this._areaModifier = 0;
        this._nFalling = 0;
        this._nMelting = 0;
        this._spawnCursor = 0;
    }

    destroy() {
        if (this._destroyed) return;
        this.clear();
        this._destroyed = true;
        this.x = null; this.y = null; this.z = null; this.gz = null;
        this.wz = null; this.bucket = null; this.radius = null;
        this.driftPhase = null; this.driftSpeed = null; this.driftAmp = null;
        this.life = null; this.state = null;
        this.vx = null; this.vy = null;
        this._bin0 = null; this._bin1 = null; this._bin2 = null;
        this._binMelt = null; this._meltAlphaCount = null;
        this.config = null; this.colorStr = null;
    }

    get fallingCount() { return this._nFalling; }
    get meltingCount() { return this._nMelting; }
    get activeCount() { return this._nFalling + this._nMelting; }
}


export const SNOW_PRESETS = Object.freeze({
    flurry: Object.freeze({
        density: 10.0,
        wind: 30,
        gravity: 40,
        driftAmplitude: 15,
        baseRadius: 2.5
    }),
    heavy: Object.freeze({
        density: 24.0,
        wind: 150,
        gravity: 80,
        driftAmplitude: 25,
        baseRadius: 3.5
    }),
    blizzard: Object.freeze({
        density: 40.0,
        wind: 400,
        gravity: 250,
        driftAmplitude: 50,
        baseRadius: 2.0 // Smaller flakes due to wind shear
    })
});