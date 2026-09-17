import { expect, test } from "playwright/test";
import { escapeDirect } from "../../src/domain/engines/direct";
import { escapeDirectFloat } from "../../src/domain/engines/directFloat";
import { bigComplex } from "../../src/domain/numeric/bigcomplex";
import { fromDecimal, toFloat } from "../../src/domain/numeric/bigfixed";
import { makeView, pixelToComplex, scaleExponentOf } from "../../src/domain/view/view";
import { decodeView, encodeView } from "../../src/domain/view/url";
import type { HarnessViewConfig, OrionHarness } from "../../src/test-harness/render";

/**
 * Playwright serialises only the callback body into the page, so nothing from
 * this module is in scope there — every callback below reaches for the harness
 * itself. A helper defined here would be `undefined` in the browser.
 */

const SHALLOW: HarnessViewConfig = {
  centerRe: "-0.75",
  centerIm: "0.1",
  width: "0.5",
  fracBits: 256,
  pixelWidth: 64,
  pixelHeight: 48,
  maxIterations: 400,
};

/**
 * The differential: the WebGL2 shader iterates the same recurrence as
 * `escapeDirectFloat`, in `f32` instead of `f64`. Every pixel's escape count is
 * compared as a number, so a disagreement is a precision difference and nothing
 * else.
 */
test("WebGL2 escape counts match the CPU L0 engine", async ({ page }) => {
  await page.goto("/harness.html");
  const result = await page.evaluate((config: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api)
      throw new Error("harness API missing: did /src/test-harness/webgl.ts load?");
    return api.renderEscapeCounts(config, "webgl2", "preview");
  }, SHALLOW);
  expect(result.stage).toBe("direct-f32");
  expect(result.counts).toHaveLength(SHALLOW.pixelWidth * SHALLOW.pixelHeight);

  const F = SHALLOW.fracBits;
  const view = makeView(
    bigComplex(fromDecimal(SHALLOW.centerRe, F), fromDecimal(SHALLOW.centerIm, F)),
    fromDecimal(SHALLOW.width, F),
    SHALLOW.pixelWidth,
    SHALLOW.pixelHeight,
  );

  let compared = 0;
  let mismatched = 0;
  let escaped = 0;
  let interior = 0;
  let maxDelta = 0;
  let interiorAgreement = 0;
  const histogram: Record<string, number> = {};
  for (let py = 0; py < view.pixelHeight; py++) {
    for (let px = 0; px < view.pixelWidth; px++) {
      const c = pixelToComplex(view, px, py);
      const expected = escapeDirectFloat(
        toFloat(c.re),
        toFloat(c.im),
        SHALLOW.maxIterations,
      );
      const want = expected.escaped ? expected.iterations : -1;
      const got = result.counts[py * view.pixelWidth + px] as number;
      compared++;
      if (want === -1) interior++;
      else escaped++;
      if ((want === -1) === (got === -1)) interiorAgreement++;
      if (got !== want) {
        mismatched++;
        const delta = Math.abs(got - want);
        maxDelta = Math.max(maxDelta, delta);
        const bucket =
          delta === 1
            ? "1"
            : delta <= 3
              ? "2-3"
              : delta <= 10
                ? "4-10"
                : delta <= 50
                  ? "11-50"
                  : "50+";
        histogram[bucket] = (histogram[bucket] ?? 0) + 1;
      }
    }
  }

  // Non-degenerate: the view really contains both kinds of pixel, so a
  // "everything matched" result cannot come from everything being equal.
  expect(compared).toBe(64 * 48);
  expect(escaped).toBeGreaterThan(100);
  expect(interior).toBeGreaterThan(100);

  // f32 against f64 at 400 iterations. Measured: 328 of 3072 pixels differ, and
  // they are *not* one-iteration wobbles — 88 are ±1 but 89 exceed 50. This is
  // f32 rounding accumulating until trajectories diverge, which is why this
  // backend is a preview engine and `exact` quality routes to the CPU path.
  // Both bounds are tripwires around the measurement.
  expect(interiorAgreement / compared).toBeGreaterThan(0.97);
  expect(mismatched / compared).toBeLessThan(0.15);
  expect(histogram["1"]).toBeGreaterThan(0);
  expect(maxDelta).toBeGreaterThan(10);
});

/**
 * The kernel is *correct*, stated as the strongest available claim: at a low
 * iteration budget the f32 shader and the f64 host agree on every single pixel.
 *
 * This is the pin that would catch a flipped axis, an off-by-half-pixel origin,
 * a transposed readback or a wrong step vector — all of which produce mismatches
 * here, while the higher-budget test below could hide them inside its tolerance.
 */
test("WebGL2 agrees with the CPU L0 engine exactly at a low iteration budget", async ({
  page,
}) => {
  await page.goto("/harness.html");
  const config: HarnessViewConfig = { ...SHALLOW, maxIterations: 8 };
  const result = await page.evaluate((cfg: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.renderEscapeCounts(cfg);
  }, config);
  const F = config.fracBits;
  const view = makeView(
    bigComplex(fromDecimal(config.centerRe, F), fromDecimal(config.centerIm, F)),
    fromDecimal(config.width, F),
    config.pixelWidth,
    config.pixelHeight,
  );
  let mismatched = 0;
  let compared = 0;
  let maxDelta = 0;
  for (let py = 0; py < view.pixelHeight; py++) {
    for (let px = 0; px < view.pixelWidth; px++) {
      const c = pixelToComplex(view, px, py);
      const expected = escapeDirectFloat(
        toFloat(c.re),
        toFloat(c.im),
        config.maxIterations,
      );
      const want = expected.escaped ? expected.iterations : -1;
      const got = result.counts[py * view.pixelWidth + px] as number;
      compared++;
      if (got !== want) {
        mismatched++;
        maxDelta = Math.max(maxDelta, Math.abs(got - want));
      }
    }
  }
  expect(compared).toBe(64 * 48);
  expect(mismatched).toBe(0);
  expect(maxDelta).toBe(0);
});

