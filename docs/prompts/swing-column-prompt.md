# Prompt — Watchlist "Swing" regression-channel column

Issued 2026-08-14. Verbatim.

---

Add a Swing Trade column to the watchlist. Read CLAUDE.md and ARCHITECTURE.md first; their rules apply, including forming-bar exclusion, worker-owned thresholds, and printed verification.

Feature spec. A new sortable column "Swing" on the watchlist table showing a linear-regression channel signal: BUY when the live price is ≥1.5 residual standard deviations below the 30-bar regression line, SELL when ≥1.5σ above, otherwise the signed σ distance (e.g. "+0.8σ") as an informational value. This mirrors thinkorswim's regression channel: OLS fit on daily closes, σ of residuals from the fitted line — not σ of the closes.

Worker (handleWatchlistBatch in worker.js). Compute per ticker inside the existing chart block — the ?range=3mo&interval=1d fetch already has everything needed. Zero new external fetches; state that in a comment.

Build date-aligned (iso, close) pairs from the chart result's timestamp and close arrays, filtering nulls on the same predicate so they stay aligned (same pattern as yahooSparkCloses withTimestamps). Do not reuse the bare filtered closes array used for RSI — it has no dates.
Exclude today's forming bar: drop the last pair if its iso equals etToday() and the session is not settled. Use the last 30 completed bars. If fewer than 30 completed bars exist, all swing fields are null (renders as "—", not 0, not an error).
OLS regression: x = 0..29, y = the 30 closes. Residual σ = sqrt(SSR / (n−2)) — standard error of the regression. Document the n−2 choice in a comment.
Evaluate the line at the session of the live quote: if etToday() is later than the last completed bar's iso, extrapolate to x = 30; if the last completed bar IS today (post-settlement), use x = 29. Comment why: the live regularMarketPrice belongs to today's session, and comparing it to yesterday's fitted value would misstate the distance by one bar of slope.
z = (regularMarketPrice − fittedValue) / residualσ. Ship on the row: swingZ (rounded to 2dp), swingSignal ('BUY' | 'SELL' | null), swingFit, swingSigma (2dp each). The worker computes the signal from the threshold — the frontend must never compare z to 1.5 itself.
Ship the threshold in the response envelope beside _meta as swingThreshold: 1.5 via a named constant SWING_Z_THRESHOLD near the other gate constants, per the worker-owns-thresholds rule. Also ship swingBars: 30 from a constant SWING_REG_BARS.

Frontend (dashboard.html).

Add one <col> to the watchlist colgroup (column resize depends on colgroup count matching), and a <th data-sort="swingZ">Swing</th> header wired like the existing sortable headers, with a title tooltip stating: 30 completed daily bars, OLS regression, residual σ, live price, threshold from the server payload (interpolate the shipped value, don't hardcode 1.5).
Cell render in renderWatchlist(): swingSignal === 'BUY' → "Buy" in var(--bull) with the z value; 'SELL' → "Sell" in var(--bear) with the z value; signal null but swingZ present → the signed σ distance in muted mono (e.g. "+0.8σ"); swingZ null → "—".
Sort: swingZ is numeric; the existing sort comparator already sinks nulls. No new sort logic.
Grep the watchlist section for every colspan="14" (the error row at minimum, plus any expanded-row detail cell) and bump each to 15. Report every occurrence changed.

Docs. CLAUDE.md describes the watchlist as "the 14-column table" — update to 15 and add one line describing the Swing column: informational regression-channel signal, threshold SWING_Z_THRESHOLD, computed from the existing 3mo chart fetch at zero added subrequest cost, forming bar excluded.

Verification — printed values, not assertions. Write a check script in the project root (pattern: existing *_check.mjs files) and run it. Print:

For NVDA, AMD, and one short-history name (SPCX or CRCL): the last completed bar's iso vs etToday(), proving the forming bar was or wasn't dropped and why.
An independent brute-force regression (separate code path, not the worker function) for NVDA: slope, intercept, fitted value at the evaluation x, residual σ, z — side by side with the worker's values. Deviation must print as a number.
Which x (29 or 30) was used for each ticker and the rule that selected it.
The short-history ticker returning null with all four swing fields null — not 0, not NaN.
One ticker where |z| ≥ 1.5 if any exists on the current watchlist, showing the signal string; if none exists today, print the max |z| observed and state that the threshold branch was exercised with a synthetic series instead (and do so).
The response envelope showing swingThreshold and swingBars present.

Save this prompt to docs/prompts/ per convention. Auto-commit and push at completion. Do NOT deploy — npx wrangler deploy stays manual.

---

## What was delivered, and the two places the spec had to be read rather than followed literally

- **"the session is not settled"** was not defined by an existing helper. It is now
  `SWING_SETTLE_ET_HOUR = 16` — the 4:00pm ET bell — mirroring `moodSettledBars()`,
  which does the same job against `MOOD_PRECLOSE_PT_HOUR = 13`. ET rather than PT
  because the bar `iso` being compared is an ET session date.
- **The regression is evaluated after `price` is finalised, not inside the chart
  block.** The pairs are built in the chart block, as specified and for the reason
  specified (zero added fetches). But `handleWatchlistBatch` overwrites the chart
  meta's quote with `quoteSummary`'s a few lines later, and that is the price the
  row renders — so a z computed against the chart meta would have been measured
  against a price the column does not show. Evaluated next to `levelPct`, which
  sits where it does for the same reason.

Two fields beyond the four specified ride along: `swingEvalX` and `swingAsOf`.
They are what makes the tooltip and the check script able to state *which* bar the
line was read at rather than re-derive it — the same relationship `levelKind` /
`levelPrice` have to `levelPct`.

**No short-history name exists on the live watchlist.** SPCX is the shortest at 43
completed bars, still comfortably over 30. The sub-30 branch is therefore driven by
truncating SPCX's real series from the front (keeping the forming-bar tail, so the
bar-count gate and the forming-bar drop are exercised together) — stated in the
script rather than presented as a live case.
