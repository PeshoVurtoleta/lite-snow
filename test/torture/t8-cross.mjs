/**
 * T8 -- cross-package conformance (S4).
 *
 * SN-19 detector: the inlined `_cssOklch` formatter (SnowEngine.js) must be
 * BYTE-IDENTICAL to @zakkster/lite-color's `toCssOklch` for every color in a
 * 64-color corpus spanning l in [0,1], c in [0,0.4], h in [0,360], with and
 * without an explicit alpha channel. @zakkster/lite-color is a DEVDEP only --
 * imported here, never by SnowEngine.js itself -- so this tier is the proof
 * that the amputation (dropping the runtime dep) did not silently change a
 * documented output string.
 *
 * The formatter is private. It is reached through the REAL call site --
 * `new SnowEngine(1, { color: obj }).colorStr` -- not a copy-pasted reimplementation,
 * so a refactor of the constructor's wiring is exercised, not just the six-line
 * template.
 *
 * The second half is the fail-closed corpus (SN-19's other half): every
 * degenerate color input must resolve to the documented default string
 * 'oklch(0.98 0.02 250)', never "oklch(NaN NaN NaN)" (canvas silently ignores
 * that, stranding fillStyle at its previous value) -- and a string color must
 * pass through byte-unchanged.
 */

import { SnowEngine } from '../../SnowEngine.js';
import { toCssOklch } from '@zakkster/lite-color';
import { check } from './harness.mjs';

const DEFAULT_COLOR = 'oklch(0.98 0.02 250)';
const CORPUS_N = 64;

/** Deterministic, decorrelated [0,1) stream so l/c/h do not move in lockstep. */
function frac(x) {
    return x - Math.floor(x);
}

/** Builds the 64-color corpus. Alternates alpha/non-alpha objects (SN-19). */
function buildCorpus() {
    const corpus = [];
    for (let i = 0; i < CORPUS_N; i++) {
        const l = frac(i * 0.6180339887498949);
        const c = frac(i * 0.4142135623730951) * 0.4;
        const h = frac(i * 0.7548776662466927) * 360;
        if (i % 2 === 0) {
            corpus.push({ l, c, h });
        } else {
            const a = frac(i * 0.31830988618379067 + 0.5);
            corpus.push({ l, c, h, a });
        }
    }
    // Endpoints explicitly, so the boundary matrix is not left to chance:
    // 0, 1, N-1 (index terms) map onto the color-space boundaries l/c/h can take.
    corpus.push({ l: 0, c: 0, h: 0 });
    corpus.push({ l: 1, c: 0.4, h: 360 });
    corpus.push({ l: 0, c: 0.4, h: 0, a: 0 });
    corpus.push({ l: 1, c: 0, h: 360, a: 1 });
    return corpus;
}

export function run() {
    // --- byte-identity across the corpus ------------------------------------
    const corpus = buildCorpus();
    for (let i = 0; i < corpus.length; i++) {
        const obj = corpus[i];
        const want = toCssOklch(obj);
        const engine = new SnowEngine(1, { color: obj });
        const got = engine.colorStr;
        check(got === want,
            () => `T8.byteIdentity: corpus[${i}] ${JSON.stringify(obj)} -- got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
        engine.destroy();
    }

    // --- fail-closed on degenerate color inputs ------------------------------
    const badCases = [
        ['{l:NaN}', { l: NaN, c: 0.1, h: 100 }],
        ['{} (missing channels)', {}],
        ['null', null],
        ['7 (non-object non-string)', 7],
        ['{l:1,c:0.1,h:NaN}', { l: 1, c: 0.1, h: NaN }],
        ['undefined channel l', { l: undefined, c: 0.1, h: 100 }],
        ['NaN channel c', { l: 0.5, c: NaN, h: 100 }],
        ['-0 channels', { l: -0, c: -0, h: -0 }], // -0 is finite: NOT fail-closed, see below
        ['array (typeof object)', []],
        ['Infinity channel h', { l: 0.5, c: 0.1, h: Infinity }],
    ];
    for (let i = 0; i < badCases.length; i++) {
        const label = badCases[i][0];
        const bad = badCases[i][1];
        const engine = new SnowEngine(1, { color: bad });
        const got = engine.colorStr;
        // -0/[] are the one entry in this list that IS well-formed per _cssOklch's
        // own contract (-0 is finite, [] is typeof 'object' with undefined
        // channels -- both must ALSO fail closed, since l/c/h are non-finite
        // (undefined) for the array case, and for -0 they resolve to '0.0000'
        // etc, which is a VALID (non-default) string, not the default -- assert
        // each on its own documented behaviour instead of blanket-asserting the
        // default for all ten.
        if (label === '-0 channels') {
            const want = toCssOklch({ l: -0, c: -0, h: -0 });
            check(got === want,
                () => `T8.negZero: -0 channels should format like lite-color, got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
            check(got !== DEFAULT_COLOR || want === DEFAULT_COLOR,
                () => `T8.negZero: -0 is finite input, must not silently fall back to default unless lite-color also would`);
        } else if (label === 'array (typeof object)') {
            check(got === DEFAULT_COLOR,
                () => `T8.failClosed[${label}]: got ${JSON.stringify(got)} want default ${JSON.stringify(DEFAULT_COLOR)} (array has undefined l/c/h -> non-finite -> fail closed)`);
        } else {
            check(got === DEFAULT_COLOR,
                () => `T8.failClosed[${label}]: got ${JSON.stringify(got)} want default ${JSON.stringify(DEFAULT_COLOR)}`);
        }
        engine.destroy();
    }

    // A string color must pass through completely unchanged (adversarial: a
    // string that itself LOOKS like a bad-color sentinel must still survive,
    // proving the string branch never touches _cssOklch at all).
    const passthroughCases = [
        'oklch(0.5 0.1 100 / 1)',
        'already a string stays a string',
        'oklch(NaN NaN NaN)', // adversarial: looks like the forbidden output, must still pass through verbatim
        '',
    ];
    for (let i = 0; i < passthroughCases.length; i++) {
        const s = passthroughCases[i];
        const engine = new SnowEngine(1, { color: s });
        check(engine.colorStr === s,
            () => `T8.passthrough: string color mutated: in=${JSON.stringify(s)} out=${JSON.stringify(engine.colorStr)}`);
        engine.destroy();
    }
}
