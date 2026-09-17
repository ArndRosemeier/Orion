import { describe, expect, it } from "vitest";
import { bigComplex } from "../numeric/bigcomplex";
import { cmp, fromDecimal, fromFloat } from "../numeric/bigfixed";
import { makeView, pixelToComplex, scaleExponentOf, type View } from "./view";
import { VIEW_URL_VERSION, decodeView, encodeView, viewUrl } from "./url";

const F = 256;

function viewAt(re: string, im: string, width: string, px = 64, py = 48): View {
  return makeView(
    bigComplex(fromDecimal(re, F), fromDecimal(im, F)),
    fromDecimal(width, F),
    px,
    py,
  );
}

describe("encodeView / decodeView round-trip exactly", () => {
  it("preserves every bit of a deep coordinate", () => {
    const original = viewAt(
      "-0.743643887037158704752191506114774",
      "0.131825904205311970493132056385139",
      "0.000000000000000000000000000001",
    );
    const decoded = decodeView(encodeView(original));
    expect(cmp(decoded.view.center.re, original.center.re)).toBe(0);
    expect(cmp(decoded.view.center.im, original.center.im)).toBe(0);
    expect(cmp(decoded.view.width, original.width)).toBe(0);
    expect(decoded.view.center.re.fracBits).toBe(original.center.re.fracBits);
    expect(decoded.view.pixelWidth).toBe(original.pixelWidth);
    expect(decoded.view.pixelHeight).toBe(original.pixelHeight);
    expect(scaleExponentOf(decoded.view)).toBe(scaleExponentOf(original));
  });

  it("round-trips a value with far more precision than a double", () => {
    // A 256-bit dyadic centre: a double could hold at most 53 of these bits.
    const original = makeView(
      bigComplex(
        { v: 123456789012345678901234567890n, fracBits: F },
        { v: -987654321n, fracBits: F },
      ),
      { v: 1n << 200n, fracBits: F },
      32,
      32,
    );
    const decoded = decodeView(encodeView(original));
    expect(cmp(decoded.view.center.re, original.center.re)).toBe(0);
    expect(cmp(decoded.view.center.im, original.center.im)).toBe(0);
    expect(cmp(decoded.view.width, original.width)).toBe(0);
  });

  it("maps every decoded pixel to the same complex point as the original", () => {
    const original = viewAt("-0.75", "0.1", "0.5", 16, 12);
    const decoded = decodeView(encodeView(original));
    for (const [px, py] of [
      [0, 0],
      [5, 7],
      [15, 11],
    ] as const) {
      const a = pixelToComplex(original, px, py);
      const b = pixelToComplex(decoded.view, px, py);
      expect(cmp(a.re, b.re)).toBe(0);
      expect(cmp(a.im, b.im)).toBe(0);
    }
  });

  it("carries the iteration budget when asked, and omits it otherwise", () => {
    const view = viewAt("-0.75", "0.1", "0.5", 8, 8);
    expect(decodeView(encodeView(view, 1234)).maxIterations).toBe(1234);
    expect(decodeView(encodeView(view)).maxIterations).toBeNull();
  });

  it("produces a fragment short enough to paste", () => {
    const view = viewAt("-0.75", "0.1", "1");
    const fragment = encodeView(view);
    // Base36 of 256-bit values: compact enough for a chat message.
    expect(fragment.length).toBeLessThan(220);
    expect(fragment).toContain(`v=${VIEW_URL_VERSION}`);
    expect(fragment).toContain("fmt=e");
  });

  it("composes a full link", () => {
    const view = viewAt("-0.75", "0.1", "1");
    expect(viewUrl(view, "https://example.test/orion")).toBe(
      `https://example.test/orion#${encodeView(view)}`,
    );
  });
});

