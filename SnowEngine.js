/**
 * @zakkster/lite-snow v1.4.0
 * Zero-GC, SoA Environmental Snow Engine
 * Drift physics, Z-depth parallax, persistent-pack accumulation, bin-driven rendering, 4 presets, reduced-motion + spawn shaping.
 */

export const VERSION = '1.4.0';

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
// exactly 3 depth buckets + (1 if the accumulation pack is non-empty) + the
// number of melt bands actually populated.
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

// Accumulation (S6). The pack is a Uint16Array heightmap: one column per
// packResolution px, each cell an integer count of packUnits. A landing adds
// PACK_GAIN; a per-frame integer-stepped decay removes it. It is an EXACT
// integer ledger (decisions/0003), never an f32 identity. Off by default
// (accumulate !== true), when off `pack === null` and nothing here is read.
const PACK_GAIN = 1;              // integer volume one landing adds to its column
const PACK_RES_MAX = 256;         // packResolution ceiling (px per column)
const PACK_WIDTH_MAX = 16384;     // maxPackWidth ceiling (px), grow-on-resize rejected
const PACK_HEIGHT_MAX = 65535;    // maxPackHeight ceiling = Uint16 max (AD-2)
const PACK_DECAY_DEF = 2.0;       // default decay rate (packUnits/s)
const PACK_ALPHA = 0.9;           // the single pack fill's globalAlpha

