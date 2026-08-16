/**
 * T0 -- metamorphic laws and determinism.
 *
 * Properties that must hold for ANY well-formed scene, checked over a seeded
 * schedule. These are the invariants every later session must preserve:
 *
 *   - Determinism: two engines, same seed, same frame schedule -> all twelve
 *     SoA arrays bit-identical.
 *   - Precompute identities: gz[i]=gravity*z[i], wz[i]=wind*z[i],
 *     driftAmp[i]=driftAmplitude*z[i] (f32-exact) for every live slot.
 *   - z[i] in [0.2,1.0]; bucket[i] agrees with the <0.4/<0.7/else thresholds.
 *   - Conservation: free+falling+melting === max after every frame, every
 *     state[i] in {0,1,2}.
 *   - Monotonicity: a melting slot's life[i] strictly decreases.
 *   - Spawn bound: one spawn(dt,w,h) raises the live count by at most
 *     floor(areaModifier * density * dt * 60). This is the SN-02 detector
 *     stated as a law -- with VALID inputs it holds today; the degenerate
 *     inputs that break it live in T1.
 *   - ASCII law (SN-24, S4): SnowEngine.js, SnowEngine.d.ts, llms.txt,
 *     README.md and CHANGELOG.md contain zero bytes outside ASCII except the
 *     two permitted code points, U+00D7 (x) and U+00B5 (micro). The roadmap
 *     describes the guard as `grep -nP '[^\x00-\x7F\x{00D7}\x{00B5}]'`; this
 *     tier PROVES the guard command itself before trusting its 0-hit result
 *     on the real files -- a guard that cannot fire is decorative (T9's rule,
 *     applied here to a grep invocation instead of an in-process control).
 *     MEASURED FINDING: this host's `grep` (BSD grep 2.6.0-FreeBSD, the macOS
 *     default -- confirmed via `grep --version` and a `spawnSync` PCRE probe)
 *     does not implement `-P` at all ("invalid option -- P", exit 2) when
 *     invoked as a bare child_process (no shell, so no interactive-shell
 *     grep-wrapping alias applies). Shelling out to a literal `grep -nP`
 *     would therefore silently mis-measure -- exit 2 on EVERY input, good or
 *     bad, which is indistinguishable from "0 hits" unless the exit code is
 *     inspected, and even then the gate cannot run at all on a plain macOS
 *     box. This tier probes PCRE support at runtime and uses the real
 *     `grep -nP` when available (GNU grep, Linux CI), falling back to an
 *     IDENTICAL-semantics pure-JS scan (`/[^\x00-\x7F×µ]/u` per
 *     line) when it is not -- so the gate is always live, never decorative,
 *     on any host. Both code paths are exercised by the two-direction proof
 *     below when possible.
 *
 * All non-ASCII-law inputs here are finite and in-range: T0 proves the engine
 * is correct on good data. Degenerate data is T1's job.
 */

import { SnowEngine } from '../../SnowEngine.js';
import { SEED, makeRng, check, makeMockCtx, conservation, spawnBoundHolds } from './harness.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX = 400;
const FRAMES = 200;
const DT = 0.05;
const W = 800;
const H = 600;

// --- ASCII law guard -------------------------------------------------------

const PKG_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ASCII_GUARD_FILES = [
    'SnowEngine.js', 'SnowEngine.d.ts', 'llms.txt', 'README.md', 'CHANGELOG.md',
].map((f) => join(PKG_ROOT, f));
const ASCII_GUARD_PCRE = '[^\\x00-\\x7F\\x{00D7}\\x{00B5}]';
// Identical semantics to the PCRE pattern above, expressed for V8's engine:
// \x{00D7}/\x{00B5} in PCRE are U+00D7/U+00B5, i.e. ×/µ with the
// `u` flag (astral-safe, though both code points are BMP already).
const ASCII_GUARD_JS = /[^\x00-\x7F×µ]/u;

