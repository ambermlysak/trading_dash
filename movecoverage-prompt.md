# Task: Add `moveCoverage` and expectancy ranking

Read `CLAUDE.md` and `ARCHITECTURE.md` in full before writing any code. If anything
below contradicts what is actually in the repo, stop and say so before acting — I
have been wrong about what exists in this codebase before.

This ships as **one commit**. It adds one new measurement, derives a ranking from
it, and surfaces both beside the model probabilities that already exist. It does
**not** merge the Premium and Long tabs, does not add a straddle lane, does not
touch `renderStrategies()` in `index.html`. Those are separate commits and I will
decide when. See §9.

## What this is, and why

The Long tab computes `beEm` (`longCandidate`, worker.js:2321) as `bePct / emPct`,
and `pBe` (:2327) as N(d2). Both are derived from the implied vol surface — `emPct`
from ATM IV, `pBe` from the IV of the strike nearest the breakeven. They tell you
whether a contract is priced consistently with its own chain. **Neither is a
measurement of what the underlying has actually done.**

`Hist Win` has sat suppressed beside POP since the strategy card was fixed, with a
comment saying it stays blank until a real backtest exists. This is that backtest,
and it is the reason the column was left in place.

The new number is the fraction of historical N-session windows in which the
underlying actually moved past a given breakeven. Rendered next to `pBe`, the
difference between the two is the finding. Once the historical windows exist, the
structure's payoff can be priced against each of them, which gives an expected
return on capital risked — and that, not probability, is the sort key.

---

## 0. Constraints to check before writing

- Subrequest cap is 10,000 per invocation on Workers Paid, one pool covering
  external fetches and binding ops. **The binding constraint is Yahoo crumb
  rate-limiting, not the cap.** Nothing here may fan out per-ticker on demand.
- `yahooSparkCloses(symbols, range, concurrency)` (worker.js:1279) already batches
  **20 symbols per fetch** and is already used elsewhere. A 22-name watchlist is
  **2 fetches**. Use it. Do not write a new per-ticker chart fetch.
- No new cron **firing**. Attach to an existing one — see §5. If you believe a new
  cron is needed, stop and ask; the PST/PDT window trap applies and I want to
  decide separately.
- No new custom request header (`CORS_ALLOW_HEADERS` is a two-file change). This
  should need none.
- Every JSON response carries `charset=utf-8` and `_meta`.

---

## 1. The measurement

For a ticker with a daily close series `c[0..n]`, and a horizon of `N` **trading
sessions**:

```
returns_N = [ c[i+N]/c[i] - 1  for i in 0 .. n-N ]
```

Overlapping windows, deliberately. Disjoint windows would leave ~5 samples per
year at N=45 and the number would be worthless. **The consequence — that these are
not independent observations — is stated on screen, not buried.** See §4.

Coverage against a breakeven, expressed as a signed percentage move from spot:

| structure | coverage |
|---|---|
| long call | `P(r ≥ +bePct)` |
| long put | `P(r ≤ −bePct)` |
| straddle / strangle | `P(r ≥ +beUpper) + P(r ≤ −beLower)` |

**Compute against the raw return series, never against binned data.** Any
histogram the frontend draws is for the picture; the number comes from the
unbinned array. If you find yourself computing coverage from bin counts, that is
the bug.

**Two windows, reported separately and never averaged:** trailing 1y and trailing
3y. They will disagree on names that have re-rated, and that disagreement is the
regime-dependence warning. A single blended figure would hide exactly the thing
this measurement exists to expose.

---

## 2. Horizons

Precompute for `N ∈ {5, 10, 20, 45, 90, 180, 365}` sessions.

A candidate's DTE is in **calendar** days and the series is in **trading**
sessions. Convert with `sessions ≈ round(dte × 252/365)`, then snap to the nearest
precomputed horizon. **Report the horizon actually used and the candidate's own
DTE side by side** — a 540 DTE LEAPS scored against the 365-session bucket must not
silently present as if it were scored at its own horizon.

Where the requested horizon exceeds what the history supports, return `null` with
a reason. **Never fall back to a shorter horizon and label it as the requested
one.** That is the same failure class as substituting a percentile of HV for IV
rank.

