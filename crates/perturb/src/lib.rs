//! The perturbation (delta) kernel, in Rust, compiled to WebAssembly.
//!
//! This is the hot loop of every deep render. The reference orbit is computed
//! once per view in wide fixed point, but the per-pixel work is the delta
//! recurrence
//!
//!     d_{n+1} = 2*Z_n*d_n + d_n^2 + dc
//!
//! evaluated in `Floatexp` (a 53-bit mantissa and an unbounded integer
//! exponent), and it runs `iterations x pixels` times. Measured on the JavaScript
//! carrier at a 2^-100 view: **~1.2 microseconds per iteration**, which is
//! ~700 microseconds per pixel at a 600-iteration budget — minutes for one
//! screenful. The arithmetic is not the problem; the allocation and the
//! bit-fiddling around it are. This kernel does the same arithmetic in registers.
//!
//! ## The contract is bit-identity, not a tolerance
//!
//! Every operation here mirrors `src/domain/numeric/floatexp.ts` in the same
//! order, including the normalisation step. That is achievable because the two
//! implementations use the same inputs through the same IEEE-754 operations, and
//! it is what makes the speedup safe: swapping the carrier cannot move a pixel.
//!
//! Three consequences, each deliberate:
//!
//! * **No `log2`.** The host turns the returned magnitude into a continuous
//!   escape count with `Math.log2`, so both carriers use the same libm.
//! * **No fused multiply-add.** `fma` would be *more* accurate and would break
//!   bit-equality. Accuracy is not the goal; matching the pinned reference is.
//! * **No reordering.** `a.m * 2^p + b.m * 2^q` is evaluated left to right, and
//!   the exponent is the maximum of the two, because that is what the JavaScript
//!   does. A "better" formulation would be a different function.
//!
//! ## Shape
//!
//! * **A batch at a time.** One call iterates a run of pixels, so the host pays
//!   the call overhead once per tile rather than once per pixel.
//! * **No allocator, no `std`, no dependencies.** The orbit, the offsets and the
//!   results live in fixed statics whose addresses the host reads and writes.
//! * **Failures are returned, not panicked.** Out-of-range arguments and
//!   non-finite values come back as a status the host raises, because a
//!   `panic` in `no_std` is an `unreachable` with no message.

#![no_std]

use core::panic::PanicInfo;
use core::ptr::addr_of_mut;

