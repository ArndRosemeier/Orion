import { describe, expect, it } from "vitest";
import { bigComplex } from "../numeric/bigcomplex";
import { fromFloat } from "../numeric/bigfixed";
import { makeView } from "../view/view";
import type { Capability, FractalBackend, TileRequest, TileResult } from "./backend";
import { chooseBackend } from "./select";

const F = 256;

const view = makeView(
  bigComplex(fromFloat(-0.75, F), fromFloat(0.1, F)),
  fromFloat(1, F),
  16,
  16,
);

const plan = {
  stage: "direct-f64" as const,
  quality: "preview" as const,
  viewFracBits: F,
  minOrbitFracBits: F,
  maxIterations: 100,
  estimatedWork: 0,
  options: [],
  reason: "test",
};

function stub(name: string, capability: Capability): FractalBackend {
  return {
    name,
    capability: () => capability,
    async render(_request: TileRequest, into: TileResult): Promise<TileResult> {
      return into;
    },
    dispose(): void {},
  };
}

describe("chooseBackend is GPU-first but never silent", () => {
  it("takes the first candidate that can render", () => {
    const choice = chooseBackend(
      [
        {
          name: "webgpu",
          backendKind: "gpu",
          backend: stub("webgpu", { supported: true, why: "compute is available" }),
        },
        {
          name: "webgl2",
          backendKind: "gpu",
          backend: stub("webgl2", { supported: true, why: "fragment path" }),
        },
      ],
      view,
      plan,
    );
    expect(choice.kind).toBe("chosen");
    if (choice.kind !== "chosen") return;
    expect(choice.name).toBe("webgpu");
    expect(choice.why).toBe("compute is available");
    expect(choice.refused).toHaveLength(0);
  });

  it("falls through to a later candidate and keeps the refusal reason", () => {
    const choice = chooseBackend(
      [
        {
          name: "webgpu",
          backendKind: "gpu",
          backend: stub("webgpu", { supported: false, why: "no adapter" }),
        },
        {
          name: "webgl2",
          backendKind: "gpu",
          backend: stub("webgl2", { supported: true, why: "fragment path" }),
        },
      ],
      view,
      plan,
    );
    expect(choice.kind).toBe("chosen");
    if (choice.kind !== "chosen") return;
    expect(choice.name).toBe("webgl2");
    expect(choice.refused).toEqual([{ name: "webgpu", why: "no adapter" }]);
  });

  it("returns every reason when nothing can render the view", () => {
    const choice = chooseBackend(
      [
        {
          name: "webgpu",
          backendKind: "gpu",
          backend: stub("webgpu", { supported: false, why: "no adapter" }),
        },
        {
          name: "webgl2",
          backendKind: "gpu",
          backend: stub("webgl2", { supported: false, why: "below the f32 limit" }),
        },
      ],
      view,
      plan,
    );
    expect(choice.kind).toBe("refused");
    if (choice.kind !== "refused") return;
    expect(choice.reasons.map((entry) => entry.name)).toEqual(["webgpu", "webgl2"]);
    expect(choice.reasons[1]?.why).toMatch(/f32 limit/);
  });

  it("carries the candidate's concurrency through, defaulting to one", () => {
    const pooled = chooseBackend(
      [
        {
          name: "cpu-pool",
          backendKind: "pool",
          backend: stub("cpu-pool", { supported: true, why: "workers available" }),
          concurrency: 6,
        },
      ],
      view,
      plan,
    );
    expect(pooled.kind === "chosen" && pooled.concurrency).toBe(6);

    const single = chooseBackend(
      [
        {
          name: "webgl2",
          backendKind: "gpu",
          backend: stub("webgl2", { supported: true, why: "one draw" }),
        },
      ],
      view,
      plan,
    );
    expect(single.kind === "chosen" && single.concurrency).toBe(1);
  });

  it("rejects an empty candidate list loudly", () => {
    expect(() => chooseBackend([], view, plan)).toThrow(/at least one candidate/);
  });
});
