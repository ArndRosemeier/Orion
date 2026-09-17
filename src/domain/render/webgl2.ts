/**
 * The WebGL2 backend: the L0 engine on the GPU.
 *
 * The fragment shader iterates exactly the recurrence `escapeDirectFloat` does,
 * in `f32` instead of `f64`. That is the point: it makes the differential test
 * isolate *precision*, not algorithm. Any disagreement between the two is a
 * rounding difference, not a different fractal.
 *
 * `f32` carries 24 fraction bits, so this backend is only offered where the view
 * is representable — roughly 2^-20 with any margin. Deeper views are refused by
 * `capability()` with a reason, and the ladder sends them elsewhere.
 *
 * The shader has two outputs, selected by a uniform:
 *  - **colour**, for the app;
 *  - **escape count**, written into an `RGBA32F` target, so the headless
 *    differential test can compare numbers against the CPU oracle rather than
 *    comparing colours and hoping.
 */

import { fromFloat, mul, toFloat } from "../numeric/bigfixed";
import { fromBigFixed } from "../numeric/floatexp";
import { computeConvergedReferenceOrbit } from "../engines/reference";
import { pixelSizeOf, pixelToComplex, scaleExponentOf } from "../view/view";
import { splitDouble } from "./doubleSingle";
import { REFUSED_COUNT, repairFlaggedPixels } from "./repair";
import {
  type Capability,
  type FractalBackend,
  type TileRequest,
  type TileResult,
  assertTileFitsView,
  tileOutputSize,
} from "./backend";

/**
 * Deepest pixel-spacing exponent this backend will accept.
 *
 * `f32` has 24 significant bits; a view at 2^-20 relative to a centre of
 * magnitude ~1 leaves 4 bits of headroom, which is the margin this backend
 * keeps. The ladder sends deeper views to the CPU perturbation path.
 */
export const WEBGL2_F32_PIXEL_EXPONENT_LIMIT = -20;

/**
 * How deep the emulated-double kernel reaches.
 *
 * The same figure as the WebGPU kernel, because the precision is the same ~48
 * bits; the only difference is how the exact product is formed. Below this the
 * offset needs the perturbation path, which is a preview engine.
 */
export const WEBGL2_DS_PIXEL_EXPONENT_LIMIT = -40;

const VERTEX_SHADER = `#version 300 es
precision highp float;
in vec2 aPosition;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

/**
 * Shared iteration loop. `uOrigin` is the complex coordinate of the tile's
 * top-left *pixel centre* and `uStep` the per-pixel complex step, both computed
 * on the CPU at full precision and handed over as `f32`.
 */
const FRAGMENT_HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform vec2 uOrigin;
uniform vec2 uStep;
uniform int uMaxIterations;
uniform int uOutputMode;      // 0 = colour, 1 = escape count
uniform sampler2D uPalette;
uniform float uCyclesPerUnit;

out vec4 fragColor;
`;

/**
 * The output stage, shared by every fragment kernel so a colour and a count mean
 * the same thing whichever engine produced them.
 */
const FRAGMENT_OUTPUT = `
void writeResult(int escapeIteration, float magnitudeSquared) {
  if (uOutputMode == 1) {
    fragColor = vec4(float(escapeIteration), 0.0, 0.0, 1.0);
    return;
  }
  if (escapeIteration == 0) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float smoothCount = float(escapeIteration) + 1.0 - log2(0.5 * log2(magnitudeSquared));
  float phase = smoothCount * uCyclesPerUnit;
  float wrapped = phase - floor(phase);
  vec3 rgb = texture(uPalette, vec2(wrapped, 0.5)).rgb;
  fragColor = vec4(rgb, 1.0);
}
`;

/**
 * The plain `f32` kernel: preview quality, and the reach limit is its own.
 * `uOrigin` is the complex coordinate of the tile's top-left *pixel centre* and
 * `uStep` the per-pixel complex step, both computed on the CPU at full precision
 * and handed over as `f32`.
 */
const L0_MAIN = `
void main() {
  vec2 c = uOrigin + gl_FragCoord.xy * uStep;
  vec2 z = vec2(0.0);
  float magnitudeSquared = 0.0;
  int escapeIteration = 0;

  for (int i = 1; i <= uMaxIterations; i++) {
    z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    magnitudeSquared = dot(z, z);
    if (magnitudeSquared > 4.0) {
      escapeIteration = i;
      break;
    }
  }

  writeResult(escapeIteration, magnitudeSquared);
}
`;

