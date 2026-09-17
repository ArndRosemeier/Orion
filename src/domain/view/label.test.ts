import { describe, expect, it } from "vitest";
import { fromDecimal, fromFloat } from "../numeric/bigfixed";
import { zoomAtPixel, viewFromDoubles } from "./navigate";
import { scaleExponentOf } from "./view";
import {
  BASE_DISPLAY_DIGITS,
  describeView,
  displayDigitsFor,
  formatCoordinate,
} from "./label";

describe("formatCoordinate", () => {
  it("truncates with a visible ellipsis rather than rounding silently", () => {
    const third = fromDecimal("0.3333333333333333333333333333", 256);
    expect(formatCoordinate(third, 6)).toBe("0.333333…");
    expect(formatCoordinate(third, 12)).toBe("0.333333333333…");
  });

  it("leaves a value that fits exactly as it is", () => {
    expect(formatCoordinate(fromFloat(-0.75, 256), 18)).toBe("−0.75");
    expect(formatCoordinate(fromFloat(0, 256), 18)).toBe("0");
  });

  it("uses a minus sign, not a hyphen", () => {
    expect(formatCoordinate(fromFloat(-2, 256), 4)).toBe("−2");
  });

  it("refuses a digit count that is not a non-negative integer", () => {
    expect(() => formatCoordinate(fromFloat(1, 256), -1)).toThrow(/digits/);
    expect(() => formatCoordinate(fromFloat(1, 256), 2.5)).toThrow(/digits/);
  });
});

describe("displayDigitsFor", () => {
  it("shows more digits the deeper the view is", () => {
    const shallow = viewFromDoubles(-0.75, 0.1, 3, 96, 64);
    let deep = shallow;
    for (let step = 0; step < 300; step++) deep = zoomAtPixel(deep, 10.5, 10.5, 0.5);
    // 3/96 = 2^-5 on this grid, so the shallow figure is 18 + ceil(5/3) = 20.
    expect(scaleExponentOf(shallow)).toBe(-5);
    expect(displayDigitsFor(shallow)).toBe(BASE_DISPLAY_DIGITS + 2);
    expect(displayDigitsFor(deep)).toBeGreaterThan(displayDigitsFor(shallow) + 80);
  });
});

describe("describeView", () => {
  it("reports the depth the renderer is being asked for", () => {
    const view = viewFromDoubles(-0.75, 0.1, 3, 96, 64);
    expect(scaleExponentOf(view)).toBe(-5);
    expect(describeView(view)).toContain("(zoom 2^5)");
    // 0.1 is not a dyadic rational, so the exact decimal expansion is the long
    // one — the label shows it truncated rather than rounded.
    expect(describeView(view)).toContain("−0.75 + 0.10000000000000000555");
  });

  it("keeps changing when a double would have stopped", () => {
    // Past 2^-60 the centre's *double* representation is frozen: this is exactly
    // the failure the whole landing exists to remove, so the label is the
    // observable that proves it is gone.
    let view = viewFromDoubles(-0.743643887037151, 0.13182590420533, 3, 96, 64);
    for (let step = 0; step < 200; step++) view = zoomAtPixel(view, 48, 32, 0.5);
    const first = describeView(view);
    const zoomed = zoomAtPixel(view, 48, 32, 0.5);
    const second = describeView(zoomed);

    const depth = -scaleExponentOf(zoomed);
    expect(depth).toBeGreaterThanOrEqual(200);
    expect(second).not.toBe(first);
    expect(second).toContain(`(zoom 2^${depth})`);
  });

  it("marks a negative imaginary part once, not twice", () => {
    const view = viewFromDoubles(-0.75, -0.1, 3, 96, 64);
    const label = describeView(view);
    expect(label).toMatch(/− 0\.10000000000000000555.*i/);
    // One minus for the real part, one as the separator: never two in a row.
    expect(label.match(/−/g)?.length).toBe(2);
    expect(label).not.toContain("− −");
  });
});
