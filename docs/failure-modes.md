# Failure modes — the incident record

Nine named failure modes, moved out of `CLAUDE.md` so the narratives, post-mortems
and harness details stop loading into every session. **The headline assertion of each
one stays resident** in `CLAUDE.md` under `## Named failure modes`, which links here.

Nothing here was reworded. Each section is the original text at its original heading.

---

## No hit rate goes on screen without its base rate

**Any hit rate, win rate or accuracy figure must be reported against the base rate
for the same population and the same window, or it does not render at all.** Not in
a tooltip, not in a legend — beside the number, with the signed difference.

A rate on its own is unreadable, and it is worse than unreadable when it looks
fine. **These are the figures the shipped code produces**, read off `calib:pooled`
via `directionalRead()` on deployed rows, 2026-08-11:

| outcome | rate | base rate | edge |
|---|---|---|---|
| sign-scored BUY (`fwd20 > 0`) | **50.5%** | **60.5%** | **−10.1 pts** |
| magnitude-scored BUY | **20.2%** | **33.7%** | **−13.5 pts** |

Both over the same **109 benchmarked BUY outcomes, of 300 resolved** in the pooled
record. 50.5% reads as a coin flip — an unremarkable, believable number. It is in
fact a **negative edge**: these names drifted up, so `P(fwd20 > 0)` over the same
20-session windows is 60.5%, and the rating *underperformed simply being long*.
Nothing about the figure 50.5% reveals that. The benchmark is not context for the
number; without it there is no number.

> **SUPERSEDED, 2026-08-11 — do not restore these from an older reading.** This
> table previously said **53.3% / 61.4% / −8.1 pts** and **17.3% / 34.3% /
> −16.9 pts** over **n=75**, with prose beside it quoting **61.5%** and **53.9%**;
> the Lane E section said 50.5% / 60.5%. Three statements of one result, and the
> live check settled it: **the Lane E pair was right and the table was not.**
>
> The figures above are what `recCalibration()` / `baseRatesFrom()` / the `cell()`
> helper actually emit. Verified two ways against independent derivations: a hand
> recount of NVDA's raw entries gives **9/19 = 0.4737** against the endpoint's
> `hitRate 0.4737`, and a brute-force sweep over raw spark closes reproduces
> `baseRatesFrom` — `P(20d > 0)` 0.6247 vs 0.6260 (one session of drift, the stored
> series being a day older), median |20d move| **7.34% exactly**, and
> `P(20d ≥ median)` **0.3575 exactly**.
>
> **The superseded numbers came from an ad-hoc analysis script, not from
> `recCalibration()`.** They carry the same date as the live pooled record
> (`pooledAsOf: 2026-08-10`) and still disagree with it, which is how we know.
>
> **OPEN QUESTION — do not treat this as closed.** The population gap is
> unexplained: **75 benchmarked vs 109, and 290 resolved vs 300, on the same date.**
> The two cross-checks above validate the ARITHMETIC. Neither validates the
> ELIGIBILITY RULE — which entries are admitted to the benchmarked set at all. If
> the ad-hoc script was more restrictive for a reason nobody wrote down, then
> `recCalibration()` may be admitting ~34 entries it should not, and every figure in
> this section inherits that. The rates above are the ones the code produces, so
> they are what ships and what the docs must say; whether the code is admitting the
> right population is a separate question and it stays open.

The base rate must be **direction-matched and population-matched**: a BUY is scored
on upside so its benchmark is `P(r ≥ threshold)` on the same underlying and horizon,
a SELL on downside. For a pooled figure it is entry-weighted across the contributing
tickers, because each entry carries its own name's benchmark.

**Population-matched is not a formality, and it was got wrong on the first pass.**
Not every logged entry has a stored move series — the sweep covers the watchlist,
the log covers every ticker ever browsed. The first version took the rate over all
**112** BUY outcomes and the benchmark over the **75** with a series, printing
**48.2% against 61.4%** as though the two described the same thing. On the matched
population the rate is **53.3%** — a 5-point difference produced entirely by the
mismatch, in the direction that exaggerates the deficit. `cell()` now restricts
BOTH to the benchmarked rows and reports `n` and `benchmarkedN` separately, so the
shrinkage is visible rather than silent. `baseRatesFrom()` and
the `cell()` helper in `recCalibration()` do this; every rate cell ships `baseRate`
and `edgePts` alongside `hitRate`.

**This applies retroactively.** Anything already rendering a rate is in scope. Known
outstanding: `index.html`'s Recommendation History card renders raw hit rates —
`/api/track/:ticker` now returns `baseRate`/`edgePts`, but surfacing them there is
still to do.

