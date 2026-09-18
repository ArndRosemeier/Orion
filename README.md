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
- **Host:** OpenCode workspace at `/workspace/orion`.

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
| `test:browser`        | Playwright: managed Chromium, GPU and CPU kernels differentially                    |
| `setup:browser`       | Install the pinned Playwright Chromium rootless + write `.browser-env.sh`           |
| `format`              | Prettier                                                                            |
| `gate`                | **the one suite**: locked wasm-drift check + typecheck + lint + Vitest + Playwright |

The gate needs the Rust toolchain (`wasm32-unknown-unknown`, pinned in
`rust-toolchain.toml`) because it rebuilds `crates/l0` and `crates/perturb` and
byte-compares them against the committed `.wasm` artifacts. The version is pinned
because that comparison is byte-exact and a different rustc can fail it; the
artifacts themselves are checked in, so the app builds without Rust.

The browser lane drives Playwright's **managed** Chromium, so the browser version
is pinned by `playwright` in `pnpm-lock.yaml` and no system Chrome is required. On
a fresh machine (especially a rootless container), run once:

```bash
pnpm run setup:browser   # installs Chromium; stages its shared libs on Debian
```

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

Pushing to `main` runs the same path automatically in GitHub Actions
(`.github/workflows/deploy.yml`): it runs the repo's gate first, then
`deploy-sync.sh`, so a build that fails any check is never published. It needs one
repository secret, `FTP_PASSWORD` (Settings → Secrets and variables → Actions);
nothing else is machine-specific. The manual `./deploy-sync.sh` stays for dry runs
and local deploys.

The `.htaccess` is load-bearing rather than boilerplate: it serves `.wasm` with
the right MIME type (without it the kernels will not instantiate) and sets
`Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy`, which is what makes
`SharedArrayBuffer` available so the worker pool can write tiles straight into the
pass image instead of transferring them.

Regenerate the card image with `pnpm run screenshot` (it drives the real app in
the managed Chromium and waits for a full render, which can be slow under
software Vulkan).

## Open in OpenCode

Point OpenCode at `/workspace/orion`. Agents follow `AGENTS.md`.
