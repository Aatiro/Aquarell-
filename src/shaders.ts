import mixbox from 'mixbox';

// All simulation state lives in textures (RGBA):
//   W   : r = surface water, g = paper dampness, b = dissolved salt, a = unused
//   P0/P1 : pigment suspended in water   (P0 = Σ m·c0..c2, Σ m ; P1 = Σ m·residual rgb, Σ m·granulation)
//   D0/D1 : pigment settled on the paper (same layout, still part of the wet layer)
//   Dry : rgb = transmittance of all dried glaze layers (linear), a = granulation of the dried stack
// Pigments are stored as mixbox latent vectors weighted by their mass, so summing them is
// Kubelka–Munk mixing and the colour of a pixel is mixbox_latent_to_rgb(Σ/m).

const HEADER = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

const NOISE = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x),
             mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p, int oct) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    s += a * vnoise(p);
    n += a;
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + 17.0;
    a *= 0.5;
  }
  return s / n;
}
float worley(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float d = 8.0;
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = hash22(i + g);
    vec2 r = g + o - f;
    d = min(d, dot(r, r));
  }
  return sqrt(d);
}
`;

const COLOR = /* glsl */ `
uniform sampler2D mixbox_lut;
${mixbox.glsl()}
uniform float uK;
vec3 srgb2lin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 lin2srgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

// Transmittance of one wet layer (mass-weighted latent sums L0/L1).
vec3 layerT(vec4 L0, vec4 L1) {
  float m = L0.a;
  if (m < 1e-5) return vec3(1.0);
  mixbox_latent lat = mixbox_latent(L0.rgb / m, L1.rgb / m, vec3(0.0));
  // Beer–Lambert: optical density grows with pigment mass; one normal wash ≈ the swatch colour
  vec3 C = max(srgb2lin(mixbox_latent_to_rgb(lat)), vec3(0.015));
  vec3 T = pow(C, vec3(m * uK));
  return T;
}
`;

const FULLSCREEN_VS = /* glsl */ `${HEADER}
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

// ---------------------------------------------------------------------------
// Procedural paper. r = height, g = fibre conductance, b = edge/creep threshold noise.
// Coordinates are in CSS pixels so every resolution (sim, display, export) matches.
export const PAPER_FS = /* glsl */ `${HEADER}
${NOISE}
uniform int uType;      // 0 = rau, 1 = glatt, 2 = Bütten
uniform float uScale;   // css px per output px
uniform vec2 uSeed;
out vec4 o;

float fibres(vec2 p) {
  float s = 0.0;
  for (int i = 0; i < 4; i++) {
    float a = float(i) * 2.399 + 0.4;
    mat2 R = mat2(cos(a), sin(a), -sin(a), cos(a));
    vec2 q = R * p;
    s += pow(vnoise(q * vec2(0.07, 0.9) + float(i) * 31.0), 3.0);
  }
  return s * 0.5;
}

void main() {
  vec2 p = gl_FragCoord.xy * uScale + uSeed;
  float h, g;
  float low = fbm(p / 26.0, 4);
  if (uType == 0) {
    // rough / torchon: big rounded tooth + fine grain
    float c1 = 1.0 - worley(p / 13.0);
    float c2 = 1.0 - worley(p / 5.0 + 11.7);
    float fine = fbm(p / 1.4, 3);
    h = 0.55 * c1 * c1 + 0.25 * c2 + 0.25 * fine + 0.25 * fbm(p / 40.0, 3);
    h = (h - 0.42) * 1.9 + 0.5;
    g = 0.35 + 0.65 * fbm(p / 3.0 + 5.0, 3);
  } else if (uType == 1) {
    // hot pressed / smooth
    h = 0.5 + 0.35 * (fbm(p / 1.3, 3) - 0.5) + 0.35 * (fbm(p / 9.0, 3) - 0.5);
    g = 0.55 + 0.25 * fbm(p / 4.0, 2);
  } else {
    // Bütten: long fibres, soft felt cells and faint laid lines
    float f = fibres(p / 1.6);
    float c1 = 1.0 - worley(p / 9.0);
    float laid = 0.5 + 0.5 * sin(p.y * 6.2831 / 4.2 + 0.6 * vnoise(p / 30.0));
    h = 0.45 * f + 0.35 * c1 * c1 + 0.12 * laid + 0.25 * fbm(p / 2.0, 3);
    h = (h - 0.45) * 1.5 + 0.5;
    g = clamp(0.15 + 1.2 * f, 0.0, 1.0);
  }
  o = vec4(clamp(h, 0.0, 1.0), clamp(g, 0.0, 1.0), low, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Shared between the two simulation passes so both compute identical exchange terms.
const SIM_COMMON = /* glsl */ `
uniform float uDampThr;
uniform float uDepBase, uDepMax, uLift, uGranSim;

