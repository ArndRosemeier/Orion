import { describe, expect, it } from "vitest";
import { bigComplex } from "../numeric/bigcomplex";
import { cmp, fromFloat, toFloat } from "../numeric/bigfixed";
import { fracBitsForScaleExponent } from "../numeric/precision";
import {
  makeView,
  pixelSizeOf,
  pixelToComplex,
  resizeView,
  scaleExponentOf,
} from "./view";

const F = 128;

function center(re: number, im: number, fracBits = F) {
  return bigComplex(fromFloat(re, fracBits), fromFloat(im, fracBits));
}

describe("View construction rejects views it cannot render", () => {
  it("rejects non-integer or non-positive pixel dimensions", () => {
    expect(() => makeView(center(0, 0), fromFloat(4, F), 0, 100)).toThrow(
      /pixelWidth must be a positive integer/,
    );
    expect(() => makeView(center(0, 0), fromFloat(4, F), 100, 1.5)).toThrow(
      /pixelHeight must be a positive integer/,
    );
  });

  it("rejects a non-positive width", () => {
    expect(() => makeView(center(0, 0), fromFloat(0, F), 100, 100)).toThrow(
      /width must be > 0/,
    );
  });

  it("rejects mismatched width/centre precision", () => {
    expect(() => makeView(center(0, 0, 128), fromFloat(4, 256), 100, 100)).toThrow(
      /precision mismatch/,
    );
  });

  it("rejects a view whose precision cannot resolve one of its own pixels", () => {
    // 2^-100 across a million pixels is a 2^-120 spacing, which needs 184 bits;
    // the view claims 128. Rendering it would produce a field of identical
    // samples, so construction must fail instead.
    expect(() =>
      makeView(center(0, 0, 128), fromFloat(2 ** -100, 128), 1_000_000, 100),
    ).toThrow(/below the 184 required/);
  });
});

describe("pixelSizeOf", () => {
  it("divides the viewport width by the pixel count", () => {
    const view = makeView(center(0, 0), fromFloat(4, F), 4, 4);
    expect(toFloat(pixelSizeOf(view))).toBeCloseTo(1, 30);
  });

  it("agrees with the precision the scale demands", () => {
    const fracBits = fracBitsForScaleExponent(-200);
    const view = makeView(
      center(1, 0, fracBits),
      fromFloat(2 ** -190, fracBits),
      1024,
      1024,
    );
    expect(toFloat(pixelSizeOf(view))).toBe(2 ** -200);
  });
});

describe("pixelToComplex samples pixel centres", () => {
  it("maps corners of a 4x4 view over [-2,2]x[-2,2]", () => {
    const view = makeView(center(0, 0), fromFloat(4, F), 4, 4);
    const first = pixelToComplex(view, 0, 0);
    expect(toFloat(first.re)).toBeCloseTo(-1.5, 30);
    expect(toFloat(first.im)).toBeCloseTo(-1.5, 30);

    const last = pixelToComplex(view, 3, 3);
    expect(toFloat(last.re)).toBeCloseTo(1.5, 30);
    expect(toFloat(last.im)).toBeCloseTo(1.5, 30);
  });

  it("maps the exact centre of an even-sized view to the centre coordinate", () => {
    const view = makeView(center(-0.5, 0.25), fromFloat(4, F), 4, 4);
    const middle = pixelToComplex(view, 1.5, 1.5);
    expect(toFloat(middle.re)).toBeCloseTo(-0.5, 30);
    expect(toFloat(middle.im)).toBeCloseTo(0.25, 30);
  });

  it("resolves adjacent pixels at a depth where doubles collapse", () => {
    const fracBits = fracBitsForScaleExponent(-200);
    const view = makeView(
      center(1, 0, fracBits),
      fromFloat(2 ** -190, fracBits),
      1024,
      1024,
    );

    const left = pixelToComplex(view, 0, 512);
    const right = pixelToComplex(view, 1, 512);

    // Exact arithmetic keeps the two pixel centres distinct...
    expect(cmp(left.re, right.re)).not.toBe(0);

    // ...while the double projection used for GPU upload and display cannot
    // tell this view's pixels apart at all. This is precisely why the ladder
    // exists, pinned as a fact rather than asserted in a comment.
    expect(toFloat(left.re)).toBe(1);
    expect(toFloat(right.re)).toBe(1);
  });

  it("rejects non-finite pixel coordinates loudly", () => {
    const view = makeView(center(0, 0), fromFloat(4, F), 4, 4);
    expect(() => pixelToComplex(view, Number.NaN, 0)).toThrow(/non-finite/);
  });
});

