# @zakkster/lite-snow

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-snow.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-snow)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-snow?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-snow)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-snow?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-snow)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-snow?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-snow)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Dependencies](https://img.shields.io/badge/dependencies-1-brightgreen)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

Zero-GC SoA environmental snow engine with drift physics, Z-depth parallax, ellipse accumulation, and bucketed rendering. One dependency. 3 presets. 198 lines.

## Live Demo
https://cdpn.io/pen/debug/yyapJqB

## Why lite-snow?

| Feature | lite-snow | tsparticles | weatherJS | p5.js |
|---|---|---|---|---|
| **Zero-GC hot path** | **Yes** | No | No | No |
| **SoA flat arrays** | **12 arrays** | No | No | No |
| **Z-depth parallax** | **Yes (0.2–1.0)** | No | No | Manual |
| **Sinusoidal drift** | **Per-flake** | Partial | No | Manual |
| **Melt accumulation** | **Ellipse morph** | No | No | No |
| **Bucketed rendering** | **3 tiers** | No | No | No |
| **Built-in presets** | **3** | Config-heavy | No | No |
| **OKLCH color** | **Yes** | No | No | No |
| **Bundle size** | **< 2KB** | ~40KB | ~10KB | ~800KB |

## Installation

```bash
npm install @zakkster/lite-snow
```

## Quick Start

```javascript
import { SnowEngine } from '@zakkster/lite-snow';

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const snow = new SnowEngine(10000);

let w = canvas.width, h = canvas.height;
let last = performance.now();

function loop(time) {
    const dt = Math.min((time - last) / 1000, 0.1);
    last = time;

    snow.spawn(dt, w, h);

    ctx.fillStyle = '#0a0a1a';
    ctx.fillRect(0, 0, w, h);         // dark sky background

    snow.updateAndDraw(ctx, dt, w, h); // snow overlays on top
    requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
```

### One-Liner with Presets

```javascript
import { SnowEngine, SNOW_PRESETS } from '@zakkster/lite-snow';

const blizzard = new SnowEngine(15000, SNOW_PRESETS.blizzard);
```

> **Important:** `updateAndDraw()` does **not** clear the canvas. Snow is an overlay effect. Call `ctx.clearRect()` or draw your background before calling `updateAndDraw()`.

---

## Presets

| Preset | Density | Wind | Gravity | Drift | Radius | Feel |
|---|---|---|---|---|---|---|
| `SNOW_PRESETS.flurry` | 10 | 30 | 40 | 15 | 2.5 | Gentle, peaceful |
| `SNOW_PRESETS.heavy` | 24 | 150 | 80 | 25 | 3.5 | Dense, windy |
| `SNOW_PRESETS.blizzard` | 40 | 400 | 250 | 50 | 2.0 | Extreme whiteout |

---

## The Snow Pipeline

### Phase 1: Falling Flake (state = 1)

Snowflakes spawn above the viewport with random Z-depth (0.2–1.0). Every parameter scales by Z:

| Property | Formula | Effect |
|---|---|---|
| Fall speed | `gravity × z` | Far flakes fall slower |
| Wind drift | `wind × z` | Far flakes drift less |
| Flake radius | `(baseRadius ± jitter) × z` | Far flakes are smaller |
| Drift amplitude | `driftAmplitude × z` | Far flakes sway less |
| Render alpha | `z × 0.8` | Far flakes are faint |

Each flake has a unique **sinusoidal drift** — a sine wave with per-flake random phase, frequency, and amplitude. This produces the natural floating-leaf motion that makes snow look real instead of just falling vertically.

All Z-dependent values are **precomputed at spawn**: `gz[]`, `wz[]`, `radius[]`, `driftAmp[]`, `bucket[]`.

### Phase 2: Melt (state = 2)

When a flake reaches the floor (`y >= h`), it transitions to a settled state:

- **Shape morphs** from a circle to a flat **ellipse** (2.5× width, 0.5× height) — simulating a flake flattening on the ground
- **Alpha fades** from `z` to 0 over `meltTimeMin` to `meltTimeMax` seconds
- Computed via `invMeltMax` (one division per frame, not per flake)

This creates a subtle accumulation layer at the bottom of the canvas — flakes don't just disappear, they settle and melt.

### Bucketed Rendering

Flakes are binned into 3 depth tiers at spawn:

| Bucket | Z Range | Alpha | Radius Scale |
|---|---|---|---|
| 0 (far) | 0.2–0.4 | 0.24 | ~0.3× |
| 1 (mid) | 0.4–0.7 | 0.44 | ~0.55× |
| 2 (near) | 0.7–1.0 | 0.72 | ~0.9× |

Each bucket renders in **one batched `ctx.fill()` call** — 3 draw calls for all 10,000 flakes.

---

## Full Config Reference

All config values are live-mutable between frames.

| Option | Type | Default | Description |
|---|---|---|---|
| `gravity` | number | 40 | Downward acceleration (px/s²). Snow is very light. |
| `wind` | number | 30 | Horizontal wind (px/s). Positive = right. |
| `density` | number | 10.0 | Spawn multiplier. Auto-scales with canvas area. |
| `baseRadius` | number | 2.5 | Base flake radius (px). Depth-scaled per flake. |
| `driftAmplitude` | number | 15 | Horizontal drift sine amplitude (px). Depth-scaled. |
| `driftFreq` | number | 1.0 | Drift sine frequency (Hz). Per-flake jitter ±0.25. |
| `meltTimeMin` | number | 2.0 | Minimum time before settled flake fades (seconds). |
| `meltTimeMax` | number | 5.0 | Maximum melt time (seconds). |
| `color` | OklchColor \| string | `'oklch(0.98 0.02 250)'` | Flake color. Pre-parsed at construction. |
| `rng` | Function | `Math.random` | RNG function. Inject for determinism. |

---

## Canvas Setup (No Built-in Resize)

```javascript
import { SnowEngine } from '@zakkster/lite-snow';

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const snow = new SnowEngine();

let w = 0, h = 0;
const dpr = window.devicePixelRatio || 1;

function updateSize() {
    w = canvas.clientWidth || window.innerWidth;
    h = canvas.clientHeight || window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
}

let scheduled = false;
new ResizeObserver(() => {
    if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(() => { scheduled = false; updateSize(); });
    }
}).observe(canvas.parentElement || document.body);

updateSize();
```

---

## Seeded Random (Deterministic)

```javascript
import { SnowEngine } from '@zakkster/lite-snow';
import { Random } from '@zakkster/lite-random';

const rng = new Random(42);
const snow = new SnowEngine(10000, { rng: () => rng.next() });
```

---

## Recipes

<details>
<summary><strong>❄️ Gentle Window Scene</strong></summary>

```javascript
import { SnowEngine, SNOW_PRESETS } from '@zakkster/lite-snow';

const snow = new SnowEngine(8000, {
    ...SNOW_PRESETS.flurry,
    color: { l: 0.95, c: 0.02, h: 240 },
});
```

</details>

<details>
<summary><strong>🌨️ Heavy Snowfall</strong></summary>

```javascript
const snow = new SnowEngine(12000, SNOW_PRESETS.heavy);
```

</details>

<details>
<summary><strong>🌬️ Blizzard with Dynamic Wind</strong></summary>

```javascript
const snow = new SnowEngine(15000, SNOW_PRESETS.blizzard);

// Ramp wind over time
let windTarget = 400;
setInterval(() => {
    windTarget = 200 + Math.random() * 500 * (Math.random() > 0.5 ? 1 : -1);
}, 3000);

// In loop:
snow.config.wind += (windTarget - snow.config.wind) * dt * 1.5;
```

</details>

<details>
<summary><strong>🎮 Game Scene Overlay</strong></summary>

```javascript
function gameLoop(dt) {
    snow.spawn(dt, w, h);

    ctx.clearRect(0, 0, w, h);
    drawBackground();
    drawCharacters();
    drawUI();

    snow.updateAndDraw(ctx, dt, w, h);
}
```

</details>

<details>
<summary><strong>🎨 Colored Snow (Ash, Cherry Blossoms, Embers)</strong></summary>

```javascript
// Volcanic ash
const ash = new SnowEngine(6000, {
    color: { l: 0.3, c: 0.05, h: 30 },
    gravity: 60,
    driftAmplitude: 20,
});

// Cherry blossom petals
const petals = new SnowEngine(4000, {
    color: { l: 0.8, c: 0.15, h: 340 },
    gravity: 25,
    driftAmplitude: 30,
    baseRadius: 3.5,
});

// Floating embers
const embers = new SnowEngine(3000, {
    color: { l: 0.6, c: 0.25, h: 30 },
    gravity: -15,  // float upward!
    wind: 50,
    driftAmplitude: 10,
    baseRadius: 1.5,
});
```

</details>

<details>
<summary><strong>🔀 Combined with Rain + Fireworks</strong></summary>

```javascript
import { SnowEngine } from '@zakkster/lite-snow';
import { RainEngine } from '@zakkster/lite-rain';
import { FireworksEngine } from '@zakkster/lite-fireworks';

const snow = new SnowEngine(8000);
const rain = new RainEngine(6000, { density: 3 });
const fireworks = new FireworksEngine(5000);

function loop(time) {
    const dt = /* ... */;

    snow.spawn(dt, w, h);
    rain.spawn(dt, w, h);

    fireworks.updateAndDraw(ctx, dt, w, h); // bloom background
    snow.updateAndDraw(ctx, dt, w, h);       // snow overlay
    rain.updateAndDraw(ctx, dt, w, h);       // rain on top
}
```

</details>

<details>
<summary><strong>🎛️ Live Config Panel</strong></summary>

```javascript
windSlider.oninput = () => snow.config.wind = +windSlider.value;
densitySlider.oninput = () => snow.config.density = +densitySlider.value;
gravitySlider.oninput = () => snow.config.gravity = +gravitySlider.value;
driftSlider.oninput = () => snow.config.driftAmplitude = +driftSlider.value;
```

</details>

---

## API

### `new SnowEngine(maxParticles?, config?)`

| Parameter | Type | Default | Description |
|---|---|---|---|
| `maxParticles` | number | 10000 | Pool capacity. Shared between flakes and melting. |
| `config` | SnowConfig | see above | All options. Live-mutable. |

### Methods

| Method | Description |
|---|---|
| `.spawn(dt, w, h)` | Spawn new flakes. Auto-scales with area × density. |
| `.updateAndDraw(ctx, dt, w, h)` | Physics + render. Does **not** clear canvas. |
| `.clear()` | Kill all particles immediately. |
| `.destroy()` | Null all 12 typed arrays. Idempotent. |

### `SNOW_PRESETS`

| Preset | Description |
|---|---|
| `.flurry` | Gentle snowfall |
| `.heavy` | Dense, windy |
| `.blizzard` | Extreme whiteout |

---

## License

MIT

## Part of the @zakkster ecosystem

Zero-GC, deterministic, tree-shakeable micro-libraries for high-performance web presentation.
