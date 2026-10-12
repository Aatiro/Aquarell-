import { latentToRgb, PigmentLatent } from './palette';

export type MixMode = 'paint' | 'smudge' | 'pick';

/**
 * A small palette well: paint is mixed per pixel in mixbox latent space (Kubelka–Munk),
 * so blue + yellow really gives green. Picking returns the exact latent mix.
 */
export class Mixer {
  mode: MixMode = 'paint';
  color: PigmentLatent | null = null;
  onPick: (c: PigmentLatent) => void = () => {};

  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private scale = 1;
  // per pixel: c0 c1 c2 r0 r1 r2 gran amount
  private lat = new Float32Array(0);
  private img!: ImageData;
  private carried: Float32Array | null = null;
  private last: { x: number; y: number } | null = null;
  private down = false;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    const up = () => { this.down = false; this.last = null; this.carried = null; };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
  }

  /** (Re)allocate for the current CSS size. Keeps nothing; call when first shown. */
  resize(): void {
    const r = this.canvas.getBoundingClientRect();
    if (r.width === 0) return;
    const s = Math.min(2, window.devicePixelRatio || 1) * 0.5; // half-res buffer is plenty
    const w = Math.max(8, Math.round(r.width * s));
    const h = Math.max(8, Math.round(r.height * s));
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h; this.scale = s;
    this.canvas.width = w;
    this.canvas.height = h;
    this.lat = new Float32Array(w * h * 8);
    this.img = this.ctx.createImageData(w, h);
    this.redraw(0, 0, w, h);
  }

  clear(): void {
    this.lat.fill(0);
    this.redraw(0, 0, this.w, this.h);
  }

  private pos(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * this.scale, y: (e.clientY - r.top) * this.scale };
  }

  private onDown(e: PointerEvent): void {
    this.resize();
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.pos(e);
    if (this.mode === 'pick') {
      this.pick(p.x, p.y);
      return;
    }
    this.down = true;
    this.last = p;
    if (this.mode === 'smudge') this.carried = this.sample(p.x, p.y);
    this.dab(p.x, p.y);
  }

  private onMove(e: PointerEvent): void {
    if (!this.down || !this.last) return;
    const p = this.pos(e);
    const d = Math.hypot(p.x - this.last.x, p.y - this.last.y);
    const step = 2;
    const n = Math.floor(d / step);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      this.dab(this.last.x + (p.x - this.last.x) * t, this.last.y + (p.y - this.last.y) * t);
    }
    if (n > 0) this.last = p;
  }

  private sample(x: number, y: number): Float32Array | null {
    const ix = Math.round(x), iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= this.w || iy >= this.h) return null;
    const o = (iy * this.w + ix) * 8;
    if (this.lat[o + 7] <= 0.01) return null;
    return this.lat.slice(o, o + 8);
  }

  private pick(x: number, y: number): void {
    // average a small neighbourhood, weighted by amount
    const acc = new Float32Array(8);
    let wsum = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const s = this.sample(x + dx, y + dy);
      if (!s) continue;
      for (let k = 0; k < 7; k++) acc[k] += s[k] * s[7];
      wsum += s[7];
    }
    if (wsum <= 0) return;
    for (let k = 0; k < 7; k++) acc[k] /= wsum;
    this.onPick({ c: [acc[0], acc[1], acc[2]], r: [acc[3], acc[4], acc[5]], gran: acc[6] });
  }

  private dab(x: number, y: number): void {
    const src = this.mode === 'smudge' ? this.carried : this.color && this.vec(this.color);
    const R = 9 * this.scale * 2;
    const x0 = Math.max(0, Math.floor(x - R)), x1 = Math.min(this.w - 1, Math.ceil(x + R));
    const y0 = Math.max(0, Math.floor(y - R)), y1 = Math.min(this.h - 1, Math.ceil(y + R));
    const L = this.lat;
    const pickup = new Float32Array(8);
    let pw = 0;
    for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
      const d = Math.hypot(px - x, py - y) / R;
      if (d >= 1) continue;
      const f = (1 - d * d) * (1 - d * d);
      const o = (py * this.w + px) * 8;
      const a = L[o + 7];
      if (this.mode === 'smudge') {
        if (a > 0.01) {
          for (let k = 0; k < 7; k++) pickup[k] += L[o + k] * f * a;
          pw += f * a;
        }
        if (!src) continue;
      }
      if (!src) continue;
      const add = this.mode === 'smudge' ? f * 0.3 * src[7] : f * 0.25;
      const t = a <= 0.001 ? 1 : add / (a + add);
      for (let k = 0; k < 7; k++) L[o + k] += (src[k] - L[o + k]) * t;
      L[o + 7] = this.mode === 'smudge' ? a + (src[7] - a) * f * 0.3 : Math.min(1, a + add);
    }
    if (this.mode === 'smudge' && pw > 0) {
      // the smudging brush picks up some of what it moves through
      const c = this.carried ?? new Float32Array(8);
      const mix = 0.15;
      for (let k = 0; k < 7; k++) c[k] = this.carried ? c[k] + (pickup[k] / pw - c[k]) * mix : pickup[k] / pw;
      c[7] = this.carried ? c[7] : 0.8;
      this.carried = c;
    }
    this.redraw(x0, y0, x1 + 1, y1 + 1);
  }

  private vec(c: PigmentLatent): Float32Array {
    return new Float32Array([c.c[0], c.c[1], c.c[2], c.r[0], c.r[1], c.r[2], c.gran, 1]);
  }

  private redraw(x0: number, y0: number, x1: number, y1: number): void {
    if (!this.img) return;
    const L = this.lat;
    const D = this.img.data;
    const paper = [247, 244, 236];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = y * this.w + x, o = i * 8;
      const a = L[o + 7];
      let r = paper[0], g = paper[1], b = paper[2];
      if (a > 0.001) {
        const rgb = latentToRgb({ c: [L[o], L[o + 1], L[o + 2]], r: [L[o + 3], L[o + 4], L[o + 5]], gran: 0 });
        const t = Math.min(1, a * 1.15);
        r += (rgb[0] - r) * t; g += (rgb[1] - g) * t; b += (rgb[2] - b) * t;
      }
      D[i * 4] = r; D[i * 4 + 1] = g; D[i * 4 + 2] = b; D[i * 4 + 3] = 255;
    }
    this.ctx.putImageData(this.img, 0, 0, x0, y0, x1 - x0, y1 - y0);
  }
}