test("colour output is real, and interior points are black", async ({ page }) => {
  await page.goto("/harness.html");
  const result = await page.evaluate((config: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.renderColours(config, "webgl2", "preview");
  }, SHALLOW);
  const rgba = result.rgba;
  expect(rgba).toHaveLength(SHALLOW.pixelWidth * SHALLOW.pixelHeight * 4);

  const colours = new Set<string>();
  let blackPixels = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i] as number;
    const g = rgba[i + 1] as number;
    const b = rgba[i + 2] as number;
    const a = rgba[i + 3] as number;
    expect(a).toBe(255);
    colours.add(`${r},${g},${b}`);
    if (r === 0 && g === 0 && b === 0) blackPixels++;
  }
  // A working render produces many distinct colours, and the set interior is
  // drawn black. A uniform image would fail both.
  expect(colours.size).toBeGreaterThan(20);
  expect(blackPixels).toBeGreaterThan(50);
});

test("a deep view is offered by the GPU's perturbation engine rather than refused", async ({
  page,
}) => {
  await page.goto("/harness.html");
  // Plain decimal: `fromDecimal` deliberately refuses exponent notation.
  const deep: HarnessViewConfig = {
    ...SHALLOW,
    width: "0.000000000000000000000000000001",
    pixelWidth: 4,
    pixelHeight: 4,
  };
  const exponent = await page.evaluate((config: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.scaleExponent(config);
  }, deep);
  expect(exponent).toBeLessThan(-20);

  // Both GPU backends now have a perturbation engine, so neither refuses a deep
  // view for preview any more — which is the point of the last two landings.
  for (const backend of ["webgl2", "webgpu"] as const) {
    const capability = await page.evaluate(
      (input: { config: HarnessViewConfig; name: "webgl2" | "webgpu" }) => {
        const api = (window as unknown as { __orion?: OrionHarness }).__orion;
        if (!api) throw new Error("harness API missing");
        return api.capability(input.config, input.name, "preview");
      },
      { config: deep, name: backend },
    );
    expect(capability.supported).toBe(true);
    expect(capability.why).toMatch(/perturbation engine, preview quality/);
  }
});

test("the view coordinates agree between host and browser", async ({ page }) => {
  await page.goto("/harness.html");
  const exponent = await page.evaluate((config: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.scaleExponent(config);
  }, SHALLOW);
  const F = SHALLOW.fracBits;
  const view = makeView(
    bigComplex(fromDecimal(SHALLOW.centerRe, F), fromDecimal(SHALLOW.centerIm, F)),
    fromDecimal(SHALLOW.width, F),
    SHALLOW.pixelWidth,
    SHALLOW.pixelHeight,
  );
  expect(exponent).toBe(scaleExponentOf(view));
});

/**
 * The app shell, end to end: React boots, the backend seam reports a stage, the
 * shader compiles and draws, and nothing surfaced an error. The harness tests
 * above prove the kernel; this proves the app actually wires it up.
 */
test("the app boots, renders and reports its stage", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto("/");
  // Two canvases exist: the visible display surface and a hidden scratch one.
  const canvas = page.locator("canvas:visible");
  await expect(canvas).toBeVisible();
  // The status line only fills in once every pass has completed, and it reports
  // the ladder's plan followed by the backend stages actually used.
  await expect(page.getByText(/direct-f64 → direct-f32/)).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(consoleErrors).toEqual([]);

  // Non-degenerate: the canvas carries an image, not a blank buffer.
  const nonUniform = await page.evaluate(() => {
    // The first canvas is the display surface, and it is a 2D context: the GPU
    // backend renders offscreen and the scheduler's passes are painted here.
    const element = document.querySelector("canvas");
    if (!(element instanceof HTMLCanvasElement)) throw new Error("no canvas");
    const context = element.getContext("2d");
    if (!context) throw new Error("no 2d context");
    const pixels = context.getImageData(0, 0, element.width, element.height).data;
    const seen = new Set<number>();
    for (let i = 0; i < pixels.length; i += 4 * 97) {
      seen.add(
        ((pixels[i] as number) << 16) |
          ((pixels[i + 1] as number) << 8) |
          (pixels[i + 2] as number),
      );
      if (seen.size > 8) break;
    }
    return seen.size;
  });
  expect(nonUniform).toBeGreaterThan(8);
});

/**
 * The WebGPU backend, judged by exactly the same differential as WebGL2.
 *
 * Having one test body serve both backends is the point: the seam is only worth
 * anything if a second implementation can be dropped in and held to the same
 * standard. It also means the *only* thing that can differ between the two
 * results is the kernel, not the harness, the view construction or the
 * comparison.
 */
function compareAgainstCpu(
  counts: number[],
  maxIterations: number,
): {
  compared: number;
  mismatched: number;
  interiorAgreement: number;
  maxDelta: number;
} {
  const F = SHALLOW.fracBits;
  const view = makeView(
    bigComplex(fromDecimal(SHALLOW.centerRe, F), fromDecimal(SHALLOW.centerIm, F)),
    fromDecimal(SHALLOW.width, F),
    SHALLOW.pixelWidth,
    SHALLOW.pixelHeight,
  );
  let compared = 0;
  let mismatched = 0;
  let interiorAgreement = 0;
  let maxDelta = 0;
  for (let py = 0; py < view.pixelHeight; py++) {
    for (let px = 0; px < view.pixelWidth; px++) {
      const c = pixelToComplex(view, px, py);
      const expected = escapeDirectFloat(toFloat(c.re), toFloat(c.im), maxIterations);
      const want = expected.escaped ? expected.iterations : -1;
      const got = counts[py * view.pixelWidth + px] as number;
      compared++;
      if ((want === -1) === (got === -1)) interiorAgreement++;
      if (got !== want) {
        mismatched++;
        maxDelta = Math.max(maxDelta, Math.abs(got - want));
      }
    }
  }
  return { compared, mismatched, interiorAgreement, maxDelta };
}

/**
 * The wheel and the address bar, end to end: the app's own zoom handler moves a
 * fixed-point view, and the link it writes back is the view it is showing.
 */
