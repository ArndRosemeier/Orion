//! The L0 escape-time kernel, in Rust, compiled to WebAssembly.
//!
//! This is the per-pixel engine the worker pool runs at shallow and mid depths —
//! the same recurrence as `escapeDirectFloat`, in the same order of operations,
//! so the two produce **bit-identical** results. That equality is the contract:
//! the differential pin compares them exactly rather than within a tolerance.
//!
//! ## Why it is shaped this way
//!
//! * **Row at a time, not pixel at a time.** SIMD only pays if there are lanes to
//!   fill, so the entry point renders a horizontal run of pixels and the two
//!   pixels of an `f64x2` pair advance together.
//! * **No allocator, no `std`, no dependencies.** The output buffers are fixed
//!   statics whose addresses the host reads; there is nothing to allocate, so
//!   there is nothing to leak or to get wrong.
//! * **No `log2`.** The host computes the continuous escape count with
//!   `Math.log2` from the magnitude this returns, which is what makes the two
//!   engines agree bit for bit — the same inputs through the same libm.
//! * **No fused multiply-add.** `fma` would be *more* accurate and would break
//!   bit-equality with the scalar engine. Accuracy is not the goal here; matching
//!   the pinned reference is.

#![no_std]

use core::panic::PanicInfo;
use core::ptr::addr_of_mut;

