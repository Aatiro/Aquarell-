// Small WebGL2 helpers: programs, float textures, multi-target framebuffers.

export interface TexFormat {
  internal: number;
  format: number;
  type: number;
  linear: boolean;
}

export interface Caps {
  /** Format for precision critical state (water). RGBA32F if renderable + filterable. */
  precise: TexFormat;
  /** Format for pigment / dry layer state. */
  half: TexFormat;
  maxTex: number;
}

export function detectCaps(gl: WebGL2RenderingContext): Caps {
  const cbf = gl.getExtension('EXT_color_buffer_float');
  const cbhf = gl.getExtension('EXT_color_buffer_half_float');
  const f32lin = gl.getExtension('OES_texture_float_linear');
  if (!cbf && !cbhf) throw new Error('Dieses Gerät kann nicht in Float-Texturen rendern (EXT_color_buffer_float fehlt).');
  const half: TexFormat = { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, linear: true };
  const precise: TexFormat = cbf
    ? { internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, linear: !!f32lin }
    : half;
  return { precise, half, maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number };
}

export function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    const numbered = src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
    console.error(numbered);
    throw new Error('Shader-Fehler: ' + log);
  }
  return sh;
}

export class Program {
  prog: WebGLProgram;
  private uniforms = new Map<string, WebGLUniformLocation | null>();
  private samplers: string[] = [];

  constructor(private gl: WebGL2RenderingContext, vs: string, fs: string) {
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link-Fehler: ' + gl.getProgramInfoLog(p));
    this.prog = p;
    // collect samplers in declaration order so units can be bound by name
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i)!;
      if (info.type === gl.SAMPLER_2D) this.samplers.push(info.name);
    }
    gl.useProgram(p);
    this.samplers.forEach((name, unit) => gl.uniform1i(this.loc(name), unit));
  }

  use(): this {
    this.gl.useProgram(this.prog);
    return this;
  }

  loc(name: string): WebGLUniformLocation | null {
    let l = this.uniforms.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.prog, name);
      this.uniforms.set(name, l);
    }
    return l;
  }

  tex(name: string, t: WebGLTexture): this {
    const unit = this.samplers.indexOf(name);
    if (unit < 0) return this;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    return this;
  }

  f(name: string, ...v: number[]): this {
    const gl = this.gl;
    const l = this.loc(name);
    if (l === null) return this;
    switch (v.length) {
      case 1: gl.uniform1f(l, v[0]); break;
      case 2: gl.uniform2f(l, v[0], v[1]); break;
      case 3: gl.uniform3f(l, v[0], v[1], v[2]); break;
      case 4: gl.uniform4f(l, v[0], v[1], v[2], v[3]); break;
    }
    return this;
  }

  i(name: string, v: number): this {
    const l = this.loc(name);
    if (l !== null) this.gl.uniform1i(l, v);
    return this;
  }
}

export function createTexture(gl: WebGL2RenderingContext, w: number, h: number, fmt: TexFormat): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texStorage2D(gl.TEXTURE_2D, 1, fmt.internal, w, h);
  const filter = fmt.linear ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

/** A framebuffer with several color attachments (MRT). */
export class Target {
  fbo: WebGLFramebuffer;
  constructor(
    private gl: WebGL2RenderingContext,
    public w: number,
    public h: number,
    public tex: WebGLTexture[],
    stencil = false,
  ) {
    this.fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    tex.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
    if (stencil) {
      const rb = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, rb);
    }
    gl.drawBuffers(tex.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Framebuffer unvollständig: 0x' + status.toString(16));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  bind(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.w, this.h);
  }

  clear(values: number[][]): void {
    this.bind();
    values.forEach((v, i) => this.gl.clearBufferfv(this.gl.COLOR, i, v));
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteFramebuffer(this.fbo);
    this.tex.forEach((t) => gl.deleteTexture(t));
  }
}

export class PingPong {
  read: Target;
  write: Target;
  constructor(gl: WebGL2RenderingContext, w: number, h: number, fmts: TexFormat[]) {
    const mk = () => new Target(gl, w, h, fmts.map((f) => createTexture(gl, w, h, f)));
    this.read = mk();
    this.write = mk();
  }
  swap(): void {
    const t = this.read;
    this.read = this.write;
    this.write = t;
  }
  dispose(): void {
    this.read.dispose();
    this.write.dispose();
  }
}

/** Fullscreen triangle; every pass uses this VAO. */
export function fullscreenVAO(gl: WebGL2RenderingContext): WebGLVertexArrayObject {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
}