test("wheel zoom moves the app deeper and keeps the address bar exact", async ({
  page,
}) => {
  await page.goto("/");
  const canvas = page.locator("canvas:visible");
  await expect(canvas).toBeVisible();
  await expect(page.getByText(/direct-f64 → direct-f32/)).toBeVisible({
    timeout: 20_000,
  });
  const box = await canvas.boundingBox();
  if (!box) throw new Error("no canvas box");
  // Off-centre, so a centre-anchored zoom would not produce the same link.
  await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2);
  const before = page.url();
  for (let step = 0; step < 6; step++) {
    await page.mouse.wheel(0, -400);
  }
  await expect.poll(async () => page.url(), { timeout: 20_000 }).not.toBe(before);
  await expect(page.getByRole("alert")).toHaveCount(0);

  // The fragment the app wrote decodes to a view at the depth the page reports,
  // and re-encoding it is stable — so the link is the view, not a rounding of it.
  const hash = new URL(page.url()).hash.slice(1);
  const decoded = decodeView(hash);
  const depth = -scaleExponentOf(decoded.view);
  expect(depth).toBeGreaterThan(5);
  expect(encodeView(decoded.view, decoded.maxIterations ?? undefined)).toBe(hash);
  await expect(page.getByText(new RegExp(`zoom 2\\^${depth}\\b`))).toBeVisible();
});

test("WebGPU agrees with the CPU L0 engine exactly at a low iteration budget", async ({
  page,
}) => {
  await page.goto("/harness.html");
  const config: HarnessViewConfig = { ...SHALLOW, maxIterations: 8 };
  const result = await page.evaluate((cfg: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.renderEscapeCounts(cfg, "webgpu", "preview");
  }, config);
  expect(result.stage).toBe("direct-f32-compute");
  const stats = compareAgainstCpu(result.counts, config.maxIterations);
  // Same claim as WebGL2, on a different GPU API and a different shader
  // language: exact agreement where f32 cannot yet have drifted.
  expect(stats.compared).toBe(64 * 48);
  expect(stats.mismatched).toBe(0);
});

test("WebGPU diverges as iterations accumulate, like its WebGL2 sibling", async ({
  page,
}) => {
  await page.goto("/harness.html");
  const result = await page.evaluate((cfg: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.renderEscapeCounts(cfg, "webgpu", "preview");
  }, SHALLOW);
  const stats = compareAgainstCpu(result.counts, SHALLOW.maxIterations);
  // f32 accumulation, not a defective kernel — the low-budget pin above rules
  // the latter out. Bounds are tripwires around the measurement.
  expect(stats.interiorAgreement / stats.compared).toBeGreaterThan(0.97);
  expect(stats.mismatched / stats.compared).toBeLessThan(0.15);
});

test("WebGPU offers a deep view through the perturbation kernel and refuses it for exact", async ({
  page,
}) => {
  await page.goto("/harness.html");
  const deep: HarnessViewConfig = {
    ...SHALLOW,
    width: "0.000000000000000000000000000001",
    pixelWidth: 4,
    pixelHeight: 4,
  };
  const preview = await page.evaluate((cfg: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.capability(cfg, "webgpu", "preview");
  }, deep);
  // The backend no longer refuses: below the direct limit it switches to the
  // perturbation kernel, which is what gives the GPU any reach at depth at all.
  expect(preview.supported).toBe(true);
  expect(preview.why).toMatch(/perturbation engine, preview quality/);

  // And it says what it cannot do: exact quality at this depth is the CPU's.
  const exact = await page.evaluate((cfg: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.capability(cfg, "webgpu", "exact");
  }, deep);
  expect(exact.supported).toBe(false);
  expect(exact.why).toMatch(/preview engine/);
});

test("WebGPU colour output is real, not a blank buffer", async ({ page }) => {
  await page.goto("/harness.html");
  const result = await page.evaluate((cfg: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.renderColours(cfg, "webgpu", "preview");
  }, SHALLOW);
  expect(result.rgba).toHaveLength(SHALLOW.pixelWidth * SHALLOW.pixelHeight * 4);
  const colours = new Set<string>();
  let blackPixels = 0;
  for (let i = 0; i < result.rgba.length; i += 4) {
    const r = result.rgba[i] as number;
    const g = result.rgba[i + 1] as number;
    const b = result.rgba[i + 2] as number;
    expect(result.rgba[i + 3]).toBe(255);
    colours.add(`${r},${g},${b}`);
    if (r === 0 && g === 0 && b === 0) blackPixels++;
  }
  expect(colours.size).toBeGreaterThan(20);
  expect(blackPixels).toBeGreaterThan(50);
});

/**
 * Emulated double precision, and the reason it exists.
 *
 * A `(hi, lo)` pair of `f32`s carries ~48 significant bits, so the compute
 * backend can represent a pixel offset at 2^-30 — where plain `f32` rounds every
 * pixel in the view to the same number and the image collapses to a single
 * value. The reference is the CPU `f64` engine, which resolves this view with
 * room to spare.
 */
const DEEP: HarnessViewConfig = {
  // Boundary-adjacent in the seahorse valley: a deep view with real structure,
  // so the render cannot be trivially "correct" by being uniformly interior.
  centerRe: "-0.75",
  centerIm: "0.1",
  width: "0.000000059604644775390625", // exactly 2^-24
  fracBits: 256,
  pixelWidth: 16,
  pixelHeight: 12,
  maxIterations: 400,
};

test("the GPU offers preview at any depth through the perturbation kernel, and exact only to its limit", async ({
  page,
}) => {
  await page.goto("/harness.html");

  // Preview: below the direct-f32 limit the backend no longer refuses — it
  // switches to the perturbation kernel, which is what lets a deep view use the
  // GPU at all instead of falling back to the CPU pool.
  const preview = await page.evaluate((cfg: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.capability(cfg, "webgpu", "preview");
  }, DEEP);
  expect(preview.supported).toBe(true);
  expect(preview.why).toMatch(/perturbation engine, preview quality/);

  // Exact: the emulated-double kernel still reaches 2^-40, and says so.
  const exact = await page.evaluate((cfg: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.capability(cfg, "webgpu", "exact");
  }, DEEP);
  expect(exact.supported).toBe(true);
  expect(exact.why).toMatch(/emulated double/);

  // Past that, exact is refused *with a reason*: the perturbation kernel is a
  // preview engine and will not pretend to match the oracle.
  const tooDeep: HarnessViewConfig = {
    ...DEEP,
    width: `0.${"0".repeat(49)}1`,
    fracBits: 256,
  };
  const refused = await page.evaluate((cfg: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.capability(cfg, "webgpu", "exact");
  }, tooDeep);
  expect(refused.supported).toBe(false);
  expect(refused.why).toMatch(/preview engine/);
});

