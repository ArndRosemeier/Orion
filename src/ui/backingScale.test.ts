import { describe, expect, it } from "vitest";
import { backingPixels, backingScale } from "./backingScale";

describe("backingScale", () => {
  it("returns 1 for a device pixel ratio of 1", () => {
    expect(backingScale(320, 240, 1)).toBe(1);
  });

  it("treats a device pixel ratio below 1 as 1", () => {
    expect(backingScale(320, 240, 0.5)).toBe(1);
  });

  it("uses the device pixel ratio for a small area", () => {
    expect(backingScale(100, 100, 2)).toBe(2);
  });

  it("caps the preferred scale at 2", () => {
    expect(backingScale(100, 100, 3)).toBe(2);
  });

  it("scales a large area down to the pixel budget", () => {
    // 1000x1000 at dpr 2 wants 4_000_000 pixels; the default budget is
    // 2_000_000, so the scale is sqrt(2_000_000 / 1_000_000) = sqrt(2).
    const scale = backingScale(1000, 1000, 2);
    expect(scale).toBeCloseTo(Math.SQRT2, 12);
    expect(scale).toBeGreaterThanOrEqual(1);
    expect(scale).toBeLessThanOrEqual(2);
  });

  it("honours the identity branch exactly at the budget boundary", () => {
    // 1000x1000 at scale 2 is exactly 4_000_000 pixels.
    expect(backingScale(1000, 1000, 2, 4_000_000)).toBe(2);
    // Just under it the sqrt path takes over: sqrt(3_000_000 / 1_000_000).
    expect(backingScale(1000, 1000, 2, 3_000_000)).toBeCloseTo(Math.sqrt(3), 12);
  });

  it("honours a maxPixels override", () => {
    expect(backingScale(1000, 1000, 2, 8_000_000)).toBe(2);
  });

  it("never drops below a scale of 1", () => {
    expect(backingScale(1_000_000, 1_000_000, 2, 1)).toBe(1);
  });

  it("never exceeds the preferred scale", () => {
    expect(backingScale(10, 10, 2, 4_000_000)).toBeLessThanOrEqual(2);
  });
});

const badValues: readonly (readonly [string, number])[] = [
  ["zero", 0],
  ["negative", -1],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
];

describe.each(badValues)("backingScale rejects %s", (_label, value) => {
  it("cssWidth", () => {
    expect(() => backingScale(value, 100, 1)).toThrow(/cssWidth/);
  });

  it("cssHeight", () => {
    expect(() => backingScale(100, value, 1)).toThrow(/cssHeight/);
  });

  it("devicePixelRatio", () => {
    expect(() => backingScale(100, 100, value)).toThrow(/devicePixelRatio/);
  });

  it("maxPixels", () => {
    expect(() => backingScale(100, 100, 1, value)).toThrow(/maxPixels/);
  });
});

describe("backingPixels", () => {
  it("returns integer CSS pixels scaled by the backing scale", () => {
    expect(backingPixels(100, 100, 2)).toEqual({ width: 200, height: 200 });
  });

  it("rounds to the nearest integer", () => {
    expect(backingPixels(100.4, 50.6, 1)).toEqual({ width: 100, height: 51 });
  });

  it("always reports at least one pixel per axis", () => {
    expect(backingPixels(0.2, 0.2, 1)).toEqual({ width: 1, height: 1 });
  });

  it("derives its scale from backingScale", () => {
    const scale = backingScale(1000, 1000, 2);
    expect(backingPixels(1000, 1000, 2)).toEqual({
      width: Math.round(1000 * scale),
      height: Math.round(1000 * scale),
    });
  });

  it("validates its arguments through backingScale", () => {
    expect(() => backingPixels(0, 100, 1)).toThrow(/cssWidth/);
    expect(() => backingPixels(100, 100, 1, Number.NaN)).toThrow(/maxPixels/);
  });
});
