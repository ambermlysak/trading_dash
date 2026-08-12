# Task: `macroRegime` — step 5

Read `CLAUDE.md` and `ARCHITECTURE.md` in full before writing any code. Read
`worker.js` and `dashboard.html` directly rather than relying on any description
below — cite by function name, not line number. Several line numbers quoted in
earlier conversation have already drifted.

If anything here contradicts what is actually in the repo, stop and say so before
acting.

**This task has a mandatory stop in the middle.** See §3. Do not set the
classification thresholds until you have printed the historical distribution and
reported it to me.

---

## 0. The problem this must not repeat

The `analysis:` rating was wired to influence sort order before anyone measured
whether it had edge. When it was finally measured against a base rate it came back
**negative**, and the sort influence was disabled — `directionalRead()` now carries
`sortDisabled: true`, `sortDisabledEdge` and `sortWouldQualify` as data so the card
can name both numbers.

`macroRegime` is the same shape of thing: a plausible signal that feels like it
should matter. The original sketch said it would "demote candidates in hostile
macro and raise the conviction threshold." **That is a sort influence with no
measured basis, and shipping it would repeat the exact mistake this codebase just
spent a week correcting.**

So this ships in two phases and phase 1 does not affect ranking at all:

| phase | what it does | ships |
|---|---|---|
| **1** | Reads and displays the current macro state | this commit |
| **2** | Conditions `moveCoverage` on macro state, measures whether it separates | later, only if phase 1's data supports it |

Sort influence, if it is ever justified, comes out of phase 2 and nowhere else.

Build phase 1 only. Phase 2 is specified in §7 so the shape is on record, not so
it gets built now.

### 0a. A documentation conflict to reconcile in this same commit

`CLAUDE.md` states the BUY calibration result three different ways:

- the table under "No hit rate goes on screen without its base rate":
  **53.3% / 61.4% / −8.1 pts**
- the prose two lines below that same table: **61.5%** and **53.9%**
- the Lane E section: **50.5% against a 60.5% base rate**, i.e. −10.1 pts

`ARCHITECTURE.md` agrees with the table (53.3 / 61.4 / −8.1, n=75). Find the
figures the code actually produces — `recCalibration()`, `baseRatesFrom()`, the
`cell()` helper — determine which pair is correct, and make all sites agree.
**Print the values you found and name which sites you changed.** If the live
figures differ from all three, report that and change nothing until I answer.

---

## 1. Phase 1 — what it reads

Four inputs, one composite state, computed once per cron and stored.

| input | source | why |
|---|---|---|
| SPY trend | `smaCrossState(closes, 50, 200)` | broad-market regime |
| QQQ trend | same | this book is concentrated in AI/semis |
| VIX level | `^VIX` last close | absolute fear level |
| VIX term structure | `^VIX` − `^VIX3M` | backwardation is the condition that matters |

### The sign convention is a subtraction, not a ratio

**Store `vixTermSpread = vix − vix3m`. Positive is backwardation and positive is
hostile.**

This is not a stylistic choice. `longRow` already stores
`termStructure = front − back` with positive meaning backwardation, and Lane E
gates `hostile-term` on `termStructure > 0`. A macro field where *below 1.0* means
backwardation would put two opposite polarities for the same concept on one screen
— the "inverted thing that looks like a copy" hazard the Long tab section is built
around. With the subtraction, the macro chip and Lane E's gate point the same
direction.

`vixTermRatio = vix3m / vix` may ship as a secondary display field. It must not be
the classifier.

**State the convention in a code comment and print it in verification.** Getting
term-structure sign backwards is a documented failure in this codebase and it
inverts the entire signal.

### `smaCrossState` returns no `above`/`below` field

It returns `{ sma50, sma200, spread, gap, slope, spreadChg, barsToCross,
goldenSetup, deathSetup, near }`. The fact wanted is the sign of `spread`. Carry
`spread` itself, not just a derived side, so the chip can say how far above or
below rather than only which side.

It returns **null** below `slow + EMA_CROSS_SLOPE_BARS` = 205 bars. The ranges in
§2 clear that comfortably, but name the null path in the reason string.

### Verify `^VIX3M` before building on it — and verify more than its existence

**There is no existing evidence in this codebase that the spark endpoint serves
`^`-prefixed symbols at all.** The only `^VIX` fetch anywhere is
`handleMarketSnapshot`, which uses `/v8/finance/chart`, not
`yahooSparkCloses`. So verify three things against the live API and print each:

1. Does spark return caret symbols at all? Test `^VIX` first.
2. Does `^VIX3M` specifically return data?
3. How many sessions does it return at the requested range?