**A rate below its base rate must never drive ranking, sizing or selection.** It is
not a weak signal, it is a signal pointing the wrong way, and ordering on it makes a
claim the data contradicts. The Long tab's alignment tag is disabled on exactly this
basis — see `directionalRead()`.

---

## A single negative probe right after a deploy is UNCONFIRMED, not a failure

**Re-probe after ~60 seconds before acting on it.** For roughly a minute after
`wrangler deploy`, requests can still land on a stale isolate serving pre-deploy
code, and there is no marker in the response saying so.

This needs to be a rule rather than left to judgement, because **the stale-isolate
signature is identical to a genuinely failed deploy**. Observed 2026-08-09, 23
seconds after deploying the coverage commit:

- the new gate field (`gates.episodeConcentrationWarn`) was **absent** — exactly
  what a build that never shipped looks like
- `long:` rows were still served under the **old schema number** — exactly what a
  `LONG_SCHEMA` bump that never landed looks like

Both read correctly a minute later; the deploy had been fine the whole time. The
natural response to that signature is to redeploy or start debugging the bump, and
both would have been wrong — a redeploy in particular would have looked like it
"fixed" the problem and buried the real behaviour.

So: **treat the first post-deploy probe as advisory only.** Confirm a suspected bad
deploy on a second probe at least a minute later before changing anything. This
applies to KV-shape checks especially, since a stale isolate reads and writes the
same namespace as the new one.

---

## Name the population a distribution was measured over

**Every reported distribution states which population produced it, explicitly.**
Not "138 Lane F candidates" but "138 candidates over the 33 names the sweeps
cover" — because the screen and the sweeps have had different populations before
and could again.

This is the same defect as the base-rate rule one level up: a rate without its
base rate is unreadable, and a distribution without its population is
unverifiable. Both were reported here in a form that quietly implied the reader
was seeing what was measured.

Concretely, three populations have already been in play at once and were nearly
reconciled against each other:

| population | what it was |
|---|---|
| **35** | `watchlist:tickers` ∪ `DEFAULT_WATCHLIST` — what the sweeps covered |
| **33** | `watchlist:tickers` — what the dashboard rendered |
| **22** | `DEFAULT_WL` — what a *fresh browser profile* renders, and what a test session mistook for the real list |

The 22 was a test artifact escalated to a finding: a Chrome profile with no
`localStorage` fell back to `DEFAULT_WL`, and the resulting "the frontend renders
a hardcoded 22" was wrong in a way that would have driven a real change. The union
deletion converges the first two at 33; the third remains the correct bootstrap
default and is not a source of truth.

**When quoting any distribution, say the N and where it came from.** If a figure
was measured over a population the reader cannot see, that is the most important
thing about it.

---

## A workaround adopted to make a test safe is evidence about production

**If a procedure has to be careful to avoid damage, the code permits the damage.**
The care is not a property of the test. It is a finding about the system, and it
belongs in the report as a defect rather than as a footnote about method.

Verifying the watchlist bootstrap, this appeared verbatim in a report:

> *"I seeded the browser from the server's list on a same-origin page first, then
> loaded the dashboard … your watchlist is untouched."*

That sentence is a bug report. Seeding was necessary because an unseeded load
would have overwritten a populated list with the defaults — which is precisely
what a new device, a cleared profile or an incognito window does, with nobody
present to seed it. The workaround was described as diligence and shipped as
diligence; the defect it was compensating for went unfixed until the next round,
when it fired and destroyed the list for real.

The test for this is one question, asked whenever a verification step needs a
precaution: **would a real user, doing this ordinary thing, have taken that
precaution?** If not, the precaution is concealing a defect.

Related shapes worth recognising, all the same failure:

- seeding or repairing state *before* an operation so it stays safe
- running against a copy because the real thing would be damaged
- ordering steps carefully to avoid a destructive intermediate state
- "just don't click that while it's loading"

---

## When you remove a fallback, audit what it was BOUNDING — not just what reads it

Deleting `DEFAULT_WATCHLIST` was scoped by grepping its five read sites, all of
which were handled. That grep was the wrong question, and the right one was never
asked: **what was this fallback making survivable?**

`loadWatchlistBatch()` had always ended with a passive
`syncWatchlistToServer(getWatchlist())`, which on a fresh profile pushes
`DEFAULT_WL`. That was near-harmless for as long as the Worker unioned the
defaults back in — a clobbered list still swept the right names, so the defect
was real but bounded. **Removing the union armed it.** The push site did not
change, was not in either commit's diff, and would not have surfaced in a review
of either one. It then overwrote a 33-name watchlist with 22.

