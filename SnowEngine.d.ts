/**
 * @zakkster/lite-snow -- TypeScript Declarations
 */

export interface SnowConfig {
    /** Downward acceleration in px/s^2. Default: 40 */
    gravity?: number;
    /** Horizontal wind in px/s. Positive = right. Default: 30 */
    wind?: number;
    /** Spawn rate multiplier (scales with canvas area). Default: 10.0 */
    density?: number;
    /** Base flake radius in px (depth-scaled). Default: 2.5 */
    baseRadius?: number;
    /** Horizontal drift sine amplitude in px (depth-scaled). Default: 15 */
    driftAmplitude?: number;
    /** Drift sine frequency in Hz. Default: 1.0 */
    driftFreq?: number;
    /** Minimum melt time in seconds (settled flakes). Default: 2.0 */
    meltTimeMin?: number;
    /** Maximum melt time in seconds (settled flakes). Default: 5.0 */
    meltTimeMax?: number;
    /**
     * Global sinusoidal horizontal acceleration amplitude in px/s^2. The phase
     * rides the shared _elapsedTime clock at gustFreq. 0 = off; when off the
     * output is byte-identical to v1.1.1. A non-finite value (incl. null) fails
     * closed to the default. Default: 0
     */
    gust?: number;
    /**
     * Gust angular frequency in rad/s. A non-finite value fails closed to the
     * default. gustFreq === 0 with gust armed is a stated no-op: sin(0)*gust is 0
     * forever, so the gust is frozen off (0 Hz means no oscillation). Default: TAU/3 (~2.094)
     */
    gustFreq?: number;
    /**
     * Per-flake rotating acceleration amplitude in px/s^2. Reuses each flake's
     * driftPhase/driftSpeed (no new rng, no new column). 0 = off. A non-finite
     * value (incl. null) fails closed to the default. Default: 0
     */
    turbulence?: number;
    /**
     * Terminal-velocity damping in [0, 1]. 1 = off (the positional base is
     * untouched and output is byte-identical to v1.1.1). drag < 1 selects a
     * SEPARATE integration model that folds gravity/wind into vx/vy and damps
     * toward a terminal fall speed (see decisions/0002-living-air.md). A
     * non-finite value (incl. null) fails closed to the default. Default: 1
     */
    drag?: number;
    /**
     * Persistent-pack accumulation (S6). true builds a Uint16 heightmap that
     * flakes land ON and that decays over time; false (the default) is
     * byte-identical to v1.2.0 and leaves `pack === null`. CONSTRUCTION-TIME ONLY:
     * arms strictly on `=== true`, and a runtime flip of this field is inert (no
     * allocation, no behaviour change). Default: false
     */
    accumulate?: boolean;
    /**
     * Pack column width in px (one heightmap cell per this many px). When armed,
     * must be an integer in [1, 256] or the constructor throws RangeError.
     * Default: 4
     */
    packResolution?: number;
    /**
     * Max px the pack spans. `nCols = floor(maxPackWidth / packResolution)` cells
     * are allocated once. A canvas wider than this accumulates only across the
     * first maxPackWidth px (degrades visibly, never reallocates). When armed,
     * must be an integer in [packResolution, 16384] or the constructor throws.
     * Default: 4096
     */
    maxPackWidth?: number;
    /**
     * Max height (in packUnits) any single column may reach; landings past it are
     * capped and booked. When armed, must be an integer in [1, 65535] or the
     * constructor throws RangeError. Default: 200
     */
    maxPackHeight?: number;
    /**
     * Pack decay rate in packUnits/second (integer-stepped). A non-finite value
     * (incl. null) fails closed to the default; a negative value coerces to 0 (no
     * decay -- never anti-decay). Default: 2.0
     */
    packDecay?: number;
    /**
     * Settle floor in px. `null` (the default) tracks the per-frame canvas height
     * `h`. A finite value is used RAW (not clamped to h) -- e.g. an overlay HUD
     * bar. Any non-finite value fails closed to `null`. Default: null
     */
    floorY?: number | null;
    /**
     * Contact-frame horizontal damping applied ONCE at the settle transition:
     * `vx *= 1 - friction`. Clamped to [0, 1]; a negative value coerces to 0
     * (never anti-friction) and a non-finite value fails closed to 0. Default: 0
     */
    friction?: number;
    /**
     * Spawn Y band (S7). `{ min, max }` (both finite, `max >= min`) shapes where
     * flakes enter, drawn as the SUBTRACTIVE `y = max - rng()*(max - min)` -- NOT
     * the mirror `min + rng()*(max - min)`, which is a different per-draw value
     * for the same rng and would break every determinism digest (see
     * decisions/0004 (c)). `null` (the default), a non-object, a non-finite bound
     * or `max < min` all fail closed to the literal default band `[-100, -50]`
     * (byte-identical to v1.3.0). Coerces, never throws (it sizes no allocation).
     * Default: null
     */
    spawnBand?: { min: number; max: number } | null;
    /**
     * Fixed horizontal spawn inset in px (S7). `null` (the default) DERIVES the
     * v1.3.0 wind offset `(h / gravity) * |wind|` verbatim. A finite value `>= 0`
     * is used raw; a non-finite or negative value fails closed to `null` = derive
     * (the same sentinel discipline as floorY). Coerces, never throws.
     * Default: null
     */
    spawnMargin?: number | null;
    /**
     * Reduced-motion accessibility flag (S7). A HARD OVERRIDE resolved ONCE at
     * construction: strict `=== true` overwrites the twelve MOTION keys (gravity,
     * wind, density, baseRadius, driftAmplitude, driftFreq, gust, gustFreq,
     * turbulence, drag, spawnBand, spawnMargin) with the `calm` scene's values, so
     * `{ ...SNOW_PRESETS.blizzard, reducedMotion: true }` equals calm exactly. The
     * FLAG WINS over any explicit knob set alongside it (`{ reducedMotion: true,
     * gust: 500 }` has gust 0). It resolves BEFORE baseRadius validation, so
     * `{ baseRadius: 0, reducedMotion: true }` constructs (baseRadius becomes
     * calm's 2.5) while `{ baseRadius: 0 }` throws (decisions/0004 (d), (d')). It
     * is absent from both frame loops, so a runtime flip is inert. Non-MOTION keys
     * (accumulate, pack*, floorY, friction, meltTime*) are NOT overridden. The
     * engine does NO DOM access: read `prefers-reduced-motion` in your app and pass
     * the flag. Default: false
     */
    reducedMotion?: boolean;
    /** Snow color as OKLCH object { l, c, h } or CSS string. Default: 'oklch(0.98 0.02 250)' */
    color?: { l: number; c: number; h: number } | string;
    /** Random number generator () => number [0, 1). Default: Math.random */
    rng?: () => number;
}