let pcreSupportCache;
/** True iff the host's `grep` binary understands `-P` (PCRE). Probed once. */
function grepSupportsPcre() {
    if (pcreSupportCache !== undefined) return pcreSupportCache;
    try {
        const r = spawnSync('grep', ['-nP', 'x'], { input: 'x\n', encoding: 'utf8' });
        // A working -P on a matching line exits 0 with output; an unsupported
        // -P exits 2 ("invalid option") regardless of input -- that is the
        // exact failure mode measured on this host's BSD grep.
        pcreSupportCache = r.status === 0 && r.stdout.length > 0;
    } catch {
        pcreSupportCache = false;
    }
    return pcreSupportCache;
}

/** Count of lines across `paths` containing a byte outside the ASCII law. */
function asciiGuardHits(paths) {
    if (grepSupportsPcre()) {
        try {
            const out = execFileSync('grep', ['-nP', ASCII_GUARD_PCRE, ...paths], { encoding: 'utf8' });
            return out.split('\n').filter((l) => l.length > 0).length;
        } catch (err) {
            if (err.status === 1) return 0; // grep: ran fine, zero matches
            throw err; // a real tool fault -- surface it, do not mask as 0
        }
    }
    // Portable fallback: identical regex, evaluated in-process.
    let hits = 0;
    for (let i = 0; i < paths.length; i++) {
        const lines = readFileSync(paths[i], 'utf8').split('\n');
        for (let j = 0; j < lines.length; j++) {
            if (ASCII_GUARD_JS.test(lines[j])) hits++;
        }
    }
    return hits;
}

function makeEngine(seed) {
    return new SnowEngine(MAX, {
        gravity: 40, wind: 30, density: 20,
        driftAmplitude: 15, driftFreq: 1.0,
        meltTimeMin: 0.5, meltTimeMax: 1.0,
        rng: makeRng(seed),
    });
}

