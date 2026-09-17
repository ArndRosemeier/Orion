/**
 * The WGSL kernels for the WebGPU backend, in two precisions.
 *
 * `single` is the fast preview path: plain `f32`, 24 significant bits.
 *
 * `double` is the exact path: emulated double precision, a value carried as an
 * unevaluated `(hi, lo)` pair of `f32`s. Using error-free transformations
 * (TwoSum, and TwoProd via `fma`), the pair behaves like ~48 significant bits —
 * enough to represent a pixel offset at zoom 2^-30 that plain `f32` collapses to
 * a single number, and enough to keep the iteration's rounding far below the
 * escape threshold for far longer.
 *
 * It is roughly ten times the arithmetic per iteration, which is why it is a
 * separate kernel rather than a replacement: preview wants speed, `exact` wants
 * numbers that match the oracle.
 *
 * Both kernels iterate the identical recurrence as `escapeDirectFloat`, so the
 * same differential judges them. WGSL requires a function to be declared before
 * it is called, so the shared output helper comes first.
 */

export const WGSL_KERNEL = `
struct Params {
  originRe: vec2<f32>,
  originIm: vec2<f32>,
  stepRe: vec2<f32>,
  stepIm: vec2<f32>,
  maxIterations: u32,
  outputMode: u32,
  width: u32,
  height: u32,
  cyclesPerUnit: f32,
  paletteSize: u32,
  // Perturbation only: the pixel step as a floatexp (mantissa, exponent) per
  // axis, and the reference pixel the offsets are measured from.
  stepFloatMantissa: vec2<f32>,
  stepFloatExponent: vec2<f32>,
  referencePixel: vec2<f32>,
  // Uniform-address-space structs must be a multiple of 16 bytes. Without the
  // padding the binding is invalid, and an invalid binding makes the dispatch a
  // silent no-op rather than an error — the worst kind of failure, because the
  // output buffer keeps whatever was in it.
  padding: vec4<f32>,
};

// The reference orbit for the perturbation kernel: one (re.m, im.m, re.e, im.e)
// per iteration. Uploaded once per view; a view has one reference point (its
// centre), so every tile cut from it shares this buffer.
@group(1) @binding(0) var<storage, read> orbit: array<vec4<f32>>;

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> counts: array<f32>;
@group(0) @binding(2) var<storage, read_write> colours: array<u32>;
@group(0) @binding(3) var<storage, read> palette: array<u32>;

// ---- shared output ----------------------------------------------------------

fn writeResult(gid: vec3<u32>, escapeIteration: u32, magnitudeSquared: f32) {
  let index = gid.y * params.width + gid.x;

  if (params.outputMode == 1u) {
    // -1 marks an interior point, matching the CPU backend's convention.
    counts[index] = select(-1.0, f32(escapeIteration), escapeIteration > 0u);
    return;
  }

  if (escapeIteration == 0u) {
    colours[index] = pack4x8unorm(vec4<f32>(0.0, 0.0, 0.0, 1.0));
    return;
  }

  let smoothCount = f32(escapeIteration) + 1.0 - log2(0.5 * log2(magnitudeSquared));
  let phase = smoothCount * params.cyclesPerUnit;
  let wrapped = phase - floor(phase);
  var paletteIndex = u32(wrapped * f32(params.paletteSize));
  if (paletteIndex >= params.paletteSize) {
    paletteIndex = params.paletteSize - 1u;
  }
  colours[index] = palette[paletteIndex];
}

// ---- single precision -------------------------------------------------------

@compute @workgroup_size(8, 8)
fn single(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let c = vec2<f32>(params.originRe.x, params.originIm.x)
        + vec2<f32>(f32(gid.x), f32(gid.y)) * vec2<f32>(params.stepRe.x, params.stepIm.x);

  var z = vec2<f32>(0.0, 0.0);
  var magnitudeSquared = 0.0;
  var escapeIteration = 0u;

  for (var i = 1u; i <= params.maxIterations; i = i + 1u) {
    z = vec2<f32>(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    magnitudeSquared = dot(z, z);
    if (magnitudeSquared > 4.0) {
      escapeIteration = i;
      break;
    }
  }

  writeResult(gid, escapeIteration, magnitudeSquared);
}

// ---- emulated double precision ---------------------------------------------

// Exact sum: s + err == a + b, with s the rounded result.
fn twoSum(a: f32, b: f32) -> vec2<f32> {
  let s = a + b;
  let bb = s - a;
  return vec2<f32>(s, (a - (s - bb)) + (b - bb));
}

// Exact sum when |a| >= |b|; one fewer operation than twoSum.
fn quickTwoSum(a: f32, b: f32) -> vec2<f32> {
  let s = a + b;
  return vec2<f32>(s, b - (s - a));
}

// Exact product via a fused multiply-add: p + err == a * b.
fn twoProd(a: f32, b: f32) -> vec2<f32> {
  let p = a * b;
  return vec2<f32>(p, fma(a, b, -p));
}

fn dsAdd(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  let s = twoSum(a.x, b.x);
  let t = twoSum(a.y, b.y);
  let head = quickTwoSum(s.x, s.y + t.x);
  return quickTwoSum(head.x, head.y + t.y);
}

fn dsSub(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  return dsAdd(a, vec2<f32>(-b.x, -b.y));
}

fn dsMul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  let p = twoProd(a.x, b.x);
  let e = fma(a.x, b.y, fma(a.y, b.x, p.y));
  return quickTwoSum(p.x, e);
}

// Exact for value < 2^24, which covers any canvas dimension.
fn dsFromInt(value: u32) -> vec2<f32> {
  return vec2<f32>(f32(value), 0.0);
}

fn dsGreaterThan(a: vec2<f32>, b: vec2<f32>) -> bool {
  if (a.x > b.x) { return true; }
  if (a.x < b.x) { return false; }
  return a.y > b.y;
}

@compute @workgroup_size(8, 8)
fn double(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }

  // The offset is formed in double-single as well: at 2^-30 the per-pixel step
  // is small enough that a single-precision product would lose the view.
  let offsetRe = dsMul(dsFromInt(gid.x), params.stepRe);
  let offsetIm = dsMul(dsFromInt(gid.y), params.stepIm);
  let cRe = dsAdd(params.originRe, offsetRe);
  let cIm = dsAdd(params.originIm, offsetIm);

  var zr = vec2<f32>(0.0, 0.0);
  var zi = vec2<f32>(0.0, 0.0);
  var magnitudeSquared = vec2<f32>(0.0, 0.0);
  var escapeIteration = 0u;

  for (var i = 1u; i <= params.maxIterations; i = i + 1u) {
    let zrSquared = dsMul(zr, zr);
    let ziSquared = dsMul(zi, zi);
    let nextZr = dsAdd(dsSub(zrSquared, ziSquared), cRe);
    let nextZi = dsAdd(dsMul(dsAdd(zr, zr), zi), cIm);
    zr = nextZr;
    zi = nextZi;
    magnitudeSquared = dsAdd(dsMul(zr, zr), dsMul(zi, zi));
    if (dsGreaterThan(magnitudeSquared, vec2<f32>(4.0, 0.0))) {
      escapeIteration = i;
      break;
    }
  }

  writeResult(gid, escapeIteration, magnitudeSquared.x);
}
`;