export declare class SnowEngine {
    readonly max: number;
    config: Required<SnowConfig>;
    colorStr: string;

    /** Live falling-flake count (state === 1). O(1) telemetry getter. @readonly */
    readonly fallingCount: number;
    /**
     * Live SETTLED/melting-flake count (state === 2). State 2 IS the settled
     * state: a flake that has landed (on the floor, or on the pack when
     * accumulate:true) and is now aging out -- so this IS the landed count. There
     * is no separate landedCount getter (decisions/0003 (b), 0004 (a)). O(1)
     * telemetry getter. @readonly
     */
    readonly meltingCount: number;
    /** fallingCount + meltingCount. O(1) telemetry getter. @readonly */
    readonly activeCount: number;

    x: Float32Array | null;
    y: Float32Array | null;
    z: Float32Array | null;
    gz: Float32Array | null;
    wz: Float32Array | null;
    bucket: Uint8Array | null;
    radius: Float32Array | null;
    driftPhase: Float32Array | null;
    driftSpeed: Float32Array | null;
    driftAmp: Float32Array | null;
    life: Float32Array | null;
    state: Uint8Array | null;
    /** Living-air perturbation velocity X (S5). Zero unless gust/turbulence/drag is armed. */
    vx: Float32Array | null;
    /** Living-air perturbation velocity Y (S5). Zero unless gust/turbulence/drag is armed. */
    vy: Float32Array | null;
    /**
     * Accumulation heightmap (S6): a Uint16Array of `maxPackWidth/packResolution`
     * columns, each an integer packUnit count. `null` unless `accumulate: true`.
     * Allocated once, never reallocated (resize truncates in place), nulled by
     * destroy().
     */
    pack: Uint16Array | null;