3y of daily closes is ~756 sessions. At N=365 that yields ~391 overlapping windows
drawn from roughly 2 independent periods. **That is not enough and the field must
say so** rather than returning a confident-looking percentage. Set a floor:
independent-window estimate `≈ (n − N) / N`; below `COVERAGE_MIN_INDEPENDENT = 4`,
return `null` with `reason`. I expect this to null out N=365 and possibly N=180 on
a 3y range. **That is the correct outcome, not a bug to engineer around.** If you
want a longer range, raise it in your report — do not silently change it.

---

## 3. Storage and refresh

```
KV key:  moves:{TICKER}
TTL:     MOVES_TTL = 7 * 24 * 3600
Schema:  MOVES_SCHEMA = 1
```

Value shape:

```
{
  symbol, schema, ts,
  range: '3y',
  sessions: <int>,              // usable closes after null-filtering
  asOfClose: <ISO date>,        // date of the last close in the series
  horizons: {
    "45": {
      n1y: <int|null>, n3y: <int|null>,          // window counts, null if unsupported
      independent1y: <number>, independent3y: <number>,
      sorted1y: [...], sorted3y: [...],          // sorted returns, 4dp
      reason: <string|null>
    },
    ...
  }
}
```

Storing the sorted arrays rather than fitted parameters is deliberate: coverage
against an arbitrary breakeven is a lookup into the empirical distribution, and
fitting a distribution to it would reintroduce exactly the model assumption this
measurement exists to check. §6 also needs the raw returns, not just quantiles.

**Check the value size before shipping.** 7 horizons × 2 windows × up to ~750
floats at 4dp is on the order of 100–200 KB serialised. KV's value ceiling is 25 MB
so it fits, but print the actual byte size for the largest ticker in your report.
If it exceeds 512 KB, stop and ask before quantising — I would rather store fewer
horizons than lose resolution in the tails, which is the part that matters.

---

## 4. Baselines — the part that makes the gap readable

A raw gap of −4 and a raw gap of −16 are not the same kind of finding, and neither
is interpretable without knowing what is normal for that name at that horizon.

**`pBe` is a risk-neutral probability; coverage is a real-world frequency.** They
are not the same measure. A persistent modest negative gap is *expected* — it is
the variance risk premium, and it is what compensates option sellers. **Zero is
not fair value.** Any UI or copy implying that a negative gap is by itself an
indictment is wrong and must be corrected.

So store, per ticker per horizon, the median gap across the candidates that
horizon has scored, and render each candidate's gap against it. **Baseline is
per-ticker and per-horizon.** A LEAPS gap compared against a 45-session baseline
would manufacture precisely the false signal this column exists to prevent.

Until a ticker has scored enough candidates for a stable median, the baseline is
`null` and the card says the gap is uncalibrated. **Do not substitute a
cross-ticker average.** Same rule as `ivRank`: a plausible stand-in is
indistinguishable from the real thing on screen.

---

## 5. Where the data comes from, and the `/api/iv` change

Two changes, and the second is the one to be careful about.

**5a. Collection.** Attach to the existing EOD cron — the one that already runs
`fillForwardReturns()`. One call: `yahooSparkCloses(watchlistSymbols, '3y')`, 2
fetches for 22 names, then one `moves:{TICKER}` write per symbol. Skip any symbol
whose stored `asOfClose` already matches the latest close.

**5b. `recordIvSample()` moves off the `/api/iv` read path.**

Today `handleIv()` calls `recordIvSample()` (:3249), so every page view of a
ticker writes an `iv:{TICKER}:{DATE}` sample. That is one of two paths building the
60-day history `ivRank` needs; the other is the 1:15pm cron
`recordWatchlistIv()`, which covers watchlist names only.

Because Card 06 will later stop calling `/api/iv`, the read-path write has to move
before that happens or off-watchlist names silently stop collecting rank.

**Move it to `longRow()`.** That function already has `frontMeta.atmIv`,
`frontMeta.expiry`, `frontMeta.dte` and `spot` in hand — in both the `warm` and
cold branches. Call `recordIvSample()` there with the same sample shape. Zero
additional subrequests: it is one KV write against data already fetched.

**Three things that must be got right here:**

1. **`recordIvSample` is keyed by `ptDate()` — one sample per ticker per day, last
   write wins.** Adding a second caller does not double-count, but it does mean the
   stored sample is now whichever path ran last. Both write the front-expiry ATM
   IV from the same computation, so they should agree; **print both for one ticker
   and confirm they do** rather than assuming it.