#[panic_handler]
fn panic(_info: &PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

/// Widest pixel batch a single call can iterate; the host chunks wider tiles.
pub const MAX_BATCH: usize = 4096;

/// Longest reference orbit the module can hold. A 16k-iteration budget is far
/// beyond anything the ladder asks for; longer is refused rather than truncated.
pub const MAX_ORBIT: usize = 16384;

// ---------------------------------------------------------------------------
// Floatexp: `value = m * 2^e`, normalised so `0.5 <= |m| < 1` (or `m == 0`).
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct Fe {
    m: f64,
    e: i32,
}

const FE_ZERO: Fe = Fe { m: 0.0, e: 0 };

/// Non-finite inputs seen since the last `reset_errors`.
///
/// The JavaScript carrier throws on a non-finite value; here the value cannot
/// carry a message, so it is counted and the host raises. Both carriers fail
/// loudly — they just do it in different places.
static mut ERRORS: u32 = 0;

/// Guard on exponent arithmetic: anything this large is a corrupted input, not a
/// scale, and silently wrapping it would be a wrong answer.
const EXPONENT_LIMIT: i32 = 1_000_000;

/// `2^k` with exactly the semantics of JavaScript's `2 ** k`, including the
/// extremes: `Infinity` above the range and `0` below it (with the subnormal
/// steps in between, which is where `2 ** -1074` stops being zero).
#[inline(always)]
fn pow2i(k: i32) -> f64 {
    if k > 1023 {
        return f64::INFINITY;
    }
    if k >= -1022 {
        return f64::from_bits(((k + 1023) as u64) << 52);
    }
    if k < -1074 {
        return 0.0;
    }
    f64::from_bits(1u64 << (k + 1074))
}

/// Decompose a double into `m * 2^e` with `0.5 <= |m| < 1`.
#[inline(always)]
fn frexp(value: f64) -> Fe {
    if value == 0.0 {
        return FE_ZERO;
    }
    if !value.is_finite() {
        unsafe {
            ERRORS += 1;
        }
        return FE_ZERO;
    }
    let bits = value.to_bits();
    let exponent_bits = ((bits >> 52) & 0x7ff) as i32;
    if exponent_bits == 0 {
        // Subnormal: rescale exactly into the normal range, then correct.
        let scaled = frexp(value * pow2i(54));
        return Fe {
            m: scaled.m,
            e: scaled.e - 54,
        };
    }
    let negative = (bits >> 63) == 1;
    // Clear sign and exponent, force the exponent to 0-bias: leaves `1.f` in
    // [1,2). Dropping the sign bit here is load-bearing — keep it and `-x`
    // comes back positive.
    let unit = f64::from_bits((bits & 0x000f_ffff_ffff_ffff) | (1023u64 << 52));
    Fe {
        m: if negative { -unit } else { unit } / 2.0,
        e: exponent_bits - 1022,
    }
}

/// Build a normalised floatexp from any `mantissa * 2^exponent`.
#[inline(always)]
fn normalize(mantissa: f64, exponent: i32) -> Fe {
    let scaled = frexp(mantissa);
    if scaled.m == 0.0 {
        return FE_ZERO;
    }
    let e = scaled.e + exponent;
    if e > EXPONENT_LIMIT || e < -EXPONENT_LIMIT {
        unsafe {
            ERRORS += 1;
        }
        return FE_ZERO;
    }
    Fe { m: scaled.m, e }
}

#[inline(always)]
fn fe_mul(a: Fe, b: Fe) -> Fe {
    if a.m == 0.0 || b.m == 0.0 {
        return FE_ZERO;
    }
    normalize(a.m * b.m, a.e + b.e)
}

#[inline(always)]
fn fe_add(a: Fe, b: Fe) -> Fe {
    if a.m == 0.0 {
        return b;
    }
    if b.m == 0.0 {
        return a;
    }
    let e = if a.e > b.e { a.e } else { b.e };
    let sum = a.m * pow2i(a.e - e) + b.m * pow2i(b.e - e);
    normalize(sum, e)
}

#[inline(always)]
fn fe_neg(a: Fe) -> Fe {
    if a.m == 0.0 {
        FE_ZERO
    } else {
        Fe { m: -a.m, e: a.e }
    }
}

#[inline(always)]
fn fe_sub(a: Fe, b: Fe) -> Fe {
    fe_add(a, fe_neg(b))
}

/// Magnitude comparison, exactly as the JavaScript orders it: exponents first,
/// then mantissas. Comparing the projected doubles would lose the scale.
#[inline(always)]
fn fe_magnitude_cmp(a: Fe, b: Fe) -> i32 {
    let am = if a.m < 0.0 { -a.m } else { a.m };
    let bm = if b.m < 0.0 { -b.m } else { b.m };
    if am == 0.0 && bm == 0.0 {
        return 0;
    }
    if am == 0.0 {
        return -1;
    }
    if bm == 0.0 {
        return 1;
    }
    if a.e != b.e {
        return if a.e < b.e { -1 } else { 1 };
    }
    if am == bm {
        return 0;
    }
    if am < bm {
        -1
    } else {
        1
    }
}

#[inline(always)]
fn fe_cmp(a: Fe, b: Fe) -> i32 {
    let a_negative = a.m < 0.0;
    let b_negative = b.m < 0.0;
    if a_negative != b_negative {
        return if a_negative { -1 } else { 1 };
    }
    let magnitude = fe_magnitude_cmp(a, b);
    if !a_negative || magnitude == 0 {
        return magnitude;
    }
    if magnitude == 1 {
        -1
    } else {
        1
    }
}

// ---------------------------------------------------------------------------
// FloatComplex, mirroring `src/domain/numeric/floatcomplex.ts`.
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct Fc {
    re: Fe,
    im: Fe,
}

#[inline(always)]
fn fc_add(a: Fc, b: Fc) -> Fc {
    Fc {
        re: fe_add(a.re, b.re),
        im: fe_add(a.im, b.im),
    }
}

#[inline(always)]
fn fc_mul(a: Fc, b: Fc) -> Fc {
    Fc {
        re: fe_sub(fe_mul(a.re, b.re), fe_mul(a.im, b.im)),
        im: fe_add(fe_mul(a.re, b.im), fe_mul(a.im, b.re)),
    }
}

#[inline(always)]
fn fc_abs2(a: Fc) -> Fe {
    fe_add(fe_mul(a.re, a.re), fe_mul(a.im, a.im))
}

// ---------------------------------------------------------------------------
// The constants and the recurrence.
// ---------------------------------------------------------------------------

/// `2^-24`, the glitch threshold. `0.5 * 2^-23` is exactly the JavaScript
/// `fromFloat(2 ** -24)`; a test asserts the two agree.
const GLITCH_THRESHOLD: Fe = Fe { m: 0.5, e: -23 };

/// `4`, the escape radius squared. Exactly `fromFloat(4)`.
const ESCAPE_THRESHOLD: Fe = Fe { m: 0.5, e: 3 };

/// One step: `d_{n+1} = 2*Z_n*d_n + d_n^2 + dc`, in the order the JavaScript
/// evaluates it.
#[inline(always)]
fn delta_step(zn: Fc, d: Fc, dc: Fc) -> Fc {
    let twice_zn = fc_add(zn, zn);
    fc_add(fc_add(fc_mul(twice_zn, d), fc_mul(d, d)), dc)
}

// Reasons a pixel was abandoned, matching `PerturbationResult`'s `reason` field.
const REASON_NONE: i32 = 0;
const REASON_PRECISION: i32 = 1;
const REASON_ORBIT_EXHAUSTED: i32 = 2;


// ---------------------------------------------------------------------------
// f64x2 pairing: two pixels per instruction, sharing the reference value.
// ---------------------------------------------------------------------------
//
// The reference orbit entry `Z_n` is the *same* for every pixel, so `2*Z_n`,
// `|Z_n|^2` and the glitch threshold are computed once per pair instead of once
// per pixel, and the per-pixel arithmetic runs two lanes wide. The lane
// arithmetic mirrors the scalar helpers operation for operation — the whole
// point is that a carrier swap cannot move a pixel — with the branches turned
// into mask selects.
//
// Two paths are deliberately *not* mirrored: a subnormal intermediate and an
// exponent outside the limit are counted as errors here rather than handled,
// because neither is reachable through this ABI (a mantissa product is in
// [0.25, 1) and an aligned sum either cancels exactly or is at least 0.5 in
// magnitude). If one ever appears, the batch fails loudly instead of returning a
// value the scalar path would not have produced.

#[cfg(target_arch = "wasm32")]
use core::arch::wasm32::v128;

/// Bias applied before comparing exponents.
///
/// `i64x2_lt`/`i64x2_gt` compare *unsigned* lanes, and every exponent in this
/// kernel is negative, so a direct comparison is nonsense — the largest-magnitude
/// negative exponent looks like the largest value. Adding a bias far above any
/// exponent puts the ordering back, and the bias cancels because it is added to
/// both sides.
#[cfg(target_arch = "wasm32")]
const EXPONENT_COMPARE_BIAS: i64 = 1 << 40;

#[cfg(target_arch = "wasm32")]
#[inline(always)]
unsafe fn exponent_lt(a: v128, b: v128) -> v128 {
    use core::arch::wasm32::*;
    i64x2_lt(
        i64x2_add(a, i64x2_splat(EXPONENT_COMPARE_BIAS)),
        i64x2_add(b, i64x2_splat(EXPONENT_COMPARE_BIAS)),
    )
}

#[cfg(target_arch = "wasm32")]
#[inline(always)]
unsafe fn exponent_gt(a: v128, b: v128) -> v128 {
    use core::arch::wasm32::*;
    i64x2_gt(
        i64x2_add(a, i64x2_splat(EXPONENT_COMPARE_BIAS)),
        i64x2_add(b, i64x2_splat(EXPONENT_COMPARE_BIAS)),
    )
}

#[cfg(target_arch = "wasm32")]
#[target_feature(enable = "simd128")]
unsafe fn fe2_frexp(m: v128) -> (v128, v128) {
    use core::arch::wasm32::*;
    let bits = m;
    let exponent_bits = v128_and(i64x2_shr(bits, 52), i64x2_splat(0x7ff));
    let negative = i64x2_lt(bits, i64x2_splat(0));
    let mantissa_bits = v128_or(
        v128_and(bits, i64x2_splat(0x000f_ffff_ffff_ffff)),
        i64x2_splat(1023i64 << 52),
    );
    let unit = f64x2_mul(mantissa_bits, f64x2_splat(0.5));
    let signed = v128_bitselect(f64x2_neg(unit), unit, negative);
    // Exponent field zero means zero or subnormal. Zero is filtered by the
    // caller; a subnormal is impossible here and would be a silent divergence,
    // so it is counted.
    let is_subnormal = v128_and(
        i64x2_eq(exponent_bits, i64x2_splat(0)),
        v128_not(f64x2_eq(m, f64x2_splat(0.0))),
    );
    if !v128_any_true(is_subnormal) {
        // nothing
    } else {
        ERRORS += 1;
    }
    let exponent = i64x2_sub(exponent_bits, i64x2_splat(1022));
    (signed, exponent)
}

#[cfg(target_arch = "wasm32")]
#[target_feature(enable = "simd128")]
unsafe fn fe2_normalize(m: v128, e: v128) -> (v128, v128) {
    use core::arch::wasm32::*;
    // Zero is tested on the *input*: the scalar `normalize` gets this from
    // `frexp`'s early return, but the vectorised `frexp` reconstructs a mantissa
    // of 0.5 from a zero exponent field, so testing the result would miss it.
    let is_zero = f64x2_eq(m, f64x2_splat(0.0));
    let (mantissa, exponent) = fe2_frexp(m);
    let sum = i64x2_add(exponent, e);
    let out_of_range = v128_or(
        i64x2_gt(sum, i64x2_splat(EXPONENT_LIMIT as i64)),
        i64x2_lt(sum, i64x2_splat(-(EXPONENT_LIMIT as i64))),
    );
    if v128_any_true(out_of_range) {
        ERRORS += 1;
    }
    (
        v128_bitselect(f64x2_splat(0.0), mantissa, is_zero),
        v128_bitselect(i64x2_splat(0), sum, is_zero),
    )
}

/// `2^k` per lane for the non-positive `k` an exponent alignment produces.
#[cfg(target_arch = "wasm32")]
#[target_feature(enable = "simd128")]
unsafe fn pow2i2(k: v128) -> v128 {
    use core::arch::wasm32::*;
    let biased = i64x2_add(k, i64x2_splat(1023));
    let normal = i64x2_shl(biased, 52);
    let is_normal = exponent_gt(biased, i64x2_splat(0));
    // Below the normal range the exponent is zero; the shift above has already
    // produced garbage there, which the select discards.
    v128_bitselect(normal, i64x2_splat(0), is_normal)
}

#[cfg(target_arch = "wasm32")]
#[target_feature(enable = "simd128")]
unsafe fn fe2_mul(am: v128, ae: v128, bm: v128, be: v128) -> (v128, v128) {
    use core::arch::wasm32::*;
    let is_zero = v128_or(
        f64x2_eq(am, f64x2_splat(0.0)),
        f64x2_eq(bm, f64x2_splat(0.0)),
    );
    let (mantissa, exponent) = fe2_normalize(f64x2_mul(am, bm), i64x2_add(ae, be));
    (
        v128_bitselect(f64x2_splat(0.0), mantissa, is_zero),
        v128_bitselect(i64x2_splat(0), exponent, is_zero),
    )
}

#[cfg(target_arch = "wasm32")]
#[target_feature(enable = "simd128")]
unsafe fn fe2_add(am: v128, ae: v128, bm: v128, be: v128) -> (v128, v128) {
    use core::arch::wasm32::*;
    let a_zero = f64x2_eq(am, f64x2_splat(0.0));
    let b_zero = f64x2_eq(bm, f64x2_splat(0.0));
    let e = v128_bitselect(ae, be, exponent_gt(ae, be));
    let sum = f64x2_add(
        f64x2_mul(am, pow2i2(i64x2_sub(ae, e))),
        f64x2_mul(bm, pow2i2(i64x2_sub(be, e))),
    );
    let (mantissa, exponent) = fe2_normalize(sum, e);
    // The scalar order is: return `b` if `a` is zero, else `a` if `b` is zero.
    // `v128_bitselect(a, b, mask)` keeps `a` where the mask is set, so the
    // replacement value is the *first* argument — the first version had these
    // reversed and zeroed every sum with a zero operand, which for a real delta
    // (zero imaginary part) is almost every sum.
    let mantissa = v128_bitselect(bm, mantissa, a_zero);
    let exponent = v128_bitselect(be, exponent, a_zero);
    let b_only = v128_and(v128_not(a_zero), b_zero);
    let mantissa = v128_bitselect(am, mantissa, b_only);
    let exponent = v128_bitselect(ae, exponent, b_only);
    (mantissa, exponent)
}

#[cfg(target_arch = "wasm32")]
#[target_feature(enable = "simd128")]
unsafe fn fe2_neg(m: v128, e: v128) -> (v128, v128) {
    use core::arch::wasm32::*;
    let is_zero = f64x2_eq(m, f64x2_splat(0.0));
    (
        v128_bitselect(f64x2_splat(0.0), f64x2_neg(m), is_zero),
        v128_bitselect(i64x2_splat(0), e, is_zero),
    )
}

#[cfg(target_arch = "wasm32")]
#[target_feature(enable = "simd128")]
unsafe fn fe2_abs2(m: v128, e: v128) -> (v128, v128) {
    use core::arch::wasm32::*;
    let is_zero = f64x2_eq(m, f64x2_splat(0.0));
    let (mantissa, exponent) = fe2_normalize(f64x2_mul(m, m), i64x2_add(e, e));
    (
        v128_bitselect(f64x2_splat(0.0), mantissa, is_zero),
        v128_bitselect(i64x2_splat(0), exponent, is_zero),
    )
}

/// `a < b` for non-negative `a` and positive `b`, i.e. the glitch test.
#[cfg(target_arch = "wasm32")]
#[target_feature(enable = "simd128")]
unsafe fn fe2_lt_positive(am: v128, ae: v128, bm: v128, be: v128) -> v128 {
    use core::arch::wasm32::*;
    let exponent_lt = exponent_lt(ae, be);
    let exponent_eq = i64x2_eq(ae, be);
    let mantissa_lt = f64x2_lt(am, bm);
    let ordinary = v128_or(exponent_lt, v128_and(exponent_eq, mantissa_lt));
    // Zero is below any positive threshold.
    v128_or(ordinary, f64x2_eq(am, f64x2_splat(0.0)))
}

/// `a > b` for non-negative `a` and positive `b`, i.e. the escape test.
#[cfg(target_arch = "wasm32")]
#[target_feature(enable = "simd128")]
unsafe fn fe2_gt_positive(am: v128, ae: v128, bm: v128, be: v128) -> v128 {
    use core::arch::wasm32::*;
    let exponent_lt_v = exponent_lt(ae, be);
    let exponent_eq = i64x2_eq(ae, be);
    let mantissa_le = v128_or(f64x2_lt(am, bm), f64x2_eq(am, bm));
    let less_or_equal = v128_or(
        exponent_lt_v,
        v128_or(v128_and(exponent_eq, mantissa_le), f64x2_eq(am, f64x2_splat(0.0))),
    );
    v128_not(less_or_equal)
}

// ---------------------------------------------------------------------------
// Buffers.
// ---------------------------------------------------------------------------

static mut ORBIT_RE_M: [f64; MAX_ORBIT] = [0.0; MAX_ORBIT];
static mut ORBIT_RE_E: [i32; MAX_ORBIT] = [0; MAX_ORBIT];
static mut ORBIT_IM_M: [f64; MAX_ORBIT] = [0.0; MAX_ORBIT];
static mut ORBIT_IM_E: [i32; MAX_ORBIT] = [0; MAX_ORBIT];

/// Per-pixel offset `dc`, two doubles (re.m, im.m) and two exponents per pixel.
static mut DC_M: [f64; MAX_BATCH * 2] = [0.0; MAX_BATCH * 2];
static mut DC_E: [i32; MAX_BATCH * 2] = [0; MAX_BATCH * 2];

/// Per-pixel *starting* delta, which is `dc` for plain perturbation and the
/// series evaluation when a prefix was skipped. Same layout as `DC_*`.
static mut START_M: [f64; MAX_BATCH * 2] = [0.0; MAX_BATCH * 2];
static mut START_E: [i32; MAX_BATCH * 2] = [0; MAX_BATCH * 2];

/// Per-pixel iteration the starting delta belongs to.
static mut START_ITER: [i32; MAX_BATCH] = [0; MAX_BATCH];

/// Per-pixel result: `glitched`, `reason`, `escaped`, `iterations`.
static mut OUT_FLAGS: [i32; MAX_BATCH * 4] = [0; MAX_BATCH * 4];
/// Per-pixel jump accounting: `blocks` and `refined`, so the jump kernel reports
/// as much as the JavaScript carrier it replaces. Zero for the exact path.
static mut OUT_BLOCKS: [i32; MAX_BATCH * 2] = [0; MAX_BATCH * 2];
/// Per-pixel `|z|^2` at escape, as mantissa and exponent.
static mut OUT_MAG: [f64; MAX_BATCH * 2] = [0.0; MAX_BATCH * 2];


// ---- the paired loop -------------------------------------------------------

#[cfg(target_arch = "wasm32")]
#[target_feature(enable = "simd128")]
unsafe fn fc2_add(
    ar: v128, ae: v128, ai: v128, aie: v128,
    br: v128, be: v128, bi: v128, bie: v128,
) -> (v128, v128, v128, v128) {
    let (re_m, re_e) = fe2_add(ar, ae, br, be);
    let (im_m, im_e) = fe2_add(ai, aie, bi, bie);
    (re_m, re_e, im_m, im_e)
}

#[cfg(target_arch = "wasm32")]
#[target_feature(enable = "simd128")]
unsafe fn fc2_mul(
    ar: v128, ae: v128, ai: v128, aie: v128,
    br: v128, be: v128, bi: v128, bie: v128,
) -> (v128, v128, v128, v128) {
    let (rr_m, rr_e) = fe2_mul(ar, ae, br, be);
    let (ii_m, ii_e) = fe2_mul(ai, aie, bi, bie);
    let (ri_m, ri_e) = fe2_mul(ar, ae, bi, bie);
    let (ir_m, ir_e) = fe2_mul(ai, aie, br, be);
    // Through the floatexp helpers, not raw lane arithmetic: a subtraction of two
    // normalised values is an *alignment* step, and subtracting mantissas while
    // subtracting exponents is a different function. The first version did that
    // and produced a magnitude the scalar path never would have.
    let (ni_m, ni_e) = fe2_neg(ii_m, ii_e);
    let (re_m, re_e) = fe2_add(rr_m, rr_e, ni_m, ni_e);
    let (im_m, im_e) = fe2_add(ri_m, ri_e, ir_m, ir_e);
    (re_m, re_e, im_m, im_e)
}

#[cfg(target_arch = "wasm32")]
#[target_feature(enable = "simd128")]
unsafe fn fc2_abs2(r: v128, re: v128, i: v128, ie: v128) -> (v128, v128) {
    let (rr_m, rr_e) = fe2_abs2(r, re);
    let (ii_m, ii_e) = fe2_abs2(i, ie);
    fe2_add(rr_m, rr_e, ii_m, ii_e)
}

/// Iterate two pixels together. Returns false when pairing is unavailable.
///
/// Both lanes share the iteration index, which is what makes the reference value
/// — and every quantity derived from it — computed once for the pair.
unsafe fn iterate_pair(
    pixel_a: usize,
    pixel_b: usize,
    orbit: usize,
    max_iterations: u32,
    orbit_re_m: *const f64,
    orbit_re_e: *const i32,
    orbit_im_m: *const f64,
    orbit_im_e: *const i32,
    dc_m: *const f64,
    dc_e: *const i32,
    start_m: *const f64,
    start_e: *const i32,
    start_iter: *const i32,
    out_flags: *mut i32,
    out_mag: *mut f64,
) -> bool {
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = (
            pixel_a, pixel_b, orbit, max_iterations, orbit_re_m, orbit_re_e, orbit_im_m,
            orbit_im_e, dc_m, dc_e, start_m, start_e, start_iter, out_flags, out_mag,
        );
        return false;
    }
    #[cfg(target_arch = "wasm32")]
    {
        use core::arch::wasm32::*;

        macro_rules! lane {
            ($buf:expr, $offset:expr) => {
                f64x2(*$buf.add(pixel_a * 2 + $offset), *$buf.add(pixel_b * 2 + $offset))
            };
        }
        macro_rules! lane_e {
            ($buf:expr, $offset:expr) => {
                i64x2(
                    *$buf.add(pixel_a * 2 + $offset) as i64,
                    *$buf.add(pixel_b * 2 + $offset) as i64,
                )
            };
        }

        let dc_re_m = lane!(dc_m, 0);
        let dc_re_e = lane_e!(dc_e, 0);
        let dc_im_m = lane!(dc_m, 1);
        let dc_im_e = lane_e!(dc_e, 1);
        let mut d_re_m = lane!(start_m, 0);
        let mut d_re_e = lane_e!(start_e, 0);
        let mut d_im_m = lane!(start_m, 1);
        let mut d_im_e = lane_e!(start_e, 1);

        let start = *start_iter.add(pixel_a) as u32;
        let mut n = start;
        let mut active = i64x2_splat(-1);
        let mut escaped_mask = i64x2_splat(0);
        let mut escape_iter = i64x2_splat(0);
        let mut escape_mag_m = f64x2_splat(0.0);
        let mut escape_mag_e = i64x2_splat(0);
        let mut glitch_mask = i64x2_splat(0);
        let mut glitch_iter = i64x2_splat(0);
        let mut exhausted_mask = i64x2_splat(0);

        while n <= max_iterations {
            if n as usize >= orbit {
                exhausted_mask = active;
                glitch_iter = v128_bitselect(i64x2_splat(n as i64), glitch_iter, active);
                break;
            }
            let index = n as usize;
            let zn_re_m = f64x2_splat(*orbit_re_m.add(index));
            let zn_re_e = i64x2_splat(*orbit_re_e.add(index) as i64);
            let zn_im_m = f64x2_splat(*orbit_im_m.add(index));
            let zn_im_e = i64x2_splat(*orbit_im_e.add(index) as i64);

            let (zr_m, zr_e, zi_m, zi_e) = fc2_add(
                zn_re_m, zn_re_e, zn_im_m, zn_im_e,
                d_re_m, d_re_e, d_im_m, d_im_e,
            );
            let (mag_m, mag_e) = fc2_abs2(zr_m, zr_e, zi_m, zi_e);

            // The reference quantities are shared by both lanes, so they are
            // computed once with the scalar helpers and broadcast.
            let reference = fc_abs2(Fc {
                re: Fe { m: *orbit_re_m.add(index), e: *orbit_re_e.add(index) },
                im: Fe { m: *orbit_im_m.add(index), e: *orbit_im_e.add(index) },
            });
            let threshold = fe_mul(reference, GLITCH_THRESHOLD);

            let glitched = v128_and(
                fe2_lt_positive(
                    mag_m,
                    mag_e,
                    f64x2_splat(threshold.m),
                    i64x2_splat(threshold.e as i64),
                ),
                active,
            );
            let escaped = v128_and(
                v128_and(
                    fe2_gt_positive(
                        mag_m,
                        mag_e,
                        f64x2_splat(ESCAPE_THRESHOLD.m),
                        i64x2_splat(ESCAPE_THRESHOLD.e as i64),
                    ),
                    active,
                ),
                v128_not(glitched),
            );
            let newly_escaped = v128_and(escaped, v128_not(escaped_mask));
            escape_iter = v128_bitselect(i64x2_splat(n as i64), escape_iter, newly_escaped);
            escape_mag_m = v128_bitselect(mag_m, escape_mag_m, newly_escaped);
            escape_mag_e = v128_bitselect(mag_e, escape_mag_e, newly_escaped);
            escaped_mask = v128_or(escaped_mask, escaped);

            let newly_glitched = v128_and(glitched, v128_not(glitch_mask));
            glitch_iter = v128_bitselect(i64x2_splat(n as i64), glitch_iter, newly_glitched);
            glitch_mask = v128_or(glitch_mask, glitched);

            active = v128_and(active, v128_not(v128_or(glitched, escaped)));
            if !v128_any_true(active) {
                break;
            }

            // Advance only the lanes still running: an escaped lane's delta must
            // not keep growing, or `inf - inf` would turn a recorded magnitude
            // into NaN on the next step.
            let (twice_re_m, twice_re_e, twice_im_m, twice_im_e) = fc2_add(
                zn_re_m, zn_re_e, zn_im_m, zn_im_e,
                zn_re_m, zn_re_e, zn_im_m, zn_im_e,
            );
            let (p_m, p_e, q_m, q_e) = fc2_mul(
                twice_re_m, twice_re_e, twice_im_m, twice_im_e,
                d_re_m, d_re_e, d_im_m, d_im_e,
            );
            let (s_m, s_e, t_m, t_e) = fc2_mul(d_re_m, d_re_e, d_im_m, d_im_e, d_re_m, d_re_e, d_im_m, d_im_e);
            let (u_m, u_e, v_m, v_e) = fc2_add(p_m, p_e, q_m, q_e, s_m, s_e, t_m, t_e);
            let (next_re_m, next_re_e, next_im_m, next_im_e) =
                fc2_add(u_m, u_e, v_m, v_e, dc_re_m, dc_re_e, dc_im_m, dc_im_e);

            d_re_m = v128_bitselect(next_re_m, d_re_m, active);
            d_re_e = v128_bitselect(next_re_e, d_re_e, active);
            d_im_m = v128_bitselect(next_im_m, d_im_m, active);
            d_im_e = v128_bitselect(next_im_e, d_im_e, active);

            n += 1;
        }

        let write = |lane: usize, glitched: bool, exhausted: bool, escaped: bool, iterations: i64, mag_m: f64, mag_e: i64| {
            let pixel = if lane == 0 { pixel_a } else { pixel_b };
            let mut reason = REASON_NONE;
            let mut final_iterations = max_iterations as i64;
            let mut final_mag_m = 0.0f64;
            let mut final_mag_e = 0i64;
            if glitched {
                reason = if exhausted { REASON_ORBIT_EXHAUSTED } else { REASON_PRECISION };
                final_iterations = iterations;
            } else if escaped {
                final_iterations = iterations;
                final_mag_m = mag_m;
                final_mag_e = mag_e;
            }
            *out_flags.add(pixel * 4) = if glitched { 1 } else { 0 };
            *out_flags.add(pixel * 4 + 1) = reason;
            *out_flags.add(pixel * 4 + 2) = if escaped { 1 } else { 0 };
            *out_flags.add(pixel * 4 + 3) = final_iterations as i32;
            *out_mag.add(pixel * 2) = final_mag_m;
            *out_mag.add(pixel * 2 + 1) = final_mag_e as f64;
        };

        for lane in 0..2usize {
            let exhausted = extract_i64(exhausted_mask, lane) != 0;
            // Exhaustion is a refusal too: the reference orbit ran out, so the
            // pixel's delta cannot be trusted. Testing only `glitch_mask` here
            // reported those pixels as bounded, which is the one answer that is
            // definitely wrong.
            let glitched = extract_i64(glitch_mask, lane) != 0 || exhausted;
            let escaped = extract_i64(escaped_mask, lane) != 0;
            let iterations = if glitched {
                extract_i64(glitch_iter, lane)
            } else {
                extract_i64(escape_iter, lane)
            };
            let mag_m = extract_f64(escape_mag_m, lane);
            let mag_e = extract_i64(escape_mag_e, lane);
            write(lane, glitched, exhausted, escaped, iterations, mag_m, mag_e);
        }
        true
    }
}

