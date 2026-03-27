/**
 * @zakkster/lite-snow — TypeScript Declarations
 */

export interface SnowConfig {
    /** Downward acceleration in px/s². Default: 40 */
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

    constructor(maxParticles?: number, config?: SnowConfig);

    /**
     * Spawn new snowflakes. Call every frame before updateAndDraw().
     * Spawn count auto-scales with canvas area × density × dt.
     */
    spawn(dt: number, w: number, h: number): void;

    /**
     * Update physics and render all snow particles.
     * Does NOT clear the canvas — snow is an overlay. Caller clears.
     * Call spawn() before this each frame.
     */
    updateAndDraw(ctx: CanvasRenderingContext2D, dt: number, w: number, h: number): void;

    /** Kill all particles immediately. */
    clear(): void;

    /** Release all typed arrays. Idempotent. */
    destroy(): void;
}

export declare const SNOW_PRESETS: {
    /** Gentle snowfall. density: 10, wind: 30, gravity: 40 */
    flurry: SnowConfig;
    /** Dense snowfall. density: 24, wind: 150, gravity: 80 */
    heavy: SnowConfig;
    /** Extreme wind + density. density: 40, wind: 400, gravity: 250 */
    blizzard: SnowConfig;
};