bool isWet(vec4 W) { return W.r > 1e-4 || W.g > uDampThr; }

// pigment exchange between water and paper (fractions per step)
void rates(float w, float h, float gran, out float dep, out float lift) {
  float wet = clamp(w / 0.25, 0.0, 1.0);
  dep = mix(uDepMax, uDepBase, wet);
  // granulating pigments settle in the valleys of the paper
  dep *= clamp(1.0 + gran * uGranSim * (0.5 - h) * 2.0, 0.4, 2.2);
  dep = min(dep, 0.2);
  lift = w > 1e-4 ? uLift * wet * clamp(0.5 + h, 0.0, 1.5) : 0.0;
}

bool bakes(vec4 W, vec4 P0, vec4 BW, vec4 BP0) {
  return W.r <= 1e-4 && W.g < 0.02 && P0.a < 0.003 && BW == vec4(0.0) && BP0.a == 0.0;
}
`;

// Pass 1: water flow, pigment transport, evaporation, brush input -> W, P0, P1
export const SIM_FLOW_FS = /* glsl */ `${HEADER}
uniform sampler2D uW, uP0, uP1, uD0, uD1, uBW, uBP0, uBP1, uPaper;
uniform float uDiff, uEdge, uEvap, uDampEvap, uAbsorb, uWMax, uSalt, uCreep, uCapillary;
${SIM_COMMON}
layout(location = 0) out vec4 oW;
layout(location = 1) out vec4 oP0;
layout(location = 2) out vec4 oP1;

// water flux a -> b; antisymmetric because the face sample is shared
float faceFlux(vec4 Wa, vec4 Wb, bool wa, bool wb, vec4 face) {
  float k = min(uDiff * (0.35 + 1.3 * face.g), 0.24);
  if (wa && wb) return k * (Wa.r - Wb.r);
  // water only creeps onto dry paper when the puddle is deep enough
  float thr = 0.3 + 0.6 * face.b;
  if (wa) return uCreep * k * max(Wa.r - thr, 0.0);
  if (wb) return -uCreep * k * max(Wb.r - thr, 0.0);
  return 0.0;
}

// fraction of the pigment of cell a that moves to b
float pigFrac(float f, vec4 Wa, vec4 Wb, bool open) {
  float fr = f > 0.0 ? f * (1.0 + uEdge) / max(Wa.r, 1e-4) : 0.0;
  if (open && Wa.r > 1e-4) fr += uSalt * max(Wa.b - Wb.b, 0.0);
  return min(fr, 0.2);
}