#[cfg(target_arch = "wasm32")]
#[target_feature(enable = "simd128")]
unsafe fn extract_i64(value: v128, lane: usize) -> i64 {
    use core::arch::wasm32::*;
    if lane == 0 {
        i64x2_extract_lane::<0>(value)
    } else {
        i64x2_extract_lane::<1>(value)
    }
}

#[cfg(target_arch = "wasm32")]
#[target_feature(enable = "simd128")]
unsafe fn extract_f64(value: v128, lane: usize) -> f64 {
    use core::arch::wasm32::*;
    if lane == 0 {
        f64x2_extract_lane::<0>(value)
    } else {
        f64x2_extract_lane::<1>(value)
    }
}


// ---------------------------------------------------------------------------
// Bivariate linear approximation: jump whole blocks at once.
// ---------------------------------------------------------------------------
//
// The tables are composed on the host, in JavaScript, by the same code the
// JavaScript carrier uses — so the two carriers apply *identical* coefficients
// and can be held to bit-identity. This side only applies them:
//
//     d <- A(n, 2^j) * d + B(n, 2^j) * dc
//
// which is two complex multiplies instead of `2^j` iterations. The loop mirrors
// `escapePerturbedWithBla` exactly, including the exact re-iteration of the block
// that escaped, so the escape count is placed rather than guessed.