/**
 * Emulated double precision, as an unevaluated `(hi, lo)` pair of `f32`s.
 *
 * WebGL2 has no f64 and — unlike WebGPU's WGSL — no fma, so the exact product is
 * built by Veltkamp splitting instead: each operand is split into 12-bit halves
 * whose products are exact in f32, and the error term falls out of their
 * difference. That is Dekker's algorithm, which is what an fma-based twoProd
 * computes in one instruction.
 *
 * This is what lets WebGL2 render `exact` at a 2^-24 view where a plain `f32`
 * offset collapses to a single value.
 */
const DS_HELPERS = `
// Exact sum: s + err == a + b, with s the rounded result.
vec2 twoSum(float a, float b) {
  float s = a + b;
  float bb = s - a;
  return vec2(s, (a - (s - bb)) + (b - bb));
}

// Exact sum when |a| >= |b|; one fewer operation than twoSum.
vec2 quickTwoSum(float a, float b) {
  float s = a + b;
  return vec2(s, b - (s - a));
}

// Veltkamp split: hi carries the top 12 bits of the mantissa, lo the rest.
float veltkampSplit(float a) {
  float t = a * 4097.0;
  return t - (t - a);
}

// Exact product: the fma-free equivalent of the WGSL twoProd.
vec2 twoProd(float a, float b) {
  float p = a * b;
  float aHi = veltkampSplit(a);
  float aLo = a - aHi;
  float bHi = veltkampSplit(b);
  float bLo = b - bHi;
  float err = ((aHi * bHi - p) + aHi * bLo + aLo * bHi) + aLo * bLo;
  return vec2(p, err);
}

vec2 dsAdd(vec2 a, vec2 b) {
  vec2 s = twoSum(a.x, b.x);
  vec2 t = twoSum(a.y, b.y);
  vec2 head = quickTwoSum(s.x, s.y + t.x);
  return quickTwoSum(head.x, head.y + t.y);
}

vec2 dsSub(vec2 a, vec2 b) {
  return dsAdd(a, vec2(-b.x, -b.y));
}

vec2 dsMul(vec2 a, vec2 b) {
  vec2 p = twoProd(a.x, b.x);
  // The cross terms are exact products too, so nothing here is rounded twice.
  vec2 c1 = twoProd(a.x, b.y);
  vec2 c2 = twoProd(a.y, b.x);
  float e = (p.y + c1.x + c2.x) + (c1.y + c2.y);
  return quickTwoSum(p.x, e);
}

// Exact for value < 2^24, which covers any canvas dimension.
vec2 dsFromInt(int value) {
  return vec2(float(value), 0.0);
}

bool dsGreaterThan(vec2 a, vec2 b) {
  if (a.x > b.x) { return true; }
  if (a.x < b.x) { return false; }
  return a.y > b.y;
}
`;

/**
 * The ds kernel's own header: four split uniforms rather than the L0 kernel's two
 * packed ones, because a `vec2` holds one `(hi, lo)` pair and there are two axes.
 * Sharing the L0 header here is what made both axes read the same value.
 */
const DS_HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform vec2 uOriginRe;
uniform vec2 uOriginIm;
uniform vec2 uStepRe;
uniform vec2 uStepIm;
uniform int uMaxIterations;
uniform int uOutputMode;
uniform sampler2D uPalette;
uniform float uCyclesPerUnit;