So a fallback removal has two scopes, and the second is the one that bites:

| scope | question | how to find it |
|---|---|---|
| direct | what reads this? | grep the identifier |
| **latent** | **what was tolerable only because this existed?** | grep the *data* it defended — every writer of the key, not just its readers |

For `watchlist:tickers` that meant auditing every **write** path, not the reads.
There were two, and only one was in the commit.

**A latent defect activated by an unrelated change is invisible to diff review by
construction**, because the activating change and the defect are in different
places. The only defence is asking what the removed thing was protecting.

---

## The frontend is ALWAYS newer than the Worker for a while — render that state

**The two halves of this app deploy on different triggers.** `dashboard.html` and
`index.html` go live on GitHub Pages **the moment a commit is pushed**;
`wrangler deploy` is **manual**. So every feature that touches both passes through
a window — minutes or days — where **the page is running new code against a Worker
that has never heard of the field it is looking for.** It is also exactly where a
Worker rollback lands, and where anyone visiting the site sits in the meantime.

**A field that is ABSENT is a different state from a field that is present and
empty, and the absent one is the one that gets forgotten.** `macroChip(m)` opened
with `if (!m) return ''`. Every *populated* failure was handled — four distinct
`unavailableCause` values, each with its own reason string, all verified in a
browser. The fifth case, `data.macro === undefined` because the deployed Worker
predates the feature, painted **nothing**: container `innerHTML` empty,
`offsetHeight` 0, zero `.macro-chip` nodes. Confirmed against live Pages and the
pre-deploy Worker, 2026-08-11.

**A blank does not throw, and that is why it survives review.** It looks like the
feature was never built rather than like a deployment window, which is honesty
rule 11 with the states one level further out: *"we have not shipped the Worker
yet"* is not *"there is nothing here"*.

So, for any change that adds a field to a response the frontend reads:

1. **Handle the absent field explicitly**, as its own named state — not as a falsy
   check that returns early. `macroChip` synthesises `unavailableCause:
   'field-absent'` and reads the same as the cold-start case, because for the
   reader that is what it is.
2. **Test it against the CURRENTLY DEPLOYED Worker before deploying**, which is
   free and is the only moment the state exists naturally. Load the live Pages URL
   cache-busted, or the local page against production `API_BASE`.
3. `null`, `undefined` and a non-object all take the same path — a payload can
   carry `macro: null` as easily as omitting the key.

**Never conclude "the frontend handles missing data" from the populated-failure
tests.** Those exercise a field that exists. This one does not.

---

## The 66 are ARITHMETIC, not a thin sample — file them that way

The count came out of a rendering audit, and filing it as a rendering finding
would misdescribe it. **Every Lane A candidate refuses, always, and will keep
refusing at `MOVES_RANGE = '3y'` regardless of ticker, date or sample quality.**

Lane A contracts are 365–900 DTE, so every one snaps to the **365-session**
horizon. Independent windows are `(S − N) / N`:

| S (sessions) | independent @ N=365 | clears the floor of 4? |
|---|---|---|
| 598 | 0.64 | no |
| 751 (a full 3y series) | **1.06** | no |
| **1825** | **4.00** | **yes** — the boundary |
| 2514 (a full 10y series) | 5.89 | yes |

Clearing 4 needs **S ≥ 1825 sessions, about 7.25 years** — more than `MOVES_RANGE`
holds. **Measured 2026-08-11 across all 33 rows: 0 of 66 Lane A candidates clear
the floor**, `coverage1y` non-null on 0, `coverage3y` on 0, `expectancyMean` on 0,
and all 66 at `coverageHorizon: 365`. Not "most" — zero, by construction.

So the fix was to render the refusals, and the *finding* is that the lane can
never publish coverage at the current range. The lane now says that **once**, at
lane level, with the per-candidate reasons kept underneath: a reader meeting 66
identical inline reasons would conclude "these names are short of history", which
is the wrong inference. Widening the range is queued in `ARCHITECTURE.md` item 13
and is **coupled to phase 2**, not a standalone change.

**A REFUSED MEASUREMENT IS A FINDING, NOT AN ABSENCE.** That is the whole of it.
Coverage that declines to publish because the sample cannot carry the horizon is
the system working, and it must read that way — dim and neutral, naming its own
numbers, never a blank row. **Phase 2 depends on this**: regime-conditioned
coverage is *expected* to null at most horizons, and if a refusal renders as
nothing then the anticipated result of the entire exercise is invisible.

