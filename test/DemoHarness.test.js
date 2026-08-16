/**
 * @zakkster/lite-snow -- demo controller leak gate (SN-27/SN-28, S4).
 *
 * THE load-bearing gate for S4's demo assertions. Drives `demo/SnowDemo.js`'s
 * `createSnowDemo({ window, document, engine }) -> { destroy }` headlessly, via
 * a hand-rolled fake window/document/ResizeObserver/rAF -- zero dependencies,
 * no jsdom, node:test only. The controller takes `window`/`document`/`engine`
 * as injected arguments (demo/SnowDemo.js:18), which is exactly what makes this
 * file possible without a real DOM; if that DI seam did not exist this gate
 * would not be writable under house law, per the S4 pre-flight note.
 *
 * Boundary matrix covered here:
 *   - 0/1/N-1/N/N+1 resize cycles (0 before the loop, 1st, 199th/200th/one more
 *     after destroy in the post-destroy no-op check)
 *   - empty listener set after destroy
 *   - duplicate dispose (destroy called twice; pagehide handler invoked twice)
 *   - dispose-during-iteration (destroy fired mid-resize, before its rAF flush)
 *   - re-entrant write (the main loop reschedules its own next frame from
 *     inside the very rAF callback the fake queue is flushing)
 *   - adversarial: a resize signal arrives AFTER disconnect() (the real
 *     browser contract -- a disconnected ResizeObserver never calls back --
 *     modeled explicitly in the fake, not assumed)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSnowDemo } from '../demo/SnowDemo.js';

// ---------------------------------------------------------------------------
// Shared live-listener registry: every addEventListener/removeEventListener,
// on every fake node (including `window` itself), lands here, keyed by the
// (node, type, fn) triple. `size` is the ONE number the leak assertions read.
// ---------------------------------------------------------------------------
class ListenerRegistry {
    constructor() {
        this.entries = [];
    }
    add(node, type, fn) {
        if (typeof fn !== 'function') {
            throw new TypeError('addEventListener: listener must be a function, got ' + typeof fn);
        }
        this.entries.push({ node, type, fn });
    }
    remove(node, type, fn) {
        const idx = this.entries.findIndex((e) => e.node === node && e.type === type && e.fn === fn);
        if (idx === -1) {
            throw new Error('removeEventListener: no matching listener for type=' + type +
                ' -- a real DOM silently no-ops here, but for THIS gate a mismatched ' +
                'remove means the controller is tracking its own listeners incorrectly');
        }
        this.entries.splice(idx, 1);
    }
    has(type) {
        return this.entries.some((e) => e.type === type);
    }
    get size() {
        return this.entries.length;
    }
}

// ---------------------------------------------------------------------------
// Fake rAF queue. request()/cancel() mirror the real API's id contract;
// flush() invokes exactly the callbacks pending AT THE MOMENT flush() is
// called (a snapshot, cleared before invocation) so a callback that reschedules
// itself (the render loop does, every frame -- the re-entrant-write case) does
// not spin flush() forever or get double-counted.
// ---------------------------------------------------------------------------
function makeFakeRaf() {
    let nextId = 1;
    let now = 0;
    const scheduled = new Map();
    const canceled = new Set();
    return {
        request(fn) {
            const id = nextId++;
            scheduled.set(id, fn);
            return id;
        },
        cancel(id) {
            scheduled.delete(id);
            canceled.add(id);
        },
        flush() {
            now += 16.6;
            const batch = Array.from(scheduled.entries());
            scheduled.clear();
            for (let i = 0; i < batch.length; i++) batch[i][1](now);
        },
        get pendingCount() { return scheduled.size; },
        wasCanceled(id) { return canceled.has(id); },
        get canceledCount() { return canceled.size; },
    };
}

// ---------------------------------------------------------------------------
// Fake ResizeObserver. Models the real contract that matters here: a
// disconnected observer never invokes its callback again -- trigger() checks
// `disconnected` itself rather than trusting the controller to stop calling it.
// ---------------------------------------------------------------------------
function makeFakeResizeObserverClass(onInstance) {
    return class FakeResizeObserver {
        constructor(cb) {
            this.cb = cb;
            this.observeCalls = 0;
            this.disconnectCalls = 0;
            this.disconnected = false;
            this.targets = [];
            onInstance(this);
        }
        observe(target) {
            this.observeCalls++;
            this.targets.push(target);
        }
        disconnect() {
            this.disconnectCalls++;
            this.disconnected = true;
        }
        /** Test-only: simulate the browser firing a resize batch. */
        trigger() {
            if (this.disconnected) return; // real browsers never fire after disconnect
            this.cb();
        }
    };
}

function makeFakeCtx() {
    return {
        fillStyle: '',
        globalAlpha: 1,
        setTransformCalls: 0,
        scaleCalls: 0,
        setTransform() { this.setTransformCalls++; },
        scale() { this.scaleCalls++; },
        fillRect() {},
        beginPath() {},
        moveTo() {},
        arc() {},
        ellipse() {},
        fill() {},
    };
}

