/**
 * @zakkster/lite-snow -- S5 armed-configuration scenario (shared by T10 and by
 * T9's per-guard controls).
 *
 * Two fixed, committed scenarios:
 *
 *   - BASELINE: the frozen v1.1.1 reproduction. Plain engine defaults (no
 *     living-air knob touched), digested over SOA_NAMES_V111. Its committed
 *     hex is the same f2e3ccef...ef15 the roadmap and decisions/0002 cite.
 *   - ARMED_CONFIGS / SCENARIO: a SEPARATE scenario (higher gravity, so both
 *     falling AND melting populate within FRAMES -- the load-bearing
 *     3000-frame lesson from the roadmap: 1000 frames melts nothing) run once
 *     per named knob combination and digested over the full 14-name SOA_NAMES.
 *     Every value in ARMED_DIGESTS is a COMMITTED CONSTANT, derived once and
 *     pinned here -- never computed-and-compared-to-itself. Regenerate ONLY by
 *     deliberate, documented re-derivation, never to make a failing assertion
 *     pass.
 *
 * Both scenarios are deterministic pure functions of (seed, config, frame
 * schedule) -- no wall clock, no Math.random, no environment-dependent
 * iteration order. Reproducibility across OS processes is therefore a
 * property of the source, provable by literally spawning a second `node`
 * process that imports this module and diffing its answer against the
 * in-process one (T10 does this).
 *
 * @license MIT
 */

import { createHash } from 'node:crypto';
import { SnowEngine } from '../../SnowEngine.js';
import { makeRng, makeMockCtx, CtxSeqRecorder, SOA_NAMES, SOA_NAMES_V111 } from './harness.mjs';

/** The frozen v1.1.1 back-compat reproduction. Plain defaults, no knob set. */
export const BASELINE = Object.freeze({
    MAX: 2000,
    SEED: 0x5EED1234,
    DT: 1 / 60,
    W: 1280,
    H: 720,
    FRAMES: 3000,
});

/** Committed v1.1.1 digest (sha256 hex, over SOA_NAMES_V111) + the load-bearing
 * activeCount split. Roadmap section: "ALREADY TRUE, do not redo". */
export const BASELINE_DIGEST = 'f2e3ccef33428a982c91c15708c616e2a5df641840529dc112c6146f1d89ef15';
export const BASELINE_COUNTS = Object.freeze({ active: 1998, falling: 1879, melting: 119 });

/**
 * Committed ORDERED ctx-call-sequence digest for the BASELINE scenario on the
 * DEFAULT (unarmed) path, over the CtxSeqRecorder encoding (opcode byte + f64
 * argument bits, rolling sha256). Captured on the untouched v1.2.0 tree BEFORE
 * any accumulation code existed; S6's headline assertion (A1) is that the
 * accumulate:false path still reproduces it exactly -- proving the pack changes
 * are byte-identical on the default path, order and arguments and not just totals
 * (a counter digest cannot see a reordering that preserves sums). Proven
 * discriminating: a gust:40 run yields a different hex. The companion counts are
 * pinned too so a digest match is never the only proof.
 */
export const CTX_SEQ_DIGEST_DEFAULT = '0886e3df880798c311b6da58a4df8f1ee0bcd1b850190570809662e24ff2ca2d';
export const CTX_SEQ_COUNTS_DEFAULT = Object.freeze({
    arcs: 5718630, ellipses: 247890, fills: 20426, beginPaths: 20426,
});

/** The armed-configuration scenario. Higher gravity than BASELINE so every
 * config -- including drag, which slows the fall -- populates BOTH falling and
 * melting within FRAMES frames. */
export const SCENARIO = Object.freeze({
    MAX: 2000,
    SEED: 0x5EED1234,
    DT: 1 / 60,
    W: 1280,
    H: 720,
    FRAMES: 3000,
    BASE: Object.freeze({ gravity: 200, wind: 30, density: 10 }),
});

/** Named knob overrides layered on SCENARIO.BASE. 'off' arms nothing. */
export const ARMED_CONFIGS = Object.freeze({
    off: Object.freeze({}),
    gust: Object.freeze({ gust: 500 }),
    turbulence: Object.freeze({ turbulence: 400 }),
    gustTurb: Object.freeze({ gust: 500, turbulence: 400 }),
    drag: Object.freeze({ drag: 0.95 }),
});

