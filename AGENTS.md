# Orion — agent/workspace rules

Orion is a Vite + React + TypeScript app on the DeepSeek Harness (DSH) shared box.
Product scope is **directed**, not invented — see ledger rows 2+ in `docs/DECISION-LEDGER.md`. Never add product scope on your own initiative.

**Host:** DeepSeek Harness on the shared box (not Cursor/Pyrion). Workspace:
`/home/box/Harness/Orion`.

## Quality bars (binding)

1. **No silent fallbacks.** Failures propagate loud errors. Never mask with placeholders, catch-and-continue, or console-only handling.
2. **Errors must be visible** — toast / error boundary / failed row with a message.
3. **Validate at every boundary.** Parse machine/IO output with a schema (Zod); validation failure fails the step.
4. **Centralize + keep it simple.** One idea → one seam. Callers go through it. Prefer the smallest design that works.

**COPIES line (every brief and landing report):**

- `COPIES: n→1 — <seam that now carries it>` when folding, or
- `COPIES: 1 — checked, no duplication (grepped: <what>)` when single-site.
  Land folds with an "exactly one" pin when possible (tripwire test / source scan).

**Critique the instruction:** Owner intent ≠ design. Extract intent; push back with evidence if the asked mechanism is wrong; never silently substitute. Briefs may be wrong — report BLOCKED with proof rather than implementing a flawed design.

**Done means verified:** typecheck + lint + test (the ONE gate) green. Even solo: re-run the gate after landing before claiming done.

**Two-strikes:** Same mistake twice → promote into AGENTS / a rule / a gate. Rules carry their incident when known.

## Quality bars (mechanical)

- Strict TS (`strict` + `noUncheckedIndexedAccess`); no `any`; typecheck before done.
- Zod at I/O boundaries; `z.infer` — do not hand-copy DTOs.
- Search before invent; extend canonical helpers; update `docs/HOW_WE_DO_IT.md` same change.
- Done = typecheck + lint + test (+ format) green. Do not claim done otherwise.
- Read `docs/ARCHITECTURE.md` before crossing layer boundaries.

## Exact commands

**Package manager: `pnpm` only.** Never mix npm / yarn / bun for installs or scripts in this repo.

- install: `pnpm install`
- dev: `pnpm run dev`
- typecheck: `pnpm run typecheck`
- lint: `pnpm run lint`
- test: `pnpm run test`
- test:watch: `pnpm run test:watch`
- format: `pnpm run format`
- build: `pnpm run build`
- preview: `pnpm run preview`
- gate: `bash scripts/gate.sh` (ONE suite script; do not hand-roll)

## Process pointers (durable state)

Read/update in the same commit when relevant:

| Artifact            | Path                      | Role                         |
| ------------------- | ------------------------- | ---------------------------- |
| Decision ledger     | `docs/DECISION-LEDGER.md` | Append-only _why_            |
| Seam / architecture | `docs/ARCHITECTURE.md`    | Checkable layer map + seams  |
| Board               | `docs/ORCHESTRATION.md`   | One-screen now-state         |
| Testing             | `docs/TESTING.md`         | What proves it; what was run |
| Living catalog      | `docs/HOW_WE_DO_IT.md`    | Canonical helpers / patterns |
| Brief template      | `docs/BRIEF-TEMPLATE.md`  | Writer brief copy-paste      |

## Boundaries

- **Always:** run gate before claiming done; update ledger/seam/catalog when you change them; absolute paths when using a worktree.
- **Ask first:** new deps, wide renames, prod/deploy, force-push.
- **Never:** secrets in chat/rules; silent Auto on hard tasks without a plan; second package manager; invent product/game features without Arnd direction.

## DSH / multi-writer notes

- Worktrees under `/tmp` (one per writer); put **absolute paths twice** in every brief.
- ≤2 writers in flight; file-disjoint sources; one locked gate at a time (`scripts/gate.sh`).
- Session start: `bash scripts/board.sh` before dispatch when multi-agent.
- Relative paths from tools resolve against the **main** workspace — always use absolute paths under the worktree.
- Docs (`DECISION-LEDGER`, `ARCHITECTURE`, `TESTING`) are not file-disjoint — assign ledger row numbers in the brief.