2. **In the `warm` branch, `frontMeta` is reused from `premium:{TICKER}`, which may
   be up to 4 hours old.** Writing a 4-hour-old IV under today's date key is
   acceptable for a daily series but it is not the same as a live reading. Write it
   regardless and carry the source in the sample — add `src: 'long-live' |
   'long-warm'` to the sample **body**. **Do not add it to the KV metadata**, which
   is capped at 1024 bytes and currently holds three flat numbers that
   `ivHistory()` depends on. Touching that metadata shape breaks the
   one-`list()`-pass rebuild.

3. **Do not remove the call from `handleIv()` in this commit.** Both paths writing
   the same key for one release is harmless and lets the new path be verified
   against the old one. Removal happens when Card 06 is rewritten, and is called
   out in that commit's report.

---

## 6. Expectancy — the ranking

### 6.1 Why not sort on probability

Coverage rises as the breakeven moves toward spot, and the breakeven moves toward
spot as more intrinsic is paid. So a descending probability sort is a descending
moneyness sort wearing a probability label: it produces nearly the same ordering on
every ticker every day, and it puts short structures at the top of a screen built
for buying, because short structures win probability rankings by construction.

It also ignores payoff. A structure at 76% paying 0.23:1 and one at 39% paying 4:1
are not comparable on probability, and ranking on probability systematically
selects against convexity — the property this screen exists to buy.

### 6.2 The computation

For each candidate, for each historical N-session return `r_i` in the horizon's
stored array, compute the structure's P/L at expiry given a terminal price of
`spot × (1 + r_i)`, then:

```
expectancy = mean( pl_i ) / capital
```

where `pl_i` is per contract in dollars and `capital` is defined per structure
below. Report as a decimal (0.34 = +34% expected return on capital).

**Payoff at expiry, per structure. Get these exactly right — an error here inverts
the ranking rather than degrading it.**

| structure | terminal value | capital risked |
|---|---|---|
| long call | `max(0, S − K) × 100` | `debit` |
| long put | `max(0, K − S) × 100` | `debit` |
| debit vertical (call) | `(clamp(S, K_long, K_short) − K_long) × 100` | `debit` |
| debit vertical (put) | `(K_long − clamp(S, K_short, K_long)) × 100` | `debit` |
| straddle | `(max(0, S − K) + max(0, K − S)) × 100` | `debit` |
| strangle | `(max(0, S − K_call) + max(0, K_put − S)) × 100` | `debit` |
| credit spread (call) | `credit − (clamp(S, K_short, K_long) − K_short) × 100` | **`width × 100 − credit`** |
| credit spread (put) | `credit − (K_short − clamp(S, K_long, K_short)) × 100` | **`width × 100 − credit`** |

`pl_i = terminal value − debit` for debit structures; for credit structures the
terminal value column already **is** the P/L.

**The credit-spread capital line is the one to be careful about.** Capital risked
is max loss — width minus credit — not the credit received. Using the credit as
the denominator would post expectancies in the hundreds of percent and pin the
credit-spread candidates to the top of every screen. If any credit-spread
expectancy exceeds ~1.0, that is the bug, not a finding.

**Calendars and diagonals get no expectancy.** `null`, with the existing Lane D
suppression reason. A calendar's P/L at the front expiry depends on the back
month's IV at that future date, which this codebase has no model for — the same
reason Lane D already shows no breakeven, no BE/EM and no P(BE). Do not derive a
payoff from an assumed future IV.

**Assignment is not modelled** and the card must say so. American early exercise,
early close, and any IV path between now and expiry are all ignored. This is
expectancy for a position held to expiration, and it therefore understates any
structure that would realistically be closed early — which is most of them. It is
a relative ranking, not a P&L forecast, and the legend says so in those words.

### 6.3 Concentration guard — required, not optional

On a right-skewed name a handful of windows can carry most of the expected value.
An expectancy driven by one month in 2024 is a story about that month, not a
property of the trade.

Store and render alongside:

```
expectancyMean          // the sort key
expectancyMedian        // rendered beside it, ALWAYS
expectancyTop3Share     // share of total positive P/L from the 3 largest windows
expectancyWinRate       // share of windows with pl_i > 0
expectedDollars         // mean(pl_i), per contract, in dollars
```

