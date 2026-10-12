import mixbox from 'mixbox';
import { Caps, PingPong, Program, Target, createTexture, detectCaps, fullscreenVAO, TexFormat } from './gl';
import {
  COPY_FS, DISPLAY_FS, FULLSCREEN_VS, PAPER_FS, POLY_FS, POLY_VS, SIM_DEPOSIT_FS, SIM_FLOW_FS, STAMP_FS, STAMP_VS,
} from './shaders';
import type { PigmentLatent } from './palette';

export type PaperType = 0 | 1 | 2;
export type ToolId = 0 | 1 | 2 | 3;

/** Stamp layout: x, y, r, angle, water, pigment, seed, unused */
export const STAMP_FLOATS = 8;

export interface SimParams {
  drySpeed: number;
  edge: number;
  granulation: number;
}

export interface Snapshot {
  t: Target;
  d: Target;
}

const PAPER_COLOR = [0.955, 0.935, 0.885]; // linear, warm white

export class Watercolor {
  readonly gl: WebGL2RenderingContext;
  readonly caps: Caps;
  /** simulation size */
  readonly w: number;
  readonly h: number;
  stepIndex = 0;
  params: SimParams = { drySpeed: 1, edge: 0.6, granulation: 1 };
  paperType: PaperType = 0;

  private t: PingPong; // W, P0, P1
  private d: PingPong; // D0, D1, Dry
  private brush: Target; // BW, BP0, BP1 (+stencil)
  private brushDirty = false;
  private paperSim!: Target;
  private paperDisp: Target | null = null;
  private dispW = 0;
  private dispH = 0;

  private vao: WebGLVertexArrayObject;
  private stampVao: WebGLVertexArrayObject;
  private stampBuf: WebGLBuffer;
  private stampCap = 0;
  private polyVao: WebGLVertexArrayObject;
  private polyBuf: WebGLBuffer;
  private lut: WebGLTexture;

  private pFlow: Program;
  private pDep: Program;
  private pDisp: Program;
  private pPaper: Program;
  private pStamp: Program;
  private pPoly: Program;
  private pCopy: Program;

  private snapFmt: TexFormat;
  private snapPool: Snapshot[] = [];

