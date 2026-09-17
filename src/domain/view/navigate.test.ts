import { describe, expect, it } from "vitest";
import { add, fromFloat, mul, sub, toFloat } from "../numeric/bigfixed";
import { encodeView, decodeView } from "./url";
import {
  NAVIGATION_MARGIN_BITS,
  navigationFracBits,
  panByPixels,
  shiftInUlps,
  viewFromDoubles,
  zoomAtPixel,
} from "./navigate";
import {
  centreForPixel,
  makeView,
  pixelSizeOf,
  pixelToComplex,
  scaleExponentOf,
  type View,
} from "./view";

const WIDTH = 96;
const HEIGHT = 64;

function initial(): View {
  return viewFromDoubles(-0.75, 0.1, 3, WIDTH, HEIGHT);
}

/** The axis distance between two fixed-point values, as a plain number. */
function fixedDistance(
  a: { v: bigint; fracBits: number },
  b: { v: bigint; fracBits: number },
): number {
  const diff = a.v - b.v;
  return Number(diff < 0n ? -diff : diff) / 2 ** a.fracBits;
}

describe("viewFromDoubles", () => {
  it("starts a view at the precision its own scale requires", () => {
    const view = initial();
    // 3/96 = 2^-5, so the scale needs GUARD_BITS - (-5) = 69 bits, floored at
    // MIN_FRAC_BITS, plus the navigation margin.
    expect(view.width.fracBits).toBeGreaterThanOrEqual(128 + NAVIGATION_MARGIN_BITS);
    expect(scaleExponentOf(view)).toBe(-5);
    expect(toFloat(view.center.re)).toBeCloseTo(-0.75, 15);
  });

  it("refuses a width that is not a positive finite number", () => {
    expect(() => viewFromDoubles(0, 0, 0, WIDTH, HEIGHT)).toThrow(/width/);
    expect(() => viewFromDoubles(0, 0, Number.NaN, WIDTH, HEIGHT)).toThrow(/width/);
  });
});

describe("zoomAtPixel", () => {
  it("leaves the anchored point where it was, to within a few ulps", () => {
    const view = initial();
    const px = 20.5;
    const py = 44.5;
    const before = pixelToComplex(view, px, py);
    const zoomed = zoomAtPixel(view, px, py, 0.5);
    const after = pixelToComplex(zoomed, px, py);

    expect(zoomed.width.fracBits).toBeGreaterThanOrEqual(view.width.fracBits);
    expect(scaleExponentOf(zoomed)).toBe(-6);
    // Two roundings (one multiplication and one subtraction) put us within a
    // couple of units in the last place — not "exactly unmoved", which fixed
    // point cannot promise.
    const ulps = shiftInUlps(before, after, zoomed.width.fracBits);
    expect(ulps).toBeLessThanOrEqual(4);
  });

  it("zooms towards the cursor, not the centre", () => {
    const view = initial();
    // Pixel 95.5 is the *centre of the last column*, which is exactly 48 pixels
    // (half the viewport) right of the centre. Anchoring there and halving the
    // width must move the centre right by half of the width that was removed.
    // Pixel 95 would be 47.5 pixels out and would move it by 0.7421875 instead —
    // a 1/128 difference that is the half-pixel convention showing through.
    const zoomed = zoomAtPixel(view, WIDTH - 0.5, HEIGHT / 2, 0.5);
    const centreShift = fixedDistance(zoomed.center.re, view.center.re);
    const halfWidth = toFloat(view.width) / 2;
    expect(centreShift).toBeCloseTo(halfWidth / 2, 12);

    const offByHalf = zoomAtPixel(view, WIDTH - 1, HEIGHT / 2, 0.5);
    expect(fixedDistance(offByHalf.center.re, view.center.re)).toBeCloseTo(
      (halfWidth / 2) * (47.5 / 48),
      12,
    );
  });

  it("keeps the anchored point while zooming 400 steps past the double range", () => {
    let view = initial();
    const px = 31.5;
    const py = 17.5;
    const anchor = pixelToComplex(view, px, py);
    for (let step = 0; step < 400; step++) {
      view = zoomAtPixel(view, px, py, 0.5);
    }

    // 3 * 2^-400 across 96 pixels: depth ~2^-406, far below anything a double
    // can express (a double dies at 2^-52).
    expect(scaleExponentOf(view)).toBeLessThanOrEqual(-400);
    expect(view.width.fracBits).toBeGreaterThan(400);
    // The view is still resolvable at its own precision — makeView enforces
    // this, so the loop would have thrown rather than gone quietly mushy.
    const pixelSize = pixelSizeOf(view);
    expect(pixelSize.v).toBeGreaterThan(0n);

    const now = pixelToComplex(view, px, py);
    const driftUlps = shiftInUlps(anchor, now, view.width.fracBits);
    // The claim, stated in the unit that has meaning at depth: the anchored
    // point drifts by less than a thousandth of a pixel.
    const driftPixels = driftUlps * 2 ** (scaleExponentOf(view) - view.width.fracBits);
    expect(driftPixels).toBeLessThan(1e-3);
    expect(driftUlps).toBeLessThan(1000);
  });

  it("survives a round trip through a link at depth 2^-400", () => {
    let view = initial();
    for (let step = 0; step < 400; step++) {
      view = zoomAtPixel(view, 10.5, 10.5, 0.75);
    }
    const decoded = decodeView(encodeView(view, 600));
    expect(decoded.view.center.re.v).toBe(view.center.re.v);
    expect(decoded.view.center.im.v).toBe(view.center.im.v);
    expect(decoded.view.width.v).toBe(view.width.v);
    expect(decoded.view.width.fracBits).toBe(view.width.fracBits);
  });

  it("refuses a zoom factor that is not a positive number", () => {
    const view = initial();
    expect(() => zoomAtPixel(view, 0, 0, 0)).toThrow(/factor/);
    expect(() => zoomAtPixel(view, 0, 0, -1)).toThrow(/factor/);
    expect(() => zoomAtPixel(view, 0, 0, Number.NaN)).toThrow(/factor/);
  });
});