const ivec2 OFF[4] = ivec2[4](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1));

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(uW, 0);
  vec2 texel = 1.0 / vec2(sz);
  vec2 uv = (vec2(c) + 0.5) * texel;

  vec4 W = texelFetch(uW, c, 0);
  vec4 P0 = texelFetch(uP0, c, 0);
  vec4 P1 = texelFetch(uP1, c, 0);
  vec4 D0 = texelFetch(uD0, c, 0);
  vec4 D1 = texelFetch(uD1, c, 0);
  vec4 BW = texelFetch(uBW, c, 0);
  vec4 BP0 = texelFetch(uBP0, c, 0);
  vec4 BP1 = texelFetch(uBP1, c, 0);
  float h = texture(uPaper, uv).r;

  bool wetC = isWet(W);
  float dW = 0.0, outF = 0.0, dDamp = 0.0, dSalt = 0.0;
  vec4 in0 = vec4(0.0), in1 = vec4(0.0);
  float dryN = 0.0;

  for (int i = 0; i < 4; i++) {
    ivec2 n = c + OFF[i];
    if (n.x < 0 || n.y < 0 || n.x >= sz.x || n.y >= sz.y) continue;
    vec4 Wn = texelFetch(uW, n, 0);
    vec4 face = texture(uPaper, uv + vec2(OFF[i]) * 0.5 * texel);
    bool wetN = isWet(Wn);
    bool open = wetC && wetN;
    if (!wetN) dryN += 1.0;
    float f = faceFlux(W, Wn, wetC, wetN, face);
    dW -= f;
    outF += pigFrac(f, W, Wn, open);
    float fin = pigFrac(-f, Wn, W, open);
    if (fin > 0.0) {
      in0 += fin * texelFetch(uP0, n, 0);
      in1 += fin * texelFetch(uP1, n, 0);
    }
    dDamp += uCapillary * (0.3 + face.g) * (Wn.g - W.g);
    if (open) dSalt += 0.04 * (Wn.b - W.b);
  }

  vec4 nP0, nP1;
  if (bakes(W, P0, BW, BP0)) {
    // the remaining suspended pigment is baked into the dry layer by the other pass
    nP0 = in0;
    nP1 = in1;
  } else {
    float gran = P1.a / max(P0.a, 1e-5);
    float dep, lift;
    rates(W.r, h, gran, dep, lift);
    float keep = 1.0 - min(outF, 0.8) - dep;
    nP0 = P0 * keep + in0 + lift * D0;
    nP1 = P1 * keep + in1 + lift * D1;
  }

  float w = W.r + dW;
  float damp = W.g + dDamp;
  float a = min(w, uAbsorb * max(1.0 - damp, 0.0));
  w -= a;
  damp += a * 3.0;
  // edges and paper peaks dry first -> water flows outwards, carrying pigment (edge darkening)
  float evap = uEvap * (1.0 + 1.2 * dryN) * (0.7 + 0.6 * h) + W.b * 0.003;
  w = max(w - evap, 0.0);
  damp = clamp(damp - uDampEvap * (w > 1e-4 ? 0.15 : 1.0), 0.0, 1.0);
  float salt = max(W.b + dSalt, 0.0);
  if (!wetC) salt *= 0.99;

  // brush / generator input
  w = min(w + BW.r, uWMax);
  damp = min(1.0, damp + BW.r * 3.0);
  nP0 += BP0;
  nP1 += BP1;
  float s = clamp(BW.g, 0.0, 1.0);
  w *= 1.0 - s;
  damp *= 1.0 - 0.6 * s;
  nP0 *= 1.0 - s;
  nP1 *= 1.0 - s;
  salt = min(salt + BW.b, 1.5);

  oW = vec4(w, damp, salt, 0.0);
  oP0 = max(nP0, 0.0);
  oP1 = max(nP1, 0.0);
}
`;

// Pass 2: pigment settling / lifting and baking of dry layers -> D0, D1, Dry
export const SIM_DEPOSIT_FS = /* glsl */ `${HEADER}
uniform sampler2D uW, uP0, uP1, uD0, uD1, uDry, uBW, uBP0, uPaper;
${COLOR}
${SIM_COMMON}
layout(location = 0) out vec4 oD0;
layout(location = 1) out vec4 oD1;
layout(location = 2) out vec4 oDry;