If spark refuses carets, the fallback is one `/v8/finance/chart` call per index
(+4 external fetches, still trivial). Take that fallback and **name the cost
change**. If `^VIX3M` specifically is unavailable, **stop and tell me** rather than
substituting `^VIX9D` or any other index — I want to decide what replaces it.

---

## 2. Collection: a separate spark call, on the 1:15pm PT branch

### Separate, not merged into the move sweep

Do **not** append the macro symbols to the array `sweepUniverse()` returns. Three
reasons, and the third is the one that would have been silent:

- That array also drives the per-ticker write loop, so merged symbols would write
  `moves:^VIX` keys.
- It puts non-watchlist symbols inside the empty-universe refusal logic that was
  deliberately built to have exactly one source.
- `collectMoveSeries` returns early when `movesweep:last === ptDate()`. A macro
  collection nested inside it would silently not run whenever the move sweep had
  already run — rule #7's signature exactly.

The merge would have been free on chunk arithmetic (`yahooSparkCloses` chunks at
20; 33 tickers is 2 chunks and 37 is still 2 chunks — the boundary is **40**, not
20). Take the separate call anyway. It costs **1 external fetch per day** and buys
total isolation plus an independent range, which §3 needs.

### Placement: the 1:15pm PT branch

Attach to the `h === 13 && m >= 15 && m < 45` branch, alongside
`generateEODSummary` and `recordWatchlistIv` — **not** the 2:00pm branch.

The reason is phase 2. `collectMoveSeries` runs at 2:00pm; a macro record written
at 1:15pm is 45 minutes old when the move sweep could read it, with no
request-path race. This is the same no-race pattern already specified for the
`gap` structural baseline reading `iv:{TICKER}:{DATE}`.

`ctx.waitUntil` does not get its own subrequest budget — this shares the
invocation's with the EOD summary and the IV sweep. **Report the branch's combined
`capCost` before and after.**

### Dedup and refusal

Follow the `ivsweep:last` / `movesweep:last` pattern exactly:

- Dedup key `macrosweep:last`, **outside the `macro:` prefix**, so nothing
  scanning that prefix can read it as a record.
- On a spark failure, **refuse before stamping** so the next firing retries.
- Log at ERROR with a greppable marker naming which input failed.

### Ranges: two, for two purposes

- **Threshold derivation** (§3) wants the longest history spark will return for
  these four symbols. Target **10y**. Three years may hold barely more than one
  cycle; ten spans 2020 and 2022, which is where the hostile state actually lives.
  Print how many sessions each symbol actually returned — do not assume the
  request was honoured.
- **Phase 2** wants a 3y slice aligned with `MOVES_RANGE`.

Store the 3y slice in the record. Derive thresholds over the full pull. **Print
the stored value size in bytes** — `moves:{TICKER}` measured ~60 KB against a 25 MB
KV ceiling, so there is room, but the figure goes in the docs.

### Storage

```
KV key:      macro:state
Dedup key:   macrosweep:last
Schema:      MACRO_SCHEMA = 1
Retention:   MACRO_TTL = 90 * 24 * 3600
Freshness:   MACRO_FRESH_MS — the stale-badge threshold
```

**Retention is 90 days, not 7, and the split from freshness is deliberate.**
`econ:dgs3mo` moved from 7d to 90d specifically because a stale labelled print
beats a blanked screen, and `calib:pooled` carries no TTL at all on the same
reasoning. §4 already requires the chip to render its age, so an old record is
labelled rather than misleading. Same freshness/retention split as
`long:` / `premium:`.

**Do not fan out per ticker.** One record, read once per request.

---

## 3. The state — and the mandatory stop

### Shape

Mirror `volRegime()` — it is the established pattern for a regime read here and a
second, differently-shaped one would be a drift hazard:

```
{
  state:         'constructive' | 'mixed' | 'hostile' | 'unavailable',
  label:         <human string naming the actual numbers>,
  provisional:   <bool>,
  reason:        <string|null>,
  asOfClose:     <ISO date>,
  spySpread, qqqSpread,        // signed % from smaCrossState, null-safe
  vixLevel,
  vixTermSpread,               // vix − vix3m, POSITIVE = backwardation
  vixTermRatio,                // display only, never the classifier
  gates: MACRO_GATES,          // the cutoffs classified against
  ts
}
```

`MACRO_GATES` mirrors `REGIME_GATES` so the card can name the thresholds it
classified against instead of deferring to a legend.

**Any input null → `state: 'unavailable'` with a reason naming which input is
missing.** Do not compute a partial state from three of four inputs and present it
as a full read. A plausible stand-in is indistinguishable from the real thing on
screen.

Do not blend the four inputs into a numeric score. Three states plus the raw
numbers, so every input stays visible and the classification stays auditable.

### Classification form