function makeFakeNode(id, registry) {
    const node = {
        id,
        value: '',
        textContent: '',
        parentElement: null,
        _classes: new Set(),
        classList: {
            add: (c) => node._classes.add(c),
            remove: (c) => node._classes.delete(c),
            contains: (c) => node._classes.has(c),
        },
        addEventListener(type, fn) { registry.add(node, type, fn); },
        removeEventListener(type, fn) { registry.remove(node, type, fn); },
    };
    return node;
}

function makeFakeDocument(registry) {
    const body = makeFakeNode('body', registry);
    const wrap = makeFakeNode('canvasWrap', registry);
    wrap.parentElement = body;

    const canvas = makeFakeNode('stage', registry);
    canvas.width = 0;
    canvas.height = 0;
    canvas.parentElement = wrap;
    canvas.getContext = () => makeFakeCtx();

    const ids = [
        'density', 'wind', 'gravity', 'denVal', 'windVal', 'gravVal',
        'telemetry', 'btnFlurry', 'btnHeavy', 'btnBlizzard',
    ];
    const elements = new Map();
    elements.set('stage', canvas);
    for (let i = 0; i < ids.length; i++) elements.set(ids[i], makeFakeNode(ids[i], registry));

    return {
        body,
        getElementById: (id) => elements.get(id) || null,
    };
}

function makeFakeWindow(registry, raf, ResizeObserverClass) {
    let dpr = 1;
    let now = 0;
    const win = {
        innerWidth: 800,
        innerHeight: 600,
        get devicePixelRatio() { return dpr; },
        set devicePixelRatio(v) { dpr = v; },
        performance: { now: () => now },
        requestAnimationFrame: (fn) => raf.request(fn),
        cancelAnimationFrame: (id) => raf.cancel(id),
        addEventListener(type, fn) { registry.add(win, type, fn); },
        removeEventListener(type, fn) { registry.remove(win, type, fn); },
        ResizeObserver: ResizeObserverClass,
    };
    return win;
}

function makeStubEngine() {
    return {
        config: { density: 10, wind: 30, gravity: 40 },
        spawnCalls: 0,
        updateAndDrawCalls: 0,
        destroyCalls: 0,
        activeCount: 0,
        fallingCount: 0,
        meltingCount: 0,
        spawn() { this.spawnCalls++; },
        updateAndDraw() { this.updateAndDrawCalls++; },
        destroy() { this.destroyCalls++; },
    };
}

/** Wires up one full fake environment. Fresh per test -- no shared state. */
function makeRig() {
    const registry = new ListenerRegistry();
    const raf = makeFakeRaf();
    let observer = null;
    const ResizeObserverClass = makeFakeResizeObserverClass((inst) => { observer = inst; });
    const document = makeFakeDocument(registry);
    const window = makeFakeWindow(registry, raf, ResizeObserverClass);
    const engine = makeStubEngine();
    const demo = createSnowDemo({ window, document, engine });
    return { registry, raf, get observer() { return observer; }, document, window, engine, demo };
}

