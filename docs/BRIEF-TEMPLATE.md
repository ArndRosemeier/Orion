# Writer brief template (copy-paste)

```markdown
You are a WRITER on Orion (Vite + React + TypeScript + Vitest + Zod on DSH). Read `AGENTS.md` FIRST —
quality bars, critique-the-instruction, centralization / COPIES, host hygiene.
Then read the specs / ledger rows for this area.

# Where you work (READ THIS TWICE)

Your worktree is <ABSOLUTE /tmp path> on branch <branch>, based on origin/main =
<sha>, deps installed.
Every shell starts with cwd = MAIN repo workspace; file tools resolve RELATIVE
paths against that workspace — so EVERY read/edit/write/shell call MUST use an
ABSOLUTE path under <worktree> (or pass an explicit workdir). Never touch the
main tree. N other writer(s) may be in flight; your source files are disjoint.

# Your ledger row: <N>

A DOCS conflict is a mechanical UNION (renumber YOUR row only). A NON-docs
conflict: STOP and report.

# The owner's report (verbatim) and the intent

"<paste owner words exactly>" — then: outcome sought, and MEASURED state today
(file:line).

# What to build

One numbered list. Name the ONE seam it extends. State design decisions already
made (writer may prove them wrong). Name what is OUT of scope and why.

COPIES: (dispatcher prefill or writer fills)

- expected: `COPIES: 1 — checked…` or `COPIES: n→1 — <seam>`

# Pins

Behaviours that must go red when broken, as statements. Reuse existing harnesses;
never build a second fixture set.

# Verification (yours)

1. ONE gate: `bash <ABSOLUTE worktree>/scripts/gate.sh` — keep RAW log; if lock
   busy, WAIT and retry (never reap another actor's processes).
2. Optional differential: print each arm's file hash; lock before inject; restore
   from HEAD in a trap; identical arms are VOID.
3. Commit style; `git pull --rebase origin main` before push.
4. If you cannot finish: COMMIT coherent partial state on your branch and report
   BLOCKED with reasoning.

# Docs to amend in the SAME commit

docs/DECISION-LEDGER.md (row N), docs/ARCHITECTURE.md if a seam moved,
docs/TESTING.md, docs/HOW_WE_DO_IT.md if shared logic changed — and the COPIES line.

# Your report (short)

LANDED or BLOCKED, then: sha; gate counts + peak; arms + hashes; COPIES line;
judgement calls; docs amended; anything this brief got wrong.
Report NOTHING in between. If you can PROVE a rule here is wrong (including this
brief's design), report BLOCKED with evidence rather than implementing it.
```

**Solo Cursor note:** Same brief shape without worktree theater — still name the
seam, COPIES line, verify commands, and re-run gate after landing. Absolute paths
matter as soon as a second tree/agent exists.