/**
 * The perturbation kernel: the delta recurrence, in floatexp with an `f32`
 * mantissa.
 *
 * Deep views cannot be iterated directly on a GPU at all — the offset of a pixel
 * from the view centre stops being representable in `f32` long before the view
 * gets interesting. Perturbation solves that: the reference orbit is computed once
 * on the CPU at full precision, and each pixel iterates only its *difference*
 * from it,
 *
 *     d_{n+1} = 2*Z_n*d_n + d_n^2 + dc
 *
 * where `dc` is a view-scale number the shader forms from the pixel's offset and
 * the step. The delta is carried as a floatexp — an `f32` mantissa with an `i32`
 * exponent — because a delta can be as small as 2^-1000 and as large as 1 in the
 * same run, which no fixed exponent range survives.
 *
 * ## What this kernel can and cannot promise
 *
 * It is a **preview** engine. An `f32` mantissa carries 24 significant bits
 * against the CPU engine's 53, so escape counts near the boundary will differ,
 * and the difference is reported rather than hidden: the pin measures the
 * agreement rate at a low iteration budget (where it should be exact) and at a
 * high one (where it is expected to drift), exactly as the L0 kernels are judged.
 *
 * A pixel whose delta becomes untrustworthy — Pauldelbrot's cancellation
 * criterion, the same one the CPU engine uses — is *flagged*, not guessed at:
 * the host repairs flagged pixels with the exact direct engine before the tile is
 * returned, and the stage string says a repair happened.
 */