describe("resizeView", () => {
  it("returns the same view when the dimensions do not change", () => {
    const view = makeView(center(0, 0), fromFloat(4, F), 960, 640);
    expect(resizeView(view, view.pixelWidth, view.pixelHeight)).toBe(view);
  });

  it("preserves the centre bit-exactly and the precision on a deep view", () => {
    const fracBits = fracBitsForScaleExponent(-200);
    const view = makeView(
      center(1, 0, fracBits),
      fromFloat(2 ** -190, fracBits),
      1024,
      1024,
    );
    const resized = resizeView(view, 1280, 800);
    expect(resized).not.toBe(view);
    expect(resized.center.re.v).toBe(view.center.re.v);
    expect(resized.center.im.v).toBe(view.center.im.v);
    expect(resized.width.fracBits).toBe(view.width.fracBits);
  });

  it("preserves the zoom depth when the viewport changes shape", () => {
    // 2.8125 / 960 = 3 * 2^-10, so the scale is exactly preserved by both
    // resizes *and* an accidental axis swap would change the pixel size by
    // 4/3 enough to cross the 2^-9/2^-8 boundary — the pin is not sitting on a
    // power-of-two edge where the exponent could not move.
    const view = makeView(center(0, 0), fromFloat(2.8125, F), 960, 640);
    const wider = resizeView(view, 1280, 800);
    const smaller = resizeView(view, 320, 200);
    expect(scaleExponentOf(wider)).toBe(scaleExponentOf(view));
    expect(scaleExponentOf(smaller)).toBe(scaleExponentOf(view));
  });

  it("keeps the old image centred when the viewport changes shape", () => {
    const view = makeView(center(0, 0), fromFloat(4, F), 960, 640);
    const resized = resizeView(view, 1280, 800);

    // A plane point at (px, py) of the original sits, after adding
    // (W1 - W0) / 2 columns and (H1 - H0) / 2 rows symmetrically about the
    // fixed centre, at (px + 160, py + 80) of the resized view.
    const px = 123.5;
    const py = 200.5;
    const before = pixelToComplex(view, px, py);
    const after = pixelToComplex(resized, px + (1280 - 960) / 2, py + (800 - 640) / 2);

    // The centre itself is exact; only the pixel spacing can move, by the
    // resize's rounding of the recomputed complex width (a few ulps — house
    // rule 13), so assert centre exactness separately from the point match.
    expect(resized.center.re.v).toBe(view.center.re.v);
    expect(resized.center.im.v).toBe(view.center.im.v);

    // Bound derived from the quantities above: the point is at most W0/2
    // pixels from the centre, the width recomputation and the pixel division
    // each round by at most half an ulp, and the two projections add one more
    // ulp — so at most ceil(W0/2) + 1 ulps on the real axis (and the same with
    // H0 on the imaginary axis).
    const realUlps =
      before.re.v < after.re.v ? after.re.v - before.re.v : before.re.v - after.re.v;
    const imagUlps =
      before.im.v < after.im.v ? after.im.v - before.im.v : before.im.v - after.im.v;
    expect(realUlps <= BigInt(Math.ceil(view.pixelWidth / 2) + 1)).toBe(true);
    expect(imagUlps <= BigInt(Math.ceil(view.pixelHeight / 2) + 1)).toBe(true);

    // Non-degeneracy: neighbouring pixels are genuinely distinct at this
    // scale, so the centring assertion above is not comparing a collapsed
    // field of identical samples.
    const p0 = pixelToComplex(resized, 0, 0);
    const p1 = pixelToComplex(resized, 1, 0);
    expect(p0.re.v).not.toBe(p1.re.v);
  });

  it("rejects a pixel dimension that is not a positive integer", () => {
    const view = makeView(center(0, 0), fromFloat(4, F), 100, 100);
    expect(() => resizeView(view, 0, 100)).toThrow(/pixelWidth/);
    expect(() => resizeView(view, -100, 100)).toThrow(/pixelWidth/);
    expect(() => resizeView(view, 1.5, 100)).toThrow(/integer/);
    expect(() => resizeView(view, 100, 0)).toThrow(/pixelHeight/);
    expect(() => resizeView(view, 100, -100)).toThrow(/pixelHeight/);
    expect(() => resizeView(view, 100, 1.5)).toThrow(/integer/);
  });
});
