# Task: CLAUDE.md pass 2 — move evidence out of always-loaded context

## Preconditions

Doctor pass 1 has already been applied to this repo: 9 unused Cloudflare skills
disabled, two derivable blocks cut from the Design system section, and the five
Long-screen sections (`### Lane F`, `### The Long tab`, `### Lane E`,
`### macroRegime — phase 1`, `### Move coverage, drift and expectancy`) migrated
to `.claude/skills/long-screen/SKILL.md` with a pointer left behind. Auto mode was
declined.

Do not redo any of that. This task is the second pass.

Environment: Windows PowerShell 5.1, project at `C:\dev\trading_dash`, no VS Code.

**Scope: documentation only.** No changes to `worker.js`, `dashboard.html`,
`wrangler.toml`, or any `*_check.mjs`. No deploy — `npx wrangler deploy` is manual
and is not part of this task.

## The problem

CLAUDE.md is loaded into every session before any file is read. After pass 1 it is
roughly 137,000 chars (~34,000 est. tokens), still ~3.4x the size at which Claude
Code warns about a memory file. Doctor correctly declined to manufacture cuts and
found only ~130 tokens of derivable content, because the file is almost entirely
gotchas, failure contracts and measurement provenance — the keep categories.

That verdict is right about the *categories* and wrong about the *granularity*. A
rule and the evidence that produced it are not the same object:

- **The rule** — the imperative statement, its constant or threshold, and the one
  line of reason that makes it stick — must stay resident. It is what changes
  behavior mid-task.
- **The evidence** — the dated instrumentation run, the measured cost table, the
  incident narrative, the superseded figure and why it was superseded — is what
  makes the rule *credible on re-reading*. It does not need to be resident. It
  needs to be findable and cited.

This pass separates those two things. Nothing is deleted.

## Phase 0 — measure first, edit nothing

Print, do not assert. Produce a table of the current CLAUDE.md: total chars, total
lines, and for every `##` and `###` heading (by exact heading text, not line
number) its char count and percent of file. Do the same for ARCHITECTURE.md
totals only.

Then report which sections you believe fall on each side of the rule/evidence
split, with your char estimate for each side. **Stop and show me this before
editing anything.**

If your measured section sizes disagree materially with the plan below, say so and
tell me why before proceeding. The plan below was built from a pre-pass-1 snapshot;
treat it as the intent, not as ground truth about the current file.

## Phase 1 — the three moves

### Move A — Worker reference to a lazy skill

Source sections: `### Worker (\`worker.js\`)` and `### The sweep universe has ONE
source, and an empty one REFUSES`, both under `## Architecture`. Roughly 53,000
chars combined.

Destination: `.claude/skills/worker-internals/SKILL.md`.

Its frontmatter description must name enough surface to route reliably: Worker
endpoints, Yahoo crumb auth, `bsDelta` / Black-Scholes, FRED `DGS3MO` risk-free
rate, SEC EDGAR Form 4 and 13F, FINRA short interest, KV key TTLs, the cron
dispatch schedule, `primeTabs()` cost, the sweep universe, and the Claude model
call path.

**Before moving, hoist these back into CLAUDE.md as a compact
`### Worker invariants` block — one line each, no narrative.** These are contracts
a session can violate in a single edit without ever opening the skill, so they must
stay resident:

- `capCost` = `extFetches` + `bindingOps`; quoting `extFetches` alone understates
  the long-screen path
- `yahooSparkCloses` takes 20 symbols per request; fetches are `ceil(N/20)`
- Never read `content[0].text` — Opus 5 thinks by default and slot 0 is a
  `thinking` block
- `max_tokens` caps thinking + answer together, not the answer alone
- IV is carried through this codebase as **percent**; `bsDelta` takes **decimals**
- `ivRank` is null until 60 days of history exist, and nothing stands in for it
- Risk-free rate comes from FRED `DGS3MO` and is **suppressed, never defaulted**
- SEC EDGAR requires a real contact email in `SEC_UA` or it 403s everything
- Verify every CIK against EDGAR before adding it to `SUPER_INVESTORS`
- Option-strategy gates are relative, never absolute
- Provenance badges are derived by `setBadge()`, never authored
- Do not declare a local `const TTL` — `TTL` is a module-level table
- `premium:{TICKER}` freshness and retention must not be equal
- `moves:{TICKER}` schema check stays strict equality
- `calib:pooled` lives in the cron and must never move
- `scheduled()` gates on the Pacific trading day before dispatching

