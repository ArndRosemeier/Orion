/**
 * Navigating a viewport at the precision the view actually needs.
 *
 * Panning and zooming look like the cheapest operations in the program and are
 * in fact the easiest place to lose a deep zoom: if the centre is carried in a
 * double, a view at 2^-400 collapses to a single repeated coordinate and the
 * explorer silently stops going deeper, while every renderer downstream is
 * perfectly capable of drawing it. So the arithmetic that *moves* the view is
 * held to the same standard as the arithmetic that draws it.
 *
 * Two rules follow, and they are the whole design:
 *
 *  1. Work at the precision the **new** scale requires, derived from the scale,
 *     never from the view being moved (a view built too coarse cannot report
 *     what it needs — the derivation would be circular).
 *  2. Do the anchoring through `centreForPixel`, the exact inverse of
 *     `pixelToComplex`, so "keep the point under the cursor fixed" is true in
 *     the same sense the renderer means it.
 *
 * Every step is still *rounded* — fixed point always is — so the pins assert how
 * much a navigation may move the anchored point (a few units in the last place)
 * rather than claiming it is unmoved. Over 400 zoom steps that is a drift of
 * ~2^-64 pixels, which is what the measurement in `navigate.test.ts` records.
 */

import { type BigComplex, bigComplex, subComplex } from "../numeric/bigcomplex";
import {
  type BigFixed,
  floorLog2,
  fromFloat,
  fromInt,
  mul,
  withFracBits,
} from "../numeric/bigfixed";
import { fracBitsForScaleExponent } from "../numeric/precision";
import {
  type View,
  atPrecision,
  centreForPixel,
  makeView,
  pixelSizeOf,
  pixelToComplex,
} from "./view";

/**
 * Extra bits over the strict scale requirement, to absorb the rounding of the
 * exponent estimate and of the navigation arithmetic itself.
 *
 * `fracBitsForScaleExponent` already carries `GUARD_BITS`, so this is a margin
 * on a margin — but it is what makes "the new view is exactly representable"
 * true rather than nearly true, and it costs a fraction of a limb.
 */
export const NAVIGATION_MARGIN_BITS = 8;

/**
 * Working precision for a viewport of this width and pixel count.
 *
 * Derived from the width's bit length (an integer property of the fixed-point
 * value) rather than from `Math.log2(width)`, so it stays correct at depths far
 * below the double exponent range.
 */
export function navigationFracBits(width: BigFixed, pixelWidth: number): number {
  if (!Number.isInteger(pixelWidth) || pixelWidth <= 0) {
    throw new Error(
      `navigationFracBits: pixelWidth must be a positive integer (got ${pixelWidth})`,
    );
  }
  const widthExponent = floorLog2(width);
  const pixelExponent = floorLog2(fromInt(pixelWidth, width.fracBits));
  return (
    fracBitsForScaleExponent(widthExponent - pixelExponent) + NAVIGATION_MARGIN_BITS
  );
}

/**
 * Build a view from double-precision inputs at a precision its scale requires.
 *
 * This is the *entry* to arbitrary depth, and the only place a double is allowed
 * to decide a view: a coordinate typed by a human, or hoisted out of a config
 * file. Everything after it is fixed point.
 */
export function viewFromDoubles(
  re: number,
  im: number,
  width: number,
  pixelWidth: number,
  pixelHeight: number,
): View {
  if (!Number.isFinite(width) || width <= 0) {
    throw new Error(`viewFromDoubles: width must be finite and > 0 (got ${width})`);
  }
  // The exponent of the pixel spacing, estimated in doubles and then *checked*
  // by `makeView` at the precision it implies — a disagreement is an error, not
  // a quietly mis-sized view.
  const exponent = Math.floor(Math.log2(width)) - Math.floor(Math.log2(pixelWidth));
  const fracBits = fracBitsForScaleExponent(exponent) + NAVIGATION_MARGIN_BITS;
  return makeView(
    bigComplex(fromFloat(re, fracBits), fromFloat(im, fracBits)),
    fromFloat(width, fracBits),
    pixelWidth,
    pixelHeight,
  );
}

/**
 * Zoom by `factor` (a multiplier on the viewport width; < 1 zooms in), holding
 * the complex point at pixel `(px, py)` still.
 *
 * The anchor is read at the *old* precision and written back at the *new* one,
 * so a deeper view is not anchored through a shallower view's rounding.
 */
export function zoomAtPixel(view: View, px: number, py: number, factor: number): View {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error(`zoomAtPixel: factor must be finite and > 0 (got ${factor})`);
  }
  const anchor = pixelToComplex(view, px, py);
  const roughWidth = mul(view.width, fromFloat(factor, view.width.fracBits));
  const fracBits = navigationFracBits(roughWidth, view.pixelWidth);

  const base = atPrecision(view, fracBits);
  const width = mul(base.width, fromFloat(factor, fracBits));
  const target: BigComplex = {
    re: withFracBits(anchor.re, fracBits),
    im: withFracBits(anchor.im, fracBits),
  };
  const zoomed: View = {
    center: base.center,
    width,
    pixelWidth: view.pixelWidth,
    pixelHeight: view.pixelHeight,
  };
  return makeView(
    centreForPixel(zoomed, px, py, target),
    width,
    view.pixelWidth,
    view.pixelHeight,
  );
}

/**
 * Pan by whole-pixel deltas: dragging right moves the image right, so the centre
 * moves left by the same number of pixels.
 */
export function panByPixels(view: View, dx: number, dy: number): View {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    throw new Error(`panByPixels: non-finite delta (${dx}, ${dy})`);
  }
  const fracBits = view.width.fracBits;
  const size = pixelSizeOf(view);
  const shift = bigComplex(
    mul(fromFloat(dx, fracBits), size),
    mul(fromFloat(dy, fracBits), size),
  );
  return makeView(
    subComplex(view.center, shift),
    view.width,
    view.pixelWidth,
    view.pixelHeight,
  );
}

/**
 * How far a point moved between two views, in units of the last place at
 * `fracBits`.
 *
 * This is the honest way to state navigation error: at 2^-400 an absolute
 * difference is either zero or meaningless, and what a user cares about is
 * whether the anchored point moved by a fraction of a *pixel*. Reporting ulps
 * keeps the claim checkable and lets the caller divide by the pixel size.
 */
export function shiftInUlps(a: BigComplex, b: BigComplex, fracBits: number): number {
  const dr = withFracBits(a.re, fracBits).v - withFracBits(b.re, fracBits).v;
  const di = withFracBits(a.im, fracBits).v - withFracBits(b.im, fracBits).v;
  const magnitude = (dr < 0n ? -dr : dr) + (di < 0n ? -di : di);
  return Number(magnitude);
}
