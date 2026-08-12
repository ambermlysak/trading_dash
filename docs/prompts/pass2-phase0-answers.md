# Phase 0 answers — proceed to Phase 1

Good report. Four answers, plus one correction to the pass-2 document itself.

---

## 1. Move C — eight `##` sections, not nine. My count was wrong.

You measured correctly. There are eight `##` failure-mode sections from
`## No hit rate goes on screen without its base rate` through
`## An empty comparison is not a pass`. The pass-2 document said nine; that was an
uncounted assertion on my part, not a section you missed.

Your identification of the ninth is right: `### return '' in a render helper is
where this hides — audit them all` (3,587 chars) is a named failure mode in
substance, nested under the frontend section only because that is where it was
found.

**Include it, producing nine entries in the resident index from eight `##`
sections.** Within it, split rather than move wholesale:

- The `return ''` audit discipline is the rule — **stays resident**.
- `#### The 66 are ARITHMETIC, not a thin sample` is the `coverageReason` /
  `COVERAGE_MIN_INDEPENDENT` incident write-up — **evidence, moves**.

---

## 2. The 400-char target is withdrawn. Your ~9,600 is the number.

The 400 was a guess anchored on nothing measured, and it contradicts
"keep every constant and threshold" in the same paragraph. When they conflict the
constraint wins and the number goes. Do not cut gate tables to hit it.

Governing test instead:

> **A resident rule must let a session decide correctly without opening the
> evidence file.** A table you check a proposed change *against* stays. A table
> that documents *how the number was arrived at* moves.

Applied to rule 1, that draws the line here:

| stays resident | moves to evidence |
|---|---|
| the one-pool statement | the "wrong in both directions" history |
| the "counts against the 10,000?" table | the dated 2026-08-08 verification |
| `capCost = extFetches + bindingOps` | the 125–143% understatement figure |
| "do not restore the two-bucket table" | the four measured-cost rows |
| the Yahoo-crumb fan-out constraint | the instrumentation caveat narrative |

Same test for the other six rules.

Your 20% pattern-based floor is worth exactly what you said it was. Report actuals
after the split; do not reconcile them back to the estimate.

**Rules 3 and 4:** agreed on 3 — leave it alone at 709. **Split rule 4** as you
proposed; your reasoning is right, the CORS incident is evidence and the
allowlist contract is a gate.

**Writing rule 1's resident summary:** you are condensing a section whose subject
is a claim that was wrong twice. Keep the fact that it was wrong in both
directions and keep the prohibition on restoring the two-bucket table — that
prohibition is a gate, not history. The dates and audit trail go to evidence.

---

## 3. The ±2% gate is replaced, not widened.

You are right that it fails, and right about why. But loosening it to 5% keeps a
bad proxy with more slack. The gate was a proxy for "nothing was silently
deleted." Measure that directly instead.

**Note this supersedes the deletion check as I first worded it — "missing must be
zero" was also wrong.** The plan requires condensed resident summaries, and
condensing rewrites lines; a rewritten line is absent from both destinations and
would register as missing even though nothing was lost. Use this:

> Normalize whitespace and lowercase both sides. For every line of the before-file
> over 60 chars, assert it appears in the after-set (CLAUDE.md + the four created
> files). Print the count checked and the count missing.
>
> **Missing need not be zero — but every missing line must be enumerated verbatim
> in the report with one of two dispositions: "absorbed into resident summary of
> \<rule\>" or "dropped, reason."** Any line you cannot assign a disposition to is
> a silent deletion and blocks the commit.
>
> Report total char growth separately, itemized by scaffolding type, as an
> unbounded figure — informational, not a gate.

This catches deletion exactly, permits any amount of legitimate scaffolding, and
cannot pass on an empty comparison because it prints the population.

---

## 4. `## Before every task` — exception granted, and it is a Phase 2 item.

You are right on the substance. Rule #1 states one pool explicitly, verified
2026-08-08 against Cloudflare's limits page, and carries "do not restore the
two-bucket table" in its own text. `## Before every task` still instructs the
reader to check against the two-bucket claim. Rule #1 was rewritten to kill that
claim and this line survived the rewrite — docs lagging code, in the file whose
job is to prevent that.

**Fix it.** It is a factual correction, not a rewording, so it does not hit the
non-goal. Correct the parenthetical to match rule #1 — one pool, KV and binding
calls included — and leave the rest of that section untouched. Do it in **Phase 2**
alongside the authority-drift updates and report it in the same list. It will
surface in the deletion check as a missing line; give it the disposition
"corrected per rule #1, Phase 2."

**Scope is isolated — do not go looking for more.** I audited the other
authoritative files. `README.md` already states one pool correctly.
`ARCHITECTURE.md` mentions the 50-subrequest cap three times, always as history
with "then in force," which is correct framing rather than a stale assertion.
`instr-bindings_check.mjs` asserts `capCost = extFetches + bindingOps` directly.
The contradiction is confined to that one line.

---

Everything else in the pass-2 document stands. Proceed with Phase 1, then Phase 2
including the fix above, then stop at the Phase 4 gate as written. Do not commit
until I approve. Do not deploy.
