import { mulberry32 } from './brush';
import { PALETTE, PigmentLatent } from './palette';
import { shaper, toArray } from './shapes';

export type GenItem =
  | { offset: number; kind: 'poly'; pts: Float32Array; color: PigmentLatent; water: number; pigment: number; seed: number }
  | { offset: number; kind: 'speed'; drySpeed: number };

/**
 * Abstract watercolour after the "deformed polygon" technique: a base polygon is recursively
 * deformed, then dozens of further-deformed copies are laid down as thin transparent washes.
 * Batches dry in between so later batches act as glazes over earlier ones.
 */
export function generate(seed: number, w: number, h: number): GenItem[] {
  const rnd = mulberry32(seed);
  const { deform, basePolygon } = shaper(rnd);

  // colour scheme: 3-4 pigments, mostly avoiding the near-black ones as main colours
  const pool = PALETTE.map((_, i) => i).filter((i) => i !== 6 && i !== 9 && i !== 11);
  const colors: PigmentLatent[] = [];
  const count = 3 + Math.floor(rnd() * 2);
  while (colors.length < count) {
    const i = pool.splice(Math.floor(rnd() * pool.length), 1)[0];
    colors.push(PALETTE[i]);
  }
  if (rnd() < 0.5) colors.push(PALETTE[[6, 9, 11][Math.floor(rnd() * 3)]]);

  const items: GenItem[] = [];
  const m = Math.min(w, h);
  let offset = 0;
  items.push({ offset: 0, kind: 'speed', drySpeed: 3 });

  const shape = (color: PigmentLatent, cx: number, cy: number, r: number, layers: number, water: number, pig: number) => {
    const base = deform(basePolygon(cx, cy, r, 10), 3, 0.45);
    for (let l = 0; l < layers; l++) {
      items.push({
        offset: offset + l * 3, kind: 'poly', pts: toArray(deform(base, 3, 0.28)), color,
        water, pigment: pig, seed: rnd() * 100,
      });
    }
    offset += layers * 3 + 20;
  };

  // pale background wash, wet-in-wet
  if (rnd() < 0.7) {
    shape(colors[0], w * (0.4 + rnd() * 0.2), h * (0.4 + rnd() * 0.2), m * 0.5, 18, 0.05, 0.0025);
    shape(colors[1 + Math.floor(rnd() * (colors.length - 1))], w * rnd(), h * rnd(), m * 0.3, 14, 0.04, 0.003);
    offset += 800;
  }

  const batches = 2 + Math.floor(rnd() * 2);
  for (let b = 0; b < batches; b++) {
    const shapes = 2 + Math.floor(rnd() * 2);
    for (let s = 0; s < shapes; s++) {
      const color = colors[Math.floor(rnd() * colors.length)];
      const r = m * (0.08 + rnd() * 0.14) * (b === batches - 1 ? 0.7 : 1);
      shape(color, w * (0.2 + rnd() * 0.6), h * (0.2 + rnd() * 0.6), r, 26 + Math.floor(rnd() * 14),
        0.022 + rnd() * 0.012, (0.005 + rnd() * 0.006) * (b + 1 === batches ? 1.4 : 1));
    }
    offset += 850;
  }
  items.push({ offset, kind: 'speed', drySpeed: -1 });
  return items;
}
