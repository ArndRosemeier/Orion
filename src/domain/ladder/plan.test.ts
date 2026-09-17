import { describe, expect, it } from "vitest";
import { F64_PIXEL_EXPONENT_LIMIT, type LadderRequest, planView } from "./plan";

function request(overrides: Partial<LadderRequest> = {}): LadderRequest {
  return {
    scaleExponent: -20,
    maxIterations: 600,
    pixelCount: 1920 * 1080,
    quality: "exact",
    ...overrides,
  };
}

function option(plan: ReturnType<typeof planView>, stage: string) {
  const found = plan.options.find((candidate) => candidate.stage === stage);
  if (!found) throw new Error(`no option ${stage}`);
  return found;
}

describe("stage validity is checked before cost", () => {
  it("never picks a stage that cannot express the view", () => {
    const plan = planView(request({ scaleExponent: -400, quality: "exact" }));
    expect(plan.stage).toBe("perturbation");
    const direct = option(plan, "direct-f64");
    expect(direct.valid).toBe(false);
    expect(direct.estimatedWork).toBeNull();
    expect(direct.why).toMatch(/below the double limit/);
  });

  it("allows direct iteration while the spacing is representable", () => {
    const plan = planView(request({ scaleExponent: F64_PIXEL_EXPONENT_LIMIT }));
    expect(option(plan, "direct-f64").valid).toBe(true);
    expect(plan.stage).toBe("direct-f64");
  });

  it("refuses the series accelerator whenever exact output was asked for", () => {
    const exact = planView(request({ scaleExponent: -400, quality: "exact" }));
    expect(option(exact, "perturbation-series").valid).toBe(false);
    expect(option(exact, "perturbation-series").why).toMatch(/rejected/);
    expect(exact.stage).not.toBe("perturbation-series");
  });

  it("offers the series accelerator for preview quality", () => {
    const preview = planView(request({ scaleExponent: -400, quality: "preview" }));
    expect(option(preview, "perturbation-series").valid).toBe(true);
    expect(option(preview, "perturbation-series").why).toMatch(/approximate/);
  });
});

describe("the choice is auditable", () => {
  it("lists every option with a reason", () => {
    const plan = planView(request({ scaleExponent: -400 }));
    expect(plan.options.map((entry) => entry.stage).sort()).toEqual([
      "direct-f64",
      "perturbation",
      "perturbation-series",
    ]);
    for (const entry of plan.options) {
      expect(entry.why.length).toBeGreaterThan(10);
      if (!entry.valid) expect(entry.estimatedWork).toBeNull();
    }
  });

  it("reports the work estimate it actually chose", () => {
    const plan = planView(request({ scaleExponent: -400 }));
    const chosen = option(plan, plan.stage);
    expect(plan.estimatedWork).toBe(chosen.estimatedWork);
  });

  it("prefers direct iteration at shallow scale, where setup buys nothing", () => {
    // A 1080p frame of direct iteration is ~2e9 iteration-equivalents; the
    // perturbation setup alone is comparable, so direct wins.
    const plan = planView(request({ scaleExponent: -10 }));
    expect(plan.stage).toBe("direct-f64");
  });

  it("prefers perturbation once a double cannot express the view", () => {
    const plan = planView(request({ scaleExponent: -300 }));
    expect(plan.stage).toBe("perturbation");
  });

  it("prefers the series accelerator in preview when a skip is known", () => {
    const withSkip = planView(
      request({ scaleExponent: -300, quality: "preview", measuredSeriesSkip: 400 }),
    );
    expect(withSkip.stage).toBe("perturbation-series");
    const withoutSkip = planView(
      request({ scaleExponent: -300, quality: "preview", measuredSeriesSkip: 0 }),
    );
    // With no measured skip there is nothing to gain, so the exact stage wins.
    expect(withoutSkip.stage).toBe("perturbation");
  });
});

describe("the plan sizes the precision the view needs", () => {
  it("asks for more orbit precision the deeper the view", () => {
    const shallow = planView(request({ scaleExponent: -60 }));
    const deep = planView(request({ scaleExponent: -600 }));
    expect(deep.minOrbitFracBits).toBeGreaterThan(shallow.minOrbitFracBits);
    expect(deep.viewFracBits).toBe(deep.minOrbitFracBits);
  });

  it("keeps the view precision floor for shallow views", () => {
    const plan = planView(request({ scaleExponent: -4 }));
    expect(plan.viewFracBits).toBeGreaterThanOrEqual(128);
  });
});

describe("planView validates its request", () => {
  it("rejects bad iteration counts, pixel counts and exponents", () => {
    expect(() => planView(request({ maxIterations: 0 }))).toThrow(/positive integer/);
    expect(() => planView(request({ pixelCount: -1 }))).toThrow(/positive integer/);
    expect(() => planView(request({ scaleExponent: Number.NaN }))).toThrow(/finite/);
  });
});