// The calm scene (S7). SINGLE SOURCE OF TRUTH for both SNOW_PRESETS.calm and the
// reducedMotion hard override (decisions/0004 (d) mechanic 5): the preset is
// Object.freeze({ ...CALM }) and the override reads its twelve MOTION keys from
// CALM, so the two can never drift. Every non-MOTION key here is a constructor
// default named with the SAME constant the default uses -- a preset is a COMPLETE
// 21-key scene (decisions/0004 (e)), and completeness is what makes { ...calm,
// ...heavy } equal heavy exactly. The seven non-default MOTION values
// (density/wind/gravity/driftAmplitude, plus baseRadius/gust/turbulence at their
// defaults) produce the measured meanDX 0.0795 / meanDY 0.1988 (decisions/0004
// (e')). spawnBand is the null SENTINEL, never a nested object (decisions/0004
// (f)).
const CALM = Object.freeze({
    gravity: 20,
    wind: 8,
    density: 4,
    baseRadius: 2.5,
    driftAmplitude: 4,
    driftFreq: 1.0,
    meltTimeMin: 2.0,
    meltTimeMax: 5.0,
    gust: 0,
    gustFreq: GUST_FREQ_DEF,
    turbulence: 0,
    drag: 1,
    spawnBand: null,
    spawnMargin: null,
    accumulate: false,
    packResolution: 4,
    maxPackWidth: 4096,
    maxPackHeight: 200,
    packDecay: PACK_DECAY_DEF,
    floorY: null,
    friction: 0
});

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
            accumulate: false,
            packResolution: 4,
            maxPackWidth: 4096,
            maxPackHeight: 200,
            packDecay: PACK_DECAY_DEF,
            floorY: null,
            friction: 0,
            spawnBand: null,
            spawnMargin: null,
            reducedMotion: false,
            color: 'oklch(0.98 0.02 250)',
            rng: Math.random,
            ...config
        };

        // reducedMotion is a HARD OVERRIDE resolved ONCE here (decisions/0004
        // (d)): the accessibility flag WINS -- an explicit motion knob set
        // alongside it is discarded, there is no "reduced blizzard". Strict arm
        // (=== true, like accumulate): 'yes'/1/{} do not arm it. It resolves
        // BEFORE baseRadius validation and every fail-closed coercion below
        // BECAUSE under the flag the twelve MOTION keys are not user-supplied at
        // all -- validating a value the engine will never read would throw on
        // discarded input, so { baseRadius: 0, reducedMotion: true } constructs
        // while { baseRadius: 0 } throws (the deliberate asymmetry, decisions/0004
        // (d')). Twelve EXPLICIT assignments from the frozen CALM const, never
        // Object.assign(this.config, CALM) -- that would mutate the caller's
        // object and defeat the two-engine non-mutation contract. NEVER read
        // again: no frame loop references _reducedMotion, so a mid-run flip is
        // inert (like accumulate).
        this._reducedMotion = this.config.reducedMotion === true;
        if (this._reducedMotion) {
            this.config.gravity = CALM.gravity;
            this.config.wind = CALM.wind;
            this.config.density = CALM.density;
            this.config.baseRadius = CALM.baseRadius;
            this.config.driftAmplitude = CALM.driftAmplitude;
            this.config.driftFreq = CALM.driftFreq;
            this.config.gust = CALM.gust;
            this.config.gustFreq = CALM.gustFreq;
            this.config.turbulence = CALM.turbulence;
            this.config.drag = CALM.drag;
            this.config.spawnBand = CALM.spawnBand;
            this.config.spawnMargin = CALM.spawnMargin;
        }

        if (!Number.isFinite(this.config.baseRadius) || this.config.baseRadius <= 0) {
            throw new RangeError('lite-snow: baseRadius must be a finite number > 0, got ' + String(this.config.baseRadius));
        }

        // Accumulation is CONSTRUCTION-TIME only (decisions/0003 (e)): the strict
        // `=== true` is the arm -- 'yes'/1/{} do not arm it, and a runtime flip of
        // config.accumulate is inert. The pack columns are validated ONLY when
        // armed; unarmed they stay at their (irrelevant) defaults and nothing
        // reads them.
        this._packOn = this.config.accumulate === true;
        if (this._packOn) {
            const pr = this.config.packResolution;
            if (!Number.isInteger(pr) || pr < 1 || pr > PACK_RES_MAX) {
                throw new RangeError('lite-snow: packResolution must be an integer 1..256, got ' + String(pr));
            }
            const pw = this.config.maxPackWidth;
            if (!Number.isInteger(pw) || pw < pr || pw > PACK_WIDTH_MAX) {
                throw new RangeError('lite-snow: maxPackWidth must be an integer packResolution..16384, got ' + String(pw));
            }
            const ph = this.config.maxPackHeight;
            if (!Number.isInteger(ph) || ph < 1 || ph > PACK_HEIGHT_MAX) {
                throw new RangeError('lite-snow: maxPackHeight must be an integer 1..65535, got ' + String(ph));
            }
        }

        // Fail closed at the door: each living-air knob coerces non-finite (incl.
        // null and undefined) to its DEFAULT, not to 0. null is not zero -- a null
        // gust must land on the inert default so the guards stay provably off.
        const cfg = this.config;
        cfg.gust = Number.isFinite(cfg.gust) ? cfg.gust : 0;
        cfg.gustFreq = Number.isFinite(cfg.gustFreq) ? cfg.gustFreq : GUST_FREQ_DEF;
        cfg.turbulence = Number.isFinite(cfg.turbulence) ? cfg.turbulence : 0;
        cfg.drag = Number.isFinite(cfg.drag) ? cfg.drag : 1;

        // Accumulation/friction knobs fail closed at the door (decisions/0003 (c),
        // AD-3). floorY: null is the "track h" sentinel, so any non-finite value
        // lands on null (never 0 = the canvas TOP). friction clamps to [0,1] with
        // negative -> 0 (never anti-friction). packDecay coerces non-finite to its
        // DEFAULT (null is not "never decay"), and a NEGATIVE decay -> 0 (a pack
        // that grows from nothing is not a thing).
        cfg.floorY = Number.isFinite(cfg.floorY) ? cfg.floorY : null;
        cfg.friction = Number.isFinite(cfg.friction) ? (cfg.friction < 0 ? 0 : cfg.friction > 1 ? 1 : cfg.friction) : 0;
        cfg.packDecay = Number.isFinite(cfg.packDecay) ? (cfg.packDecay < 0 ? 0 : cfg.packDecay) : PACK_DECAY_DEF;

        // spawnBand -> two plain-number locals for the SUBTRACTIVE spawn form
        // `y = spawnY0 - rng()*spawnYSpan` (decisions/0004 (c)). DO NOT
        // "simplify" to the mirror `min + rng()*(max-min)`: it is a DIFFERENT
        // per-draw value for the same rng and breaks every committed digest while
        // the snow still looks right. null (default), non-object, non-finite
        // bound or max < min all FAIL CLOSED to the literal -50/50 constants
        // (byte-identical to v1.3.0 by construction); a negative span would flip
        // the sign of the rng term, so an unverified band is not a band. A
        // coerce, not a throw: it sizes no allocation (decisions/0004 (g)).
        const sb = cfg.spawnBand;
        if (sb !== null && typeof sb === 'object' &&
            Number.isFinite(sb.min) && Number.isFinite(sb.max) && sb.max >= sb.min) {
            this._spawnY0 = sb.max;
            this._spawnYSpan = sb.max - sb.min;
        } else {
            this._spawnY0 = -50;
            this._spawnYSpan = 50;
        }

        // spawnMargin -> raw px inset, or null = DERIVE (the v1.3.0 wind-offset
        // expression, preserved verbatim in spawn()). null is the ONLY value
        // meaning "derive" -- same sentinel discipline as floorY. A finite
        // spawnMargin >= 0 is used raw; non-finite or negative fails closed to
        // null=derive. Coerce, not throw (decisions/0004 (g)).
        const sm = cfg.spawnMargin;
        this._spawnMargin = Number.isFinite(sm) && sm >= 0 ? sm : null;

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

        // Accumulation heightmap (S6), sized ONCE and only when armed. nCols is
        // maxPackWidth/packResolution columns (default 1024 -> 2 KB). It is NOT
        // per-particle: a separate fixed cost that never grows and is never
        // reallocated (grow-on-resize rejected -- decisions/0003). Unarmed:
        // pack === null and every pack field is null/0.
        const nCols = this._packOn ? Math.floor(this.config.maxPackWidth / this.config.packResolution) : 0;
        this.pack = this._packOn ? new Uint16Array(nCols) : null;
        this._packCols = nCols;
        this._invPackRes = this._packOn ? 1 / this.config.packResolution : 0;
        // Integer ledger (decisions/0003 (a)). Every term is an exact integer, so
        // packSum === _packLanded*PACK_GAIN - _packDecayed - _packCapped -
        // _packTruncated holds with no epsilon. _packActive is the count of
        // non-zero columns -- a render gate, not a ledger term.
        this._packDecayAcc = 0;
        this._packLanded = 0;
        this._packDecayed = 0;
        this._packCapped = 0;
        this._packTruncated = 0;
        this._packSkipped = 0;
        this._packActive = 0;

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
            // SN-08 pack policy: TRUNCATE, do not rescale (decisions/0003). One
            // fill(0) on this already-cold hook; the zeroed volume is booked to
            // _packTruncated so the exact integer identity survives the resize.
            if (this._packOn && this._packActive !== 0) {
                const pack = this.pack, cols = this._packCols;
                let sum = 0;
                for (let c = 0; c < cols; c++) sum += pack[c];
                this._packTruncated += sum;
                pack.fill(0);
                this._packActive = 0;
            }
        }

        const raw = Math.floor(this._areaModifier * this.config.density * (dt * 60));
        const cap = Number.isFinite(raw) && raw > 0 ? (raw > this.max ? this.max : raw) : 0;
        if (cap <= 0) return;
        // Spawn inset (decisions/0004 (c')). _spawnMargin === null (default) means
        // DERIVE: the v1.3.0 expression below runs VERBATIM, including the g === 0
        // short-circuit and the finiteness guard. A resolved _spawnMargin is used
        // raw. One branch per frame, zero per slot.
        let windOffset;
        if (this._spawnMargin === null) {
            const g = this.config.gravity;
            windOffset = g === 0 ? 0 : (h / g) * Math.abs(this.config.wind);
            if (!Number.isFinite(windOffset)) windOffset = 0;
        } else {
            windOffset = this._spawnMargin;
        }

        // Hoisted config/columns -- read once, not per slot.
        const rng = this.config.rng;
        const gravity = this.config.gravity;
        const wind = this.config.wind;
        const baseRadius = this.config.baseRadius;
        const driftAmplitude = this.config.driftAmplitude;
        const driftFreq = this.config.driftFreq;
        // Spawn-band locals, hoisted (decisions/0004 (c)): default -50/50 =>
        // y[i] = spawnY0 - rng()*spawnYSpan is byte-identical to v1.3.0's
        // literal `-50 - rng()*50`.
        const spawnY0 = this._spawnY0, spawnYSpan = this._spawnYSpan;
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
            y[i] = spawnY0 - rng() * spawnYSpan;

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

        // Accumulation/friction knobs, hoisted ONCE (SN-14). All guarded by the
        // construction-time _packOn / fricOn flags so an unarmed engine pays only
        // branch bytes and its output stays byte-identical to v1.2.0. fy is the
        // settle floor: floorY === null tracks the per-frame h (ONE comparison per
        // frame, zero per flake -- decisions/0003 (c)).
        const packOn = this._packOn;
        const pack = this.pack;
        const nCols = this._packCols;
        const invPackRes = this._invPackRes;
        const packRes = packOn ? this.config.packResolution : 0;
        const maxPackHeight = packOn ? this.config.maxPackHeight : 0;
        const packDecay = this.config.packDecay;
        const floorCfg = this.config.floorY;
        const fy = floorCfg === null ? h : floorCfg;
        const friction = this.config.friction;
        const fricOn = friction !== 0;
        const fricMul = 1 - friction;

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

                if (packOn) {
                    // Settle onto the PACK surface: the threshold is fy minus the
                    // column's current height. Out-of-domain columns (overhang,
                    // wind past w) settle at fy and raise nothing -- fail closed by
                    // SKIPPING, never clamping (decisions/0003 (d)). Math.floor,
                    // not | 0: (-1, 0) must reject to -1, not fold into column 0.
                    const c = Math.floor(x[i] * invPackRes);
                    const inCol = c >= 0 && c < nCols;
                    const thr = inCol ? fy - pack[c] : fy;
                    if (y[i] >= thr) {
                        y[i] = thr;
                        state[i] = 2;
                        this._nFalling--; this._nMelting++;
                        life[i] = meltTimeMin + rng() * meltRange;
                        if (fricOn) vx[i] *= fricMul; // contact-frame damp, vx only
                        if (inCol) {
                            const prev = pack[c];
                            const raised = prev + PACK_GAIN;
                            if (raised <= maxPackHeight) {
                                if (prev === 0) this._packActive++;
                                pack[c] = raised;
                                this._packLanded++;
                            } else {
                                // Cap: the column is full. Book the clipped volume
                                // so the identity stays exact; prev >= maxPackHeight
                                // >= 1 here, so the column was already non-zero.
                                pack[c] = maxPackHeight;
                                this._packLanded++;
                                this._packCapped += raised - maxPackHeight;
                            }
                        } else {
                            this._packSkipped++;
                        }
                    }
                } else if (y[i] >= fy) {
                    y[i] = fy;
                    state[i] = 2;
                    this._nFalling--; this._nMelting++;
                    life[i] = meltTimeMin + rng() * meltRange;
                    if (fricOn) vx[i] *= fricMul; // contact-frame damp, vx only
                }
            } else { // s === 2
                life[i] -= dt;
                if (life[i] <= 0) { state[i] = 0; this._nMelting--; continue; }
                if (y[i] > fy) y[i] = fy; // resize-shrink clamp, melt branch only (SN-08)
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

        // --- 1b. PACK DECAY (integer-stepped, over the FULL raise domain) ---
        // Decay MUST cover exactly the columns the settle branch can raise, which
        // is all nCols (culling admits x out to w+200, so landings reach columns
        // past any visible-width bound). A narrower window would leave columns in
        // [visible, nCols) WRITE-ONLY -- raised forever, never decayed, a permanent
        // pile that stopping the snow never melts. nCols is a FIXED bound (1024 at
        // defaults), independent of w (so resize-stable) and NEVER the particle
        // count. Conservation stays exact but does NOT prove this: the ledger only
        // counts what the loop decremented, so a too-small decay domain is
        // invisible to the identity -- it is proven by packMeltsToZero instead
        // (decisions/0003). The whole integer part of the accumulator drains in
        // one pass (AD-1); each column loses its ACTUAL decrement (min(ticks,
        // height)) so the identity survives any packDecay.
        if (packOn) {
            this._packDecayAcc += packDecay * dt;
            const ticks = Math.floor(this._packDecayAcc);
            if (ticks > 0) {
                this._packDecayAcc -= ticks;
                let decayed = 0;
                for (let c = 0; c < nCols; c++) {
                    const v = pack[c];
                    if (v !== 0) {
                        const d = v < ticks ? v : ticks;
                        pack[c] = v - d;
                        decayed += d;
                        if (v === d) this._packActive--;
                    }
                }
                this._packDecayed += decayed;
            }
        }

        // --- 2. BIN-DRIVEN RENDER PIPELINE ---
        // Exactly 3 depth-bucket fills + one pack fill (when non-empty) + one fill
        // per populated melt band.
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

            // Pack: ONE closed-path fill for the whole pile, drawn AFTER the three
            // bucket fills and BEFORE the melt bands so melting flakes render over
            // it (decisions/0003 (b)). A stepped top profile walked across the
            // visible columns, closed along fy. Emitted only when the pack is
            // non-empty, so an armed-but-empty engine still fills exactly 3 + melt
            // bands -- the +1 is provably the pack, not a miscount.
            if (packOn && this._packActive > 0) {
                ctx.globalAlpha = PACK_ALPHA;
                ctx.beginPath();
                let vis = Math.ceil(w * invPackRes);
                if (vis > nCols) vis = nCols;
                ctx.moveTo(0, fy);
                for (let c = 0; c < vis; c++) {
                    const top = fy - pack[c];
                    const x0 = c * packRes;
                    ctx.lineTo(x0, top);
                    ctx.lineTo(x0 + packRes, top);
                }
                ctx.lineTo(vis * packRes, fy);
                ctx.closePath();
                ctx.fill();
            }

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
        // Pack reset (guarded non-null): the heightmap AND every ledger scalar
        // return to fresh-construction, so a next cycle's flakes never settle on a
        // stale pile (decisions/0003).
        if (this.pack !== null) this.pack.fill(0);
        this._packDecayAcc = 0;
        this._packLanded = 0;
        this._packDecayed = 0;
        this._packCapped = 0;
        this._packTruncated = 0;
        this._packSkipped = 0;
        this._packActive = 0;
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
        this.pack = null;
        this.config = null; this.colorStr = null;
    }

    get fallingCount() { return this._nFalling; }
    get meltingCount() { return this._nMelting; }
    get activeCount() { return this._nFalling + this._nMelting; }
}


