# Phase 4 — approved, with three changes before the commit

Verification accepted. The scaffolding itemization sums to 10,606 against your
stated 10,607 growth, which is the `~2,010` rounding you flagged yourself — that
reconciles, and combined with 1,350 lines checked / 2 missing / both dispositioned,
nothing was silently dropped.

The rule-2 antecedent catch is the most valuable thing in the report. Splitting a
rule left `2-6` with no antecedent because its explanation had gone to evidence,
and restoring it recovered a platform fact — Cloudflare's day-of-week field is
1-indexed with 1 = Sunday — that a zero-occurrence grep would never have surfaced.
Sweeping the rest of the resident block for the same class of dangling reference,
unprompted, was the right follow-through.

---

## The projection miss is mine, not yours

I said ~37,200 resident; actual is 52,682. You applied my governing test literally
and correctly. The test was under-specified — it failed to distinguish two things:

- A **gate table** is consulted *before* acting: does this change fit the budget,
  does this path clear the spend gate. **Resident.**
- A **diagnostic table** is consulted *after* something breaks: symptom in one
  column, cause in the other. That is lookup-on-failure — the findable-when-needed
  category. **Evidence.**

Rule 5's seven-path gate table and rule 1's three are the first kind. Rule 6's two
diagnostic tables and rule 7's telemetry table read as the second.

**Do not act on this now.** Refining it is a pass 3. Re-opening the resident rules
block would invalidate 22 boundary assertions, 11/11 headings, 6/6 pointers, 5/5
fence balance and the deletion check, and buy a second full verification cycle for
a few thousand chars. Commit the verified state.

---

## Three changes

### 1. Hoist `**THIS IS A FINDING, NOT AN ABSENCE**`

You were right to read it as a rule and right to follow my disposition rather than
override it silently — but the disposition was wrong. That sentence is the general
principle: a structurally guaranteed refusal is a finding to report, not missing
data to render blank. The 66-of-757 Lane A arithmetic is the *evidence* for it.

Hoist that one sentence into the resident `## Named failure modes` index under its
entry. Leave the incident in `docs/failure-modes.md`. Add it to the deletion-check
report with disposition "hoisted to resident index per approval."

### 2. Gitignore `settings.local.json` before staging

`git add .claude/skills/` alone works but leaves the hazard armed for the next
commit. In this same commit:

- add `.claude/settings.local.json` to `.gitignore`
- then stage `.claude/skills/` specifically

This repo is public. Those 72 allow rules include `Bash(node -e ' *)` and
`Bash(curl *)`. Not secrets, but publishing my own automation permissions is free
reconnaissance.

### 3. Commit both prompt files under `docs/prompts/`

Move `claude-md-pass2-prompt.md` and `pass2-phase0-answers.md` into
`docs/prompts/` and track them. `macroregime-prompt.md` and
`movecoverage-prompt.md` are already tracked; `long-tab-prompt.md` being gitignored
is the inconsistency, not these two. This pass rewrote the repo's authority
structure — the prompt and the answers document are the provenance for why.

Leave `long-tab-prompt.md` alone; reconciling it is a separate decision.

---

## Then re-verify narrowly, not fully

Only what the three changes touch:

1. Pointer check on the `## Named failure modes` entry you edited — target file and
   heading both exist.
2. Fence balance on CLAUDE.md and `docs/failure-modes.md`.
3. Print CLAUDE.md's new char count and the updated resident-token figure.
4. Confirm `git status` shows `.claude/settings.local.json` ignored and
   `.claude/skills/` staged.

Do not re-run the full suite. Print the four results, then commit and push.

Commit message should name the three moves, the resident delta (−81,702 chars,
−60.8%), the Phase 2 authority-drift fix, and the rule-2 antecedent restoration.

**Do not deploy.** No code, config or `*_check.mjs` was touched and none should be.

---

## For the record, not for this task

At 52,682 CLAUDE.md is still ~32% above the ~40,000-char large-memory warning
threshold, and you were right not to soften that. A pass 3 folding in the
gate/diagnostic distinction above, plus splitting
`### Adding a rule: two failure modes found building the Long tab` — keep the three
repo-wide lessons resident, move the Long-tab narrative — would plausibly land near
40k. Worth doing, not urgent.

I'll run `/context` after the commit. Your 15,052 @3.5 is the figure I'll compare
against, not the 13,171.
