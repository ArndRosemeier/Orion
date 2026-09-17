/**
 * The precision ladder's arithmetic basis.
 *
 * Deep zoom fails for one reason: the pixel spacing falls below the smallest
 * representable step. Every engine in the ladder needs a working precision
 * derived from that spacing, and deriving it *anywhere else* invites the two
 * numbers drifting apart — which shows up as mush, not as an error.
 *
 * So there is exactly one derivation, here, with two entry points:
 *
 *  - `fracBitsForScaleExponent` — the primitive. Callers who know their zoom
 *    depth (i.e. everyone constructing a view) use this, because a view built
 *    too coarse cannot be asked what precision it needs: its own pixel size
 *    rounds to zero. Deriving precision from the view would be circular.
 *  - `fracBitsForPixelSize` — the exact, checked form, for validating a view
 *    that already exists.
 *
 * Both share the one formula; neither restates it.
 */

import { type BigFixed, floorLog2 } from "./bigfixed";

/**
 * Extra fractional bits beyond what the pixel spacing strictly needs.
 *
 * Each iteration of `z -> z^2 + c` roughly doubles whatever error is already
 * present, so an engine running N iterations needs ~N bits of headroom or it
 * loses the low bits. 64 bits keeps a few thousand iterations honest while
 * costing almost nothing; the ladder raises it further for long orbits.
 */
export const GUARD_BITS = 64;

/**
 * Floor on working precision, in fractional bits.
 *
 * Shallow views need almost none, but the fixed-point substrate is also used
 * for reference orbits whose *scale* is far below the view scale. Paying for a
 * couple of limbs unconditionally is much cheaper than discovering a precision
 * cliff at a zoom depth nobody tested.
 */
export const MIN_FRAC_BITS = 128;

/**
 * Fractional bits required when the pixel spacing is `2^pixelSizeExponent`.
 *
 * Every bit you zoom in buys one more bit of required precision — which is
 * exactly why the ladder escalates with depth instead of choosing one precision
 * up front.
 */
export function fracBitsForScaleExponent(pixelSizeExponent: number): number {
  if (!Number.isFinite(pixelSizeExponent)) {
    throw new Error(
      `fracBitsForScaleExponent: exponent must be finite (got ${pixelSizeExponent})`,
    );
  }
  return Math.max(MIN_FRAC_BITS, Math.ceil(GUARD_BITS - pixelSizeExponent));
}

/**
 * Fractional bits required to resolve the given pixel spacing exactly.
 *
 * Derived from the spacing's bit length, never from a float round-trip, so it
 * stays correct far below the double exponent range.
 *
 * Throws on a non-positive pixel size: a zero spacing is a mis-sized view, not
 * a value to paper over with a default.
 */
export function fracBitsForPixelSize(pixelSize: BigFixed): number {
  return fracBitsForScaleExponent(floorLog2(pixelSize));
}