// Each preset is a COMPLETE 21-key scene (decisions/0004 (e)): all four name the
// same keys in the same order, so { ...calm, ...heavy } equals heavy exactly
// (completeness leaves no leftovers) and { ...anyPreset, reducedMotion: true }
// equals calm on every field the digest sees (identical non-MOTION keys). Every
// key a preset does not deliberately change is set to the CONSTRUCTOR DEFAULT
// using the SAME CONSTANT the default uses (GUST_FREQ_DEF, PACK_DECAY_DEF, null),
// so flurry/heavy/blizzard reproduce their committed v1.3.0 digests BY
// CONSTRUCTION -- flurry's five values ARE the defaults, so its digest equals the
// no-preset default. spawnBand is the null SENTINEL, never a nested object
// (decisions/0004 (f)), so Object.isFrozen(preset) is true all the way down.
// calm is Object.freeze({ ...CALM }) -- one source of truth with the reducedMotion
// override (decisions/0004 (d) mechanic 5). Presets never name rng, color or
// reducedMotion (injection/appearance/accessibility, not scene -- decisions/0004
// (e)).
export const SNOW_PRESETS = Object.freeze({
    flurry: Object.freeze({
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
        spawnBand: null,
        spawnMargin: null,
        accumulate: false,
        packResolution: 4,
        maxPackWidth: 4096,
        maxPackHeight: 200,
        packDecay: PACK_DECAY_DEF,
        floorY: null,
        friction: 0
    }),
    heavy: Object.freeze({
        gravity: 80,
        wind: 150,
        density: 24.0,
        baseRadius: 3.5,
        driftAmplitude: 25,
        driftFreq: 1.0,
        meltTimeMin: 2.0,
        meltTimeMax: 5.0,
        gust: 0,
        gustFreq: GUST_FREQ_DEF,
        turbulence: 0,
        drag: 1,
        spawnBand: null,
        spawnMargin: null,
        accumulate: false,
        packResolution: 4,
        maxPackWidth: 4096,
        maxPackHeight: 200,
        packDecay: PACK_DECAY_DEF,
        floorY: null,
        friction: 0
    }),
    blizzard: Object.freeze({
        gravity: 250,
        wind: 400,
        density: 40.0,
        baseRadius: 2.0, // Smaller flakes due to wind shear
        driftAmplitude: 50,
        driftFreq: 1.0,
        meltTimeMin: 2.0,
        meltTimeMax: 5.0,
        gust: 0,
        gustFreq: GUST_FREQ_DEF,
        turbulence: 0,
        drag: 1,
        spawnBand: null,
        spawnMargin: null,
        accumulate: false,
        packResolution: 4,
        maxPackWidth: 4096,
        maxPackHeight: 200,
        packDecay: PACK_DECAY_DEF,
        floorY: null,
        friction: 0
    }),
    calm: Object.freeze({ ...CALM })
});