describe('DemoHarness (SN-27/SN-28 leak gate)', () => {
    test('wires up via ResizeObserver, not a raw resize handler', () => {
        const { registry, raf, observer } = makeRig();
        assert.ok(observer, 'window.ResizeObserver must be constructed');
        assert.equal(observer.observeCalls, 1, 'observer.observe() called exactly once');
        assert.equal(registry.has('resize'), false,
            'no raw window "resize" listener may exist -- SN-27 requires the rAF-batched ' +
            'ResizeObserver path, never a synchronous resize handler');
        assert.ok(raf.pendingCount >= 1, 'the render loop schedules its first frame at init');
    });

    test('200 resize cycles: live listener count is constant, no accumulation', () => {
        const { registry, raf, observer } = makeRig();
        const baseline = registry.size;
        assert.ok(baseline > 0, 'sanity: init must register at least one listener');

        for (let i = 0; i < 200; i++) {
            observer.trigger();
            raf.flush();
            assert.equal(registry.size, baseline,
                `listener count drifted at resize cycle ${i}: ${registry.size} vs baseline ${baseline}`);
        }
    });

    test('devicePixelRatio is re-read on every resize, not captured once', () => {
        const { window, document, observer, raf } = makeRig();
        const canvas = document.getElementById('stage');

        // First resize at dpr=1.
        observer.trigger();
        raf.flush();
        assert.equal(canvas.width, window.innerWidth * 1);
        assert.equal(canvas.height, window.innerHeight * 1);

        // Mutate dpr AND viewport between resizes -- both must be re-read live.
        window.devicePixelRatio = 3;
        window.innerWidth = 1000;
        window.innerHeight = 700;
        observer.trigger();
        raf.flush();
        assert.equal(canvas.width, 1000 * 3, 'canvas backing width must reflect the NEW dpr');
        assert.equal(canvas.height, 700 * 3, 'canvas backing height must reflect the NEW dpr');

        // And back down again -- proves it is not a one-way ratchet either.
        window.devicePixelRatio = 1;
        observer.trigger();
        raf.flush();
        assert.equal(canvas.width, 1000 * 1);
    });

    test('pagehide destroy(): cancels rAF, disconnects observer, destroys engine exactly once, empties listeners', () => {
        const { registry, raf, observer, window, engine } = makeRig();

        // Drive some activity first so destroy() has real state to tear down.
        for (let i = 0; i < 5; i++) { observer.trigger(); raf.flush(); }

        const pendingBeforeDestroy = raf.pendingCount;
        assert.ok(pendingBeforeDestroy >= 1, 'a frame must be in flight before destroy()');

        const pagehideEntry = registry.entries.find((e) => e.node === window && e.type === 'pagehide');
        assert.ok(pagehideEntry, 'a pagehide listener must be registered on window');

        pagehideEntry.fn(); // invoke exactly as the browser would fire pagehide

        assert.equal(engine.destroyCalls, 1, 'engine.destroy() must fire exactly once');
        assert.equal(observer.disconnectCalls, 1, 'observer.disconnect() must fire exactly once');
        assert.equal(registry.size, 0, 'every listener destroy() added must be removed -- SN-27');
        assert.ok(raf.canceledCount >= 1, 'the in-flight animation frame must be canceled');

        // --- duplicate dispose: calling the SAME handler again must be a pure no-op ---
        pagehideEntry.fn();
        assert.equal(engine.destroyCalls, 1, 'duplicate dispose must not call engine.destroy() twice');
        assert.equal(observer.disconnectCalls, 1, 'duplicate dispose must not disconnect twice');
        assert.equal(registry.size, 0, 'duplicate dispose must not throw removing already-removed listeners');
    });

    test('destroy() via the returned handle is equivalent to the pagehide path', () => {
        const rig = makeRig();
        rig.demo.destroy();
        assert.equal(rig.engine.destroyCalls, 1);
        assert.equal(rig.observer.disconnectCalls, 1);
        assert.equal(rig.registry.size, 0);
        rig.demo.destroy(); // duplicate dispose via the public handle
        assert.equal(rig.engine.destroyCalls, 1);
    });

    test('after destroy: further resize/rAF activity is a no-op (adversarial: stray post-disconnect signal)', () => {
        const rig = makeRig();
        for (let i = 0; i < 3; i++) { rig.observer.trigger(); rig.raf.flush(); }
        rig.demo.destroy();

        const spawnBefore = rig.engine.spawnCalls;
        const drawBefore = rig.engine.updateAndDrawCalls;
        const pendingBefore = rig.raf.pendingCount;
        assert.equal(pendingBefore, 0, 'nothing should remain scheduled immediately after destroy()');

        // Adversarial case the planner did not think of: the browser fires ONE
        // more ResizeObserver callback that was already in flight when
        // disconnect() ran. The fake models the real contract (disconnected ->
        // never calls back), so trigger() must be a silent no-op here.
        rig.observer.trigger();
        rig.raf.flush();

        assert.equal(rig.raf.pendingCount, 0, 'no new frame may be scheduled after destroy()');
        assert.equal(rig.engine.spawnCalls, spawnBefore, 'engine.spawn() must not fire after destroy()');
        assert.equal(rig.engine.updateAndDrawCalls, drawBefore, 'engine.updateAndDraw() must not fire after destroy()');
    });

    test('dispose-during-iteration: destroy() fired between a resize signal and its rAF flush', () => {
        const rig = makeRig();
        // A resize signal lands (schedules the debounced updateSize rAF)...
        rig.observer.trigger();
        // ...and destroy() runs BEFORE that scheduled frame is flushed.
        rig.demo.destroy();
        assert.doesNotThrow(() => rig.raf.flush(),
            'flushing a frame that was in flight when destroy() ran must not throw');
        assert.equal(rig.engine.destroyCalls, 1);
        assert.equal(rig.registry.size, 0);
    });

    test('re-entrant write: the render loop rescheduling itself inside its own rAF callback does not corrupt the queue', () => {
        const rig = makeRig();
        const before = rig.raf.pendingCount;
        assert.ok(before >= 1);
        // Each flush() invokes the current loop callback, which itself calls
        // window.requestAnimationFrame(loop) again from INSIDE the callback --
        // a direct re-entrant write into the same queue flush() is draining.
        for (let i = 0; i < 50; i++) {
            rig.raf.flush();
            assert.equal(rig.raf.pendingCount, 1,
                `queue must hold exactly one re-scheduled frame after flush ${i}, got ${rig.raf.pendingCount}`);
        }
        assert.equal(rig.engine.spawnCalls, 50);
        assert.equal(rig.engine.updateAndDrawCalls, 50);
    });
});