out vec4 fragColor;
`;

const DS_MAIN = `
void main() {
  // The offset is formed in double-single as well: at 2^-30 the per-pixel step
  // is small enough that a single-precision product would lose the view.
  vec2 cRe = dsAdd(uOriginRe, dsMul(dsFromInt(int(gl_FragCoord.x)), uStepRe));
  vec2 cIm = dsAdd(uOriginIm, dsMul(dsFromInt(int(gl_FragCoord.y)), uStepIm));

  vec2 zr = vec2(0.0);
  vec2 zi = vec2(0.0);
  vec2 magnitudeSquared = vec2(0.0);
  int escapeIteration = 0;

  for (int i = 1; i <= uMaxIterations; i++) {
    vec2 zrSquared = dsMul(zr, zr);
    vec2 ziSquared = dsMul(zi, zi);
    vec2 nextZr = dsAdd(dsSub(zrSquared, ziSquared), cRe);
    vec2 nextZi = dsAdd(dsMul(dsAdd(zr, zr), zi), cIm);
    zr = nextZr;
    zi = nextZi;
    magnitudeSquared = dsAdd(dsMul(zr, zr), dsMul(zi, zi));
    if (dsGreaterThan(magnitudeSquared, vec2(4.0, 0.0))) {
      escapeIteration = i;
      break;
    }
  }

  writeResult(escapeIteration, magnitudeSquared.x);
}
`;

const FRAGMENT_SHADER = FRAGMENT_HEADER + FRAGMENT_OUTPUT + L0_MAIN;
const DS_FRAGMENT_SHADER = DS_HEADER + DS_HELPERS + FRAGMENT_OUTPUT + DS_MAIN;

/**
 * The perturbation fragment shader: the same delta recurrence and the same
 * floatexp arithmetic as the WebGPU compute kernel, in GLSL ES 3.00.
 *
 * This is the only way a WebGL2 browser can render a deep view at all. WebGL2 has
 * no f64 and no double-single kernel for the *direct* recurrence, so past 2^-20
 * the direct shader has nothing to iterate. Perturbation sidesteps the limit
 * rather than fighting it: the reference orbit is computed once on the CPU at full
 * precision and uploaded as a texture, and each fragment iterates only its
 * *difference* from it, carried as a floatexp (an f32 mantissa with an int
 * exponent) because a delta spans 2^-1000 to 1 within a single view.
 *
 * A fragment whose delta the fast path cannot trust is written as a *refusal* —
 * -2 in count mode, a fully transparent pixel in colour mode — and the host
 * recomputes it with the exact direct engine. The shader never guesses.
 *
 * The orbit texture holds (re.m, im.m, re.e, im.e) per iteration, laid out
 * row-major across uOrbitWidth texels; the width is a uniform because a float
 * texture's maximum size is smaller than the longest orbit this engine supports.
 */
const PERTURB_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform vec2 uReferencePixel;
uniform vec2 uStepMantissa;
uniform vec2 uStepExponent;
uniform int uMaxIterations;
uniform int uOutputMode;
uniform sampler2D uPalette;
uniform sampler2D uOrbit;
uniform int uOrbitWidth;
uniform int uOrbitLength;
uniform float uCyclesPerUnit;

out vec4 fragColor;

struct Fe { float m; int e; };

Fe feZero() { return Fe(0.0, 0); }

// 2^k for the non-positive k an exponent alignment produces.
float fePow2(int k) {
  if (k >= -126) {
    return uintBitsToFloat(uint(k + 127) << 23u);
  }
  if (k >= -149) {
    return uintBitsToFloat(1u << uint(k + 149));
  }
  return 0.0;
}

// m * 2^e with 0.5 <= |m| < 1, mirroring floatexp.ts. Written without recursion:
// the subnormal rescale is inlined because GLSL forbids recursion.
Fe feFrexp(float value) {
  if (value == 0.0) {
    return feZero();
  }
  float scaled = value;
  int adjust = 0;
  if ((floatBitsToUint(scaled) & 0x7f800000u) == 0u) {
    scaled = scaled * 16777216.0;
    adjust = -24;
  }
  uint bits = floatBitsToUint(scaled);
  uint exponentBits = (bits >> 23u) & 0xffu;
  bool negative = (bits >> 31u) == 1u;
  float unit = uintBitsToFloat((bits & 0x007fffffu) | (127u << 23u));
  float signedUnit = negative ? -unit : unit;
  return Fe(signedUnit * 0.5, int(exponentBits) - 126 + adjust);
}

Fe feNormalize(float mantissa, int exponent) {
  Fe scaled = feFrexp(mantissa);
  if (scaled.m == 0.0) {
    return feZero();
  }
  return Fe(scaled.m, scaled.e + exponent);
}

Fe feMul(Fe a, Fe b) {
  if (a.m == 0.0 || b.m == 0.0) {
    return feZero();
  }
  return feNormalize(a.m * b.m, a.e + b.e);
}

Fe feAdd(Fe a, Fe b) {
  if (a.m == 0.0) { return b; }
  if (b.m == 0.0) { return a; }
  int e = max(a.e, b.e);
  return feNormalize(a.m * fePow2(a.e - e) + b.m * fePow2(b.e - e), e);
}

Fe feNeg(Fe a) {
  if (a.m == 0.0) { return feZero(); }
  return Fe(-a.m, a.e);
}

Fe feSub(Fe a, Fe b) { return feAdd(a, feNeg(b)); }

// Magnitude comparison, exponents first: the ordering the CPU engine uses.
bool feGreater(Fe a, Fe b) {
  float am = abs(a.m);
  float bm = abs(b.m);
  if (am == 0.0) { return false; }
  if (bm == 0.0) { return true; }
  if (a.e != b.e) { return a.e > b.e; }
  return am > bm;
}

Fe feAbs2(Fe a) {
  if (a.m == 0.0) { return feZero(); }
  return feNormalize(a.m * a.m, a.e + a.e);
}

struct Fc { Fe re; Fe im; };

Fc fcAdd(Fc a, Fc b) { return Fc(feAdd(a.re, b.re), feAdd(a.im, b.im)); }

Fc fcMul(Fc a, Fc b) {
  return Fc(
    feSub(feMul(a.re, b.re), feMul(a.im, b.im)),
    feAdd(feMul(a.re, b.im), feMul(a.im, b.re))
  );
}

Fe fcAbs2(Fc a) { return feAdd(feAbs2(a.re), feAbs2(a.im)); }

Fc readOrbit(int n) {
  vec4 entry = texelFetch(uOrbit, ivec2(n % uOrbitWidth, n / uOrbitWidth), 0);
  return Fc(Fe(entry.x, int(entry.z)), Fe(entry.y, int(entry.w)));
}

void refuse() {
  // Two different refusals, one meaning: this pixel is not answered here.
  if (uOutputMode == 1) {
    fragColor = vec4(-2.0, 0.0, 0.0, 1.0);
  } else {
    fragColor = vec4(0.0, 0.0, 0.0, 0.0);
  }
}

void main() {
  // Fragments are bottom-up while view rows are top-down, so the imaginary
  // offset is measured *from* the reference downward. Writing this as a plain
  // subtraction flips the image vertically, which the differential pin catches.
  vec2 sampleOffset = vec2(
    gl_FragCoord.x - uReferencePixel.x,
    uReferencePixel.y - gl_FragCoord.y
  );
  Fc dc = Fc(
    feNormalize(uStepMantissa.x * sampleOffset.x, int(uStepExponent.x)),
    feNormalize(uStepMantissa.y * sampleOffset.y, int(uStepExponent.y))
  );

  Fc d = dc;
  int escapeIteration = 0;
  Fe magnitude = feZero();

  for (int n = 1; n <= uMaxIterations; n++) {
    if (n >= uOrbitLength) {
      refuse();
      return;
    }
    Fc zn = readOrbit(n);
    Fc z = fcAdd(zn, d);
    Fe magnitudeSquared = fcAbs2(z);

    // Pauldelbrot: |z|^2 < |Z|^2 * 2^-24.
    Fe threshold = feMul(fcAbs2(zn), Fe(0.5, -23));
    if (feGreater(threshold, magnitudeSquared)) {
      refuse();
      return;
    }

    if (feGreater(magnitudeSquared, Fe(0.5, 3))) {
      escapeIteration = n;
      magnitude = magnitudeSquared;
      break;
    }

    Fc twiceZn = fcAdd(zn, zn);
    d = fcAdd(fcAdd(fcMul(twiceZn, d), fcMul(d, d)), dc);
  }

  if (uOutputMode == 1) {
    fragColor = vec4(float(escapeIteration), 0.0, 0.0, 1.0);
    return;
  }
  if (escapeIteration == 0) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float log2MagnitudeSquared = log2(magnitude.m) + float(magnitude.e);
  float smoothCount = float(escapeIteration) + 1.0 - log2(0.5 * log2MagnitudeSquared);
  float phase = smoothCount * uCyclesPerUnit;
  float wrapped = phase - floor(phase);
  vec3 rgb = texture(uPalette, vec2(wrapped, 0.5)).rgb;
  fragColor = vec4(rgb, 1.0);
}`;

