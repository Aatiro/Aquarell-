import mixbox from 'mixbox';

/** A pigment as the shaders see it: mixbox latent (3 coefficients + residual) and granulation. */
export interface PigmentLatent {
  c: [number, number, number];
  r: [number, number, number];
  gran: number;
}

export interface Pigment extends PigmentLatent {
  name: string;
  rgb: [number, number, number];
}

export function latentFromRgb(rgb: [number, number, number], gran: number): PigmentLatent {
  const l = mixbox.rgbToLatent(rgb[0], rgb[1], rgb[2]) as number[];
  return { c: [l[0], l[1], l[2]], r: [l[4], l[5], l[6]], gran };
}

export function latentToRgb(l: PigmentLatent): [number, number, number] {
  const c3 = 1 - l.c[0] - l.c[1] - l.c[2];
  const rgb = mixbox.latentToRgb([l.c[0], l.c[1], l.c[2], c3, l.r[0], l.r[1], l.r[2]]) as number[];
  return [rgb[0], rgb[1], rgb[2]];
}

function pigment(name: string, hex: string, gran: number): Pigment {
  const n = parseInt(hex.slice(1), 16);
  const rgb: [number, number, number] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return { name, rgb, ...latentFromRgb(rgb, gran) };
}

// Colours of a medium wash of twelve classic watercolour pigments (they deepen with more
// pigment via Beer–Lambert); gran = tendency to granulate.
export const PALETTE: Pigment[] = [
  pigment('Kadmiumgelb', '#f8c80c', 0.05),
  pigment('Gelber Ocker', '#d49a3a', 0.55),
  pigment('Kadmiumorange', '#f07a1c', 0.1),
  pigment('Kadmiumrot', '#d8302c', 0.15),
  pigment('Krapplack', '#b01f4e', 0.05),
  pigment('Gebrannte Siena', '#a8532a', 0.7),
  pigment('Gebrannte Umbra', '#6b4a33', 0.75),
  pigment('Ultramarin', '#3a4cb8', 1.0),
  pigment('Coelinblau', '#3b8fc6', 0.8),
  pigment('Phthaloblau', '#1d4aa0', 0.0),
  pigment('Saftgrün', '#5b8a28', 0.25),
  pigment("Payne's Grau", '#4a5563', 0.35),
];

export function cssColor(rgb: [number, number, number]): string {
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}
