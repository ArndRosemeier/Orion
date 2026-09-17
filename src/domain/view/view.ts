/**
 * Viewport <-> complex plane mapping at arbitrary precision.
 *
 * A `View` carries its own precision: the centre and width are `BigFixed` at a
 * shared `fracBits`, so the mapping stays exact at zoom depths where the whole
 * viewport spans less than one double-precision epsilon.
 *
 * The precision is *validated*, never assumed: `fracBitsForView` reports what
 * the view actually needs, and a view built with too few bits fails loudly
 * instead of rendering a field of identical pixels.
 */

import { type BigComplex, bigComplex } from "../numeric/bigcomplex";
import {
  type BigFixed,
  add,
  cmp,
  div,
  fromFloat,
  fromInt,
  isZero,
  mul,
  sub,
  withFracBits,
} from "../numeric/bigfixed";
import { floorLog2 } from "../numeric/bigfixed";
import { fracBitsForPixelSize } from "../numeric/precision";

export type View = {
  /** Complex-plane centre of the viewport. */
  readonly center: BigComplex;
  /** Complex-plane width covered by the viewport. Must be > 0. */
  readonly width: BigFixed;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
};

export function makeView(
  center: BigComplex,
  width: BigFixed,
  pixelWidth: number,
  pixelHeight: number,
): View {
  if (!Number.isInteger(pixelWidth) || pixelWidth <= 0) {
    throw new Error(`View: pixelWidth must be a positive integer (got ${pixelWidth})`);
  }
  if (!Number.isInteger(pixelHeight) || pixelHeight <= 0) {
    throw new Error(
      `View: pixelHeight must be a positive integer (got ${pixelHeight})`,
    );
  }
  if (width.fracBits !== center.re.fracBits) {
    throw new Error(
      `View: width/centre precision mismatch (${width.fracBits} vs ${center.re.fracBits} fractional bits)`,
    );
  }
  if (cmp(width, fromInt(0, width.fracBits)) <= 0) {
    throw new Error("View: width must be > 0");
  }

  const view: View = {
    center: bigComplex(center.re, center.im),
    width,
    pixelWidth,
    pixelHeight,
  };

  // A view that cannot resolve its own pixels renders a field of identical
  // samples. Reject it here, at construction, rather than letting it reach a
  // renderer that would happily draw mush.
  const required = fracBitsForView(view);
  if (required > width.fracBits) {
    throw new Error(
      `View: ${width.fracBits} fractional bits is below the ${required} required to resolve ${pixelWidth} pixels at this scale`,
    );
  }
  return view;
}

/**
 * Complex-plane distance between adjacent pixel centres.
 *
 * Throws if the view's precision cannot resolve a single pixel: that means the
 * caller picked `fracBits` below what this scale needs, and the honest response
 * is an error rather than a blank image.
 */
export function pixelSizeOf(view: View): BigFixed {
  const size = div(view.width, fromInt(view.pixelWidth, view.width.fracBits));
  if (isZero(size)) {
    throw new Error(
      `View.pixelSizeOf: width at ${view.width.fracBits} fractional bits cannot resolve ${view.pixelWidth} pixels — precision too low for this scale`,
    );
  }
  return size;
}

/** Fractional bits this view's scale actually requires. */
export function fracBitsForView(view: View): number {
  return fracBitsForPixelSize(pixelSizeOf(view));
}

/**
 * Offset of the centre of pixel `(px, py)` from the view centre, in *pixels*.
 *
 * This is the single site that owns the `+0.5` pixel-centre convention. Both
 * `pixelToComplex` and the navigation code go through it, so a renderer and the
 * interaction that moves the viewport cannot disagree about which complex point
 * a pixel shows — which is the difference between "zoom keeps the cursor fixed"
 * and "zoom keeps something near the cursor fixed".
 */
export function pixelOffset(
  view: View,
  px: number,
  py: number,
): { readonly dx: BigFixed; readonly dy: BigFixed } {
  if (!Number.isFinite(px) || !Number.isFinite(py)) {
    throw new Error(`View.pixelOffset: non-finite pixel coordinate (${px}, ${py})`);
  }
  const fracBits = view.width.fracBits;
  // px + 0.5 is a dyadic rational, so this conversion is exact for any
  // fracBits >= 1, however large px is.
  return {
    dx: sub(fromFloat(px + 0.5, fracBits), fromFloat(view.pixelWidth / 2, fracBits)),
    dy: sub(fromFloat(py + 0.5, fracBits), fromFloat(view.pixelHeight / 2, fracBits)),
  };
}

/**
 * Complex coordinate at the centre of pixel `(px, py)`, sampled at `+0.5`
 * (pixel centres, not corners).
 */
export function pixelToComplex(view: View, px: number, py: number): BigComplex {
  const { dx, dy } = pixelOffset(view, px, py);
  const pixelSize = pixelSizeOf(view);
  return {
    re: add(view.center.re, mul(dx, pixelSize)),
    im: add(view.center.im, mul(dy, pixelSize)),
  };
}

/**
 * The centre a view must have for pixel `(px, py)` to sit at `target`.
 *
 * The exact inverse of `pixelToComplex` at the same precision: navigation builds
 * the "keep this point under the cursor" view by moving the centre so the
 * anchored pixel lands where it already was.
 */
export function centreForPixel(
  view: View,
  px: number,
  py: number,
  target: BigComplex,
): BigComplex {
  const { dx, dy } = pixelOffset(view, px, py);
  const pixelSize = pixelSizeOf(view);
  return {
    re: sub(target.re, mul(dx, pixelSize)),
    im: sub(target.im, mul(dy, pixelSize)),
  };
}

/**
 * Re-express a view at a different working precision.
 *
 * Raising precision is exact; lowering it rounds, by the one rounding rule. A
 * navigation step that needs more bits than the view carries raises first, so
 * the choice of working precision never itself moves a pixel.
 */
export function atPrecision(view: View, fracBits: number): View {
  if (fracBits === view.width.fracBits) return view;
  return makeView(
    bigComplex(
      withFracBits(view.center.re, fracBits),
      withFracBits(view.center.im, fracBits),
    ),
    withFracBits(view.width, fracBits),
    view.pixelWidth,
    view.pixelHeight,
  );
}

/**
 * `log2` of the complex-plane distance between adjacent pixel centres.
 *
 * Derived through `pixelSizeOf`, which is exact, rather than through a float
 * division that would lose the low bits precisely where they matter. This is the
 * number the ladder keys every stage decision on.
 */
export function scaleExponentOf(view: View): number {
  return floorLog2(pixelSizeOf(view));
}