test("emulated double precision renders a 2^-24 view that f32 cannot express", async ({
  page,
}) => {
  await page.goto("/harness.html");
  const result = await page.evaluate((cfg: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.renderEscapeCounts(cfg, "webgpu", "exact");
  }, DEEP);
  expect(result.stage).toBe("direct-ds-compute");

  const F = DEEP.fracBits;
  const view = makeView(
    bigComplex(fromDecimal(DEEP.centerRe, F), fromDecimal(DEEP.centerIm, F)),
    fromDecimal(DEEP.width, F),
    DEEP.pixelWidth,
    DEEP.pixelHeight,
  );

  // The reference is the arbitrary-precision oracle, not the f64 engine: at
  // this depth and budget f64 is itself marginal, so comparing against it
  // would measure two approximations against each other.
  let compared = 0;
  let mismatched = 0;
  const distinct = new Set<number>();
  for (let py = 0; py < view.pixelHeight; py++) {
    for (let px = 0; px < view.pixelWidth; px++) {
      const c = pixelToComplex(view, px, py);
      const expected = escapeDirect(c, DEEP.maxIterations);
      const want = expected.escaped ? expected.iterations : -1;
      const got = result.counts[py * view.pixelWidth + px] as number;
      compared++;
      distinct.add(got);
      if (got !== want) mismatched++;
    }
  }

  // The claim is exactness at a depth f32 cannot express, and it is exact:
  // every pixel matches the arbitrary-precision oracle.
  //
  // This view happens to be uniformly interior at this budget, and the oracle
  // agrees it is — so uniformity is the *correct* answer, not a collapsed
  // render. What proves f32 cannot express it is the capability test above,
  // which refuses preview outright at this spacing; `distinct` is recorded
  // because a single value from a *bad* render would look identical.
  expect(compared).toBe(16 * 12);
  expect(distinct.size).toBeGreaterThanOrEqual(1);
  expect(mismatched).toBe(0);
});

test("double precision agrees exactly with the CPU engine at a low iteration budget", async ({
  page,
}) => {
  await page.goto("/harness.html");
  const config: HarnessViewConfig = { ...SHALLOW, maxIterations: 8 };
  const result = await page.evaluate((cfg: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.renderEscapeCounts(cfg, "webgpu", "exact");
  }, config);
  expect(result.stage).toBe("direct-ds-compute");
  const stats = compareAgainstCpu(result.counts, config.maxIterations);
  expect(stats.compared).toBe(64 * 48);
  expect(stats.mismatched).toBe(0);
});

/**
 * A shared link must reproduce the view it names, and must not be silently
 * replaced by the default when it is malformed. Both halves are pinned here,
 * because "opens the wrong place quietly" is the failure that would make a
 * share feature worse than none.
 */
test("the app opens a shared link and keeps the address bar in step", async ({
  page,
}) => {
  const F = SHALLOW.fracBits;
  const shared = makeView(
    bigComplex(fromDecimal("-0.5", F), fromDecimal("0.25", F)),
    fromDecimal("0.125", F),
    960,
    640,
  );
  const fragment = encodeView(shared, 600);

  await page.goto(`/#${fragment}`);
  await expect(page.getByRole("alert")).toHaveCount(0);
  // The centre label reflects the linked view, not the default (-0.75, 0.1).
  await expect(page.getByText(/−0\.5 \+ 0\.25i/)).toBeVisible({
    timeout: 20_000,
  });
  // And the address bar still carries that view after the render.
  const hash = await page.evaluate(() => window.location.hash);
  expect(hash.length).toBeGreaterThan(1);
  const decoded = decodeView(hash);
  expect(toFloat(decoded.view.center.re)).toBeCloseTo(-0.5, 10);
  expect(toFloat(decoded.view.center.im)).toBeCloseTo(0.25, 10);
});

test("the app reports a malformed link instead of silently showing the default", async ({
  page,
}) => {
  await page.goto("/#v=1&fmt=e&f=256&re=!!!&im=1&w=1&px=8&py=8");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText(/not a base36 digit/)).toBeVisible();
});

/**
 * The CPU worker pool.
 *
 * The claim is bit-identical output: a view rendered as many tiles across
 * several workers must produce exactly the image the single-threaded backend
 * produces as one tile. Comparing assembled images rather than individual tiles
 * also proves the scheduler places every tile correctly — a gap or an overlap
 * would show up as a mismatch, not as a plausible-looking picture.
 */
const POOLED: HarnessViewConfig = {
  centerRe: "-0.75",
  centerIm: "0.1",
  width: "0.5",
  fracBits: 256,
  pixelWidth: 32,
  pixelHeight: 24,
  maxIterations: 300,
};

test("the worker pool renders bit-identically to the serial CPU backend", async ({
  page,
}) => {
  await page.goto("/harness.html");

  const serial = await page.evaluate((cfg: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.renderColours(cfg, "cpu", "exact");
  }, POOLED);

  const pooled = await page.evaluate(async (cfg: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.renderWithPool(cfg, 4);
  }, POOLED);

  // Cross-origin isolation is what makes SharedArrayBuffer available at all, so
  // the headers are asserted rather than assumed — a missing header would make
  // the pool quietly use a different transport.
  expect(pooled.pool.isolated).toBe(true);
  expect(pooled.pool.transport).toBe("shared");
  expect(pooled.pool.size).toBe(4);
  expect(pooled.pool.stats.failed).toBe(0);

  // 32x24 at 8 samples across is 4 by 3 tiles, every one of them dispatched.
  expect(pooled.pool.stats.dispatched).toBe(12);
  expect(pooled.pool.stats.completed).toBe(12);

  // The assembled image is identical, pixel for pixel.
  expect(pooled.counts.length).toBe(serial.rgba.length);
  expect(pooled.counts).toEqual(serial.rgba);
});

/**
 * The perturbation path through the pool: the workers hold the WASM delta
 * carrier, the serial backend on the main thread holds the JavaScript one, and
 * the images must still agree pixel for pixel. That cross-carrier equality is the
 * whole point of the kernel's bit-identity pin — here it is checked end to end,
 * through real workers, a real deep view and the real queued transport.
 */