export const WGSL_PERTURB = `
struct Fe {
  m: f32,
  e: i32,
};

struct Fc {
  re: Fe,
  im: Fe,
};

// The same output helper the L0 kernels use, so a flagged pixel and an interior
// pixel are written the way the host expects.
fn writePerturbed(gid: vec3<u32>, escapeIteration: u32, magnitude: Fe, flagged: bool) {
  let index = gid.y * params.width + gid.x;
  if (flagged) {
    // -2 means "the fast path could not be trusted"; the host recomputes it.
    counts[index] = -2.0;
    colours[index] = 0u;
    return;
  }
  if (params.outputMode == 1u) {
    counts[index] = select(-1.0, f32(escapeIteration), escapeIteration > 0u);
    return;
  }
  if (escapeIteration == 0u) {
    colours[index] = pack4x8unorm(vec4<f32>(0.0, 0.0, 0.0, 1.0));
    return;
  }
  let log2MagnitudeSquared = log2(magnitude.m) + f32(magnitude.e);
  let smoothCount = f32(escapeIteration) + 1.0 - log2(0.5 * log2MagnitudeSquared);
  let phase = smoothCount * params.cyclesPerUnit;
  let wrapped = phase - floor(phase);
  var paletteIndex = u32(wrapped * f32(params.paletteSize));
  if (paletteIndex >= params.paletteSize) {
    paletteIndex = params.paletteSize - 1u;
  }
  colours[index] = palette[paletteIndex];
}

// ---- floatexp, mantissa in f32 -------------------------------------------------

fn feZero() -> Fe { return Fe(0.0, 0); }

// 2^k, for the non-positive k an exponent alignment produces.
fn fePow2(k: i32) -> f32 {
  if (k >= -126) {
    return bitcast<f32>(u32(k + 127) << 23u);
  }
  if (k >= -149) {
    return bitcast<f32>(1u << u32(k + 149));
  }
  return 0.0;
}

// Decompose into m * 2^e with 0.5 <= |m| < 1, mirroring floatexp.ts. The
// subnormal rescale is written out rather than recursive because WGSL forbids
// recursion outright — the CPU version calls itself, this one cannot.
fn feFrexp(value: f32) -> Fe {
  if (value == 0.0) {
    return feZero();
  }
  var scaled = value;
  var adjust = 0;
  if ((bitcast<u32>(scaled) & 0x7f800000u) == 0u) {
    // Subnormal: scale into the normal range exactly, then correct. A delta can
    // reach this range legitimately at extreme depth.
    scaled = scaled * 16777216.0;
    adjust = -24;
  }
  let bits = bitcast<u32>(scaled);
  let exponentBits = (bits >> 23u) & 0xffu;
  let negative = (bits >> 31u) == 1u;
  let unit = bitcast<f32>((bits & 0x007fffffu) | (127u << 23u));
  let signedUnit = select(unit, -unit, negative);
  return Fe(signedUnit * 0.5, i32(exponentBits) - 126 + adjust);
}

fn feNormalize(mantissa: f32, exponent: i32) -> Fe {
  let scaled = feFrexp(mantissa);
  if (scaled.m == 0.0) {
    return feZero();
  }
  return Fe(scaled.m, scaled.e + exponent);
}

fn feMul(a: Fe, b: Fe) -> Fe {
  if (a.m == 0.0 || b.m == 0.0) {
    return feZero();
  }
  return feNormalize(a.m * b.m, a.e + b.e);
}

fn feAdd(a: Fe, b: Fe) -> Fe {
  if (a.m == 0.0) { return b; }
  if (b.m == 0.0) { return a; }
  let e = max(a.e, b.e);
  return feNormalize(a.m * fePow2(a.e - e) + b.m * fePow2(b.e - e), e);
}

fn feNeg(a: Fe) -> Fe {
  if (a.m == 0.0) { return feZero(); }
  return Fe(-a.m, a.e);
}

fn feSub(a: Fe, b: Fe) -> Fe { return feAdd(a, feNeg(b)); }

// Magnitude comparison, exponents first — the ordering the CPU engine uses.
fn feGreater(a: Fe, b: Fe) -> bool {
  let am = abs(a.m);
  let bm = abs(b.m);
  if (am == 0.0) { return false; }
  if (bm == 0.0) { return true; }
  if (a.e != b.e) { return a.e > b.e; }
  return am > bm;
}

fn feAbs2(a: Fe) -> Fe {
  if (a.m == 0.0) { return feZero(); }
  return feNormalize(a.m * a.m, a.e + a.e);
}

// ---- complex over floatexp -----------------------------------------------------

fn fcAdd(a: Fc, b: Fc) -> Fc {
  return Fc(feAdd(a.re, b.re), feAdd(a.im, b.im));
}

fn fcMul(a: Fc, b: Fc) -> Fc {
  return Fc(
    feSub(feMul(a.re, b.re), feMul(a.im, b.im)),
    feAdd(feMul(a.re, b.im), feMul(a.im, b.re)),
  );
}

fn fcAbs2(a: Fc) -> Fe {
  return feAdd(feAbs2(a.re), feAbs2(a.im));
}

fn readOrbit(n: u32) -> Fc {
  let entry = orbit[n];
  return Fc(Fe(entry.x, i32(entry.z)), Fe(entry.y, i32(entry.w)));
}

@compute @workgroup_size(8, 8)
fn perturb(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }

  // dc from the pixel's offset and the view's step, both as floatexps: the step
  // carries the scale (2^-300 is just an exponent) and the offset is an exact
  // small float.
  let dx = f32(gid.x) - params.referencePixel.x;
  let dy = f32(gid.y) - params.referencePixel.y;
  let dc = Fc(
    feNormalize(params.stepFloatMantissa.x * dx, i32(params.stepFloatExponent.x)),
    feNormalize(params.stepFloatMantissa.y * dy, i32(params.stepFloatExponent.y)),
  );

  var d = dc;
  var escapeIteration = 0u;
  var magnitude = feZero();
  var flagged = false;

  for (var n = 1u; n <= params.maxIterations; n = n + 1u) {
    if (n >= arrayLength(&orbit)) {
      flagged = true;
      break;
    }
    let zn = readOrbit(n);
    let z = fcAdd(zn, d);
    let magnitudeSquared = fcAbs2(z);

    // Pauldelbrot: |z|^2 < |Z|^2 * 2^-24. The reference passed near zero and the
    // pixel did not, so the sum kept only the bits left over.
    let threshold = feMul(fcAbs2(zn), Fe(0.5, -23));
    if (feGreater(threshold, magnitudeSquared)) {
      flagged = true;
      break;
    }

    if (feGreater(magnitudeSquared, Fe(0.5, 3))) {
      escapeIteration = n;
      magnitude = magnitudeSquared;
      break;
    }

    let twiceZn = fcAdd(zn, zn);
    d = fcAdd(fcAdd(fcMul(twiceZn, d), fcMul(d, d)), dc);
  }

  writePerturbed(gid, escapeIteration, magnitude, flagged);
}
`;