  constructor(
    readonly canvas: HTMLCanvasElement,
    /** paper size in CSS pixels */
    readonly cssW: number,
    readonly cssH: number,
    readonly simScale: number,
  ) {
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 wird von diesem Browser nicht unterstützt.');
    this.gl = gl;
    this.caps = detectCaps(gl);
    this.w = Math.max(16, Math.round(cssW * simScale));
    this.h = Math.max(16, Math.round(cssH * simScale));
    const { precise, half } = this.caps;
    this.snapFmt = half;

    this.t = new PingPong(gl, this.w, this.h, [precise, half, half]);
    this.d = new PingPong(gl, this.w, this.h, [half, half, half]);
    this.brush = new Target(gl, this.w, this.h, [half, half, half].map((f) => createTexture(gl, this.w, this.h, f)), true);

    this.vao = fullscreenVAO(gl);
    this.lut = mixbox.lutTexture(gl);

    this.pFlow = new Program(gl, FULLSCREEN_VS, SIM_FLOW_FS);
    this.pDep = new Program(gl, FULLSCREEN_VS, SIM_DEPOSIT_FS);
    this.pDisp = new Program(gl, FULLSCREEN_VS, DISPLAY_FS);
    this.pPaper = new Program(gl, FULLSCREEN_VS, PAPER_FS);
    this.pStamp = new Program(gl, STAMP_VS, STAMP_FS);
    this.pPoly = new Program(gl, POLY_VS, POLY_FS);
    this.pCopy = new Program(gl, FULLSCREEN_VS, COPY_FS);

    // instanced quad for stamps
    this.stampVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.stampVao);
    const quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.stampBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stampBuf);
    for (let i = 0; i < 2; i++) {
      gl.enableVertexAttribArray(1 + i);
      gl.vertexAttribPointer(1 + i, 4, gl.FLOAT, false, STAMP_FLOATS * 4, i * 16);
      gl.vertexAttribDivisor(1 + i, 1);
    }
    this.polyVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.polyVao);
    this.polyBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.polyBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.setPaper(0);
    this.clear();
    this.brush.clear([[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
  }

  /** Bytes one undo snapshot needs on the GPU. */
  get snapshotBytes(): number {
    return this.w * this.h * 8 * 6;
  }

  // ------------------------------------------------------------------ paper
  private makePaper(w: number, h: number, scale: number): Target {
    const gl = this.gl;
    const fmt: TexFormat = { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, linear: true };
    const target = new Target(gl, w, h, [createTexture(gl, w, h, fmt)]);
    target.bind();
    this.pPaper.use().i('uType', this.paperType).f('uScale', scale).f('uSeed', 137.0, 91.0);
    this.draw();
    return target;
  }

  setPaper(type: PaperType): void {
    this.paperType = type;
    this.paperSim?.dispose();
    this.paperSim = this.makePaper(this.w, this.h, 1 / this.simScale);
    if (this.paperDisp) {
      this.paperDisp.dispose();
      this.paperDisp = null;
    }
  }

  private ensureDisplayPaper(): void {
    const { width, height } = this.canvas;
    if (this.paperDisp && this.dispW === width && this.dispH === height) return;
    this.paperDisp?.dispose();
    this.dispW = width;
    this.dispH = height;
    this.paperDisp = this.makePaper(width, height, this.cssW / width);
  }

  // ------------------------------------------------------------------ state
  clear(): void {
    this.t.read.clear([[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    this.d.read.clear([[0, 0, 0, 0], [0, 0, 0, 0], [1, 1, 1, 0]]);
  }

  private draw(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Advance the simulation by one step. */
  step(): void {
    const p = this.params;
    const [W, P0, P1] = this.t.read.tex;
    const [D0, D1, Dry] = this.d.read.tex;
    const [BW, BP0, BP1] = this.brush.tex;
    const paper = this.paperSim.tex[0];
    const speed = p.drySpeed;

    this.t.write.bind();
    this.pFlow.use()
      .tex('uW', W).tex('uP0', P0).tex('uP1', P1).tex('uD0', D0).tex('uD1', D1)
      .tex('uBW', BW).tex('uBP0', BP0).tex('uBP1', BP1).tex('uPaper', paper)
      .f('uDiff', 0.2).f('uEdge', p.edge).f('uEvap', 0.00055 * speed).f('uDampEvap', 0.0028 * speed)
      .f('uAbsorb', 0.01).f('uWMax', 1.2).f('uSalt', 0.7).f('uCreep', 0.35).f('uCapillary', 0.01)
      .f('uDampThr', 0.12).f('uDepBase', 0.006).f('uDepMax', 0.1).f('uLift', 0.004).f('uGranSim', p.granulation);
    this.draw();

    this.d.write.bind();
    this.pDep.use()
      .tex('uW', W).tex('uP0', P0).tex('uP1', P1).tex('uD0', D0).tex('uD1', D1).tex('uDry', Dry)
      .tex('uBW', BW).tex('uBP0', BP0).tex('uPaper', paper).tex('mixbox_lut', this.lut)
      .f('uK', 1.9)
      .f('uDampThr', 0.12).f('uDepBase', 0.006).f('uDepMax', 0.1).f('uLift', 0.004).f('uGranSim', p.granulation);
    this.draw();

    this.t.swap();
    this.d.swap();
    if (this.brushDirty) {
      this.brush.clear([[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
      this.brushDirty = false;
    }
    this.stepIndex++;
  }

  /** Draw brush stamps (instanced) into the brush input; consumed by the next step. */
  stamps(data: Float32Array, count: number, tool: ToolId, color: PigmentLatent | null): void {
    if (count === 0) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stampBuf);
    const bytes = count * STAMP_FLOATS * 4;
    if (bytes > this.stampCap) {
      this.stampCap = Math.max(bytes, this.stampCap * 2, 4096);
      gl.bufferData(gl.ARRAY_BUFFER, this.stampCap, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * STAMP_FLOATS);
    this.brush.bind();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    const c = color ?? { c: [0, 0, 0], r: [0, 0, 0], gran: 0 };
    this.pStamp.use().tex('uPaper', this.paperSim.tex[0]).f('uSimSize', this.w, this.h).i('uTool', tool)
      .f('uC', c.c[0], c.c[1], c.c[2]).f('uR', c.r[0], c.r[1], c.r[2]).f('uGranP', c.gran);
    gl.bindVertexArray(this.stampVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.disable(gl.BLEND);
    this.brushDirty = true;
  }

  /** Fill an arbitrary (non-convex) polygon with water + pigment via stencil. */
  polygon(points: Float32Array, color: PigmentLatent, water: number, pigment: number, seed: number): void {
    const gl = this.gl;
    const n = points.length / 2;
    if (n < 3) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.polyBuf);
    gl.bufferData(gl.ARRAY_BUFFER, points, gl.STREAM_DRAW);
    this.brush.bind();
    gl.enable(gl.STENCIL_TEST);
    gl.clearStencil(0);
    gl.clear(gl.STENCIL_BUFFER_BIT);
    // pass 1: parity of the triangle fan -> stencil bit 0
    gl.colorMask(false, false, false, false);
    gl.stencilMask(1);
    gl.stencilFunc(gl.ALWAYS, 0, 1);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
    this.pPoly.use().f('uSimSize', this.w, this.h);
    gl.bindVertexArray(this.polyVao);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, n);
    // pass 2: fill where the bit is set
    gl.colorMask(true, true, true, true);
    gl.stencilFunc(gl.EQUAL, 1, 1);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.ZERO); // zero on write: overlapping fan triangles fill once
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    this.pPoly.f('uWater', water).f('uPig', pigment).f('uSeed', seed)
      .f('uC', color.c[0], color.c[1], color.c[2]).f('uR', color.r[0], color.r[1], color.r[2]).f('uGranP', color.gran);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, n);
    gl.disable(gl.BLEND);
    gl.disable(gl.STENCIL_TEST);
    this.brushDirty = true;
  }

  // ------------------------------------------------------------------ display
  private renderTo(width: number, height: number, paper: Target): void {
    const gl = this.gl;
    const [W, P0, P1] = this.t.read.tex;
    const [D0, D1, Dry] = this.d.read.tex;
    gl.viewport(0, 0, width, height);
    this.pDisp.use()
      .tex('uW', W).tex('uP0', P0).tex('uP1', P1).tex('uD0', D0).tex('uD1', D1).tex('uDry', Dry)
      .tex('uPaper', paper.tex[0]).tex('mixbox_lut', this.lut)
      .f('uRes', width, height).f('uK', 1.9).f('uGran', this.params.granulation * 0.5)
      .f('uPaperColor', PAPER_COLOR[0], PAPER_COLOR[1], PAPER_COLOR[2])
      .f('uRelief', (this.paperType === 1 ? 0.9 : 1.4) * (width / this.cssW));
    this.draw();
  }

  render(): void {
    this.ensureDisplayPaper();
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.renderTo(this.canvas.width, this.canvas.height, this.paperDisp!);
  }

  /** Render at `scale` × CSS size and return a PNG blob. */
  async exportPNG(scale: number): Promise<Blob> {
    const gl = this.gl;
    let s = scale;
    const maxSide = Math.min(this.caps.maxTex, 8192);
    s = Math.min(s, maxSide / this.cssW, maxSide / this.cssH);
    const w = Math.round(this.cssW * s);
    const h = Math.round(this.cssH * s);
    const paper = this.makePaper(w, h, this.cssW / w);
    const fmt: TexFormat = { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, linear: false };
    const out = new Target(gl, w, h, [createTexture(gl, w, h, fmt)]);
    out.bind();
    this.renderTo(w, h, paper);
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    out.dispose();
    paper.dispose();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    const row = w * 4;
    for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    ctx.putImageData(img, 0, 0);
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Export fehlgeschlagen'))), 'image/png'));
  }

  // ------------------------------------------------------------------ snapshots
  private copy(src: Target, dst: Target): void {
    dst.bind();
    this.pCopy.use().tex('uA', src.tex[0]).tex('uB', src.tex[1]).tex('uC', src.tex[2]);
    this.draw();
  }

  snapshot(): Snapshot {
    const gl = this.gl;
    let s = this.snapPool.pop();
    if (!s) {
      const mk = () => new Target(gl, this.w, this.h, [0, 1, 2].map(() => createTexture(gl, this.w, this.h, this.snapFmt)));
      s = { t: mk(), d: mk() };
    }
    this.copy(this.t.read, s.t);
    this.copy(this.d.read, s.d);
    return s;
  }

  restore(s: Snapshot): void {
    this.copy(s.t, this.t.read);
    this.copy(s.d, this.d.read);
  }

  release(s: Snapshot): void {
    this.snapPool.push(s);
  }
}
