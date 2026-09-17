import { describe, expect, it } from "vitest";
import { CLASSIC_PALETTE } from "../color/palette";
import { escapeDirect } from "../engines/direct";
import { escapeDirectFloat } from "../engines/directFloat";
import { bigComplex } from "../numeric/bigcomplex";
import { fromDecimal, toFloat } from "../numeric/bigfixed";
import { makeView, pixelToComplex, scaleExponentOf } from "../view/view";
import type { ConvergedOrbit } from "../engines/reference";
import type { SeriesApproximation } from "../engines/series";
import { makeTileResult } from "./backend";
import { createCpuBackend } from "./cpu";
import { createLruCache, splitIntoTiles } from "./tiles";

const F = 256;

function viewAt(re: string, im: string, widthExponent: number, pixels: number) {
  return makeView(
    bigComplex(fromDecimal(re, F), fromDecimal(im, F)),
    { v: 1n << BigInt(F + widthExponent), fracBits: F },
    pixels,
    pixels,
  );
}

async function renderCounts(
  view: ReturnType<typeof makeView>,
  maxIterations: number,
  quality: "preview" | "exact" = "exact",
) {
  const backend = createCpuBackend();
  const tile = { x: 0, y: 0, width: view.pixelWidth, height: view.pixelHeight };
  const result = makeTileResult(tile.width, tile.height, "escape-count");
  await backend.render(
    {
      view,
      tile,
      step: 1,
      quality,
      maxIterations,
      palette: CLASSIC_PALETTE,
      output: "escape-count",
    },
    result,
  );
  return result;
}

describe("the CPU backend reproduces the L0 engine pixel for pixel", () => {
  it("matches escapeDirectFloat on every pixel of a shallow tile", async () => {
    const view = viewAt("-0.75", "0.1", -2, 8); // spacing 2^-5
    expect(scaleExponentOf(view)).toBe(-5);
    const result = await renderCounts(view, 400);
    expect(result.stage).toBe("direct-f64");

    for (let py = 0; py < view.pixelHeight; py++) {
      for (let px = 0; px < view.pixelWidth; px++) {
        const c = pixelToComplex(view, px, py);
        const expected = escapeDirectFloat(toFloat(c.re), toFloat(c.im), 400);
        const actual = result.escapeCounts[py * view.pixelWidth + px];
        expect(actual).toBe(expected.escaped ? expected.iterations : -1);
      }
    }
  }, 60_000);

  it("uses -1 for interior points and the escape count otherwise", async () => {
    const view = viewAt("0", "0", -3, 4); // centred on a point deep inside the set
    const result = await renderCounts(view, 50);
    const counts = Array.from(result.escapeCounts);
    expect(counts.every((value) => value === -1)).toBe(true);
  }, 60_000);
});

describe("the CPU backend follows the ladder", () => {
  it("switches to perturbation once a double cannot express the view", async () => {
    const view = viewAt(
      "-0.743643887037158704752191506114774",
      "0.131825904205311970493132056385139",
      -60,
      3,
    );
    expect(scaleExponentOf(view)).toBeLessThan(-52);
    // `exact` never takes the series accelerator...
    const exact = await renderCounts(view, 120, "exact");
    expect(exact.stage).toBe("perturbation");
    // ...and `preview` always does, which is the whole meaning of the field.
    const preview = await renderCounts(view, 120, "preview");
    // BLA joins the preview path when a jump validates on this view, which it
    // does at this depth; the stage names it rather than hiding it.
    expect(preview.stage).toBe("perturbation+series+bla");
    // Every pixel resolved to a real answer — and "finite" is not enough to say
    // so, because a buffer that was never written is full of finite zeros. The
    // exact path is compared against the arbitrary-precision oracle pixel by
    // pixel, which is the only assertion that would have caught the render being
    // skipped entirely.
    expect(exact.escapeCounts.length).toBe(9);
    for (let py = 0; py < view.pixelHeight; py++) {
      for (let px = 0; px < view.pixelWidth; px++) {
        const expected = escapeDirect(pixelToComplex(view, px, py), 120);
        const want = expected.escaped ? expected.iterations : -1;
        expect(exact.escapeCounts[py * view.pixelWidth + px]).toBe(want);
      }
    }
    expect(preview.escapeCounts.length).toBe(9);
    for (const value of preview.escapeCounts) {
      expect(Number.isFinite(value)).toBe(true);
    }
    // The approximation must still be a plausible image, not a blank one.
    expect(Array.from(preview.escapeCounts).some((value) => value !== 0)).toBe(true);
  }, 120_000);

  it("refuses a forced f64 stage on a view that needs perturbation", () => {
    const view = viewAt("-0.75", "0.1", -60, 2);
    const backend = createCpuBackend({ forceStage: "direct-f64" });
    const capability = backend.capability(view, {
      stage: "perturbation",
      quality: "exact",
      viewFracBits: F,
      minOrbitFracBits: F,
      maxIterations: 100,
      estimatedWork: 0,
      options: [],
      reason: "test",
    });
    expect(capability.supported).toBe(false);
    expect(capability.why).toMatch(/below the double limit/);
  });
});