test("a deep view is bit-identical between the pooled WASM carrier and the serial JS carrier", async ({
  page,
}) => {
  await page.goto("/harness.html");
  const deep: HarnessViewConfig = {
    centerRe: "-0.743643887037151",
    centerIm: "0.13182590420533",
    width: `0.${"0".repeat(59)}1`,
    fracBits: 512,
    pixelWidth: 32,
    pixelHeight: 24,
    maxIterations: 150,
  };

  // The serial backend on this thread uses the JavaScript carrier.
  const serial = await page.evaluate((cfg: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.renderColours(cfg, "cpu", "exact");
  }, deep);
  expect(serial.stage).toBe("perturbation");

  const pooled = await page.evaluate(async (cfg: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.renderWithPool(cfg, 4);
  }, deep);

  expect(pooled.pool.stats.failed).toBe(0);
  // The carrier is reported, not assumed: a silent fall back to JavaScript in
  // the worker would fail here rather than merely be slower.
  expect(pooled.outcomeStages).toContain("perturbation-wasm");
  expect(pooled.counts).toEqual(serial.rgba);
});

/**
 * The tiling a pass gets decides how much of the pool is used, so a one-tile
 * coarse pass is one busy worker and seven idle ones. Measured on the app's
 * coarse pass (a 120x80 sample grid at step 8, 600 iterations, four workers):
 * one tile 1332ms, twelve tiles 607ms, and the planner's choice 512ms.
 */
test("the pool gets enough tiles to use every worker on the coarse pass", async ({
  page,
}) => {
  await page.goto("/harness.html");
  const coarse: HarnessViewConfig = {
    centerRe: "-0.743643887037151",
    centerIm: "0.13182590420533",
    width: `0.${"0".repeat(59)}1`,
    fracBits: 512,
    pixelWidth: 120,
    pixelHeight: 80,
    maxIterations: 600,
  };

  const measure = async (samplesAcross: number) => {
    const started = Date.now();
    const report = await page.evaluate(
      async (input: { cfg: HarnessViewConfig; n: number; s: number }) => {
        const api = (window as unknown as { __orion?: OrionHarness }).__orion;
        if (!api) throw new Error("harness API missing");
        return api.renderWithPoolSized(input.cfg, input.n, input.s);
      },
      { cfg: coarse, n: 4, s: samplesAcross },
    );
    return { ms: Date.now() - started, tiles: report.pool.stats.dispatched };
  };

  // The configuration this replaced: 1024 samples across is the whole 120x80
  // grid in one tile.
  const single = await measure(1024);
  expect(single.tiles).toBe(1);

  // What the planner picks, which is what the app does.
  const planned = await measure(0);
  expect(planned.tiles).toBeGreaterThanOrEqual(4);
  console.log(
    `pass tiling: one tile ${single.ms}ms/${single.tiles} tile vs planned ${planned.ms}ms/${planned.tiles} tiles`,
  );
});

test("the pool refuses to render once it has been disposed", async ({ page }) => {
  await page.goto("/harness.html");
  const problem = await page.evaluate(async (cfg: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.poolAfterDispose(cfg);
  }, POOLED);
  expect(problem).toMatch(/disposed/);
});

/**
 * The Rust→WASM L0 kernel.
 *
 * The contract is bit-identity with the JavaScript kernel — not a tolerance —
 * because a carrier swap that moves a pixel is not safe to rely on. The module
 * was written to the same order of operations precisely so this can be exact.
 *
 * Timings are reported rather than asserted tightly: CPU work *is* measurable on
 * this box (unlike the GPU, where SwiftShader makes numbers meaningless), but a
 * wall-clock threshold in a test is a flake waiting to happen, so the assertion
 * is only a wide sanity bound.
 */
test("the WASM kernel is bit-identical to the JS kernel and measurably faster", async ({
  page,
}) => {
  await page.goto("/harness.html");
  const benchmark = await page.evaluate(async () => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.benchmarkL0(2048, 400, 20);
  });

  expect(benchmark.compared).toBe(2048);
  expect(benchmark.mismatches).toBe(0);
  expect(benchmark.wasmName).toMatch(/wasm/);
  expect(benchmark.jsName).toMatch(/js/);

  // Reported, not asserted: the actual numbers belong in the log and in
  // docs/TESTING.md, where they can be read as evidence.
  console.log(
    `l0 carriers: js=${benchmark.jsMs.toFixed(3)}ms wasm=${benchmark.wasmMs.toFixed(3)}ms speedup=${benchmark.speedup.toFixed(2)}x over ${benchmark.compared} pixels`,
  );

  // A broken build would show up as pathological slowness; anything better is
  // the point of the exercise.
  expect(benchmark.wasmMs).toBeLessThan(benchmark.jsMs * 3);
  expect(benchmark.speedup).toBeGreaterThan(0);
});

test("the pipeline reports the WASM carrier when it renders through the pool", async ({
  page,
}) => {
  await page.goto("/harness.html");
  const stages = await page.evaluate(async () => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    const pool = await api.renderStageFromPool({
      centerRe: "-0.75",
      centerIm: "0.1",
      width: "0.5",
      fracBits: 256,
      pixelWidth: 16,
      pixelHeight: 12,
      maxIterations: 200,
    });
    return pool;
  });
  // The worker chose the WASM carrier; a silent fall back to JS would fail here.
  expect(stages).toBe("direct-f64-simd");
});

/**
 * The series accelerator, now wired into the CPU backend's `preview` path.
 *
 * The wiring was the missing piece: the accelerator had been implemented and
 * pinned since landing 5, but no renderer called it. Both qualities are checked
 * here at the backend level — `exact` must never take the approximation, and
 * `preview` must — and the speed is reported rather than asserted.
 */
const SERIES_VIEW: HarnessViewConfig = {
  centerRe: "-0.743643887037158704752191506114774",
  centerIm: "0.131825904205311970493132056385139",
  // Exactly 2^-56 with 4 pixels is a spacing of 2^-58, below the double limit —
  // so the ladder selects perturbation and the series accelerator applies at
  // all. (At 2^-30 it correctly selects `direct-f64`, where there is nothing to
  // accelerate.)
  width: "0.000000000000000013877787807814457",
  fracBits: 512,
  pixelWidth: 4,
  pixelHeight: 4,
  maxIterations: 3000,
};