/// Longest orbit the BLA tables can cover. Longer budgets stay on the exact
/// kernel rather than silently losing their tail.
pub const MAX_BLA_INDEX: usize = 8192;

/// Largest block exponent the tables carry (a block of `2^6 = 64`).
pub const MAX_BLA_LEVEL: usize = 6;

/// `(A.re, A.im, B.re, B.im)` per (level, index), mantissa then exponent.
static mut BLA_M: [f64; (MAX_BLA_LEVEL + 1) * MAX_BLA_INDEX * 4] =
    [0.0; (MAX_BLA_LEVEL + 1) * MAX_BLA_INDEX * 4];
static mut BLA_E: [i32; (MAX_BLA_LEVEL + 1) * MAX_BLA_INDEX * 4] =
    [0; (MAX_BLA_LEVEL + 1) * MAX_BLA_INDEX * 4];

#[no_mangle]
pub extern "C" fn bla_m_ptr() -> *mut f64 {
    addr_of_mut!(BLA_M).cast::<f64>()
}

#[no_mangle]
pub extern "C" fn bla_e_ptr() -> *mut i32 {
    addr_of_mut!(BLA_E).cast::<i32>()
}

#[no_mangle]
pub extern "C" fn bla_index_capacity() -> u32 {
    MAX_BLA_INDEX as u32
}

