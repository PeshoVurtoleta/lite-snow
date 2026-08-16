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
    /** Live melting-flake count (state === 2). O(1) telemetry getter. @readonly */
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
     */
    updateAndDraw(ctx: CanvasRenderingContext2D, dt: number, w: number, h: number): void;

    /**
     * Full simulation reset: empties the pool and resets the clock, the dimension
     * cache and the telemetry counters to their fresh-construction values.
     */
    clear(): void;

    /**
     * Release all typed arrays -- the twelve SoA columns and the five render
     * bins -- and the config and colorStr references. Runs clear() first, so the
     * clock and counters are zeroed. Idempotent.
     */
    destroy(): void;
}

/** Package version. Kept in sync with package.json and llms.txt. */
export declare const VERSION: string;

export declare const SNOW_PRESETS: {
    /** Gentle snowfall. density: 10, wind: 30, gravity: 40 */
    flurry: SnowConfig;
    /** Dense snowfall. density: 24, wind: 150, gravity: 80 */
    heavy: SnowConfig;
    /** Extreme wind + density. density: 40, wind: 400, gravity: 250 */
    blizzard: SnowConfig;
};