    /** Simulation clock in seconds, advanced by updateAndDraw(). @internal */
    _elapsedTime: number;
    /** Set by destroy(); every method is a no-op once true. @internal */
    _destroyed: boolean;
    /** Cached canvas width; guards _areaModifier recompute. @internal */
    _lastW: number;
    /** Cached canvas height; guards _areaModifier recompute. @internal */
    _lastH: number;
    /** (w * h) / 100000, recomputed only on dimension change. @internal */
    _areaModifier: number;
    /** Ring-cursor spawn probe position; wraps at max. @internal */
    _spawnCursor: number;
    /** reducedMotion arm (config.reducedMotion === true), resolved once. @internal */
    _reducedMotion: boolean;
    /** Spawn band upper Y bound (default -50); `y = _spawnY0 - rng()*_spawnYSpan`. @internal */
    _spawnY0: number;
    /** Spawn band Y span (default 50); the SUBTRACTIVE rng term. @internal */
    _spawnYSpan: number;
    /** Resolved spawn inset px, or null = derive the wind offset in spawn(). @internal */
    _spawnMargin: number | null;
    /** Render index bin for depth bucket 0 (near). Preallocated Uint32Array(max). @internal */
    _bin0: Uint32Array | null;
    /** Render index bin for depth bucket 1 (mid). Preallocated Uint32Array(max). @internal */
    _bin1: Uint32Array | null;
    /** Render index bin for depth bucket 2 (far). Preallocated Uint32Array(max). @internal */
    _bin2: Uint32Array | null;
    /** Render bin of packed settled/melting slots (index | band<<24). @internal */
    _binMelt: Uint32Array | null;
    /** Per-melt-band populate flags (Uint32Array(8)). @internal */
    _meltAlphaCount: Uint32Array | null;

    /**
     * @throws {RangeError} if maxParticles is not an integer in 1..10000000, or
     * if config.baseRadius is not a finite number greater than 0. The guards run
     * before any typed array is allocated.
     */
    constructor(maxParticles?: number, config?: SnowConfig);

    /**
     * Fail-closed frame door. Returns the clamped dt (capped at 0.1), or -1 to
     * reject the frame when dt is non-finite/negative or w/h is non-positive or
     * non-finite. @internal
     */
    _sane(dt: number, w: number, h: number): number;

    /**
     * Spawn new snowflakes. Call every frame before updateAndDraw().
     * Spawn count auto-scales with canvas area × density × dt.
     * A non-finite or negative dt, or a non-positive/non-finite w/h, is a
     * documented no-op frame: no slots are touched.
     */
    spawn(dt: number, w: number, h: number): void;

    /**
     * Update physics and render all snow particles.
     * Does NOT clear the canvas -- snow is an overlay. Caller clears.
     * Call spawn() before this each frame.
     * A non-finite or negative dt, or a non-positive/non-finite w/h, is a
     * documented no-op frame: the clock does not advance and no state is touched.
     * A null ctx, or one without arc()/ellipse(), is likewise a no-op frame. A
     * draw call that throws mid-render restores globalAlpha to 1.0 and RETHROWS.
     * When `accumulate: true`, emits ONE extra closed-path fill for the pack
     * (only when the pack is non-empty), drawn under the melt ellipses.
     */
    updateAndDraw(ctx: CanvasRenderingContext2D, dt: number, w: number, h: number): void;

    /**
     * Full simulation reset: empties the pool and resets the clock, the dimension
     * cache and the telemetry counters to their fresh-construction values.
     */
    clear(): void;

    /**
     * Release all typed arrays -- the fourteen SoA columns, the five render bins
     * and the accumulation pack -- and the config and colorStr references. Runs
     * clear() first, so the clock and counters are zeroed. Idempotent.
     */
    destroy(): void;
}

/** Package version. Kept in sync with package.json and llms.txt. */
export declare const VERSION: string;

/**
 * Four COMPLETE preset scenes. Each names all 21 scene keys (defaults included via
 * the same constants the engine uses), so `{ ...calm, ...heavy }` equals heavy
 * exactly. Presets never name rng, color or reducedMotion. Frozen, with no nested
 * object (spawnBand is the null sentinel) -- decisions/0004 (e), (f).
 */
export declare const SNOW_PRESETS: {
    /** Gentle snowfall. density: 10, wind: 30, gravity: 40. Its values ARE the engine defaults. */
    flurry: SnowConfig;
    /** Dense snowfall. density: 24, wind: 150, gravity: 80 */
    heavy: SnowConfig;
    /** Extreme wind + density. density: 40, wind: 400, gravity: 250 */
    blizzard: SnowConfig;
    /** Minimal motion. density: 4, wind: 8, gravity: 20, driftAmplitude: 4. The reducedMotion target. */
    calm: SnowConfig;
};