type GlState = {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  readonly program: WebGLProgram;
  readonly perturbProgram: WebGLProgram;
  /** Emulated double-precision kernel: the `exact` path WebGL2 did not have. */
  readonly doubleProgram: WebGLProgram;
  readonly palette: WebGLTexture;
  readonly vao: WebGLVertexArrayObject;
  readonly uniforms: {
    origin: WebGLUniformLocation;
    step: WebGLUniformLocation;
    maxIterations: WebGLUniformLocation;
    outputMode: WebGLUniformLocation;
    palette: WebGLUniformLocation;
    cyclesPerUnit: WebGLUniformLocation;
  };
  readonly doubleUniforms: {
    originRe: WebGLUniformLocation;
    originIm: WebGLUniformLocation;
    stepRe: WebGLUniformLocation;
    stepIm: WebGLUniformLocation;
    maxIterations: WebGLUniformLocation;
    outputMode: WebGLUniformLocation;
    palette: WebGLUniformLocation;
    cyclesPerUnit: WebGLUniformLocation;
  };
  readonly perturbUniforms: {
    referencePixel: WebGLUniformLocation;
    stepMantissa: WebGLUniformLocation;
    stepExponent: WebGLUniformLocation;
    maxIterations: WebGLUniformLocation;
    outputMode: WebGLUniformLocation;
    palette: WebGLUniformLocation;
    orbit: WebGLUniformLocation;
    orbitWidth: WebGLUniformLocation;
    orbitLength: WebGLUniformLocation;
    cyclesPerUnit: WebGLUniformLocation;
  };
  paletteName: string | null;
  /** Reference orbit for the perturbation shader, and what is currently in it. */
  orbitTexture: WebGLTexture | null;
  orbitKey: string | null;
  orbitWidth: number;
  orbitLength: number;
  /** Float framebuffer used for escape-count output. */
  floatTarget: {
    framebuffer: WebGLFramebuffer;
    texture: WebGLTexture;
    width: number;
    height: number;
  } | null;
};

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("webgl2: createShader returned null");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "(no log)";
    gl.deleteShader(shader);
    throw new Error(`webgl2: shader failed to compile: ${log}`);
  }
  return shader;
}

