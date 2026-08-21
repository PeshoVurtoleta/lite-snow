/**
 * @zakkster/lite-snow -- demo controller (SN-27/SN-28).
 *
 * All demo wiring lives here so it is importable and dependency-injected: the
 * browser shell (demo.html) builds the real DOM env and calls this; QA drives
 * the exact same code in node:test with a hand-rolled fake window/document/
 * ResizeObserver (zero dep). Every listener is added through the INJECTED
 * window/document so a test can count them, and destroy() removes/cancels
 * every one -- the SN-27 resize leak cannot exist if this stays true.
 *
 * createSnowDemo({ window, document, engine }) -> { destroy }
 *
 * @license MIT
 */

import { SNOW_PRESETS } from '../SnowEngine.js';

export function createSnowDemo({ window, document, engine }) {
    const canvas = document.getElementById('stage');
    const ctx = canvas.getContext('2d', { alpha: false });

    // Cached control handles ($-prefixed, resolved once at init).
    const $den = document.getElementById('density');
    const $wind = document.getElementById('wind');
    const $grav = document.getElementById('gravity');
    const $gust = document.getElementById('gust');
    const $turb = document.getElementById('turbulence');
    const $drag = document.getElementById('drag');
    const $denVal = document.getElementById('denVal');
    const $windVal = document.getElementById('windVal');
    const $gravVal = document.getElementById('gravVal');
    const $gustVal = document.getElementById('gustVal');
    const $turbVal = document.getElementById('turbVal');
    const $dragVal = document.getElementById('dragVal');
    const $telemetry = document.getElementById('telemetry');
    const $btnFlurry = document.getElementById('btnFlurry');
    const $btnHeavy = document.getElementById('btnHeavy');
    const $btnBlizzard = document.getElementById('btnBlizzard');
    const btns = [$btnFlurry, $btnHeavy, $btnBlizzard];

    // Every listener we own, so destroy() can remove exactly what it added.
    const listeners = [];
    function on(target, type, fn) {
        target.addEventListener(type, fn);
        listeners.push([target, type, fn]);
    }

    let w = 0, h = 0;
    let rafId = 0;
    let resizeScheduled = false;
    let destroyed = false;

    // Re-read devicePixelRatio on EVERY resize (SN-28): a window dragged between
    // a hi-dpi and a standard display changes dpr live; capturing it once bakes
    // in the launch display's ratio.
    function updateSize() {
        const dpr = window.devicePixelRatio || 1;
        w = window.innerWidth;
        h = window.innerHeight;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.scale(dpr, dpr);
    }

    // rAF-batched ResizeObserver (SN-27): coalesce a burst of resize callbacks
    // into one layout read on the next frame, never a synchronous resize handler.
    const observer = new window.ResizeObserver(() => {
        if (resizeScheduled) return;
        resizeScheduled = true;
        window.requestAnimationFrame(() => {
            resizeScheduled = false;
            if (!destroyed) updateSize();
        });
    });
    observer.observe(canvas.parentElement || document.body);

    function syncLabels() {
        $denVal.textContent = $den.value + '.0';
        $windVal.textContent = $wind.value;
        $gravVal.textContent = $grav.value;
        $gustVal.textContent = $gust.value;
        $turbVal.textContent = $turb.value;
        $dragVal.textContent = $drag.value;
    }

    function applySliders() {
        engine.config.density = parseFloat($den.value);
        engine.config.wind = parseFloat($wind.value);
        engine.config.gravity = parseFloat($grav.value);
        engine.config.gust = parseFloat($gust.value);
        engine.config.turbulence = parseFloat($turb.value);
        engine.config.drag = parseFloat($drag.value);
        syncLabels();
    }

    // Preset buttons drive the SHIPPED SNOW_PRESETS surface (SN-28), not
    // hand-rolled numbers. Spread so the frozen preset is never mutated.
    function applyPreset(btn, preset) {
        for (let i = 0; i < btns.length; i++) btns[i].classList.remove('active');
        btn.classList.add('active');
        Object.assign(engine.config, preset);
        $den.value = String(preset.density);
        $wind.value = String(preset.wind);
        $grav.value = String(preset.gravity);
        syncLabels();
    }

    on($den, 'input', applySliders);
    on($wind, 'input', applySliders);
    on($grav, 'input', applySliders);
    on($gust, 'input', applySliders);
    on($turb, 'input', applySliders);
    on($drag, 'input', applySliders);
    on($btnFlurry, 'click', (e) => applyPreset(e.currentTarget, SNOW_PRESETS.flurry));
    on($btnHeavy, 'click', (e) => applyPreset(e.currentTarget, SNOW_PRESETS.heavy));
    on($btnBlizzard, 'click', (e) => applyPreset(e.currentTarget, SNOW_PRESETS.blizzard));

    // Hook initial UI from the engine's actual config, never hardcoded.
    $den.value = String(engine.config.density);
    $wind.value = String(engine.config.wind);
    $grav.value = String(engine.config.gravity);
    $gust.value = String(engine.config.gust);
    $turb.value = String(engine.config.turbulence);
    $drag.value = String(engine.config.drag);
    syncLabels();
    updateSize();

    // --- render loop ---
    let lastTime = window.performance.now();
    let frame = 0;

    function loop(time) {
        const dt = Math.min((time - lastTime) / 1000, 0.1);
        lastTime = time;

        ctx.fillStyle = '#0d111a';
        ctx.fillRect(0, 0, w, h);

        engine.spawn(dt, w, h);
        engine.updateAndDraw(ctx, dt, w, h);

        // Telemetry throttled to ~10Hz via a frame-counter mask -- no per-frame
        // textContent write, showcases the 1.1.0 O(1) getters.
        if ($telemetry && (frame & 7) === 0) {
            $telemetry.textContent =
                'active ' + engine.activeCount +
                ' | falling ' + engine.fallingCount +
                ' | melting ' + engine.meltingCount;
        }
        frame++;

        rafId = window.requestAnimationFrame(loop);
    }
    rafId = window.requestAnimationFrame(loop);

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        if (rafId) window.cancelAnimationFrame(rafId);
        rafId = 0;
        observer.disconnect();
        for (let i = 0; i < listeners.length; i++) {
            const l = listeners[i];
            l[0].removeEventListener(l[1], l[2]);
        }
        listeners.length = 0;
        engine.destroy();
    }

    // A backgrounded/closed page tears the demo down deterministically.
    on(window, 'pagehide', destroy);

    return { destroy };
}