```
hostile       — vixTermSpread > T_BACK, OR both SPY and QQQ spread < 0
constructive  — vixTermSpread < T_CONTANGO AND both SPY and QQQ spread > 0
mixed         — everything else
```

`T_BACK` and `T_CONTANGO` are **not** given here. Implement the classifier with
them as named parameters and derive them as follows.

### STOP HERE — Part A: print the distribution before setting the constants

`EPISODE_CONCENTRATION_WARN = 1` was chosen from an observed distribution, with the
rejected alternative and its reasoning in the comment beside it. These thresholds
get the same treatment. A cutoff chosen from intuition is the thing this codebase
keeps getting wrong.

Classify every session in the full historical pull and print:

1. **Frequency** of each of the four states, as a percentage and a count.
2. **Run length** per state — median and p90 consecutive sessions, plus the total
   number of state transitions across the series.
3. The distribution of `vixTermSpread` itself: min, p10, median, p90, max, and the
   fraction of sessions above zero.

**Frequency alone is insufficient.** A state that fires on 20% of days but flips
every other day is not a regime, it is noise wearing a regime label, and a chip
that changes daily trains the reader to ignore it. If median run length comes back
at 1–2 sessions, the fix is not a different cutoff — it is smoothing the input (a
5-session mean of `vixTermSpread`) or hysteresis, and I want to know that before
the constants are frozen rather than after the chip is on screen.

### Pre-registered acceptance bands

Written before the numbers are seen, so the thresholds cannot be tuned to produce
an agreeable print:

| hostile fires on | reading |
|---|---|
| 5–25% of sessions | as intended — proceed to Part B |
| under 5% | honest but nearly inert as a daily chip; proceed and state the rarity |
| 25–35% | borderline — report and wait for my answer |
| over 35% | the definition is wrong; it is describing the ordinary environment — report and wait |

**Sanity check that must pass either way: `constructive` should be the most common
state.** Contango is the normal condition of the VIX term structure. If
`constructive` comes back rare and `hostile` common, something is inverted — stop
and report, because that is exactly the failure the sign convention in §1 exists to
prevent and this print is what catches it.

### The anti-tuning rule

**The thresholds must not be adjusted so that today's state comes out any
particular way.** They are set from the historical distribution and today falls
where it falls. A cutoff chosen to make the current chip read "hostile" is
indistinguishable in the code from one chosen from the distribution, which is why
it is written down here.

### Part B — after I have seen Part A

Set `T_BACK` and `T_CONTANGO`, and put the Part A distribution **in the comment
block above them**, dated, in the style of `EPISODE_CONCENTRATION_WARN`. Name the
alternative you rejected and why. Then finish the task.

---

## 4. Rendering

A single chip in the Long tab header — **not per-row, not per-lane, not
per-candidate.** Macro is one fact about the day; repeating it 33 times is noise.

**The record is served once in the response envelope, beside `_meta` — never
attached to a row object.** On `/api/long/batch` that means one macro object for
33 symbols, not 33 copies. An earlier draft of this spec said "attached to every
row," which contradicted the header-only rule and would have produced exactly that.

The chip shows the state and the raw numbers, e.g.
`macro hostile · SPY +4.2% QQQ +6.1% vs 200 · VIX 24.1 · term +1.8 (backwardation)`

**It must say, in visible text, that it does not affect ranking.** Macro state is
shown for context and is not used to sort, gate or filter, because it has not been
measured against outcomes. That sentence comes out only when phase 2 justifies
removing it.

**Age it.** The record is written by cron and read per request, so it can be up to
a day old — and with 90d retention, in a cron failure, much older. Show its age the
way Lane E's gate verdict does, and badge it stale past `MACRO_FRESH_MS`.

---

## 5. What phase 1 must not do

- **Must not influence sort order.** Not by demotion, not by tie-break, not by
  threshold adjustment.
- **Must not gate any lane.** Lanes A–F keep exactly the gates they have.
- **Must not blend into expectancy, coverage, gap, or any existing figure.**
- **Must not appear per-candidate or per-row.** Envelope and header only.
- **Must not be described anywhere as a signal, edge, or filter.** It is a
  displayed condition with no measured relationship to outcomes.

---

## 6. Verification

**Quote `capCost`, never `extFetches`.** `extFetches` alone was reported as the
cost of a long-screen ticker and understated it by 125–143%. Every cost figure
below means `extFetches + bindingOps`, and all three numbers get printed.

Collection path:

- Print `_instr` for the macro collection: `extFetches`, `bindingOps`, `capCost`.
- Print the 1:15pm branch's combined `capCost` before and after this change.
- Print the four raw inputs, `vixTermSpread` **with its sign convention stated**,
  and the classified state for the current day. Hand-check the spread against the
  raw `^VIX` and `^VIX3M` closes.