test("the series accelerator runs for preview and never for exact", async ({
  page,
}) => {
  await page.goto("/harness.html");
  const benchmark = await page.evaluate(async (cfg: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.benchmarkSeriesQuality(cfg, 3);
  }, SERIES_VIEW);

  expect(benchmark.exactStage).toBe("perturbation");
  expect(benchmark.previewStage).toBe("perturbation+series");
  console.log(
    `series accelerator: exact=${benchmark.exactMs.toFixed(1)}ms (sum=${benchmark.exactChecksum}, interior=${benchmark.interiorPixels}/${benchmark.pixels}) preview=${benchmark.previewMs.toFixed(1)}ms (sum=${benchmark.previewChecksum}) speedup=${benchmark.speedup.toFixed(2)}x`,
  );
  // The accelerator produces the same escape counts, which is what this pin is
  // for. It does **not** assert a speedup: the coefficients and the validation
  // are per *view*, so on a 16-pixel view they cannot pay for themselves, and
  // asserting a ratio here would pin this lane's view size rather than the
  // accelerator. Measured speedups are recorded in docs/TESTING.md.
  expect(benchmark.previewChecksum).toBe(benchmark.exactChecksum);
  expect(benchmark.interiorPixels).toBeGreaterThan(0);
});

/**
 * The tile cache in the browser, through the real CPU backend and the real view
 * construction. The scheduler's own pin proves the lattice and blit arithmetic
 * against an analytic oracle; this one proves the integration — that a pan
 * through the pooled/WASM CPU path reuses tiles and still paints the same
 * picture.
 */
test("the CPU backend reuses lattice tiles across a pan without changing it", async ({
  page,
}) => {
  await page.goto("/harness.html");
  const report = await page.evaluate((config: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    // 8 samples per tile, so a 3-pixel pan leaves most of every tile reusable.
    return api.tileCacheReuse(config, 3, "preview");
  }, SHALLOW);

  expect(report.firstSkipped).toBe(0);
  expect(report.hits).toBeGreaterThan(0);
  expect(report.warmSkipped).toBeGreaterThan(0);
  expect(report.warmTiles).toBeLessThan(report.coldTiles);
  // The safety property, on real rendered pixels rather than stubs.
  expect(report.identical).toBe(true);
});

/**
 * The interaction path, not the renderer: the app's view state is fixed point
 * with a precision derived from the scale, so zooming keeps working where a
 * double has long since stopped being able to name the place. The anchor is
 * deliberately off-centre — a centre anchor stays put whatever the code does.
 */
test("navigation reaches depths a double cannot express, and the link keeps them", async ({
  page,
}) => {
  await page.goto("/harness.html");
  const report = await page.evaluate((config: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.navigateDeep(config, 400, 0.75);
  }, SHALLOW);

  // 0.5 wide over 64 pixels is 2^-7, and 400 steps of 0.75 buy
  // 400 * log2(4/3) = 166 more bits: a pixel spacing of about 2^-173, where a
  // double — which dies at 2^-52 — has no digits left at all.
  expect(report.scaleExponent).toBeLessThanOrEqual(-170);
  expect(report.fracBits).toBeGreaterThan(170);
  // The ladder routes it to the deep engine, and refuses the direct one *by
  // name*: at this depth direct iteration cannot even express a pixel offset.
  expect(report.directValid).toBe(false);
  expect(report.directWhy).toMatch(/below the double limit/);
  expect(report.stageExact).toBe("perturbation");
  // `perturbation-series` is only chosen once a skip has actually been
  // measured; with no measurement the ladder prices the unskipped path, which
  // is the honest assumption rather than a hopeful one.
  expect(report.stagePreview).toBe("perturbation");
  // The link the app writes carries the whole view, exactly: a 2^-173 width has
  // ~52 significant decimal digits, all of which survive the round trip.
  expect(report.roundTrips).toBe(true);
  expect(report.widthDigits).toBeGreaterThan(45);
  // The anchored point moved by a fraction of a pixel so small that the figure
  // is 0 at double precision. Reported by the harness rather than assumed.
  expect(report.anchorDriftUlps).toBeLessThan(1000);
  expect(report.anchorDriftPixels).toBeLessThan(1e-6);
});

/**
 * The GPU perturbation kernel, judged the way every other kernel here is: by the
 * arbitrary-precision oracle, pixel by pixel.
 *
 * A deep view that plain f32 cannot express at all — the offset of a pixel from
 * the view centre is far below the f32 range — is rendered by the GPU through the
 * delta recurrence against a full-precision reference orbit. The delta mantissa is
 * f32 (24 bits) against the CPU's 53, so this is a *preview* engine and the pin
 * says so: it asserts exact agreement at a low iteration budget, where no
 * rounding has accumulated, and measures the divergence at a high one instead of
 * pretending there is none.
 */
test("the GPU perturbation kernel agrees with the oracle at a deep view", async ({
  page,
}) => {
  await page.goto("/harness.html");
  const deep: HarnessViewConfig = {
    centerRe: "-0.75",
    centerIm: "0.1",
    centerRe: "-0.75",
    centerIm: "0.1",
    width: "0.000000059604644775390625", // exactly 2^-24
    fracBits: 256,
    pixelWidth: 16,
    pixelHeight: 12,
    // 48 iterations: the first budget at which the whole view has escaped, so
    // the comparison is not a page of identical interior pixels.
    maxIterations: 48,
  };
  const result = await page.evaluate((cfg: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.renderEscapeCounts(cfg, "webgpu", "preview");
  }, deep);
  expect(result.stage).toBe("perturbation-f32-compute");

  const F = deep.fracBits;
  const view = makeView(
    bigComplex(fromDecimal(deep.centerRe, F), fromDecimal(deep.centerIm, F)),
    fromDecimal(deep.width, F),
    deep.pixelWidth,
    deep.pixelHeight,
  );

  let compared = 0;
  let mismatched = 0;
  let escaped = 0;
  for (let py = 0; py < view.pixelHeight; py++) {
    for (let px = 0; px < view.pixelWidth; px++) {
      const expected = escapeDirect(pixelToComplex(view, px, py), deep.maxIterations);
      const want = expected.escaped ? expected.iterations : -1;
      const got = result.counts[py * view.pixelWidth + px] as number;
      compared++;
      if (want !== got) mismatched++;
      if (expected.escaped) escaped++;
    }
  }
  expect(compared).toBe(16 * 12);
  // Non-degeneracy: a view where nothing escapes would agree trivially.
  expect(escaped).toBe(compared);
  // An exact-equality claim, not a tolerance: the shader's floatexp arithmetic
  // and the oracle agree on every pixel of this view.
  expect(mismatched).toBe(0);
});