#[no_mangle]
pub extern "C" fn bla_level_capacity() -> u32 {
    MAX_BLA_LEVEL as u32
}

/// Read one `(A, B)` pair for a level and index.
#[inline(always)]
unsafe fn bla_read(level: usize, index: usize) -> (Fc, Fc) {
    let base = (level * MAX_BLA_INDEX + index) * 4;
    let m = addr_of_mut!(BLA_M).cast::<f64>();
    let e = addr_of_mut!(BLA_E).cast::<i32>();
    let a = Fc {
        re: Fe { m: *m.add(base), e: *e.add(base) },
        im: Fe { m: *m.add(base + 1), e: *e.add(base + 1) },
    };
    let b = Fc {
        re: Fe { m: *m.add(base + 2), e: *e.add(base + 2) },
        im: Fe { m: *m.add(base + 3), e: *e.add(base + 3) },
    };
    (a, b)
}

/// One jump: `A*d + B*dc`, in the order the JavaScript carrier evaluates it.
#[inline(always)]
fn apply_jump(a: Fc, b: Fc, d: Fc, dc: Fc) -> Fc {
    fc_add(fc_mul(a, d), fc_mul(b, dc))
}


// ---- the paired jump loop --------------------------------------------------
//
// The same structure as the paired exact loop: two pixels advance together while
// both are running, the reference-dependent work is shared, and finished lanes
// are frozen by mask. What is *not* shared is each lane's last block — a lane
// that has escaped stops advancing while the other keeps jumping — so those ride
// in vectors too.
//
// An escaping lane's block is re-iterated exactly, per lane, after the loop: it
// happens at most once per pixel and only for pixels that escape, so it stays
// scalar rather than doubling the mask machinery.