function link(
  gl: WebGL2RenderingContext,
  fragmentSource: string = FRAGMENT_SHADER,
): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error("webgl2: createProgram returned null");
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "(no log)";
    gl.deleteProgram(program);
    throw new Error(`webgl2: program failed to link: ${log}`);
  }
  return program;
}

function requireUniform(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name);
  if (!location) {
    throw new Error(
      `webgl2: uniform ${name} not found — the shader and the host have drifted`,
    );
  }
  return location;
}

function createState(canvas: HTMLCanvasElement): GlState {
  const gl = canvas.getContext("webgl2", {
    preserveDrawingBuffer: true,
    antialias: false,
  });
  if (!gl) {
    throw new Error("webgl2: context creation failed");
  }
  const program = link(gl);
  const perturbProgram = link(gl, PERTURB_FRAGMENT_SHADER);
  const doubleProgram = link(gl, DS_FRAGMENT_SHADER);
  const vao = gl.createVertexArray();
  if (!vao) throw new Error("webgl2: createVertexArray returned null");
  gl.bindVertexArray(vao);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW,
  );
  const position = gl.getAttribLocation(program, "aPosition");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const palette = gl.createTexture();
  if (!palette) throw new Error("webgl2: createTexture returned null");

  const floatTarget = gl.getExtension("EXT_color_buffer_float")
    ? createFloatTarget(gl, 1, 1)
    : null;

  return {
    canvas,
    gl,
    program,
    palette,
    vao,
    uniforms: {
      origin: requireUniform(gl, program, "uOrigin"),
      step: requireUniform(gl, program, "uStep"),
      maxIterations: requireUniform(gl, program, "uMaxIterations"),
      outputMode: requireUniform(gl, program, "uOutputMode"),
      palette: requireUniform(gl, program, "uPalette"),
      cyclesPerUnit: requireUniform(gl, program, "uCyclesPerUnit"),
    },
    perturbProgram,
    doubleProgram,
    // The ds kernel reads `uOrigin`/`uStep` as `(hi, lo)` pairs, so the host
    // uploads them with `uniform2f` twice over — same names, wider meaning.
    doubleUniforms: {
      originRe: requireUniform(gl, doubleProgram, "uOriginRe"),
      originIm: requireUniform(gl, doubleProgram, "uOriginIm"),
      stepRe: requireUniform(gl, doubleProgram, "uStepRe"),
      stepIm: requireUniform(gl, doubleProgram, "uStepIm"),
      maxIterations: requireUniform(gl, doubleProgram, "uMaxIterations"),
      outputMode: requireUniform(gl, doubleProgram, "uOutputMode"),
      palette: requireUniform(gl, doubleProgram, "uPalette"),
      cyclesPerUnit: requireUniform(gl, doubleProgram, "uCyclesPerUnit"),
    },
    perturbUniforms: {
      referencePixel: requireUniform(gl, perturbProgram, "uReferencePixel"),
      stepMantissa: requireUniform(gl, perturbProgram, "uStepMantissa"),
      stepExponent: requireUniform(gl, perturbProgram, "uStepExponent"),
      maxIterations: requireUniform(gl, perturbProgram, "uMaxIterations"),
      outputMode: requireUniform(gl, perturbProgram, "uOutputMode"),
      palette: requireUniform(gl, perturbProgram, "uPalette"),
      orbit: requireUniform(gl, perturbProgram, "uOrbit"),
      orbitWidth: requireUniform(gl, perturbProgram, "uOrbitWidth"),
      orbitLength: requireUniform(gl, perturbProgram, "uOrbitLength"),
      cyclesPerUnit: requireUniform(gl, perturbProgram, "uCyclesPerUnit"),
    },
    paletteName: null,
    orbitTexture: null,
    orbitKey: null,
    orbitWidth: 1,
    orbitLength: 0,
    floatTarget,
  };
}

function createFloatTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
} {
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  if (!texture || !framebuffer)
    throw new Error("webgl2: failed to allocate float target");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA32F,
    width,
    height,
    0,
    gl.RGBA,
    gl.FLOAT,
    null,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    texture,
    0,
  );
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`webgl2: float framebuffer incomplete (0x${status.toString(16)})`);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { framebuffer, texture, width, height };
}