describe("decodeView accepts a hand-written decimal link", () => {
  it("parses decimals and keeps every digit it was given", () => {
    const decoded = decodeView(
      "v=1&fmt=d&f=256&re=-0.743643887037158704752191506114774&im=0.131825904205311970493132056385139&w=0.001&px=64&py=48",
    );
    expect(
      cmp(
        decoded.view.center.re,
        fromDecimal("-0.743643887037158704752191506114774", F),
      ),
    ).toBe(0);
    // The 33rd decimal digit survived, which a double could not have carried.
    expect(decoded.view.center.re.v % 1000000n).not.toBe(0n);
  });

  it("accepts a leading hash", () => {
    const fragment = encodeView(viewAt("-0.75", "0.1", "1"));
    expect(decodeView(`#${fragment}`).view.pixelWidth).toBe(64);
  });
});

describe("decodeView fails loudly on a bad link", () => {
  const bad: Array<[string, RegExp]> = [
    ["", /empty fragment/],
    ["v=2&fmt=e&f=256&re=1&im=1&w=1&px=8&py=8", /invalid parameters/],
    ["v=1&fmt=x&f=256&re=1&im=1&w=1&px=8&py=8", /invalid parameters/],
    ["v=1&fmt=e&f=0&re=1&im=1&w=1&px=8&py=8", /invalid parameters/],
    ["v=1&fmt=e&f=256&re=1&im=1&w=1&px=0&py=8", /invalid parameters/],
    ["v=1&fmt=e&f=256&re=1&im=1&w=1&px=8", /invalid parameters/],
    ["v=1&fmt=e&f=256&re=!!!&im=1&w=1&px=8&py=8", /not a base36 digit/],
  ];

  for (const [text, pattern] of bad) {
    it(`rejects ${text === "" ? "(empty)" : text}`, () => {
      expect(() => decodeView(text)).toThrow(pattern);
    });
  }

  it("rejects a link whose precision cannot resolve its own pixels", () => {
    // Width 71/2^32 across 4096 pixels is a spacing of ~2^-38, which 32
    // fractional bits cannot resolve: `makeView` must reject it.
    expect(() => decodeView("v=1&fmt=e&f=32&re=0&im=0&w=1z&px=4096&py=4096")).toThrow();
  });

  it("rejects a decimal field when the format says exact base36", () => {
    expect(() => decodeView("v=1&fmt=e&f=256&re=-0.75&im=0.1&w=1&px=8&py=8")).toThrow(
      /not a base36 digit/,
    );
  });

  it("rejects a non-integer precision", () => {
    expect(() => decodeView("v=1&fmt=e&f=abc&re=1&im=1&w=1&px=8&py=8")).toThrow(
      /invalid parameters/,
    );
  });
});

describe("encoded links survive a trip through text", () => {
  it("round-trips through URLSearchParams unchanged", () => {
    const original = viewAt("-0.75", "0.1", "0.5");
    const fragment = encodeView(original, 600);
    const reparsed = new URLSearchParams(fragment).toString();
    expect(reparsed).toBe(fragment);
    const decoded = decodeView(reparsed);
    expect(cmp(decoded.view.center.re, original.center.re)).toBe(0);
    expect(decoded.maxIterations).toBe(600);
  });

  it("handles a negative zero-ish centre and a wide view", () => {
    for (const [re, im, w] of [
      ["0", "0", "4"],
      ["-2", "0", "0.000001"],
      ["0.25", "-0.5", "3"],
    ] as const) {
      const original = viewAt(re, im, w, 16, 16);
      const decoded = decodeView(encodeView(original));
      expect(cmp(decoded.view.center.re, original.center.re)).toBe(0);
      expect(cmp(decoded.view.center.im, original.center.im)).toBe(0);
      expect(cmp(decoded.view.width, original.width)).toBe(0);
    }
  });

  it("survives a view at the minimum working precision", () => {
    // 128 bits is the floor `makeView` enforces; anything below it is refused at
    // construction, so it is the lowest precision a link can legitimately carry.
    const original = makeView(
      bigComplex(fromFloat(-0.5, 128), fromFloat(0.25, 128)),
      fromFloat(2, 128),
      16,
      16,
    );
    const decoded = decodeView(encodeView(original));
    expect(decoded.view.center.re.fracBits).toBe(128);
    expect(cmp(decoded.view.center.re, original.center.re)).toBe(0);
  });
});
