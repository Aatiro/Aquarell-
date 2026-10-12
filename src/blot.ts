import { mulberry32, StrokeSettings } from './brush';
import { shaper, Shaper, toArray, V } from './shapes';

export interface BlotLayer {
  pts: Float32Array;
  water: number;
  pigment: number;
  seed: number;
}

/**
 * Press-and-hold blot: every frame lays down one more thin, freshly deformed layer around
 * the pointer. The radius grows while the pointer is held (fast at first, then slower) and
 * each layer carries less pigment, so a long press gives a big blot with a soft, pale rim.
 */
export class BlotGrower {
  private sh: Shaper;
  private base: V[];
  private frames = 0;
  private cx: number;
  private cy: number;
  private tx: number;
  private ty: number;
  private p: number;

  constructor(readonly s: StrokeSettings, private simScale: number, x: number, y: number, p: number) {
    this.sh = shaper(mulberry32(s.seed));
    // unit-radius base shape; layers are scaled around the (moving) centre
    this.base = this.sh.deform(this.sh.basePolygon(0, 0, 1, 10), 2, 0.4);
    this.cx = this.tx = x;
    this.cy = this.ty = y;
    this.p = p;
  }

  move(x: number, y: number, p: number): void {
    this.tx = x;
    this.ty = y;
    this.p = p;
  }

  get layers(): number {
    return this.frames;
  }

  next(): BlotLayer {
    const f = this.frames++;
    // follow the pointer with a little lag so dragging smears the blot
    this.cx += (this.tx - this.cx) * 0.35;
    this.cy += (this.ty - this.cy) * 0.35;
    const r0 = Math.max(2, this.s.size * this.simScale);
    const R = r0 * (0.6 + 2.9 * (1 - Math.exp(-f / 75))) * (0.75 + 0.25 * this.p);
    const layer = this.sh.deform(this.base, 3, 0.22);
    const pts = toArray(layer.map((v) => ({ x: this.cx + v.x * R, y: this.cy + v.y * R, v: v.v })));
    const fade = Math.exp(-f / 100);
    return {
      pts,
      water: (0.015 + 0.045 * this.s.water) * (0.4 + 0.6 * fade),
      pigment: this.s.pigment * 0.03 * (0.2 + 0.8 * fade) * (0.5 + 0.5 * this.p),
      seed: this.sh.rnd() * 100,
    };
  }
}