#[cfg(target_arch = "wasm32")]
#[target_feature(enable = "simd128")]
unsafe fn iterate_bla_pair(
    pixel_a: usize,
    pixel_b: usize,
    orbit: usize,
    block_exponent: u32,
    max_iterations: u32,
    orbit_re_m: *const f64,
    orbit_re_e: *const i32,
    orbit_im_m: *const f64,
    orbit_im_e: *const i32,
    dc_m: *const f64,
    dc_e: *const i32,
    start_m: *const f64,
    start_e: *const i32,
    start_iter: *const i32,
    out_flags: *mut i32,
    out_mag: *mut f64,
) -> bool {
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = (
            pixel_a, pixel_b, orbit, block_exponent, max_iterations, orbit_re_m, orbit_re_e,
            orbit_im_m, orbit_im_e, dc_m, dc_e, start_m, start_e, start_iter, out_flags, out_mag,
        );
        return false;
    }
    #[cfg(target_arch = "wasm32")]
    {
        use core::arch::wasm32::*;

        macro_rules! lane {
            ($buf:expr, $offset:expr) => {
                f64x2(*$buf.add(pixel_a * 2 + $offset), *$buf.add(pixel_b * 2 + $offset))
            };
        }
        macro_rules! lane_e {
            ($buf:expr, $offset:expr) => {
                i64x2(
                    *$buf.add(pixel_a * 2 + $offset) as i64,
                    *$buf.add(pixel_b * 2 + $offset) as i64,
                )
            };
        }

        let dc_re_m = lane!(dc_m, 0);
        let dc_re_e = lane_e!(dc_e, 0);
        let dc_im_m = lane!(dc_m, 1);
        let dc_im_e = lane_e!(dc_e, 1);
        let mut d_re_m = lane!(start_m, 0);
        let mut d_re_e = lane_e!(start_e, 0);
        let mut d_im_m = lane!(start_m, 1);
        let mut d_im_e = lane_e!(start_e, 1);

        let jump = 1u32 << block_exponent;
        let mut n = *start_iter.add(pixel_a) as u32;
        let mut active = i64x2_splat(-1);
        let mut escaped_mask = i64x2_splat(0);
        let mut glitch_mask = i64x2_splat(0);
        let mut exhausted_mask = i64x2_splat(0);
        let mut escape_iter = i64x2_splat(0);
        let mut glitch_iter = i64x2_splat(0);
        let mut escape_mag_m = f64x2_splat(0.0);
        let mut escape_mag_e = i64x2_splat(0);
        let mut blocks = i64x2_splat(0);
        let mut refined_mask = i64x2_splat(0);
        // Per-lane memory of the block that produced the current delta.
        let mut last_start = i64x2_splat(0);
        let mut last_length = i64x2_splat(1);
        let mut last_re_m = f64x2_splat(0.0);
        let mut last_re_e = i64x2_splat(0);
        let mut last_im_m = f64x2_splat(0.0);
        let mut last_im_e = i64x2_splat(0);

        while n <= max_iterations {
            if n as usize >= orbit {
                exhausted_mask = active;
                glitch_iter = v128_bitselect(i64x2_splat(n as i64), glitch_iter, active);
                break;
            }
            let index = n as usize;
            let zn_re_m = f64x2_splat(*orbit_re_m.add(index));
            let zn_re_e = i64x2_splat(*orbit_re_e.add(index) as i64);
            let zn_im_m = f64x2_splat(*orbit_im_m.add(index));
            let zn_im_e = i64x2_splat(*orbit_im_e.add(index) as i64);

            let (zr_m, zr_e, zi_m, zi_e) = fc2_add(
                zn_re_m, zn_re_e, zn_im_m, zn_im_e,
                d_re_m, d_re_e, d_im_m, d_im_e,
            );
            let (mag_m, mag_e) = fc2_abs2(zr_m, zr_e, zi_m, zi_e);

            let reference = fc_abs2(Fc {
                re: Fe { m: *orbit_re_m.add(index), e: *orbit_re_e.add(index) },
                im: Fe { m: *orbit_im_m.add(index), e: *orbit_im_e.add(index) },
            });
            let threshold = fe_mul(reference, GLITCH_THRESHOLD);

            let glitched = v128_and(
                fe2_lt_positive(
                    mag_m,
                    mag_e,
                    f64x2_splat(threshold.m),
                    i64x2_splat(threshold.e as i64),
                ),
                active,
            );
            let escaped = v128_and(
                v128_and(
                    fe2_gt_positive(
                        mag_m,
                        mag_e,
                        f64x2_splat(ESCAPE_THRESHOLD.m),
                        i64x2_splat(ESCAPE_THRESHOLD.e as i64),
                    ),
                    active,
                ),
                v128_not(glitched),
            );

            let newly_escaped = v128_and(escaped, v128_not(escaped_mask));
            escape_iter = v128_bitselect(i64x2_splat(n as i64), escape_iter, newly_escaped);
            escape_mag_m = v128_bitselect(mag_m, escape_mag_m, newly_escaped);
            escape_mag_e = v128_bitselect(mag_e, escape_mag_e, newly_escaped);
            // A jumped block is re-iterated exactly, which is what the JavaScript
            // carrier reports — whether or not the escape is found inside it.
            let jumped = exponent_gt(last_length, i64x2_splat(1));
            refined_mask = v128_bitselect(
                i64x2_splat(1),
                refined_mask,
                v128_and(newly_escaped, jumped),
            );
            escaped_mask = v128_or(escaped_mask, escaped);

            let newly_glitched = v128_and(glitched, v128_not(glitch_mask));
            glitch_iter = v128_bitselect(i64x2_splat(n as i64), glitch_iter, newly_glitched);
            glitch_mask = v128_or(glitch_mask, glitched);

            active = v128_and(active, v128_not(v128_or(glitched, escaped)));
            if !v128_any_true(active) {
                break;
            }

            let remaining = max_iterations - n + 1;
            let usable = if jump > 1 && jump <= remaining && n + jump - 1 < orbit as u32 {
                jump
            } else {
                1
            };
            // Remember the block for every *active* lane before moving on.
            last_start = v128_bitselect(i64x2_splat(n as i64), last_start, active);
            last_length = v128_bitselect(i64x2_splat(usable as i64), last_length, active);
            last_re_m = v128_bitselect(d_re_m, last_re_m, active);
            last_re_e = v128_bitselect(d_re_e, last_re_e, active);
            last_im_m = v128_bitselect(d_im_m, last_im_m, active);
            last_im_e = v128_bitselect(d_im_e, last_im_e, active);

            if usable == 1 {
                let (tr_m, tr_e, ti_m, ti_e) =
                    fc2_add(zn_re_m, zn_re_e, zn_im_m, zn_im_e, zn_re_m, zn_re_e, zn_im_m, zn_im_e);
                let (p_m, p_e, q_m, q_e) =
                    fc2_mul(tr_m, tr_e, ti_m, ti_e, d_re_m, d_re_e, d_im_m, d_im_e);
                let (s_m, s_e, t_m, t_e) =
                    fc2_mul(d_re_m, d_re_e, d_im_m, d_im_e, d_re_m, d_re_e, d_im_m, d_im_e);
                let (u_m, u_e, v_m, v_e) = fc2_add(p_m, p_e, q_m, q_e, s_m, s_e, t_m, t_e);
                let (nr_m, nr_e, ni_m, ni_e) =
                    fc2_add(u_m, u_e, v_m, v_e, dc_re_m, dc_re_e, dc_im_m, dc_im_e);
                d_re_m = v128_bitselect(nr_m, d_re_m, active);
                d_re_e = v128_bitselect(nr_e, d_re_e, active);
                d_im_m = v128_bitselect(ni_m, d_im_m, active);
                d_im_e = v128_bitselect(ni_e, d_im_e, active);
            } else {
                // The tables are shared by both lanes: one read, one jump, twice
                // the arithmetic.
                let base = (block_exponent as usize * MAX_BLA_INDEX + n as usize) * 4;
                let table_m = addr_of_mut!(BLA_M).cast::<f64>();
                let table_e = addr_of_mut!(BLA_E).cast::<i32>();
                let a_re_m = f64x2_splat(*table_m.add(base));
                let a_re_e = i64x2_splat(*table_e.add(base) as i64);
                let a_im_m = f64x2_splat(*table_m.add(base + 1));
                let a_im_e = i64x2_splat(*table_e.add(base + 1) as i64);
                let b_re_m = f64x2_splat(*table_m.add(base + 2));
                let b_re_e = i64x2_splat(*table_e.add(base + 2) as i64);
                let b_im_m = f64x2_splat(*table_m.add(base + 3));
                let b_im_e = i64x2_splat(*table_e.add(base + 3) as i64);

                let (ad_m, ad_e, adi_m, adi_e) = fc2_mul(
                    a_re_m, a_re_e, a_im_m, a_im_e,
                    d_re_m, d_re_e, d_im_m, d_im_e,
                );
                let (bd_m, bd_e, bdi_m, bdi_e) = fc2_mul(
                    b_re_m, b_re_e, b_im_m, b_im_e,
                    dc_re_m, dc_re_e, dc_im_m, dc_im_e,
                );
                let (nr_m, nr_e, ni_m, ni_e) = fc2_add(
                    ad_m, ad_e, adi_m, adi_e,
                    bd_m, bd_e, bdi_m, bdi_e,
                );
                d_re_m = v128_bitselect(nr_m, d_re_m, active);
                d_re_e = v128_bitselect(nr_e, d_re_e, active);
                d_im_m = v128_bitselect(ni_m, d_im_m, active);
                d_im_e = v128_bitselect(ni_e, d_im_e, active);
                blocks = i64x2_add(blocks, v128_and(active, i64x2_splat(1)));
            }
            n += usable;
        }

        for lane in 0..2usize {
            let pixel = if lane == 0 { pixel_a } else { pixel_b };
            let exhausted = extract_i64(exhausted_mask, lane) != 0;
            let escaped = extract_i64(escaped_mask, lane) != 0;
            let glitched = extract_i64(glitch_mask, lane) != 0 || exhausted;
            let mut iterations = if glitched {
                extract_i64(glitch_iter, lane)
            } else if escaped {
                extract_i64(escape_iter, lane)
            } else {
                max_iterations as i64
            };
            let mut mag_m = if escaped { extract_f64(escape_mag_m, lane) } else { 0.0 };
            let mut mag_e = if escaped { extract_i64(escape_mag_e, lane) } else { 0i64 };
            let mut refined = extract_i64(refined_mask, lane) != 0;
            // This lane's own offset, for the exact re-iteration below.
            let lane_dc = Fc {
                re: Fe { m: *dc_m.add(pixel * 2), e: *dc_e.add(pixel * 2) },
                im: Fe { m: *dc_m.add(pixel * 2 + 1), e: *dc_e.add(pixel * 2 + 1) },
            };

            // Place an escaped, jumped block exactly.
            if escaped && refined {
                let mut exact_d = Fc {
                    re: Fe { m: extract_f64(last_re_m, lane), e: extract_i64(last_re_e, lane) as i32 },
                    im: Fe { m: extract_f64(last_im_m, lane), e: extract_i64(last_im_e, lane) as i32 },
                };
                let mut exact_n = extract_i64(last_start, lane);
                let mut placed = false;
                while exact_n < iterations {
                    let step_zn = Fc {
                        re: Fe {
                            m: *orbit_re_m.add(exact_n as usize),
                            e: *orbit_re_e.add(exact_n as usize),
                        },
                        im: Fe {
                            m: *orbit_im_m.add(exact_n as usize),
                            e: *orbit_im_e.add(exact_n as usize),
                        },
                    };
                    let step_z = fc_add(step_zn, exact_d);
                    let step_magnitude = fc_abs2(step_z);
                    if fe_cmp(step_magnitude, ESCAPE_THRESHOLD) > 0 {
                        iterations = exact_n;
                        mag_m = step_magnitude.m;
                        mag_e = step_magnitude.e as i64;
                        placed = true;
                        break;
                    }
                    exact_d = delta_step(step_zn, exact_d, lane_dc);
                    exact_n += 1;
                }
                if !placed {
                    refined = true;
                }
            }

            *out_flags.add(pixel * 4) = if glitched { 1 } else { 0 };
            *out_flags.add(pixel * 4 + 1) = if glitched {
                if exhausted {
                    REASON_ORBIT_EXHAUSTED
                } else {
                    REASON_PRECISION
                }
            } else {
                REASON_NONE
            };
            *out_flags.add(pixel * 4 + 2) = if escaped { 1 } else { 0 };
            *out_flags.add(pixel * 4 + 3) = iterations as i32;
            *out_mag.add(pixel * 2) = mag_m;
            *out_mag.add(pixel * 2 + 1) = mag_e as f64;
            let out_blocks = addr_of_mut!(OUT_BLOCKS).cast::<i32>();
            *out_blocks.add(pixel * 2) = extract_i64(blocks, lane) as i32;
            *out_blocks.add(pixel * 2 + 1) = if refined { 1 } else { 0 };
        }
        true
    }
}

