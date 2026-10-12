declare module 'mixbox' {
  const mixbox: {
    LATENT_SIZE: number;
    lerp(a: unknown, b: unknown, t: number): number[];
    rgbToLatent(r: number | string | number[], g?: number, b?: number): number[];
    latentToRgb(latent: number[]): number[];
    glsl(): string;
    lutTexture(gl: WebGLRenderingContext | WebGL2RenderingContext): WebGLTexture;
  };
  export default mixbox;
}