Leave a pointer at the old location naming the skill and what it holds.

### Move B — rule evidence to `docs/rules-evidence.md`

Source: the seven numbered sections under `## ⚠ Read this before writing any code`
(`### 1. Subrequest budget` through `### 7. A job that never runs produces no
evidence`). Roughly 37,000 chars.

For each rule, **keep resident**: the heading, the imperative statement, every
constant and threshold in it, the shell/config blocks under `## Deploy & develop`
and the secrets list, and one sentence of reason. Target under 400 chars per rule.

**Move to `docs/rules-evidence.md`**: the measured cost tables, the dated
instrumentation runs, the "this is what it used to be and why it changed"
passages, and the incident write-ups. One section per rule, same heading text,
cross-linked both directions.

Rules 3 and 4 are already short — check their measured size before touching them
and leave them alone if the split would not save meaningfully.

### Move C — failure-mode narratives to `docs/failure-modes.md`

Source: the nine `##` failure-mode sections, from `## No hit rate goes on screen
without its base rate` through `## An empty comparison is not a pass`. Roughly
22,000 chars.

Keep resident: a `## Named failure modes` section containing the nine headline
assertions, one line each, verbatim as they are already phrased, each followed by
a link into `docs/failure-modes.md`.

Move: the incident narratives, the field-name post-mortems, the harness details.

### Stays resident, untouched, verbatim

Do not reword, reflow, condense or "improve" any of these:

- `# CLAUDE.md`, `## What this is`
- `## Deploy & develop` and the secrets block, including all shell
- `## Design system`, `## Git workflow`
- `## Adding a rule: two failure modes found building the Long tab` — doctor
  deliberately kept this in pass 1 because its lessons are repo-wide; that holds
- `### Frontends`, `### Data: real vs. stubbed`
- `## Verification standard`, `## Before every task`, `## After every task`,
  `## Adding a new failure mode`
- The `.claude/skills/long-screen/` pointer from pass 1

## Phase 2 — fix the drift this creates (required, same commit)

CLAUDE.md and ARCHITECTURE.md both currently assert that they are the
authoritative record of this build. After pass 1 and this pass, the authoritative
content lives across five files. Update those assertions in **both** documents to
name the full set and say what each holds:

- `CLAUDE.md` — rules, invariants, workflow, resident
- `ARCHITECTURE.md` — data sources, design decisions, build position
- `.claude/skills/long-screen/SKILL.md` — Lanes A–F, move coverage, macro regime
- `.claude/skills/worker-internals/SKILL.md` — Worker endpoints and data plumbing
- `docs/rules-evidence.md`, `docs/failure-modes.md` — measured evidence behind the
  rules

Leaving this out recreates the dashboard/config drift failure mode this repo
already has a name for.

## Phase 3 — verify, with printed values

1. Print char and line counts for CLAUDE.md before and after, and for every file
   created, plus the sum. **The sum must be within 2% of the before-total** —
   this is a move, not a rewrite. Report the delta and explain any excess.
2. For every heading moved: assert it appears exactly once in its new home and
   zero times in CLAUDE.md. Print the counts.
3. For every pointer written into CLAUDE.md: assert the target file exists and the
   named heading exists inside it. Print pass/fail per pointer. A pointer to a
   heading that does not exist is worse than no pointer.
4. Check code-fence balance in every file written. Note: the line in the Worker
   section beginning with four backticks is **valid CommonMark** (its info string
   contains backticks, so it is not a fence opener) — do not "fix" it. It only
   trips naive `^```` greps.
5. State what you could not verify, separately and explicitly.

Then tell me to run `/context` myself for the live measurement. Your figures are
disk-based estimates; this file is dense with backticked identifiers and hex
values and tokenizes closer to 3.5 chars/token than 4, so treat your token
estimates as a floor and say so.

## Phase 4 — gate

Report everything above and **stop**. Do not commit until I approve. On approval,
commit and push with a message naming the three moves and the char delta. Do not
deploy.

## Non-goals

No new rules. No rewording of retained text. No changes to code or config. No
reordering of sections beyond what the moves require. If you find something that
looks like a bug while reading, report it at the end — do not fix it in this task.