function uploadPalette(state: GlState, request: TileRequest): void {
  if (state.paletteName === request.palette.name) return;
  const { gl } = state;
  const bytes = new Uint8Array(request.palette.size * 4);
  for (let i = 0; i < request.palette.size; i++) {
    const colour = request.palette.at(i);
    bytes[i * 4] = colour.r;
    bytes[i * 4 + 1] = colour.g;
    bytes[i * 4 + 2] = colour.b;
    bytes[i * 4 + 3] = 255;
  }
  gl.bindTexture(gl.TEXTURE_2D, state.palette);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    request.palette.size,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    bytes,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  state.paletteName = request.palette.name;
}

export function createWebGl2Backend(canvas: HTMLCanvasElement): FractalBackend {
  let state: GlState | null = null;

  const ensure = (): GlState => {
    state ??= createState(canvas);
    return state;
  };

  return {
    name: "webgl2",

    capability(view, plan): Capability {
      const exponent = scaleExponentOf(view);
      // Quality first, then depth: `exact` at a depth the emulated-double kernel
      // can reach must not be refused just because the *preview* shader would
      // have taken a different path there.
      if (plan.quality === "exact") {
        if (exponent < WEBGL2_DS_PIXEL_EXPONENT_LIMIT) {
          return {
            supported: false,
            why: `pixel spacing 2^${exponent} is below the emulated-double limit 2^${WEBGL2_DS_PIXEL_EXPONENT_LIMIT}, and the perturbation shader is a preview engine; exact output at this depth uses the CPU backend`,
          };
        }
        return {
          supported: true,
          why: `L0 engine with emulated double precision (~48-bit, Veltkamp splitting since GLSL ES 3.00 has no fma), reach 2^${WEBGL2_DS_PIXEL_EXPONENT_LIMIT}`,
        };
      }
      if (exponent < WEBGL2_F32_PIXEL_EXPONENT_LIMIT) {
        // Below the direct limit the offset is not representable in f32 at all,
        // so the perturbation shader takes over. This is what gives WebGL2 — the
        // only GPU path most browsers have — any reach at depth.
        return {
          supported: true,
          why: "perturbation engine, preview quality (f32 mantissa deltas against a full-precision reference orbit)",
        };
      }
      return {
        supported: true,
        why: `L0 engine in f32, direct down to 2^${WEBGL2_F32_PIXEL_EXPONENT_LIMIT}`,
      };
    },

    async render(request: TileRequest, into: TileResult): Promise<TileResult> {
      const glState = ensure();
      const { gl } = glState;
      assertTileFitsView(request.view, request.tile, request.allowOutsideView ?? false);
      const output = tileOutputSize(request.tile, request.step);
      if (output.width !== into.width || output.height !== into.height) {
        throw new Error(
          `webgl2 backend: result buffer is ${into.width}x${into.height}, but a ${request.tile.width}x${request.tile.height} tile at step ${request.step} is ${output.width}x${output.height}`,
        );
      }

      if (
        glState.canvas.width !== request.view.pixelWidth ||
        glState.canvas.height !== request.view.pixelHeight
      ) {
        glState.canvas.width = request.view.pixelWidth;
        glState.canvas.height = request.view.pixelHeight;
      }

      // The shader reads `gl_FragCoord`, which is bottom-up, so the origin is the
      // tile's *bottom*-left pixel centre and the step's y component is
      // positive. Getting this backwards flips the image vertically, which the
      // differential test catches immediately.
      const origin = pixelCentreAt(
        request,
        request.tile.x,
        request.tile.y + request.tile.height - 1,
      );
      const nextRow = pixelCentreAt(
        request,
        request.tile.x,
        request.tile.y + request.tile.height - 2,
      );
      const nextColumn = pixelCentreAt(
        request,
        request.tile.x + 1,
        request.tile.y + request.tile.height - 1,
      );
      const stepRe = nextColumn.re - origin.re;
      const stepIm = nextRow.im - origin.im;

      const exponent = scaleExponentOf(request.view);
      // `exact` takes the emulated-double kernel wherever it reaches, exactly as
      // the WebGPU backend does; perturbation is what preview falls back to below
      // the f32 limit.
      const useDouble =
        request.quality === "exact" && exponent >= WEBGL2_DS_PIXEL_EXPONENT_LIMIT;
      const usePerturbation = !useDouble && exponent < WEBGL2_F32_PIXEL_EXPONENT_LIMIT;
      if (request.quality === "exact" && !useDouble) {
        throw new Error(
          `webgl2 backend: pixel spacing 2^${exponent} is below the emulated-double limit 2^${WEBGL2_DS_PIXEL_EXPONENT_LIMIT}, and the perturbation shader is a preview engine`,
        );
      }

      gl.bindFramebuffer(
        gl.FRAMEBUFFER,
        request.output === "escape-count"
          ? floatTarget(glState, request).framebuffer
          : null,
      );
      gl.viewport(0, 0, output.width, output.height);
      gl.useProgram(
        usePerturbation
          ? glState.perturbProgram
          : useDouble
            ? glState.doubleProgram
            : glState.program,
      );
      gl.bindVertexArray(glState.vao);
      uploadPalette(glState, request);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, glState.palette);

      if (usePerturbation) {
        const orbit = uploadOrbit(glState, request);
        const uniforms = glState.perturbUniforms;
        gl.uniform1i(uniforms.palette, 0);
        // Tile-local reference, in view coordinates: the fragment's sample offset
        // is measured from the view centre, and the shader handles the bottom-up
        // fragment origin.
        gl.uniform2f(
          uniforms.referencePixel,
          request.view.pixelWidth / 2 - request.tile.x + 0.5,
          request.tile.y + request.tile.height - 1 - request.view.pixelHeight / 2,
        );
        const sampleStep = mul(
          pixelSizeOf(request.view),
          fromFloat(request.step, request.view.width.fracBits),
        );
        const sampleFloatexp = fromBigFixed(sampleStep);
        gl.uniform2f(uniforms.stepMantissa, sampleFloatexp.m, sampleFloatexp.m);
        // As floats: the uniform is vec2 and an integer bit pattern would read as
        // a denormal and truncate to zero — a mistake that cost a landing on the
        // WebGPU side and is written down here so it cannot recur.
        gl.uniform2f(uniforms.stepExponent, sampleFloatexp.e, sampleFloatexp.e);
        gl.uniform1i(uniforms.maxIterations, request.maxIterations);
        gl.uniform1i(uniforms.outputMode, request.output === "escape-count" ? 1 : 0);
        gl.uniform1i(uniforms.orbit, 1);
        gl.uniform1i(uniforms.orbitWidth, orbit.width);
        gl.uniform1i(uniforms.orbitLength, orbit.length);
        gl.uniform1f(uniforms.cyclesPerUnit, request.palette.cyclesPerUnit);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, orbit.texture);
        gl.activeTexture(gl.TEXTURE0);
      } else if (useDouble) {
        const uniforms = glState.doubleUniforms;
        // `pixelCentreAt` has already projected to doubles, so the split is the
        // only step left before the shader sees a (hi, lo) pair.
        const [originReHi, originReLo] = splitDouble(origin.re);
        const [originImHi, originImLo] = splitDouble(origin.im);
        const [stepReHi, stepReLo] = splitDouble(stepRe);
        const [stepImHi, stepImLo] = splitDouble(stepIm);
        gl.uniform1i(uniforms.palette, 0);
        gl.uniform2f(uniforms.originRe, originReHi, originReLo);
        gl.uniform2f(uniforms.originIm, originImHi, originImLo);
        gl.uniform2f(uniforms.stepRe, stepReHi, stepReLo);
        gl.uniform2f(uniforms.stepIm, stepImHi, stepImLo);
        gl.uniform1i(uniforms.maxIterations, request.maxIterations);
        gl.uniform1i(uniforms.outputMode, request.output === "escape-count" ? 1 : 0);
        gl.uniform1f(uniforms.cyclesPerUnit, request.palette.cyclesPerUnit);
      } else {
        gl.uniform1i(glState.uniforms.palette, 0);
        gl.uniform2f(glState.uniforms.origin, origin.re, origin.im);
        gl.uniform2f(glState.uniforms.step, stepRe, stepIm);
        gl.uniform1i(glState.uniforms.maxIterations, request.maxIterations);
        gl.uniform1i(
          glState.uniforms.outputMode,
          request.output === "escape-count" ? 1 : 0,
        );
        gl.uniform1f(glState.uniforms.cyclesPerUnit, request.palette.cyclesPerUnit);
      }

      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.finish();

      if (request.output === "escape-count") {
        const buffer = new Float32Array(output.width * output.height * 4);
        gl.readPixels(0, 0, output.width, output.height, gl.RGBA, gl.FLOAT, buffer);
        const error = gl.getError();
        if (error !== gl.NO_ERROR) {
          throw new Error(`webgl2: readPixels failed (0x${error.toString(16)})`);
        }
        for (let row = 0; row < output.height; row++) {
          // Flip rows: readPixels is bottom-up, the result buffer is top-down.
          const source = (output.height - 1 - row) * output.width;
          const destination = row * output.width;
          for (let column = 0; column < output.width; column++) {
            const value = buffer[(source + column) * 4] as number;
            // Shader writes 0 for interior; the CPU backend uses -1.
            into.escapeCounts[destination + column] = value === 0 ? -1 : value;
          }
        }
      } else {
        const buffer = new Uint8Array(output.width * output.height * 4);
        gl.readPixels(
          0,
          0,
          output.width,
          output.height,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          buffer,
        );
        for (let row = 0; row < output.height; row++) {
          const source = (output.height - 1 - row) * output.width * 4;
          const destination = row * output.width * 4;
          into.pixels.set(
            buffer.subarray(source, source + output.width * 4),
            destination,
          );
        }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      // Fragments the perturbation shader refused are recomputed exactly, by the
      // same direct engine the CPU backend repairs with.
      const repaired = usePerturbation
        ? repairFlaggedPixels(request, into, output, (index) =>
            request.output === "escape-count"
              ? into.escapeCounts[index] === REFUSED_COUNT
              : into.pixels[index * 4 + 3] === 0,
          )
        : 0;
      into.stage = usePerturbation
        ? repaired > 0
          ? "perturbation-f32-fragment+repair"
          : "perturbation-f32-fragment"
        : useDouble
          ? "direct-ds"
          : "direct-f32";
      return into;
    },

    dispose(): void {
      if (state === null) return;
      const { gl } = state;
      gl.deleteProgram(state.program);
      gl.deleteTexture(state.palette);
      gl.deleteVertexArray(state.vao);
      if (state.floatTarget) {
        gl.deleteFramebuffer(state.floatTarget.framebuffer);
        gl.deleteTexture(state.floatTarget.texture);
      }
      state = null;
    },
  };
}

