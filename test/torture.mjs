/**
 * @zakkster/lite-snow -- torture gate.
 *
 * The DONE-WHEN of every session is a single command:
 *
 *     node --expose-gc test/torture.mjs        -> prints exactly "ok", exit 0
 *     npm run torture
 *
 * Ten tiers share one shape (roadmap section 3). S0 stands up the harness and
 * wires the tiers this session needs -- T0, T1, T6, T7, T9 -- and registers the
 * rest (T2, T3, T4, T5, T8) as empty placeholders that later sessions fill:
 *
 *     T0  metamorphic laws + determinism   T1  degenerate values (SN-01..05 todo)
 *     T2  canvas-state contract (later)    T3  adversarial sequences (later)
 *     T4  lifecycle + hostile input (later) T5  differential fuzz (later)
 *     T6  the zero-alloc gate              T7  soak + conservation + lite-leak
 *     T8  cross-package (later)            T9  controls (must be able to fail)
 *
 * lite-gc-profiler is one-measurement-at-a-time, so tiers run STRICTLY
 * SEQUENTIALLY -- never nested, never concurrent.
 *
 * Controls: `SNOW_TORTURE_BREAK=1 node --expose-gc test/torture.mjs` injects
 * retained allocations into the T6 hot loop and must exit non-zero. A gate that
 * cannot fail is decorative.
 *
 * Peers (lite-gc-profiler, lite-leak) are devDependencies only.
 *
 * @license MIT
 */

import { SEED, BREAK } from './torture/harness.mjs';
import { run as t0 } from './torture/t0-laws.mjs';
import { run as t1 } from './torture/t1-degenerate.mjs';
import { run as t2 } from './torture/t2-ctx.mjs';
import { run as t3 } from './torture/t3-adversarial.mjs';
import { run as t4 } from './torture/t4-lifecycle.mjs';
import { run as t5 } from './torture/t5-fuzz.mjs';
import { run as t6 } from './torture/t6-alloc.mjs';
import { run as t7 } from './torture/t7-soak.mjs';
import { run as t8 } from './torture/t8-cross.mjs';
import { run as t9 } from './torture/t9-controls.mjs';

const TIERS = [
    ['T0 laws', t0],
    ['T1 degenerate', t1],
    ['T2 ctx', t2],
    ['T3 adversarial', t3],
    ['T4 lifecycle', t4],
    ['T5 fuzz', t5],
    ['T6 alloc', t6],
    ['T7 soak', t7],
    ['T8 cross', t8],
    ['T9 controls', t9],
];

function main() {
    if (typeof globalThis.gc !== 'function') {
        process.stderr.write(
            'torture: FAIL -- run with --expose-gc:  node --expose-gc test/torture.mjs\n');
        process.exit(1);
    }

    for (let i = 0; i < TIERS.length; i++) {
        const name = TIERS[i][0];
        const run = TIERS[i][1];
        try {
            run();
        } catch (err) {
            // Tiers normally fail via die() (which exits). A thrown error is an
            // unexpected fault -- surface it with the replay seed and stop.
            process.stderr.write(
                'torture: FAIL -- ' + name + ' threw: ' + (err && err.stack || err) +
                '\n  replay: TORTURE_SEED=' + SEED + ' node --expose-gc test/torture.mjs\n');
            process.exit(1);
        }
    }

    // Reaching here in BREAK mode means T6's control did not trip -- a fault.
    if (BREAK) {
        process.stderr.write('torture: FAIL -- SNOW_TORTURE_BREAK set but the gate still passed\n');
        process.exit(1);
    }

    process.stdout.write('ok\n');
    process.exit(0);
}

main();
