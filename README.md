# Orion

Vite + React + TypeScript + Vitest + Zod scaffold for **DeepSeek Harness (DSH)** on the shared box.

**Orion is a fractal explorer** built for arbitrarily deep zoom: an adaptive _precision ladder_ picks the cheapest sufficient math for the current zoom stage, rendering is GPU-first behind a single backend seam (WebGPU + WebGL2), and a multithreaded CPU path takes over at depths where float precision dies. Correctness is pinned against an exact arbitrary-precision oracle.

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

| Script                | Purpose                        |
| --------------------- | ------------------------------ |
| `dev`                 | Vite dev server                |
| `build`               | typecheck + production build   |
| `preview`             | preview production build       |
| `typecheck`           | `tsc -b`                       |
| `lint`                | ESLint                         |
| `test` / `test:watch` | Vitest                         |
| `format`              | Prettier                       |
| `gate`                | locked typecheck + lint + test |

## Open in DSH

Point the harness at `/home/box/Harness/Orion`. Agents follow `AGENTS.md`.
