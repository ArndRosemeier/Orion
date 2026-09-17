import { describe, expect, it } from "vitest";
import { clamp } from "./clamp";

describe("clamp", () => {
  it("returns n when inside range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it("clamps below min", () => {
    expect(clamp(-1, 0, 10)).toBe(0);
  });

  it("clamps above max", () => {
    expect(clamp(99, 0, 10)).toBe(10);
  });

  it("throws when min > max", () => {
    expect(() => clamp(1, 10, 0)).toThrow(/min .* > max/);
  });
});
