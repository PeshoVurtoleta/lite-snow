/**
 * @zakkster/lite-snow v1.0.2
 * Zero-GC, SoA Environmental Snow Engine
 * Drift physics, Z-depth parallax, ellipse accumulation, bucketed rendering, 3 presets.
 */

import { toCssOklch } from '@zakkster/lite-color';

export const VERSION = '1.0.2';

const TAU = Math.PI * 2;
const DT_MAX = 0.1;

export class SnowEngine {
    constructor(maxParticles = 10000, config = {}) {
        this.max = maxParticles;
        this.config = {
            gravity: 40,          
            wind: 30,             
            density: 10.0,        
            baseRadius: 2.5,      
            driftAmplitude: 15,   
            driftFreq: 1.0,       
            meltTimeMin: 2.0,     
            meltTimeMax: 5.0,     
            color: 'oklch(0.98 0.02 250)', 
            rng: Math.random,     
            ...config
        };

        this.colorStr = typeof this.config.color === 'string' ? this.config.color : toCssOklch(this.config.color);

        this.x = new Float32Array(this.max);
        this.y = new Float32Array(this.max);
        this.z = new Float32Array(this.max);
        
        this.gz = new Float32Array(this.max);    
        this.wz = new Float32Array(this.max);    
        this.bucket = new Uint8Array(this.max);  
        this.radius = new Float32Array(this.max); 
        this.driftPhase = new Float32Array(this.max); 
        this.driftSpeed = new Float32Array(this.max); 
        this.driftAmp = new Float32Array(this.max); 

        this.life = new Float32Array(this.max); 
        this.state = new Uint8Array(this.max);  
        
        this._elapsedTime = 0;
        this._destroyed = false;
        
        // Dimension cache — recompute only on size change
        this._lastW = 0;
        this._lastH = 0;
        this._areaModifier = 0;

        this._buckets = [
            { id: 0, zAvg: 0.3 },
            { id: 1, zAvg: 0.55 },
            { id: 2, zAvg: 0.9 } 
        ];
    }

    /** Fail-closed frame door. Returns the clamped dt, or -1 to reject the frame. */
    _sane(dt, w, h) {
        if (!Number.isFinite(dt) || dt < 0) return -1;
        if (!Number.isFinite(w) || w <= 0) return -1;
        if (!Number.isFinite(h) || h <= 0) return -1;
        return dt > DT_MAX ? DT_MAX : dt;
    }

    spawn(dt, w, h) {
        if (this._destroyed) return;
        dt = this._sane(dt, w, h); if (dt < 0) return;

        // Only recompute area modifier on dimension change
        if (this._lastW !== w || this._lastH !== h) {
            this._lastW = w;
            this._lastH = h;
            this._areaModifier = (w * h) / 100000;
        }

        const cap = Math.floor(this._areaModifier * this.config.density * (dt * 60)) | 0;
        if (cap <= 0) return;
        const g = this.config.gravity;
        let windOffset = g === 0 ? 0 : (h / g) * Math.abs(this.config.wind);
        if (!Number.isFinite(windOffset)) windOffset = 0;
        let spawned = 0;

        for (let i = 0; i < this.max; i++) {
            if (this.state[i] === 0) {
                this.state[i] = 1;

                this.x[i] = this.config.rng() * (w + windOffset * 2) - windOffset;
                this.y[i] = -50 - this.config.rng() * 50;
                
                this.z[i] = 0.2 + this.config.rng() * 0.8;
                
                this.gz[i] = this.config.gravity * this.z[i];
                this.wz[i] = this.config.wind * this.z[i];
                
                const jitter = (this.config.rng() - 0.5) * 0.8;
                this.radius[i] = (this.config.baseRadius + jitter) * this.z[i];
                this.driftAmp[i] = this.config.driftAmplitude * this.z[i];
                
                this.bucket[i] = this.z[i] < 0.4 ? 0 : this.z[i] < 0.7 ? 1 : 2;
                this.driftPhase[i] = this.config.rng() * TAU;
                this.driftSpeed[i] = this.config.driftFreq + (this.config.rng() - 0.5) * 0.5;

                if (++spawned >= cap) return;
            }
        }
    }

    updateAndDraw(ctx, dt, w, h) {
        if (this._destroyed) return;
        dt = this._sane(dt, w, h); if (dt < 0) return;
        this._elapsedTime += dt;
        const invMeltMax = 1.0 / this.config.meltTimeMax;

        // --- 1. GLOBAL PHYSICS PASS ---
        for (let i = 0; i < this.max; i++) {
            if (this.state[i] === 0) continue;

            if (this.state[i] === 1) {
                const sway = Math.sin(this._elapsedTime * this.driftSpeed[i] + this.driftPhase[i]) * this.driftAmp[i];
                
                this.x[i] += (this.wz[i] + sway) * dt; 
                this.y[i] += this.gz[i] * dt; 

                // Off-screen culling (X-axis wind leak AND Y-axis negative gravity leak)
                if (!(this.x[i] >= -200 && this.x[i] <= w + 200 && this.y[i] >= -200)) {
                    this.state[i] = 0;
                    continue;
                }

                if (this.y[i] >= h) {
                    this.y[i] = h; 
                    this.state[i] = 2; 
                    this.life[i] = this.config.meltTimeMin + this.config.rng() * (this.config.meltTimeMax - this.config.meltTimeMin);
                }
            } 
            else if (this.state[i] === 2) {
                this.life[i] -= dt;
                if (this.life[i] <= 0) this.state[i] = 0; 
            }
        }

        // --- 2. BUCKETED RENDER PIPELINE ---
        ctx.fillStyle = this.colorStr;

        for (const bucket of this._buckets) {
            ctx.globalAlpha = bucket.zAvg * 0.8; 
            ctx.beginPath(); 
            for (let i = 0; i < this.max; i++) {
                if (this.state[i] === 1 && this.bucket[i] === bucket.id) {
                    ctx.moveTo(this.x[i] + this.radius[i], this.y[i]);
                    ctx.arc(this.x[i], this.y[i], this.radius[i], 0, TAU);
                }
            }
            ctx.fill(); 
        }

        for (let i = 0; i < this.max; i++) {
            if (this.state[i] === 2) {
                ctx.globalAlpha = (this.life[i] * invMeltMax) * this.z[i]; 
                ctx.beginPath();
                ctx.ellipse(this.x[i], this.y[i], this.radius[i] * 2.5, this.radius[i] * 0.5, 0, 0, TAU);
                ctx.fill();
            }
        }
        
        ctx.globalAlpha = 1.0;
    }

    clear() {
        if (this._destroyed) return;
        this.state.fill(0);
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this.clear();
        this.x = null; this.y = null; this.z = null; this.gz = null; 
        this.wz = null; this.bucket = null; this.radius = null; 
        this.driftPhase = null; this.driftSpeed = null; this.driftAmp = null;
        this.life = null; this.state = null;
    }
}


export const SNOW_PRESETS = {
    flurry: {
        density: 10.0,
        wind: 30,
        gravity: 40,
        driftAmplitude: 15,
        baseRadius: 2.5
    },
    heavy: {
        density: 24.0,
        wind: 150,
        gravity: 80,
        driftAmplitude: 25,
        baseRadius: 3.5
    },
    blizzard: {
        density: 40.0,
        wind: 400,
        gravity: 250,
        driftAmplitude: 50,
        baseRadius: 2.0 // Smaller flakes due to wind shear
    }
};