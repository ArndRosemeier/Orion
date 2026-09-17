import { describe, expect, it } from "vitest";
import { bigComplex } from "../numeric/bigcomplex";
import { cmp, fromFloat, toFloat } from "../numeric/bigfixed";
import { fracBitsForScaleExponent } from "../numeric/precision";
import { makeView, pixelSizeOf, pixelToComplex } from "./view";

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