describe("the CPU backend validates its buffers", () => {
  it("rejects a result buffer that does not match the tile", async () => {
    const view = viewAt("-0.75", "0.1", -2, 4);
    const backend = createCpuBackend();
    const wrong = makeTileResult(2, 2, "escape-count");
    await expect(
      backend.render(
        {
          view,
          tile: { x: 0, y: 0, width: 4, height: 4 },
          step: 1,
          quality: "preview",
          maxIterations: 50,
          palette: CLASSIC_PALETTE,
          output: "escape-count",
        },
        wrong,
      ),
    ).rejects.toThrow(/result buffer/);
  }, 60_000);

  it("rejects a tile that does not fit the view", async () => {
    const view = viewAt("-0.75", "0.1", -2, 4);
    const backend = createCpuBackend();
    const result = makeTileResult(4, 4, "escape-count");
    await expect(
      backend.render(
        {
          view,
          tile: { x: 2, y: 2, width: 4, height: 4 },
          step: 1,
          quality: "preview",
          maxIterations: 50,
          palette: CLASSIC_PALETTE,
          output: "escape-count",
        },
        result,
      ),
    ).rejects.toThrow(/does not fit/);
  }, 60_000);
});

describe("the reference-orbit cache pays off across tiles", () => {
  const DEEP_RE = "-0.743643887037158704752191506114774";
  const DEEP_IM = "0.131825904205311970493132056385139";

  it("computes one orbit for every tile of a view", async () => {
    // A deep view, so the perturbation path — and therefore the expensive
    // high-precision orbit — is what is being cached.
    const view = viewAt(DEEP_RE, DEEP_IM, -60, 6);
    const cache = createLruCache<string, ConvergedOrbit>(4);
    const backend = createCpuBackend({ orbitCache: cache });
    const tiles = splitIntoTiles(view.pixelWidth, view.pixelHeight, 1, 3).tiles;

    for (const tile of tiles) {
      const result = makeTileResult(tile.width, tile.height, "escape-count");
      await backend.render(
        {
          view,
          tile,
          step: 1,
          quality: "preview",
          maxIterations: 60,
          palette: CLASSIC_PALETTE,
          output: "escape-count",
        },
        result,
      );
    }

    // The reference point is the view centre, so all four tiles ask for the
    // same orbit: one miss, three hits.
    expect(tiles.length).toBe(4);
    expect(cache.misses).toBe(1);
    expect(cache.hits).toBe(3);
    expect(cache.size).toBe(1);
  }, 120_000);
});

describe("the series-coefficient cache pays off across tiles", () => {
  const DEEP_RE = "-0.743643887037158704752191506114774";
  const DEEP_IM = "0.131825904205311970493132056385139";

  it("builds one set of coefficients for every tile of a view", async () => {
    const view = viewAt(DEEP_RE, DEEP_IM, -60, 6);
    const orbitCache = createLruCache<string, ConvergedOrbit>(4);
    const seriesCache = createLruCache<string, SeriesApproximation>(4);
    const backend = createCpuBackend({ orbitCache, seriesCache });
    const tiles = splitIntoTiles(view.pixelWidth, view.pixelHeight, 1, 3).tiles;

    for (const tile of tiles) {
      const result = makeTileResult(tile.width, tile.height, "escape-count");
      await backend.render(
        {
          view,
          tile,
          step: 1,
          quality: "preview",
          maxIterations: 60,
          palette: CLASSIC_PALETTE,
          output: "escape-count",
        },
        result,
      );
      expect(result.stage).toBe("perturbation+series+bla");
    }

    // Coefficients are shared the same way the orbit is: once per view.
    expect(tiles.length).toBe(4);
    expect(seriesCache.misses).toBe(1);
    expect(seriesCache.hits).toBe(3);

    // And `exact` never touches them at all.
    const exactCache = createLruCache<string, SeriesApproximation>(4);
    const exactBackend = createCpuBackend({ seriesCache: exactCache });
    const exactResult = makeTileResult(3, 3, "escape-count");
    await exactBackend.render(
      {
        view,
        tile: { x: 0, y: 0, width: 3, height: 3 },
        step: 1,
        quality: "exact",
        maxIterations: 60,
        palette: CLASSIC_PALETTE,
        output: "escape-count",
      },
      exactResult,
    );
    expect(exactResult.stage).toBe("perturbation");
    expect(exactCache.misses).toBe(0);
    expect(exactCache.hits).toBe(0);
  }, 120_000);
});