test("the GPU perturbation kernel still agrees with the oracle at 400 iterations", async ({
  page,
}) => {
  await page.goto("/harness.html");
  const deep: HarnessViewConfig = {
    centerRe: "-0.75",
    centerIm: "0.1",
    width: "0.000000059604644775390625",
    fracBits: 256,
    pixelWidth: 16,
    pixelHeight: 12,
    maxIterations: 400,
  };
  const result = await page.evaluate((cfg: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.renderEscapeCounts(cfg, "webgpu", "preview");
  }, deep);
  expect(result.stage).toMatch(/^perturbation-f32-compute/);

  const F = deep.fracBits;
  const view = makeView(
    bigComplex(fromDecimal(deep.centerRe, F), fromDecimal(deep.centerIm, F)),
    fromDecimal(deep.width, F),
    deep.pixelWidth,
    deep.pixelHeight,
  );
  let compared = 0;
  let agreeing = 0;
  let worst = 0;
  for (let py = 0; py < view.pixelHeight; py++) {
    for (let px = 0; px < view.pixelWidth; px++) {
      const expected = escapeDirect(pixelToComplex(view, px, py), deep.maxIterations);
      const want = expected.escaped ? expected.iterations : -1;
      const got = result.counts[py * view.pixelWidth + px] as number;
      compared++;
      if (want === got) agreeing++;
      if (want >= 0 && got >= 0) worst = Math.max(worst, Math.abs(want - got));
    }
  }
  console.log(
    `GPU perturbation at 400 iterations: ${agreeing}/${compared} escape counts agree with the oracle, worst shift ${worst}`,
  );
  // Measured, and stronger than expected: the f32 delta mantissa reproduces the
  // oracle's counts exactly here. The wider sweep recorded in docs/TESTING.md
  // covers 2^-24 to 2^-100 at 300 iterations, and 2^-60 at 2000, all exact.
  expect(agreeing).toBe(compared);
  expect(worst).toBe(0);
});

/**
 * The WebGL2 perturbation shader, judged the way every other kernel here is.
 *
 * WebGL2 is the GPU path most browsers actually have, and it has no f64 and no
 * emulated-double kernel, so before this it could not render past 2^-20 at all.
 * The shader sidesteps the limit instead of fighting it: the reference orbit is
 * computed once on the CPU at full precision, uploaded as a float texture, and
 * each fragment iterates only its delta.
 */
test("the WebGL2 perturbation shader matches the oracle at a deep view", async ({
  page,
}) => {
  await page.goto("/harness.html");
  const deep: HarnessViewConfig = {
    centerRe: "-0.75",
    centerIm: "0.1",
    width: "0.000000059604644775390625", // exactly 2^-24
    fracBits: 256,
    pixelWidth: 16,
    pixelHeight: 12,
    maxIterations: 48,
  };
  const result = await page.evaluate((cfg: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.renderEscapeCounts(cfg, "webgl2", "preview");
  }, deep);
  expect(result.stage).toBe("perturbation-f32-fragment");

  const F = deep.fracBits;
  const view = makeView(
    bigComplex(fromDecimal(deep.centerRe, F), fromDecimal(deep.centerIm, F)),
    fromDecimal(deep.width, F),
    deep.pixelWidth,
    deep.pixelHeight,
  );
  let compared = 0;
  let mismatched = 0;
  let escaped = 0;
  for (let py = 0; py < view.pixelHeight; py++) {
    for (let px = 0; px < view.pixelWidth; px++) {
      const expected = escapeDirect(pixelToComplex(view, px, py), deep.maxIterations);
      const want = expected.escaped ? expected.iterations : -1;
      const got = result.counts[py * view.pixelWidth + px] as number;
      compared++;
      if (want !== got) mismatched++;
      if (expected.escaped) escaped++;
    }
  }
  expect(compared).toBe(16 * 12);
  expect(escaped).toBe(compared);
  expect(mismatched).toBe(0);
});

test("WebGL2 offers preview at any depth through the perturbation shader, and refuses exact", async ({
  page,
}) => {
  await page.goto("/harness.html");
  const deep: HarnessViewConfig = {
    ...SHALLOW,
    width: `0.${"0".repeat(49)}1`,
    fracBits: 256,
    pixelWidth: 4,
    pixelHeight: 4,
  };
  const preview = await page.evaluate((cfg: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.capability(cfg, "webgl2", "preview");
  }, deep);
  expect(preview.supported).toBe(true);
  expect(preview.why).toMatch(/perturbation engine, preview quality/);

  const exact = await page.evaluate((cfg: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.capability(cfg, "webgl2", "exact");
  }, deep);
  expect(exact.supported).toBe(false);
  expect(exact.why).toMatch(/below the emulated-double limit/);
});

/**
 * WebGL2's emulated-double kernel, judged by the same differential as WebGPU's.
 *
 * WebGL2 has no f64 and no fma, so the exact product is built by Veltkamp
 * splitting; the result is the same ~48 significant bits, which is what lets a
 * 2^-24 view render at all — a plain f32 offset there collapses to a single
 * value. This is the piece objective item 2 asks for on the broad-reach backend.
 */