/// Iterate one pixel with jumps, mirroring `escapePerturbedWithBla`.
#[inline(always)]
unsafe fn iterate_one_bla(
    pixel: usize,
    orbit: usize,
    block_exponent: u32,
    max_iterations: u32,
    orbit_re_m: *const f64,
    orbit_re_e: *const i32,
    orbit_im_m: *const f64,
    orbit_im_e: *const i32,
    dc_m: *const f64,
    dc_e: *const i32,
    start_m: *const f64,
    start_e: *const i32,
    start_iter: *const i32,
    out_flags: *mut i32,
    out_mag: *mut f64,
) {
    let dc = Fc {
        re: Fe { m: *dc_m.add(pixel * 2), e: *dc_e.add(pixel * 2) },
        im: Fe { m: *dc_m.add(pixel * 2 + 1), e: *dc_e.add(pixel * 2 + 1) },
    };
    let jump = 1u32 << block_exponent;
    let mut d = Fc {
        re: Fe { m: *start_m.add(pixel * 2), e: *start_e.add(pixel * 2) },
        im: Fe { m: *start_m.add(pixel * 2 + 1), e: *start_e.add(pixel * 2 + 1) },
    };
    let mut n = *start_iter.add(pixel) as u32;
    let mut blocks = 0u32;
    // The block that produced the current delta, so an escape found *at*
    // iteration `n` can be placed exactly by re-iterating that block.
    let mut last_start = n;
    let mut last_delta = d;
    let mut last_length = 1u32;

    let mut glitched = 0i32;
    let mut reason = REASON_NONE;
    let mut escaped = 0i32;
    let mut iterations = max_iterations;
    let mut mag_m = 0.0f64;
    let mut mag_e = 0i32;
    let mut refined = 0i32;

    while n <= max_iterations {
        if n as usize >= orbit {
            glitched = 1;
            reason = REASON_ORBIT_EXHAUSTED;
            iterations = n;
            break;
        }
        let zn = Fc {
            re: Fe { m: *orbit_re_m.add(n as usize), e: *orbit_re_e.add(n as usize) },
            im: Fe { m: *orbit_im_m.add(n as usize), e: *orbit_im_e.add(n as usize) },
        };
        let z = fc_add(zn, d);
        let magnitude_squared = fc_abs2(z);
        if fe_cmp(magnitude_squared, fe_mul(fc_abs2(zn), GLITCH_THRESHOLD)) < 0 {
            glitched = 1;
            reason = REASON_PRECISION;
            iterations = n;
            break;
        }
        if fe_cmp(magnitude_squared, ESCAPE_THRESHOLD) > 0 {
            escaped = 1;
            // `refined` means "this block was re-iterated", which is what the
            // JavaScript carrier reports — including when the re-iteration finds
            // no escape inside the block. Reporting it only on success made the
            // two carriers differ on exactly those pixels.
            refined = if last_length > 1 { 1 } else { 0 };
            if last_length > 1 {
                let mut exact_d = last_delta;
                let mut exact_n = last_start;
                let mut placed = false;
                while exact_n < n {
                    let step_zn = Fc {
                        re: Fe {
                            m: *orbit_re_m.add(exact_n as usize),
                            e: *orbit_re_e.add(exact_n as usize),
                        },
                        im: Fe {
                            m: *orbit_im_m.add(exact_n as usize),
                            e: *orbit_im_e.add(exact_n as usize),
                        },
                    };
                    let step_z = fc_add(step_zn, exact_d);
                    let step_magnitude = fc_abs2(step_z);
                    if fe_cmp(step_magnitude, ESCAPE_THRESHOLD) > 0 {
                        iterations = exact_n;
                        mag_m = step_magnitude.m;
                        mag_e = step_magnitude.e;
                        placed = true;
                        break;
                    }
                    exact_d = delta_step(step_zn, exact_d, dc);
                    exact_n += 1;
                }
                if placed {
                    break;
                }
            }
            iterations = n;
            mag_m = magnitude_squared.m;
            mag_e = magnitude_squared.e;
            break;
        }

        let remaining = max_iterations - n + 1;
        let usable = if jump > 1 && jump <= remaining && n + jump - 1 < orbit as u32 {
            jump
        } else {
            1
        };
        last_start = n;
        last_delta = d;
        last_length = usable;
        if usable == 1 {
            d = delta_step(zn, d, dc);
        } else {
            let (a, b) = bla_read(block_exponent as usize, n as usize);
            d = apply_jump(a, b, d, dc);
            blocks += 1;
        }
        n += usable;
    }

    *out_flags.add(pixel * 4) = glitched;
    *out_flags.add(pixel * 4 + 1) = reason;
    *out_flags.add(pixel * 4 + 2) = escaped;
    *out_flags.add(pixel * 4 + 3) = iterations as i32;
    *out_mag.add(pixel * 2) = mag_m;
    *out_mag.add(pixel * 2 + 1) = mag_e as f64;
    let out_blocks = addr_of_mut!(OUT_BLOCKS).cast::<i32>();
    *out_blocks.add(pixel * 2) = blocks as i32;
    *out_blocks.add(pixel * 2 + 1) = refined as i32;
}

/// Iterate a batch with jumps. Mirrors `iterate_batch`'s contract.
#[no_mangle]
pub extern "C" fn iterate_batch_bla(
    orbit_len: u32,
    count: u32,
    max_iterations: u32,
    block_exponent: u32,
) -> u32 {
    if orbit_len < 2 || orbit_len as usize > MAX_BLA_INDEX {
        return 1;
    }
    if count == 0 || count as usize > MAX_BATCH {
        return 2;
    }
    if max_iterations < 1 {
        return 3;
    }
    if block_exponent > MAX_BLA_LEVEL as u32 {
        return 5;
    }
    let orbit = orbit_len as usize;
    let n_pixels = count as usize;
    unsafe {
        ERRORS = 0;
        let dc_m = addr_of_mut!(DC_M).cast::<f64>();
        let dc_e = addr_of_mut!(DC_E).cast::<i32>();
        let start_m = addr_of_mut!(START_M).cast::<f64>();
        let start_e = addr_of_mut!(START_E).cast::<i32>();
        let start_iter = addr_of_mut!(START_ITER).cast::<i32>();
        let flags = addr_of_mut!(OUT_FLAGS).cast::<i32>();
        let mag = addr_of_mut!(OUT_MAG).cast::<f64>();
        let orbit_re_m = addr_of_mut!(ORBIT_RE_M).cast::<f64>();
        let orbit_re_e = addr_of_mut!(ORBIT_RE_E).cast::<i32>();
        let orbit_im_m = addr_of_mut!(ORBIT_IM_M).cast::<f64>();
        let orbit_im_e = addr_of_mut!(ORBIT_IM_E).cast::<i32>();

        let mut pixel = 0usize;
        while pixel < n_pixels {
            if pixel + 1 < n_pixels
                && *start_iter.add(pixel) == *start_iter.add(pixel + 1)
                && iterate_bla_pair(
                    pixel,
                    pixel + 1,
                    orbit,
                    block_exponent,
                    max_iterations,
                    orbit_re_m,
                    orbit_re_e,
                    orbit_im_m,
                    orbit_im_e,
                    dc_m,
                    dc_e,
                    start_m,
                    start_e,
                    start_iter,
                    flags,
                    mag,
                )
            {
                pixel += 2;
                continue;
            }
            iterate_one_bla(
                pixel,
                orbit,
                block_exponent,
                max_iterations,
                orbit_re_m,
                orbit_re_e,
                orbit_im_m,
                orbit_im_e,
                dc_m,
                dc_e,
                start_m,
                start_e,
                start_iter,
                flags,
                mag,
            );
            pixel += 1;
        }
        if ERRORS > 0 {
            return 4;
        }
    }
    0
}