describe("panByPixels", () => {
  it("moves the image by exactly the pixels dragged", () => {
    const view = initial();
    const panned = panByPixels(view, 5, -3);
    // The complex point that was at (10, 20) is now at (15, 17).
    const before = pixelToComplex(view, 10.5, 20.5);
    const after = pixelToComplex(panned, 15.5, 17.5);
    expect(shiftInUlps(before, after, view.width.fracBits)).toBeLessThanOrEqual(2);
    expect(scaleExponentOf(panned)).toBe(scaleExponentOf(view));
    expect(panned.width.fracBits).toBe(view.width.fracBits);
  });

  it("pans at depth without losing the scale", () => {
    let view = initial();
    for (let step = 0; step < 120; step++) view = zoomAtPixel(view, 48, 32, 0.5);
    const depth = scaleExponentOf(view);
    const panned = panByPixels(view, 1000, -1000);
    expect(scaleExponentOf(panned)).toBe(depth);
    // Far from the origin, and still exactly on scale: the two views' pixel
    // sizes are identical, not merely close.
    expect(panned.width.v).toBe(view.width.v);
  });

  it("refuses a non-finite delta", () => {
    const view = initial();
    expect(() => panByPixels(view, Number.NaN, 0)).toThrow(/delta/);
    expect(() => panByPixels(view, 0, Number.POSITIVE_INFINITY)).toThrow(/delta/);
  });
});

describe("navigationFracBits", () => {
  it("buys one bit per bit of depth, once past the floor", () => {
    // Past MIN_FRAC_BITS the ladder is linear in depth; below it the floor wins,
    // which is why the shallow case is pinned separately rather than assumed.
    // 512 bits, because 2^-300 at 256 bits rounds to zero and the module
    // refuses that (pinned below) rather than reporting a depth it cannot see.
    const at100 = navigationFracBits(fromFloat(2 ** -100, 512), 96);
    const at300 = navigationFracBits(fromFloat(2 ** -300, 512), 96);
    expect(at300 - at100).toBe(200);
    // The floor holds until the scale itself needs more than 128 bits, which is
    // 2^-64; 2^-100 is already past it, so its figure follows the linear rule
    // (64 + 106) rather than the floor. Below the floor the figure is *not* a
    // function of depth at all, which is the case worth pinning.
    expect(navigationFracBits(fromFloat(1, 256), 96)).toBe(
      128 + NAVIGATION_MARGIN_BITS,
    );
    expect(navigationFracBits(fromFloat(2 ** -30, 256), 96)).toBe(
      128 + NAVIGATION_MARGIN_BITS,
    );
    expect(at100).toBe(64 + 106 + NAVIGATION_MARGIN_BITS);
  });

  it("refuses a pixel width that is not a positive integer", () => {
    expect(() => navigationFracBits(fromFloat(1, 256), 0)).toThrow(/pixelWidth/);
    expect(() => navigationFracBits(fromFloat(1, 256), 1.5)).toThrow(/pixelWidth/);
  });

  it("refuses a width that its own precision cannot represent", () => {
    // 2^-300 at 256 fractional bits rounds to zero. Reporting a precision for a
    // view that does not exist would be the silent version; this throws.
    expect(() => navigationFracBits(fromFloat(2 ** -300, 256), 96)).toThrow(
      /logarithm/,
    );
  });
});

describe("the pixel-centre convention has one owner", () => {
  it("is the exact inverse used by centreForPixel", () => {
    const view = initial();
    const target = pixelToComplex(view, 40.5, 9.5);
    const moved = makeView(
      centreForPixel(view, 40.5, 9.5, target),
      view.width,
      view.pixelWidth,
      view.pixelHeight,
    );
    const back = pixelToComplex(moved, 40.5, 9.5);
    expect(back.re.v).toBe(target.re.v);
    expect(back.im.v).toBe(target.im.v);
  });

  it("puts pixel 0's centre half a pixel inside the left edge", () => {
    const view = initial();
    const size = pixelSizeOf(view);
    const expected = add(
      view.center.re,
      mul(fromFloat(-(view.pixelWidth / 2 - 0.5), view.width.fracBits), size),
    );
    expect(pixelToComplex(view, 0, 0).re.v).toBe(expected.v);
    // A full pixel further right, exactly.
    expect(sub(pixelToComplex(view, 1, 0).re, pixelToComplex(view, 0, 0).re).v).toBe(
      size.v,
    );
  });
});