export function run() {
    // --- Law 1: determinism + per-frame conservation -----------------------
    const a = makeEngine(SEED);
    const b = makeEngine(SEED);
    const ctxA = makeMockCtx();
    const ctxB = makeMockCtx();

    for (let f = 0; f < FRAMES; f++) {
        a.spawn(DT, W, H);
        a.updateAndDraw(ctxA, DT, W, H);
        b.spawn(DT, W, H);
        b.updateAndDraw(ctxB, DT, W, H);
        check(conservation(a),
            () => `T0.conservation: pool not conserved at frame ${f} (seed=${SEED})`);
    }

    // All twelve columns bit-identical between the two seeded engines.
    const names = ['x', 'y', 'z', 'gz', 'wz', 'bucket',
        'radius', 'driftPhase', 'driftSpeed', 'driftAmp', 'life', 'state'];
    for (let n = 0; n < names.length; n++) {
        const key = names[n];
        const arrA = a[key];
        const arrB = b[key];
        for (let i = 0; i < MAX; i++) {
            check(Object.is(arrA[i], arrB[i]),
                () => `T0.determinism: ${key}[${i}] diverged ${arrA[i]} vs ${arrB[i]} (seed=${SEED})`);
        }
    }

    // --- Law 2: precompute identities + z-range + bucket agreement ----------
    const g = a.config.gravity, wnd = a.config.wind, amp = a.config.driftAmplitude;
    for (let i = 0; i < MAX; i++) {
        if (a.state[i] === 0) continue;
        const z = a.z[i];
        check(z >= 0.2 && z <= 1.0,
            () => `T0.zrange: z[${i}]=${z} outside [0.2,1.0] (seed=${SEED})`);
        check(a.gz[i] === Math.fround(g * z),
            () => `T0.precompute: gz[${i}] != gravity*z (seed=${SEED})`);
        check(a.wz[i] === Math.fround(wnd * z),
            () => `T0.precompute: wz[${i}] != wind*z (seed=${SEED})`);
        check(a.driftAmp[i] === Math.fround(amp * z),
            () => `T0.precompute: driftAmp[${i}] != driftAmplitude*z (seed=${SEED})`);
        const wantBucket = z < 0.4 ? 0 : z < 0.7 ? 1 : 2;
        check(a.bucket[i] === wantBucket,
            () => `T0.bucket: bucket[${i}]=${a.bucket[i]} != ${wantBucket} for z=${z} (seed=${SEED})`);
    }

    // --- Law 3: melt-life monotonicity --------------------------------------
    // A slot that stays state 2 across a frame must have a strictly smaller
    // life afterwards (render alpha is life*const, so it is non-increasing too).
    const m = new SnowEngine(MAX, {
        gravity: 5000, wind: 0, density: 40,
        meltTimeMin: 1.0, meltTimeMax: 2.0,
        rng: makeRng(SEED ^ 0x55555555),
    });
    const ctxM = makeMockCtx();
    const stateBefore = new Uint8Array(MAX);
    const lifeBefore = new Float32Array(MAX);
    m.spawn(0.05, W, H);
    for (let f = 0; f < 8; f++) m.updateAndDraw(ctxM, 0.05, W, H); // settle some
    for (let f = 0; f < 20; f++) {
        stateBefore.set(m.state);
        lifeBefore.set(m.life);
        m.updateAndDraw(ctxM, 0.05, W, H);
        for (let i = 0; i < MAX; i++) {
            if (stateBefore[i] === 2 && m.state[i] === 2) {
                check(m.life[i] < lifeBefore[i],
                    () => `T0.monotone: life[${i}] did not decrease ${lifeBefore[i]} -> ${m.life[i]} (seed=${SEED})`);
            }
        }
    }

    // --- Law 4: spawn bound (the SN-02 detector, on VALID inputs) -----------
    // One spawn raises the live count by at most floor(areaModifier*density*dt*60).
    // Shares spawnBoundHolds with T9 control 4, so T0 and the control exercise the
    // same predicate on the same code path.
    const s = new SnowEngine(MAX, { density: 20, rng: makeRng(SEED ^ 0x0f0f0f0f) });
    check(spawnBoundHolds(s, 0.016, W, H),
        () => `T0.spawnbound: one spawn exceeded floor(areaModifier*density*dt*60) or dropped the live count (seed=${SEED})`);

    // --- Law 5: ASCII law (SN-24) -------------------------------------------
    // (i) Prove the guard can FIRE at all -- direction (a) -- before trusting
    // its silence on the real files. Direction (b) proves it does NOT fire on
    // the one permitted exception. Both run against a scratch temp dir, never
    // against the shipped files, and are cleaned up unconditionally.
    const scratch = mkdtempSync(join(tmpdir(), 'lite-snow-ascii-guard-'));
    try {
        const arrowFile = join(scratch, 'arrow.txt');
        const timesFile = join(scratch, 'times.txt');
        // (a) U+2192 (RIGHTWARDS ARROW) is NOT a permitted exception: the guard
        // must count at least one hit.
        writeFileSync(arrowFile, 'a line with a forbidden arrow → here\n', 'utf8');
        const arrowHits = asciiGuardHits([arrowFile]);
        check(arrowHits > 0,
            () => `T0.asciiGuard: guard failed to FIRE on a planted U+2192 -- measured ${arrowHits} hits, wanted > 0 (guard is decorative)`);

        // (b) U+00D7 (MULTIPLICATION SIGN) is the one permitted exception: the
        // guard must report zero hits on a file whose only non-ASCII byte is it.
        writeFileSync(timesFile, 'a line with a permitted 3 × 3 sign only\n', 'utf8');
        const timesHits = asciiGuardHits([timesFile]);
        check(timesHits === 0,
            () => `T0.asciiGuard: guard fired on the permitted U+00D7 -- measured ${timesHits} hits, wanted 0 (guard is untrustworthy in the direction that matters)`);
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }

    // (ii) Only after both directions are proven live do we trust a 0-hit
    // result on the real shipped files.
    const realHits = asciiGuardHits(ASCII_GUARD_FILES);
    check(realHits === 0,
        () => `T0.asciiGuard: ${realHits} non-ASCII (beyond U+00D7/U+00B5) hits across ${ASCII_GUARD_FILES.join(', ')}`);
}