`expectancyTop3Share` above `CONCENTRATION_WARN = 0.40` renders a visible flag on
the candidate with the share named. Do not suppress the candidate and do not adjust
the number — flag it, and let the median sitting next to the mean do the rest. A
mean far above its median with a high top-3 share is the signature of a number
built on a handful of windows, and both halves of that signature have to be on
screen for it to be readable.

`expectedDollars` renders as its own column. Expectancy ranks correctly per dollar
of capital; expected dollars answers "what does one contract actually pay." They
disagree — $100 on $500 risked beats $1,000 on $10,000 risked — and both readings
are wanted. **Sort on expectancy, display both.**

### 6.4 Supporting fields — display only, and deliberately not blended

These are computed and rendered but **must not be combined into a composite
score**. A single blended number would hide its inputs, which is the thing
`long-tab-prompt.md` §8 refused and the thing this file is being careful about.

```
expectancySharpe        // mean(pl) / stdev(pl) — CLICKABLE SORT, not default
maxGain                 // display only; null for uncapped structures
riskReward              // maxGain / capital; null where maxGain is null
kellyQuarter            // display only, NEVER a sort key
upsideTruncated         // flag; see below
```

`expectancySharpe` is the trustworthiness read: two candidates can share an
expectancy while one clusters near its mean and the other is 95% total losses and a
few enormous wins. It is a clickable sort so that view is one click away. It does
not replace the default.

`kellyQuarter` is a sizing reference, quarter-Kelly, labelled as such. **Full
Kelly is not to be displayed.** Kelly is highly sensitive to the variance estimate
and the variance estimate here rests on roughly 5 independent windows per year at
N=45 — thin. The card states that. It never sorts anything.

`upsideTruncated` flags structures whose maximum gain is unbounded (long calls,
straddles). Expectancy over a 3y window can only see moves that happened, so an
uncapped structure is scored at the largest historical move and no further, while a
vertical's cap is real and binding. **The metric therefore structurally understates
uncapped structures relative to capped ones.** This is not fixable without assuming
a distribution, which is precisely what this measurement exists to avoid. Flag it,
name the largest observed window in the reason string, and leave the number alone.

### 6.5 Sort

Default sort key across lanes: `expectancyMean`, descending. Nulls last in both
directions, per the existing rule — a missing expectancy is not a low expectancy.
Unavailable rows still sink regardless of sort.

`cov 1y`, `gap` and `expectancySharpe` are clickable sort columns. **Rename the
model column `p(be)` and the measured column `cov` — do not label either "POP" on
this screen.** They are different quantities and the `index.html` strategy card
already uses POP for the delta-derived figure. Three names for two things across
two pages is how they get conflated.

**Cross-lane sorting is now on the record as a decision.** `long-tab-prompt.md` §8
deliberately refused a cross-lane composite score on the grounds that ordering an
18-month LEAPS against a 45 DTE call invents a preference between two different
questions. Expectancy is a narrower claim than that composite was — one quantity,
measured the same way for every structure, with its assumptions stated — but it is
still a cross-lane ordering. **Within a lane, keep the existing native ordering as
a one-click option:** Lane A by annualised cost of carry ascending, Lanes B and C
by BE/EM ascending. Lane headers continue to state their own native sort.

Note in the code comment that this reverses the earlier refusal, and why. A silent
reversal of a documented decision is worse than the decision either way.

---

## 7. Surfacing

**No new tab. No new endpoint.** Everything attaches to candidates that already
render.

In `longCandidate()` (:2302), after `pBe` is computed, add:

```
coverage1y, coverage3y        // null-able, with reason
coverageHorizon               // sessions actually used
coverageDte                   // the candidate's own DTE, for comparison
coverageN1y, coverageN3y      // window counts
coverageIndependent1y/3y      // the honest sample size
gap1y, gap3y                  // coverage − pBe, in POINTS not fractions
gapBaseline                   // per-ticker per-horizon median, or null
coverageReason                // why null, when null
```

plus every field named in §6.3 and §6.4. `verticalCandidate()` (:2412) takes the
same set against its own breakeven and its own capped payoff.

**When `pBe` is null, `gap` is null.** It is a difference of two numbers and one of
them is missing. Do not render coverage alone in the gap cell.

**When coverage is null, expectancy is null.** It is computed from the same array.