- Confirm backwardation classifies as **hostile**, not constructive.
- Print sessions returned per symbol at the requested range, and the stored record
  size in bytes.

Request path — these figures are in a CLAUDE.md table that has already been
superseded twice, so **re-measure and update it in the same commit**:

- `/api/long/batch`, 33 symbols: expected 33 → **34** (one read for the whole
  batch, not one per symbol). Print measured.
- `/api/long/:ticker` warm: expected 12 → **13**. Print measured.
- `/api/long/:ticker` cold: expected 18 → **19**. Print measured.

If any measured figure differs from the expectation, that is a finding — report it
rather than adjusting the expectation.

State machine:

- Force each of the four states, including `unavailable` with each input missing in
  turn, and print the reason string for each.
- Print the Part A distribution and run-length figures again in the final report.

Non-regression:

- Confirm no row payload changed shape and no sort order changed. Print a
  before/after candidate ordering for one ticker to prove ranking is untouched.
- Verify against a second and third ticker, not one.

Browser:

- Per the render-layer rule, **assert an identifier from the new code inside the
  page** — the CDN byte count does not confirm what a cached tab executes.
- Confirm the chip draws, the raw numbers match the payload, the
  not-used-for-ranking text is visible, and the age treatment renders.
- Hand-check the rendered figures against their own definitions, the way the Lane F
  max-loss bug was found.

Harness:

- Non-zero population asserted on every comparison; `reportVerdict` with a
  `minComparisons` floor set to the **observed** count, not a guess.
- If this adds a check script, add it to the suite count in the docs.

Name what you could not verify, separately and explicitly.

---

## 7. Phase 2 — specified, NOT to be built now

Recorded so the shape is on record and phase 1 does not foreclose it.

The question phase 2 answers: **does macro state actually separate outcomes?**

`moves:{TICKER}` stores `[return, startIdx]` pairs. If the macro state at each
historical session index can be reconstructed, every window can be labelled with
the regime it started in, and coverage computed conditioned on regime:

> "In backwardated-VIX regimes, NVDA cleared this breakeven 14% of the time,
> against 31% across all regimes."

That is a measurement, and it is the only thing that would earn a sort influence.

Phase 1 stores the 3y slice precisely so phase 2 needs no second collection pass.
Mapping `startIdx` to a date requires a schema bump on `moves:` — `readMoveSeries()`
guards with strict equality, so that bump retires every cached blob and coverage
columns render blank until the next 2:00pm sweep. **That is a phase 2 decision, not
a phase 1 one.** Do not bump `MOVES_SCHEMA` in this commit.

**The likely outcome, stated in advance so it is not a disappointment:**
conditioning splits an already-thin sample. At N=45 a 3y series gives ~15.8
independent windows; split three ways that is ~5.3 per regime, against
`COVERAGE_MIN_INDEPENDENT = 4`.

**And 5.3 is optimistic.** Regimes arrive in contiguous stretches — backwardation
clusters — so conditioned windows are far more autocorrelated than an even split
implies, and the effective count is below 5. Pooling across the 33 names does not
fix it: they share the regime by construction, so pooling adds windows without
adding independent observations of the regime.

**Conditioned coverage will probably null out at most horizons, and that is a
legitimate finding, not a failure to engineer around.** If it nulls everywhere, the
honest conclusion is that this dataset cannot support a macro-conditioned claim and
`macroRegime` stays informational permanently. Do not lower
`COVERAGE_MIN_INDEPENDENT` to buy the horizons back.

Any conditioned figure must be reported against its unconditioned base rate. A
conditioned coverage of 14% means nothing without the 31% beside it.

---

## 8. Out of scope

- Position awareness
- `index.html`
- Any change to Lane A–F gates, thresholds, or sort keys
- Any `MOVES_SCHEMA` bump
- Phase 2
- Any macro input beyond the four in §1 — no rates, no breadth, no credit spreads,
  no sector rotation. If you think one is materially better than one of the four,
  say so before implementing rather than adding a fifth.

---

## 9. Documentation, same commit

- Add `macro:state` and `macrosweep:last` to the KV key table in `CLAUDE.md`, with
  retention, freshness, what writes them, and the prefix-separation reason.
- Add `MACRO_SCHEMA`, `MACRO_TTL`, `MACRO_FRESH_MS`, `MACRO_SYMBOLS`,
  `MACRO_RANGE`, `MACRO_GATES`, `T_BACK`, `T_CONTANGO` wherever constants are
  recorded.
- Update the measured-subrequest table with the re-measured warm / cold / batch
  figures.
- Update the step 5 row in `ARCHITECTURE.md`'s build-position table, and add
  phase 2 to "Not yet done."
- Reconcile the §0a calibration-figure conflict.

`wrangler deploy` is manual — **do not deploy**. Auto-commit and push is fine.
