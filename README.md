# Orion

**A fractal explorer for arbitrarily deep zoom.** An adaptive _precision ladder_
picks the cheapest sufficient math for the current zoom stage — direct `f64`,
perturbation against a full-precision reference orbit, series approximation and
bivariate linear approximation, floatexp deltas with glitch detection and exact
repair, all on limb fixed point at a precision derived from the scale. Rendering
is GPU-first behind a single backend seam (WebGPU compute and WebGL2 fragment),
with a multithreaded CPU path — worker pool over `SharedArrayBuffer` and a
Rust→WASM SIMD core — that is the primary engine where floats die. Every kernel
is pinned against an arbitrary-precision oracle.

Product scope is directed — see `docs/DECISION-LEDGER.md` rows 2+. Do not invent scope.

## Humans / agents

- **Canonical agent rules:** [`AGENTS.md`](./AGENTS.md) (read this first).
- **Process docs:** `docs/` (ledger, architecture, orchestration board, testing, how-we-do-it).
- **Host:** DSH workspace at `/home/box/Harness/Orion` (not Cursor/Pyrion).

## Package manager

**`pnpm` only.** Do not use npm, yarn, or bun for installs/scripts here.

```bash
pnpm install
pnpm run dev
bash scripts/gate.sh
```

## Scripts

| Script                | Purpose                                                                             |
| --------------------- | ----------------------------------------------------------------------------------- |
| `dev`                 | Vite dev server                                                                     |
| `build`               | typecheck + production build                                                        |
| `preview`             | preview production build                                                            |
| `typecheck`           | `tsc --noEmit`                                                                      |
| `lint`                | ESLint                                                                              |
| `test` / `test:watch` | Vitest (math pins against the oracle)                                               |
| `test:browser`        | Playwright: headless Chrome, GPU and CPU kernels differentially                     |
| `format`              | Prettier                                                                            |
| `gate`                | **the one suite**: locked wasm-drift check + typecheck + lint + Vitest + Playwright |

The gate needs the Rust toolchain (`wasm32-unknown-unknown`) because it rebuilds
`crates/l0` and `crates/perturb` and byte-compares them against the committed
`.wasm` artifacts; the artifacts themselves are checked in, so the app builds
without Rust.

## Deploying to futuremagic.de

`https://futuremagic.de/Orion/` is a static deploy of `dist/`, uploaded over FTP
and listed in the website's registry. One command does the whole thing:

```bash
./deploy-sync.sh              # build, sync, register
./deploy-sync.sh --dry-run    # build, then show the registration diff only
./deploy-sync.sh --no-register
```

It needs `FTP_PASSWORD` (the futuremagic FTP account), read from the environment
or from `~/.config/orion/ftp.env` (chmod 600) or `./.ftp.env.local` (gitignored).
The password is never printed and never reaches the build.

What the deploy does, in order:

1. `pnpm run build:domainfactory` — Vite with base `/Orion/`.
2. Copies `public/.htaccess` into `dist/` and patches `RewriteBase /Orion/`.
3. Diff-syncs `dist/` to `/webseiten/Orion/`: new and changed files only, stale
   remote files removed, the remote tree never wiped.
4. Registers the app in `/webseiten/apps.json` (`scripts/futuremagic-registry.py`),
   which is what puts a card on the site. The card reads
   `/Orion/futuremagic.json` for its title, tagline, tags and screenshot.

The `.htaccess` is load-bearing rather than boilerplate: it serves `.wasm` with
the right MIME type (without it the kernels will not instantiate) and sets
`Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy`, which is what makes
`SharedArrayBuffer` available so the worker pool can write tiles straight into the
pass image instead of transferring them.

Regenerate the card image with `pnpm run screenshot` (it drives the real app in
headless Chrome; on a box without a GPU that takes minutes, since software Vulkan
draws every pixel).

## Open in DSH

Point the harness at `/home/box/Harness/Orion`. Agents follow `AGENTS.md`.