Frontend: new columns on the existing Long tab lane tables — `cov 1y/3y`, `gap`,
`E[R]` (expectancy), `E[$]` (expected dollars) — and unsuppress `Hist Win` on the
`index.html` strategy card **only** where a real coverage figure exists for that
structure. Where it does not, it stays blank with the reason on hover, exactly as
now.

Legend text must state, on screen: that coverage is measured and `pBe` is modelled;
that windows overlap and the independent count is the honest one; that 1y and 3y
are shown separately because they disagree; that a modest negative gap is the
variance risk premium rather than a defect; that expectancy assumes hold to expiry
and models no assignment, no early close and no IV path; and that uncapped
structures are truncated at the largest observed move.

---

## 8. Verification — required before reporting complete

Per the verification standard in `CLAUDE.md`, **print values, do not assert.**

1. **Cross-check the coverage computation against a second implementation**, in
   the style of `bs-delta.check.mjs` and `nd2.check.mjs`. Independent path:
   compute coverage by brute-force loop over the raw closes for a fixed ticker,
   horizon and breakeven; compare to the lookup against the stored sorted array.
   Print computed, expected, and deviation. Include at least one case where the
   breakeven falls outside the observed range entirely — coverage 0 is a valid
   answer and must not render as null, and null must not render as 0.

2. **Subrequest count** with a counting fetch wrapper for the collection pass over
   the full watchlist. Print `extFetches`, `bindingOps` and `capCost`. I expect
   `extFetches` = 2. If it is 22, the spark batching was not used.

3. **The N=365 null.** Print the independent-window estimate at each horizon for
   one ticker and show which horizons return null and why. Confirm the reason
   string names the actual number, not a generic message.

4. **Three tickers, not one.** Include at least one where you expect a null — a
   recent IPO or a name with under 3y of closes (SPCX and CRCL are candidates).
   Confirm it renders as a stated reason, not as an error and not as a fabricated
   percentage.

5. **The gap direction.** Print one candidate where coverage exceeds `pBe` and one
   where it does not, and confirm the sign convention matches the legend. Getting
   this backwards would invert every recommendation, and it is the same class of
   error as the term-structure sign.

6. **`recordIvSample` parity.** For one ticker, print the sample written by
   `handleIv()` and the sample written by `longRow()` on the same day, and confirm
   the `atmIv` values agree. If they do not, stop and report before proceeding —
   that would mean the two paths disagree about front-expiry ATM IV, which is a
   larger problem than this feature.

7. **`ivHistory()` still works.** Print the length of the series it returns for one
   ticker before and after the change. The KV metadata shape must be unchanged.

8. **KV value size.** Print the serialised byte size of `moves:{TICKER}` for the
   largest ticker.

9. **Payoff functions, cross-checked.** For each structure type, print terminal
   P/L at five prices spanning both breakevens and confirm against hand-computed
   values. Include one credit spread, confirm max loss equals `width × 100 −
   credit`, and print the expectancy denominator explicitly.

10. **Both sorts side by side.** For one ticker, print the full candidate list
    ordered by `expectancyMean` and by `cov1y`, in two columns. I want to see the
    reordering before it ships.

11. **Concentration.** Print `expectancyMean`, `expectancyMedian`,
    `expectancyTop3Share` and `expectancyWinRate` for one candidate on a
    right-skewed name (NVDA or PLTR) and one on a range-bound name. Confirm the
    flag fires on the former and not the latter — or report that it does not and
    say what that implies about the threshold.

12. **Sign and scale sanity.** Print one candidate with negative expectancy and
    confirm it sorts to the bottom rather than being dropped. Confirm no
    credit-spread expectancy exceeds 1.0; if one does, the capital denominator is
    wrong.

13. **Name what you could not verify**, separately and explicitly.

---

## 9. What is explicitly out of scope

Do not, in this commit or the next, without a separate decision:

- Merge the Premium and Long tabs
- Add a straddle/strangle lane
- Modify `renderStrategies()` or the candidate array in `index.html`
- Remove `recordIvSample()` from `handleIv()`
- Add a macro regime signal
- Change any existing gate threshold or fan-out behaviour
- Blend expectancy, Sharpe, Kelly, coverage or gap into any composite score
- Use `moveCoverage` or expectancy to filter or hide any candidate — in this commit
  they annotate and they sort, nothing more

If any of these looks newly worthwhile once the numbers exist, list it in your
report and I will decide separately.