float avg3(vec3 v) { return dot(v, vec3(1.0 / 3.0)); }

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec2 uv = (vec2(c) + 0.5) / vec2(textureSize(uW, 0));
  vec4 W = texelFetch(uW, c, 0);
  vec4 P0 = texelFetch(uP0, c, 0);
  vec4 P1 = texelFetch(uP1, c, 0);
  vec4 D0 = texelFetch(uD0, c, 0);
  vec4 D1 = texelFetch(uD1, c, 0);
  vec4 Dry = texelFetch(uDry, c, 0);
  vec4 BW = texelFetch(uBW, c, 0);
  vec4 BP0 = texelFetch(uBP0, c, 0);
  float h = texture(uPaper, uv).r;

  vec4 nD0, nD1;
  if (bakes(W, P0, BW, BP0)) {
    // dry: the wet layer becomes a transparent glaze multiplied onto what lies below
    vec4 L0 = D0 + P0, L1 = D1 + P1;
    if (L0.a > 1e-6) {
      vec3 T = layerT(L0, L1);
      float dNew = -log(max(avg3(T), 1e-3));
      float dOld = -log(max(avg3(Dry.rgb), 1e-3));
      float g = L1.a / L0.a;
      Dry.a = (Dry.a * dOld + g * dNew) / max(dOld + dNew, 1e-5);
      Dry.rgb *= T;
    }
    nD0 = vec4(0.0);
    nD1 = vec4(0.0);
  } else {
    float gran = P1.a / max(P0.a, 1e-5);
    float dep, lift;
    rates(W.r, h, gran, dep, lift);
    nD0 = D0 * (1.0 - lift) + P0 * dep;
    nD1 = D1 * (1.0 - lift) + P1 * dep;
  }

  // sponge lifts settled paint and a little of the dried paint
  float s = clamp(BW.g, 0.0, 1.0);
  nD0 *= 1.0 - 0.7 * s;
  nD1 *= 1.0 - 0.7 * s;
  Dry.rgb = mix(Dry.rgb, vec3(1.0), 0.06 * s * (0.5 + h));

  oD0 = max(nD0, 0.0);
  oD1 = max(nD1, 0.0);
  oDry = Dry;
}
`;

// ---------------------------------------------------------------------------
export const DISPLAY_FS = /* glsl */ `${HEADER}
uniform sampler2D uW, uP0, uP1, uD0, uD1, uDry, uPaper;
${COLOR}
uniform vec2 uRes;
uniform float uGran;
uniform vec3 uPaperColor;
uniform float uRelief;
out vec4 o;