/**
 * Committed sha256 hex digests (over SOA_NAMES, all fourteen columns) for each
 * ARMED_CONFIGS key, taken over SCENARIO above. Each is a fixed constant, not
 * derived from a same-run computation -- the comparison in T10 is against
 * THESE strings, not against a second call to the same function.
 */
export const ARMED_DIGESTS = Object.freeze({
    off: '9d11268a329c2d0daf3d256e39dec16db59cadccc05868409f5ce2a8a975007c',
    gust: '4aa9d62b3378f4893a4edb4451f6347152507716b043486343aed1ef40314de7',
    turbulence: '45379f2a5abccf77b77b397b2925a7ffa195d7d181395b7f1133fcf3406014aa',
    gustTurb: '8f03af4272c35c2a8ccc6d9bedc518168ca55c522835d16f206c8a7222ea26e1',
    drag: '8934123e94516972b7e21104afbd96b7007b4ab9c8a8559f126b6e8e27df8b7e',
});

/** Committed falling/melting counts at the end of the SCENARIO run, so a
 * digest match is not the only proof -- the state-1/state-2 split is asserted
 * directly too (the "any scenario MUST populate state 1 AND state 2" law). */
export const ARMED_COUNTS = Object.freeze({
    off: Object.freeze({ falling: 1372, melting: 626 }),
    gust: Object.freeze({ falling: 1593, melting: 401 }),
    turbulence: Object.freeze({ falling: 1216, melting: 770 }),
    gustTurb: Object.freeze({ falling: 1283, melting: 703 }),
    drag: Object.freeze({ falling: 1774, melting: 224 }),
});

/** Builds (but does not run) the engine for the frozen v1.1.1 baseline. */
export function buildBaselineEngine() {
    return new SnowEngine(BASELINE.MAX, { rng: makeRng(BASELINE.SEED) });
}

/** Builds (but does not run) the engine for the named armed configuration. */
export function buildArmedEngine(key) {
    const extra = ARMED_CONFIGS[key];
    if (extra === undefined) throw new Error('armed-scenario: unknown key ' + key);
    return new SnowEngine(SCENARIO.MAX, { rng: makeRng(SCENARIO.SEED), ...SCENARIO.BASE, ...extra });
}

/** Runs `engine` for `frames` spawn+updateAndDraw cycles against a fresh mock
 * ctx at (dt, w, h). Returns the SAME engine, now advanced. */
function drive(engine, dt, w, h, frames) {
    const ctx = makeMockCtx();
    for (let f = 0; f < frames; f++) {
        engine.spawn(dt, w, h);
        engine.updateAndDraw(ctx, dt, w, h);
    }
    return engine;
}

/** Runs the frozen v1.1.1 BASELINE scenario to completion. */
export function runBaseline() {
    return drive(buildBaselineEngine(), BASELINE.DT, BASELINE.W, BASELINE.H, BASELINE.FRAMES);
}

/** Runs the ARMED SCENARIO for the named configuration to completion. */
export function runArmed(key) {
    return drive(buildArmedEngine(key), SCENARIO.DT, SCENARIO.W, SCENARIO.H, SCENARIO.FRAMES);
}

/** sha256 hex over `names` (default SOA_NAMES) of the engine's live typed-array
 * backing bytes, in column order. Test-only -- allocates freely. */
export function digestEngine(engine, names) {
    const cols = names || SOA_NAMES;
    const hash = createHash('sha256');
    for (let n = 0; n < cols.length; n++) {
        const arr = engine[cols[n]];
        hash.update(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
    }
    return hash.digest('hex');
}

/** SOA_NAMES_V111 re-exported so callers need only import this module. */
export { SOA_NAMES, SOA_NAMES_V111 };

// --- standalone cross-process entry point -----------------------------------
// `node armed-scenario.mjs baseline` or `node armed-scenario.mjs <armedKey>`
// prints the sha256 digest for that scenario to stdout and nothing else. T10
// spawns this file as a SEPARATE OS process and diffs its stdout against the
// in-process digest, so "reproducible across processes" is measured, not
// assumed from a second in-process call.
if (process.argv[1] && process.argv[1].endsWith('armed-scenario.mjs')) {
    const key = process.argv[2];
    if (key === 'baseline') {
        process.stdout.write(digestEngine(runBaseline(), SOA_NAMES_V111) + '\n');
    } else {
        process.stdout.write(digestEngine(runArmed(key)) + '\n');
    }
}