#[panic_handler]
fn panic(_info: &PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

/// Widest run a single call can render; the host chunks longer rows.
pub const MAX_ROW: usize = 4096;

static mut ITERATIONS: [i32; MAX_ROW] = [0; MAX_ROW];
static mut MAGNITUDES: [f64; MAX_ROW] = [0.0; MAX_ROW];

/// Address of the escape-count buffer, for the host to read.
#[no_mangle]
pub extern "C" fn iterations_ptr() -> *mut i32 {
    addr_of_mut!(ITERATIONS).cast::<i32>()
}

/// Address of the `|z|^2`-at-escape buffer, for the host to read.
#[no_mangle]
pub extern "C" fn magnitudes_ptr() -> *mut f64 {
    addr_of_mut!(MAGNITUDES).cast::<f64>()
}

/// The working row width, so the host does not have to be told.
#[no_mangle]
pub extern "C" fn max_row() -> u32 {
    MAX_ROW as u32
}

/// Iterate one point, returning `(escape_iteration, |z|^2)`, where an escape
/// iteration of `0` means the point stayed bounded for the whole budget.
#[inline(always)]
fn escape_one(c_re: f64, c_im: f64, max_iterations: u32) -> (i32, f64) {
    let mut zr = 0.0f64;
    let mut zi = 0.0f64;
    let mut n = 1u32;
    while n <= max_iterations {
        let zr2 = zr * zr;
        let zi2 = zi * zi;
        let next_zr = zr2 - zi2 + c_re;
        let next_zi = 2.0 * zr * zi + c_im;
        zr = next_zr;
        zi = next_zi;
        let magnitude_squared = zr * zr + zi * zi;
        if magnitude_squared > 4.0 {
            return (n as i32, magnitude_squared);
        }
        n += 1;
    }
    (0, 0.0)
}

/// The SIMD pair step, available only on wasm32 with `simd128`.
///
/// Operations appear in exactly the order `escape_one` uses them, lane for lane.
#[cfg(target_arch = "wasm32")]
#[target_feature(enable = "simd128")]
unsafe fn escape_pair(c_re: core::arch::wasm32::v128, c_im: core::arch::wasm32::v128, max_iterations: u32) -> (core::arch::wasm32::v128, core::arch::wasm32::v128) {
    use core::arch::wasm32::*;

    let mut zr = f64x2_splat(0.0);
    let mut zi = f64x2_splat(0.0);
    let mut recorded = i32x4_splat(0);
    // Freeze each lane's magnitude on the step it escapes. Without this the
    // escaped lane keeps squaring until it overflows and `inf - inf` turns the
    // recorded magnitude into NaN — the scalar path cannot do that, because it
    // returns on the same step.
    let mut recorded_magnitude = f64x2_splat(0.0);
    let mut escaped = i32x4_splat(0);

    let four = f64x2_splat(4.0);
    let two = f64x2_splat(2.0);

    let mut n = 1u32;
    while n <= max_iterations {
        let zr2 = f64x2_mul(zr, zr);
        let zi2 = f64x2_mul(zi, zi);
        let next_zr = f64x2_add(f64x2_sub(zr2, zi2), c_re);
        let next_zi = f64x2_add(f64x2_mul(f64x2_mul(two, zr), zi), c_im);
        zr = next_zr;
        zi = next_zi;
        let magnitude_squared = f64x2_add(f64x2_mul(zr, zr), f64x2_mul(zi, zi));

        let over = f64x2_gt(magnitude_squared, four);
        // Record the iteration only on the step where a lane first escapes.
        let newly = v128_and(over, v128_not(escaped));
        recorded = v128_or(recorded, v128_and(newly, i32x4_splat(n as i32)));
        recorded_magnitude = v128_or(recorded_magnitude, v128_and(newly, magnitude_squared));
        escaped = v128_or(escaped, over);
        if i32x4_all_true(escaped) {
            break;
        }
        n += 1;
    }
    (recorded, recorded_magnitude)
}

/// Render `count` consecutive pixels starting at `(c_re0, c_im)` with a step of
/// `d_re` in the real direction.
///
/// Results land in the static buffers, in order: escape iteration (`0` for
/// bounded) and `|z|^2` at escape (`0.0` when bounded).
#[no_mangle]
pub extern "C" fn render_row(c_re0: f64, c_im: f64, d_re: f64, count: u32, max_iterations: u32) {
    let n = count as usize;
    if n == 0 {
        return;
    }
    if n > MAX_ROW {
        core::arch::wasm32::unreachable();
    }
    let out_iter = addr_of_mut!(ITERATIONS).cast::<i32>();
    let out_mag = addr_of_mut!(MAGNITUDES).cast::<f64>();

    #[cfg(target_arch = "wasm32")]
    let mut i = 0usize;
    #[cfg(target_arch = "wasm32")]
    if cfg!(target_feature = "simd128") {
        // Two pixels per SIMD pair, exactly as the scalar path would compute them.
        unsafe {
            while i + 2 <= n {
                let c_re = core::arch::wasm32::f64x2(
                    c_re0 + d_re * (i as f64),
                    c_re0 + d_re * ((i + 1) as f64),
                );
                let c_im_v = core::arch::wasm32::f64x2_splat(c_im);
                let (recorded, magnitude) = escape_pair(c_re, c_im_v, max_iterations);
                let it0 = core::arch::wasm32::i32x4_extract_lane::<0>(recorded);
                let it1 = core::arch::wasm32::i32x4_extract_lane::<2>(recorded);
                let m0 = core::arch::wasm32::f64x2_extract_lane::<0>(magnitude);
                let m1 = core::arch::wasm32::f64x2_extract_lane::<1>(magnitude);
                *out_iter.add(i) = if it0 == 0 { 0 } else { it0 };
                *out_iter.add(i + 1) = it1;
                *out_mag.add(i) = if it0 == 0 { 0.0 } else { m0 };
                *out_mag.add(i + 1) = if it1 == 0 { 0.0 } else { m1 };
                i += 2;
            }
        }
    }

    let _ = (&out_iter, &out_mag);
    #[cfg(not(target_arch = "wasm32"))]
    let mut i = 0usize;

    while i < n {
        let c_re = c_re0 + d_re * (i as f64);
        let (iterations, magnitude) = escape_one(c_re, c_im, max_iterations);
        unsafe {
            *out_iter.add(i) = iterations;
            *out_mag.add(i) = magnitude;
        }
        i += 1;
    }
}