void main() {
  ivec2 pc = ivec2(gl_FragCoord.xy);
  ivec2 ps = textureSize(uPaper, 0) - 1;
  vec2 uv = gl_FragCoord.xy / uRes;
  float h = texelFetch(uPaper, pc, 0).r;
  float hx = texelFetch(uPaper, min(pc + ivec2(1, 0), ps), 0).r;
  float hy = texelFetch(uPaper, min(pc + ivec2(0, 1), ps), 0).r;
  vec3 n = normalize(vec3((h - hx) * uRelief, (h - hy) * uRelief, 1.0));
  vec3 L = normalize(vec3(-0.5, 0.6, 0.65));
  float shade = 1.0 + (dot(n, L) - L.z) * 0.6;

  vec4 W = texture(uW, uv);
  vec4 D0 = texture(uD0, uv), D1 = texture(uD1, uv);
  vec4 P0 = texture(uP0, uv), P1 = texture(uP1, uv);
  vec4 Dry = texture(uDry, uv);

  float gExp = uGran * (0.5 - h) * 2.0;
  vec3 dry = pow(max(Dry.rgb, 1e-4), vec3(1.0 + Dry.a * gExp));
  vec4 L0 = D0 + P0, L1 = D1 + P1;
  float g = L1.a / max(L0.a, 1e-5);
  vec3 T = pow(layerT(L0, L1), vec3(1.0 + g * gExp));

  vec3 col = uPaperColor * shade * dry * T;
  float wet = smoothstep(0.0, 0.12, W.r);
  col *= 1.0 - 0.08 * wet - 0.04 * clamp(W.g, 0.0, 1.0);
  vec3 r = reflect(-L, n);
  col += wet * 0.05 * pow(clamp(r.z, 0.0, 1.0), 24.0);
  o = vec4(lin2srgb(clamp(col, 0.0, 1.0)), 1.0);
}
`;

// ---------------------------------------------------------------------------
// Brush stamps, instanced; additive blending into the brush input targets.
export const STAMP_VS = /* glsl */ `${HEADER}
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec4 aI0; // x, y, radius, angle   (sim px)
layout(location = 2) in vec4 aI1; // water, pigment, seed, kind
uniform vec2 uSimSize;
out vec2 vLocal;
out vec2 vWorld;
flat out vec4 vI0;
flat out vec4 vI1;
void main() {
  float r = aI0.z * 1.25 + 1.0;
  vec2 world = aI0.xy + aPos * r;
  vLocal = aPos * r / aI0.z;
  vWorld = world;
  vI0 = aI0;
  vI1 = aI1;
  gl_Position = vec4(world / uSimSize * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const STAMP_FS = /* glsl */ `${HEADER}
${NOISE}
uniform int uTool;  // 0 brush, 1 water, 2 sponge, 3 salt
uniform vec3 uC;
uniform vec3 uR;
uniform float uGranP;
uniform sampler2D uPaper;
uniform vec2 uSimSize;
in vec2 vLocal;
in vec2 vWorld;
flat in vec4 vI0;
flat in vec4 vI1;
layout(location = 0) out vec4 oBW;
layout(location = 1) out vec4 oBP0;
layout(location = 2) out vec4 oBP1;

void main() {
  float r = vI0.z;
  float seed = vI1.z;
  float d = length(vLocal);
  oBW = vec4(0.0); oBP0 = vec4(0.0); oBP1 = vec4(0.0);

  if (uTool == 3) {
    float g = 1.0 - smoothstep(0.2, 1.0, d);
    if (g <= 0.0) discard;
    oBW = vec4(0.0, 0.0, g * vI1.y, 0.0);
    return;
  }

  float n = fbm(vWorld / max(r * 0.45, 1.5) + seed * 17.3, 3);
  float edge = d + (n - 0.5) * 0.4;
  float fall = 1.0 - smoothstep(0.5, 1.0, edge);
  if (fall <= 0.0) discard;
  float water = vI1.x, pig = vI1.y;

  if (uTool == 0) {
    float h = texture(uPaper, vWorld / uSimSize).r;
    // dry brush: with little water only the peaks of the paper catch pigment
    float dryness = 1.0 - clamp(water / 0.3, 0.0, 1.0);
    float thr = mix(-0.3, 0.62, dryness);
    float mask = smoothstep(thr - 0.12, thr + 0.12, h);
    vec2 dir = vec2(cos(vI0.w), sin(vI0.w));
    float across = dot(vLocal, vec2(-dir.y, dir.x));
    float streak = vnoise(vec2(across * 6.0 + seed * 3.1, seed * 7.0));
    mask *= mix(0.85 + 0.3 * streak, 0.3 + 1.0 * streak, dryness);
    float m = pig * fall * mask;
    oBW = vec4(water * fall, 0.0, 0.0, 0.0);
    oBP0 = vec4(uC * m, m);
    oBP1 = vec4(uR * m, uGranP * m);
  } else if (uTool == 1) {
    oBW = vec4(water * fall, 0.0, 0.0, 0.0);
  } else {
    oBW = vec4(0.0, pig * fall, 0.0, 0.0);
  }
}
`;

// Polygon fill for the generator (drawn through a stencil mask).
export const POLY_VS = /* glsl */ `${HEADER}
layout(location = 0) in vec2 aPos;
uniform vec2 uSimSize;
void main() { gl_Position = vec4(aPos / uSimSize * 2.0 - 1.0, 0.0, 1.0); }
`;

export const POLY_FS = /* glsl */ `${HEADER}
${NOISE}
uniform float uWater, uPig, uGranP, uSeed;
uniform vec3 uC, uR;
layout(location = 0) out vec4 oBW;
layout(location = 1) out vec4 oBP0;
layout(location = 2) out vec4 oBP1;
void main() {
  vec2 p = gl_FragCoord.xy;
  float n = fbm(p / 35.0 + uSeed, 4);
  float m = uPig * clamp(0.2 + 1.6 * n, 0.0, 2.0);
  oBW = vec4(uWater, 0.0, 0.0, 0.0);
  oBP0 = vec4(uC * m, m);
  oBP1 = vec4(uR * m, uGranP * m);
}
`;

export const COPY_FS = /* glsl */ `${HEADER}
uniform sampler2D uA, uB, uC;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
layout(location = 2) out vec4 oC;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  oA = texelFetch(uA, c, 0);
  oB = texelFetch(uB, c, 0);
  oC = texelFetch(uC, c, 0);
}
`;

export { FULLSCREEN_VS };
