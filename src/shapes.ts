// "Deformed polygon" helpers shared by the generator and the blot tool: recursively inserting
// jittered midpoints gives the ragged, organic outline of a watercolour puddle.

export interface V { x: number; y: number; v: number }

export interface Shaper {
  rnd: () => number;
  gauss: () => number;
  deform(pts: V[], depth: number, variance: number): V[];
  basePolygon(cx: number, cy: number, r: number, n: number): V[];
}

export function shaper(rnd: () => number): Shaper {
  const gauss = () => {
    const u = Math.max(rnd(), 1e-9), v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  const deform = (pts: V[], depth: number, variance: number): V[] => {
    for (let d = 0; d < depth; d++) {
      const out: V[] = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        out.push(a);
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const t = 0.5 + gauss() * 0.08;
        const sd = len * variance * a.v;
        out.push({
          x: a.x + (b.x - a.x) * t + gauss() * sd,
          y: a.y + (b.y - a.y) * t + gauss() * sd,
          v: (a.v + b.v) * 0.5 * (0.85 + rnd() * 0.3),
        });
      }
      pts = out;
    }
    return pts;
  };

  const basePolygon = (cx: number, cy: number, r: number, n: number): V[] => {
    const pts: V[] = [];
    const rot = rnd() * Math.PI * 2;
    const sx = 0.7 + rnd() * 0.6;
    for (let i = 0; i < n; i++) {
      const a = rot + (i / n) * Math.PI * 2;
      pts.push({ x: cx + Math.cos(a) * r * sx, y: cy + Math.sin(a) * r / sx, v: 0.4 + rnd() * 0.9 });
    }
    return pts;
  };

  return { rnd, gauss, deform, basePolygon };
}

export function toArray(pts: V[]): Float32Array {
  const a = new Float32Array(pts.length * 2);
  pts.forEach((p, i) => { a[i * 2] = p.x; a[i * 2 + 1] = p.y; });
  return a;
}