> Split note: this subsection was nested under *"The frontend is ALWAYS newer…"* as an
> `####`. Its parent discipline — the `return ''` audit and its CONTROL-vs-FACT
> question — stayed resident in `CLAUDE.md`; this write-up is the evidence behind it.

---

## A newly rendered figure gets eyes on it before the commit is done

**Any commit that puts a NEW number on screen requires browser verification of
that number before it is called complete.** Not "the script passed", not "the
payload is correct" — the rendered cell, read in a browser, against the value it
claims to be.

**A value that is only ever wrong at the render layer cannot be caught by a check
script.** Lane F shipped with the max-loss cell computing `money(c.maxLoss / 100)`
and printing **`$7.50` where `width × 100 − credit = 750`** — a 100× error on the
single figure the lane exists to show, contradicting its own tooltip. Every layer
below it was right: the Worker computed 750, `lane-f.check.mjs` verified 750
against a hand-computed 750, 138 of 138 production candidates matched
`width × 100 − credit` exactly. **The bug lived entirely in the division inside
the `<td>`, and nothing that tests the Worker can see inside a `<td>`.**

This generalises past unit errors. The render layer is where a value gets divided,
rounded, `toFixed`-ed, formatted as a percent when it is a fraction, labelled with
one column's heading while carrying another's, or dropped into the wrong cell
entirely. None of that is reachable from a test that stops at the JSON.

So, for any commit that adds a rendered figure:

1. Confirm the Pages byte count first (`curl … | wc -c` against local), because a
   stale bundle makes the whole check meaningless — see the propagation rule.
2. **Then confirm the BROWSER is running that bundle, which is a separate
   question.** `curl` bypasses the browser's HTTP cache; the browser does not.
   Checking the CDN and concluding the page is current is a category error, and it
   caused real damage: a verification run reported the new bundle by byte count
   while the tab executed the *previous* commit's code from cache — the version
   with the unconditional watchlist push — and it overwrote a 33-name list with
   the 22 defaults. Assert an identifier from the new code inside the page:

   ```js
   typeof someNewFunction            // 'function', not 'undefined'
   document.documentElement.outerHTML.includes('async function initWatchlist')
   ```

   A hard reload is not sufficient on its own; verify, do not assume.
3. Open the page and read the actual cell.
3. **Hand-check it against its own definition**, ideally the one in its tooltip.
   The Lane F bug was visible the instant the cell and the tooltip were read
   together, and invisible in every other way.

The corollary is that the fix is cheap and the omission is not: this bug survived
a full verification round — eight check scripts, a 35-name production sweep, and a
side-by-side against a local rebuild — and was found in the first ten seconds of
looking at the page.

---

## An empty comparison is not a pass

**No comparison may report agreement without first asserting a non-zero population
on both sides, and the population count goes in the output beside the verdict.**

A harness that measures nothing reports success. That is not a hypothetical:
verifying the first live move-series sweep, a script printed

```
VERDICT (i) vs (ii): IDENTICAL — the storage round-trip loses nothing.
```

having scored **zero** candidates on both sides — two wrong field names
(`winners` / `episodesTo50` instead of `expectancyWinRate` /
`expectancyEpisodesTo50`). Two empty sets compare equal, so the most reassuring
possible output appeared at the exact moment the test was measuring nothing.

**The failure was already latent in the committed suite, in two places.**
`bs-delta.check.mjs` and `nd2.check.mjs` both judged on `worst < 7.5e-8` with
`worst` initialised to `0` — so a run whose cases never executed printed "within
spec" and exited 0. Neither had any notion of how many comparisons it had made.

All six check scripts now share `check-harness.mjs`:

- `tally()` / `record(t, ok)` — the counter, incremented **where the comparison
  happens**, inside the row helper. Counting declared cases instead would restore
  the same blind spot one level up: a loop that skips every case still declared them.
- `reportVerdict({ label, comparisons, failures, minComparisons })` — prints
  `ALL CHECKS PASSED across N comparisons` and **refuses a verdict** below the
  floor, exiting non-zero.
- `populated(label, ...sides)` — guards an aggregate comparison *before* it is made.

`minComparisons` is each script's **observed** population, not a guess: 138 / 31 /
28 / 35 / 13 / 30 for moves / long-fixtures / cron-gate / instr-bindings /
bs-delta / nd2. Set at the exact count on purpose — a change in population is
something a human should have to notice and update deliberately, not something
that slides. (The first draft guessed 25 for bs-delta, whose real count is 13, and
the guard correctly refused the verdict; that refusal is also the proof it fires.)
