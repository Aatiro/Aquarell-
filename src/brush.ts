import { STAMP_FLOATS, ToolId } from './sim';
import type { PigmentLatent } from './palette';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface StrokeSettings {
  tool: ToolId;
  /** radius in CSS px */
  size: number;
  /** 0..1 */
  water: number;
  /** 0..1 */
  pigment: number;
  color: PigmentLatent;
  seed: number;
}

/** Growable stamp list shared by all strokes of one frame. */
export class StampBuffer {
  data = new Float32Array(STAMP_FLOATS * 256);
  count = 0;
  push(x: number, y: number, r: number, angle: number, water: number, pig: number, seed: number): void {
    if ((this.count + 1) * STAMP_FLOATS > this.data.length) {
      const n = new Float32Array(this.data.length * 2);
      n.set(this.data);
      this.data = n;
    }
    const o = this.count * STAMP_FLOATS;
    const d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = r; d[o + 3] = angle;
    d[o + 4] = water; d[o + 5] = pig; d[o + 6] = seed; d[o + 7] = 0;
    this.count++;
  }
}

/**
 * Turns input points (sim px + pressure) into evenly spaced stamps.
 * Deterministic for a given settings.seed, so strokes replay identically.
 */
export class StrokeBuilder {
  private lx = 0;
  private ly = 0;
  private lp = 1;
  private started = false;
  private travelled = 0;
  private since = 0;
  private angle = 0;
  private rnd: () => number;

  constructor(readonly s: StrokeSettings, private simScale: number) {
    this.rnd = mulberry32(s.seed);
  }

  private radius(p: number): number {
    return Math.max(0.8, this.s.size * this.simScale * (0.25 + 0.75 * p));
  }

  add(x: number, y: number, p: number, out: StampBuffer): void {
    if (!this.started) {
      this.started = true;
      this.lx = x; this.ly = y; this.lp = p;
      this.emit(x, y, p, out, this.spacing(p) / this.radius(p));
      return;
    }
    const dx = x - this.lx, dy = y - this.ly;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-3) return;
    const target = Math.atan2(dy, dx);
    // smooth the direction a little so bristle streaks don't jitter
    let da = target - this.angle;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    this.angle += da * 0.5;

    let consumed = 0;
    let since = this.since;
    while (true) {
      const pp = this.lp + (p - this.lp) * (consumed / dist);
      const sp = this.spacing(pp);
      const need = sp - since;
      if (consumed + need > dist) {
        this.since = since + (dist - consumed);
        break;
      }
      consumed += need;
      since = 0;
      const t = consumed / dist;
      const pt = this.lp + (p - this.lp) * t;
      this.emit(this.lx + dx * t, this.ly + dy * t, pt, out, sp / this.radius(pt));
      this.travelled += sp;
    }
    this.lx = x; this.ly = y; this.lp = p;
  }

  /** A tap without movement still leaves a full dab. */
  finish(out: StampBuffer): void {
    if (this.started && this.travelled === 0 && this.s.tool !== 3) this.emit(this.lx, this.ly, this.lp, out, 0.9);
  }

  private spacing(p: number): number {
    const r = this.radius(p);
    return this.s.tool === 3 ? Math.max(1.5, r * 0.7) : Math.max(0.5, r * 0.18);
  }

  private emit(x: number, y: number, p: number, out: StampBuffer, density: number): void {
    const s = this.s;
    const r = this.radius(p);
    const L = this.travelled / Math.max(r, 1);
    switch (s.tool) {
      case 0: {
        // the brush slowly runs out of paint and water along the stroke
        const loadP = 0.45 + 0.55 * Math.exp(-L / 60);
        const loadW = 0.6 + 0.4 * Math.exp(-L / 90);
        const water = (0.06 + 0.94 * s.water) * 0.55 * density * loadW * (0.7 + 0.3 * p);
        const pig = s.pigment * 0.5 * density * loadP * (0.6 + 0.4 * p);
        out.push(x, y, r, this.angle, water, pig, s.seed % 1000);
        break;
      }
      case 1: {
        const water = (0.06 + 0.94 * s.water) * 0.6 * density * (0.7 + 0.3 * p);
        out.push(x, y, r, this.angle, water, 0, s.seed % 1000);
        break;
      }
      case 2:
        out.push(x, y, r, this.angle, 0, 0.6 * density * (0.5 + 0.5 * p), s.seed % 1000);
        break;
      case 3: {
        const grains = 1 + Math.floor(r * r * 0.012 * (0.5 + s.pigment));
        for (let i = 0; i < grains; i++) {
          const a = this.rnd() * Math.PI * 2;
          const d = Math.sqrt(this.rnd()) * r;
          const gr = (1.0 + this.rnd() * 2.6) * this.simScale + 0.4;
          out.push(x + Math.cos(a) * d, y + Math.sin(a) * d, gr, 0, 0, 0.6 + 0.4 * this.rnd(), 0);
        }
        break;
      }
    }
  }
}