/**
 * Upload the reference orbit for the perturbation shader, once per view.
 *
 * A float texture rather than a uniform array: a 600-iteration orbit is 600
 * texels, and uniform arrays that size are not portable. Laid out row-major
 * across `width` texels so the shader can index it with `texelFetch`, with the
 * width capped by the driver's maximum texture size.
 */
function uploadOrbit(
  state: GlState,
  request: TileRequest,
): { texture: WebGLTexture; width: number; length: number } {
  const { gl } = state;
  const { view } = request;
  const key = `${view.width.v}|${view.pixelWidth}x${view.pixelHeight}|${request.maxIterations}`;
  if (state.orbitKey === key && state.orbitTexture) {
    return {
      texture: state.orbitTexture,
      width: state.orbitWidth,
      length: state.orbitLength,
    };
  }

  const reference = pixelToComplex(view, view.pixelWidth / 2, view.pixelHeight / 2);
  const orbit = computeConvergedReferenceOrbit(
    reference,
    request.maxIterations + 1,
    view.width.fracBits,
  ).orbit;
  const length = orbit.length;
  const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  const width = Math.min(length, maxSize, 2048);
  const height = Math.ceil(length / width);

  const packed = new Float32Array(width * height * 4);
  for (let i = 0; i < length; i++) {
    packed[i * 4] = orbit.reMantissa[i] as number;
    packed[i * 4 + 1] = orbit.imMantissa[i] as number;
    packed[i * 4 + 2] = orbit.reExponent[i] as number;
    packed[i * 4 + 3] = orbit.imExponent[i] as number;
  }

  if (!state.orbitTexture) {
    state.orbitTexture = gl.createTexture();
    if (!state.orbitTexture)
      throw new Error("webgl2: createTexture returned null for the orbit");
  }
  gl.bindTexture(gl.TEXTURE_2D, state.orbitTexture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA32F,
    width,
    height,
    0,
    gl.RGBA,
    gl.FLOAT,
    packed,
  );
  // Nearest, clamped: the shader fetches exact texels by index and must not get
  // an interpolated or wrapped neighbour.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  state.orbitKey = key;
  state.orbitWidth = width;
  state.orbitLength = length;
  return { texture: state.orbitTexture, width, length };
}

function floatTarget(state: GlState, request: TileRequest) {
  if (state.floatTarget === null) {
    throw new Error(
      "webgl2: escape-count output needs EXT_color_buffer_float, which this context does not expose",
    );
  }
  if (
    state.floatTarget.width < request.tile.width ||
    state.floatTarget.height < request.tile.height
  ) {
    const { gl } = state;
    gl.deleteFramebuffer(state.floatTarget.framebuffer);
    gl.deleteTexture(state.floatTarget.texture);
    state.floatTarget = createFloatTarget(gl, request.tile.width, request.tile.height);
  }
  return state.floatTarget;
}

/** The f64 complex coordinate of a pixel centre, for handing to the shader. */
function pixelCentreAt(request: TileRequest, x: number, y: number) {
  const c = pixelToComplex(request.view, x, y);
  return { re: toFloat(c.re), im: toFloat(c.im) };
}