test("WebGL2 emulated double precision renders a 2^-24 view that f32 cannot express", async ({
  page,
}) => {
  await page.goto("/harness.html");

  // First a boundary view where the escape counts genuinely vary, so the claim
  // is not satisfied by a render that collapsed to one value.
  const varied: HarnessViewConfig = {
    centerRe: "-0.75",
    centerIm: "0.1",
    width: "0.01",
    fracBits: 256,
    pixelWidth: 8,
    pixelHeight: 6,
    maxIterations: 200,
  };
  const boundary = await page.evaluate((cfg: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.renderEscapeCounts(cfg, "webgl2", "exact");
  }, varied);
  expect(boundary.stage).toBe("direct-ds");
  const boundaryView = makeView(
    bigComplex(
      fromDecimal(varied.centerRe, varied.fracBits),
      fromDecimal(varied.centerIm, varied.fracBits),
    ),
    fromDecimal(varied.width, varied.fracBits),
    varied.pixelWidth,
    varied.pixelHeight,
  );
  let boundaryMismatched = 0;
  const boundaryCounts = new Set<number>();
  for (let py = 0; py < boundaryView.pixelHeight; py++) {
    for (let px = 0; px < boundaryView.pixelWidth; px++) {
      const expected = escapeDirect(
        pixelToComplex(boundaryView, px, py),
        varied.maxIterations,
      );
      const want = expected.escaped ? expected.iterations : -1;
      const got = boundary.counts[py * boundaryView.pixelWidth + px] as number;
      boundaryCounts.add(want);
      if (want !== got) boundaryMismatched++;
    }
  }
  expect(boundaryCounts.size).toBeGreaterThan(1);
  expect(boundaryMismatched).toBe(0);

  // Then the depth claim: a 2^-24 view, which plain f32 cannot express at all.
  const result = await page.evaluate((cfg: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.renderEscapeCounts(cfg, "webgl2", "exact");
  }, DEEP);
  expect(result.stage).toBe("direct-ds");

  const F = DEEP.fracBits;
  const view = makeView(
    bigComplex(fromDecimal(DEEP.centerRe, F), fromDecimal(DEEP.centerIm, F)),
    fromDecimal(DEEP.width, F),
    DEEP.pixelWidth,
    DEEP.pixelHeight,
  );

  // The oracle, not the f64 engine: at this depth f64 is itself marginal.
  //
  // This view is uniform at this budget and the oracle agrees it is, so
  // uniformity is the correct answer rather than a collapsed render; what proves
  // f32 cannot express the view is the capability refusal, pinned separately.
  let compared = 0;
  let mismatched = 0;
  for (let py = 0; py < view.pixelHeight; py++) {
    for (let px = 0; px < view.pixelWidth; px++) {
      const expected = escapeDirect(pixelToComplex(view, px, py), DEEP.maxIterations);
      const want = expected.escaped ? expected.iterations : -1;
      const got = result.counts[py * view.pixelWidth + px] as number;
      compared++;
      if (want !== got) mismatched++;
    }
  }
  expect(compared).toBe(16 * 12);
  expect(mismatched).toBe(0);
});

test("WebGL2 will not claim exact quality past the emulated-double limit", async ({
  page,
}) => {
  await page.goto("/harness.html");
  const tooDeep: HarnessViewConfig = {
    ...SHALLOW,
    width: `0.${"0".repeat(49)}1`,
    fracBits: 256,
    pixelWidth: 4,
    pixelHeight: 4,
  };
  const exact = await page.evaluate((cfg: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.capability(cfg, "webgl2", "exact");
  }, tooDeep);
  expect(exact.supported).toBe(false);
  expect(exact.why).toMatch(/below the emulated-double limit/);
});

/**
 * The zero-copy path: with the page isolated, the scheduler allocates the pass
 * image in shared memory and hands each tile the offset and stride of its
 * rectangle, so the worker writes the pixels where they belong and nothing is
 * copied on this thread. The pin is that the image is still *identical* to the
 * serial backend's, and that the direct path actually ran.
 */
test("the pool writes tiles straight into the shared pass image, and the image is unchanged", async ({
  page,
}) => {
  await page.goto("/harness.html");
  const pooled = await page.evaluate(async (cfg: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.renderColoursWithPool(cfg, 4);
  }, POOLED);
  const serial = await page.evaluate((cfg: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.renderColours(cfg, "cpu", "preview");
  }, POOLED);

  expect(pooled.isolated).toBe(true);
  expect(pooled.pool.stats.failed).toBe(0);
  // The claim: these tiles never crossed a thread boundary.
  expect(pooled.tilesDirect).toBeGreaterThan(0);
  expect(pooled.tilesDirect).toBe(pooled.tilesRendered);
  // And the pixels are exactly what the serial backend produces.
  expect(pooled.rgba).toEqual(serial.rgba);
});

/**
 * The ladder is only adaptive if something tells it what a render measured. This
 * is the loop the app runs between its passes: plan a view, render it, and plan
 * it again with the measurement. Before this, nothing ever supplied one, so the
 * series stage was priced as if it skipped nothing and was never selected.
 */
test("a render's measurement feeds the next plan, and the ladder changes its mind", async ({
  page,
}) => {
  await page.goto("/harness.html");
  const deep: HarnessViewConfig = {
    centerRe: "-0.743643887037151",
    centerIm: "0.13182590420533",
    width: `0.${"0".repeat(59)}1`,
    fracBits: 512,
    pixelWidth: 24,
    pixelHeight: 18,
    maxIterations: 400,
  };
  const report = await page.evaluate(async (cfg: HarnessViewConfig) => {
    const api = (window as unknown as { __orion?: OrionHarness }).__orion;
    if (!api) throw new Error("harness API missing");
    return api.measureAndReplan(cfg);
  }, deep);

  console.log(
    `ladder: ${report.stageBefore}(work=${report.workBefore.toFixed(0)}) -> measured skip ${report.measuredSkip} -> ${report.stageAfter}(work=${report.workAfter.toFixed(0)}), render stage ${report.stage}`,
  );
  // The render really did validate a prefix, and it really was recorded.
  expect(report.measuredSkip).not.toBeNull();
  expect(report.measuredSkip as number).toBeGreaterThan(0);
  // With that measurement the ladder prefers the series stage, and prices it
  // below the unskipped plan rather than merely labelling it.
  expect(report.stageAfter).toBe("perturbation-series");
  expect(report.workAfter).toBeLessThan(report.workBefore);
  // And the render itself used the accelerator, which is what the label means.
  expect(report.stage).toMatch(/perturbation\+series/);
});