#[no_mangle]
pub extern "C" fn batch_capacity() -> u32 {
    MAX_BATCH as u32
}

#[no_mangle]
pub extern "C" fn orbit_capacity() -> u32 {
    MAX_ORBIT as u32
}

#[no_mangle]
pub extern "C" fn orbit_re_m_ptr() -> *mut f64 {
    addr_of_mut!(ORBIT_RE_M).cast::<f64>()
}

#[no_mangle]
pub extern "C" fn orbit_re_e_ptr() -> *mut i32 {
    addr_of_mut!(ORBIT_RE_E).cast::<i32>()
}

#[no_mangle]
pub extern "C" fn orbit_im_m_ptr() -> *mut f64 {
    addr_of_mut!(ORBIT_IM_M).cast::<f64>()
}

#[no_mangle]
pub extern "C" fn orbit_im_e_ptr() -> *mut i32 {
    addr_of_mut!(ORBIT_IM_E).cast::<i32>()
}

#[no_mangle]
pub extern "C" fn dc_m_ptr() -> *mut f64 {
    addr_of_mut!(DC_M).cast::<f64>()
}

#[no_mangle]
pub extern "C" fn dc_e_ptr() -> *mut i32 {
    addr_of_mut!(DC_E).cast::<i32>()
}

#[no_mangle]
pub extern "C" fn start_m_ptr() -> *mut f64 {
    addr_of_mut!(START_M).cast::<f64>()
}

#[no_mangle]
pub extern "C" fn start_e_ptr() -> *mut i32 {
    addr_of_mut!(START_E).cast::<i32>()
}

#[no_mangle]
pub extern "C" fn start_iter_ptr() -> *mut i32 {
    addr_of_mut!(START_ITER).cast::<i32>()
}

#[no_mangle]
pub extern "C" fn out_flags_ptr() -> *mut i32 {
    addr_of_mut!(OUT_FLAGS).cast::<i32>()
}

#[no_mangle]
pub extern "C" fn out_blocks_ptr() -> *mut i32 {
    addr_of_mut!(OUT_BLOCKS).cast::<i32>()
}

#[no_mangle]
pub extern "C" fn out_mag_ptr() -> *mut f64 {
    addr_of_mut!(OUT_MAG).cast::<f64>()
}

/// Number of non-finite values seen since the last reset.
#[no_mangle]
pub extern "C" fn errors() -> u32 {
    unsafe { ERRORS }
}

#[no_mangle]
pub extern "C" fn reset_errors() {
    unsafe {
        ERRORS = 0;
    }
}

/// Iterate `count` pixels against the uploaded orbit.
///
/// Returns `0` on success; any other value is a refusal the host must raise.
#[no_mangle]
pub extern "C" fn iterate_batch(orbit_len: u32, count: u32, max_iterations: u32) -> u32 {
    if orbit_len < 2 || orbit_len as usize > MAX_ORBIT {
        return 1;
    }
    if count == 0 || count as usize > MAX_BATCH {
        return 2;
    }
    if max_iterations < 1 {
        return 3;
    }

    let orbit = orbit_len as usize;
    let n_pixels = count as usize;
    unsafe {
        ERRORS = 0;
        let dc_m = addr_of_mut!(DC_M).cast::<f64>();
        let dc_e = addr_of_mut!(DC_E).cast::<i32>();
        let start_m = addr_of_mut!(START_M).cast::<f64>();
        let start_e = addr_of_mut!(START_E).cast::<i32>();
        let start_iter = addr_of_mut!(START_ITER).cast::<i32>();
        let flags = addr_of_mut!(OUT_FLAGS).cast::<i32>();
        let mag = addr_of_mut!(OUT_MAG).cast::<f64>();
        let orbit_re_m = addr_of_mut!(ORBIT_RE_M).cast::<f64>();
        let orbit_re_e = addr_of_mut!(ORBIT_RE_E).cast::<i32>();
        let orbit_im_m = addr_of_mut!(ORBIT_IM_M).cast::<f64>();
        let orbit_im_e = addr_of_mut!(ORBIT_IM_E).cast::<i32>();

        let mut pixel = 0usize;
        while pixel < n_pixels {
            // Two pixels advance together when they start at the same iteration,
            // which is the common case: plain perturbation starts everyone at 1,
            // and the series path starts everyone at the same validated skip.
            if pixel + 1 < n_pixels
                && *start_iter.add(pixel) == *start_iter.add(pixel + 1)
                && iterate_pair(
                    pixel,
                    pixel + 1,
                    orbit,
                    max_iterations,
                    orbit_re_m,
                    orbit_re_e,
                    orbit_im_m,
                    orbit_im_e,
                    dc_m,
                    dc_e,
                    start_m,
                    start_e,
                    start_iter,
                    flags,
                    mag,
                )
            {
                pixel += 2;
                continue;
            }

            let dc = Fc {
                re: Fe {
                    m: *dc_m.add(pixel * 2),
                    e: *dc_e.add(pixel * 2),
                },
                im: Fe {
                    m: *dc_m.add(pixel * 2 + 1),
                    e: *dc_e.add(pixel * 2 + 1),
                },
            };

            // Plain perturbation starts from `d = dc` at iteration 1; the series
            // approximation starts from its own evaluated delta at the iteration
            // whose prefix it skipped. Both are the same loop from here.
            let mut d = Fc {
                re: Fe {
                    m: *start_m.add(pixel * 2),
                    e: *start_e.add(pixel * 2),
                },
                im: Fe {
                    m: *start_m.add(pixel * 2 + 1),
                    e: *start_e.add(pixel * 2 + 1),
                },
            };
            let mut glitched = 0i32;
            let mut reason = REASON_NONE;
            let mut escaped = 0i32;
            // The JavaScript returns `maxIterations` when the budget runs out,
            // so this is the default and only the exits overwrite it.
            let mut iterations = max_iterations;
            let mut mag_m = 0.0f64;
            let mut mag_e = 0i32;

            let mut n = *start_iter.add(pixel) as u32;
            while n <= max_iterations {
                if n as usize >= orbit {
                    glitched = 1;
                    reason = REASON_ORBIT_EXHAUSTED;
                    iterations = n;
                    break;
                }
                let index = n as usize;
                let zn = Fc {
                    re: Fe {
                        m: *orbit_re_m.add(index),
                        e: *orbit_re_e.add(index),
                    },
                    im: Fe {
                        m: *orbit_im_m.add(index),
                        e: *orbit_im_e.add(index),
                    },
                };
                let z = fc_add(zn, d);
                let magnitude_squared = fc_abs2(z);

                if fe_cmp(magnitude_squared, fe_mul(fc_abs2(zn), GLITCH_THRESHOLD)) < 0 {
                    glitched = 1;
                    reason = REASON_PRECISION;
                    iterations = n;
                    break;
                }

                if fe_cmp(magnitude_squared, ESCAPE_THRESHOLD) > 0 {
                    escaped = 1;
                    iterations = n;
                    mag_m = magnitude_squared.m;
                    mag_e = magnitude_squared.e;
                    break;
                }

                d = delta_step(zn, d, dc);
                n += 1;
            }

            *flags.add(pixel * 4) = glitched;
            *flags.add(pixel * 4 + 1) = reason;
            *flags.add(pixel * 4 + 2) = escaped;
            *flags.add(pixel * 4 + 3) = iterations as i32;
            *mag.add(pixel * 2) = mag_m;
            *mag.add(pixel * 2 + 1) = mag_e as f64;
            let out_blocks = addr_of_mut!(OUT_BLOCKS).cast::<i32>();
            *out_blocks.add(pixel * 2) = 0;
            *out_blocks.add(pixel * 2 + 1) = 0;
            pixel += 1;
        }

        if ERRORS > 0 {
            return 4;
        }
    }
    0
}
