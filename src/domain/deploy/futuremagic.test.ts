import { describe, expect, it } from "vitest";
import htaccess from "../../../public/.htaccess?raw";
import manifestoRaw from "../../../public/futuremagic.json?raw";
import deployScript from "../../../deploy-sync.sh?raw";

/**
 * The deploy's contract with the website, pinned.
 *
 * These files are not exercised by the app or by the browser lane: a missing
 * `.wasm` MIME type or a missing cross-origin-isolation header would only show up
 * in production, as a silent fall back to the slower transport (or as a kernel
 * that refuses to instantiate). The registry entry the site renders is derived
 * from the same values, so drift between them is a broken card.
 */
describe("the futuremagic deploy", () => {
  const manifesto = JSON.parse(manifestoRaw) as Record<string, unknown>;

  it("declares a card the website can render", () => {
    expect(typeof manifesto.title).toBe("string");
    expect(typeof manifesto.tagline).toBe("string");
    expect(Array.isArray(manifesto.tags)).toBe(true);
    expect((manifesto.tags as unknown[]).length).toBeGreaterThan(0);
  });

  it("points at a screenshot that is deployed with the app, not at a shared path", () => {
    const screenshot = manifesto.screenshot;
    expect(typeof screenshot).toBe("string");
    // The site resolves a relative path against the app's own directory, so a
    // relative value is a file this deploy uploads. An absolute path would point
    // at a directory nothing in this repo writes — which is why the sibling
    // project's card image is a 404.
    expect(screenshot as string).not.toMatch(/^\//);
    expect(screenshot as string).not.toMatch(/^https?:/);
    expect(screenshot).toBe("shot.png");
  });

  it("keeps the apache config patchable and complete", () => {
    // The deploy patches this line rather than editing the file per host.
    expect(htaccess).toMatch(/^\s*RewriteBase\s+\S+/m);
    // Without the WASM type the kernels are served as octet-stream and
    // `instantiateStreaming` refuses them.
    expect(htaccess).toMatch(/AddType application\/wasm \.wasm/);
    // Orion's worker pool uses SharedArrayBuffer; without these two the pool
    // silently falls back to transferring buffers instead of writing in place.
    expect(htaccess).toMatch(/Cross-Origin-Opener-Policy/);
    expect(htaccess).toMatch(/Cross-Origin-Embedder-Policy/);
  });

  it("registers the same path it deploys to", () => {
    const base = /^BASE_PATH="([^"]+)"/m.exec(deployScript)?.[1];
    const remote = /^REMOTE_PATH="([^"]+)"/m.exec(deployScript)?.[1];
    const slug = /^SLUG="([^"]+)"/m.exec(deployScript)?.[1];
    const registryRemote = /^REGISTRY_REMOTE="([^"]+)"/m.exec(deployScript)?.[1];
    expect(base).toBe("/Orion/");
    expect(remote).toBe("/webseiten/Orion/");
    expect(slug).toBe("Orion");
    // The registry is a sibling of the app directories, not inside one.
    expect(registryRemote).toBe("/webseiten/");
    // A registration that disagrees with the deploy path would link to nothing.
    expect(deployScript).toContain('--path "$BASE_PATH"');
    expect(deployScript).toContain("futuremagic-registry.py");
  });
});
