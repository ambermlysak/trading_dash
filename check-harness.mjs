/* Shared verdict helper for the six `*.check.mjs` scripts.
   ══════════════════════════════════════════════════════════════════════════════

   THE RULE: no comparison reports agreement without first asserting a non-zero
   population on both sides, and the population count goes in the output next to
   the verdict.

   WHY IT EXISTS. Verifying the first live move-series sweep, a script compared a
   stored distribution against a rebuilt one and printed:

       VERDICT (i) vs (ii): IDENTICAL — the storage round-trip loses nothing.

   It had scored ZERO candidates on both sides — two wrong field names — and two
   empty sets compare equal. The verdict was not merely unsupported, it was the
   most reassuring possible output at the moment the harness was measuring
   nothing. A test suite that silently tests nothing reports success, which is
   strictly worse than one that fails.

   The failure is not exotic. `bs-delta.check.mjs` and `nd2.check.mjs` both judged
   on `worst < 7.5e-8` with `worst` initialised to 0 — so a suite whose cases
   never ran passed "within spec". That was latent in both from the day they were
   written and neither had a comparison counter to notice.

   So every check script now counts what it actually compared and reports that
   count beside its verdict. A pass with `(0 comparisons)` cannot be printed:
   `reportVerdict` refuses it and exits non-zero.

   Note the counter must be incremented where the comparison HAPPENS — inside the
   row/check helper — not where the cases are declared. Counting declarations
   would restore the same blind spot one level up: a loop that skips every case
   still declared them. */

/** A comparison ledger. Pass it to every row helper in the script. */
export function tally() {
  return { comparisons: 0, failures: 0 };
}

/** Record one comparison and whether it agreed. Returns `ok` so callers can
 *  chain it into their own formatting. */
export function record(t, ok) {
  t.comparisons++;
  if (!ok) t.failures++;
  return ok;
}

/**
 * Print the verdict and return a process exit code.
 *
 * `minComparisons` is the floor a run must clear to be allowed a verdict at all.
 * Default 1 — the bare "it did something" bar. Pass a real expected count where
 * one is known: a script that should compare 198 candidates and compares 3 has
 * not passed either, and only the caller knows that number.
 */
export function reportVerdict({ label, comparisons, failures, minComparisons = 1 }) {
  const n = `${comparisons} comparison${comparisons === 1 ? '' : 's'}`;

  if (!Number.isFinite(comparisons) || comparisons < minComparisons) {
    console.log(`\nNO VERDICT — ${label}: ${n} performed, at least ${minComparisons} required.`);
    console.log('An empty comparison is not a pass. Two empty sets compare equal, and a');
    console.log('harness that measures nothing reports success. Fix the harness first.\n');
    return 1;
  }
  if (failures > 0) {
    console.log(`\n${failures} CHECK(S) FAILED across ${n} — see above.\n`);
    return 1;
  }
  console.log(`\nALL CHECKS PASSED across ${n}.\n`);
  return 0;
}

/**
 * Guard an aggregate comparison BEFORE it is made. Use where two collections are
 * about to be compared wholesale — the empty-vs-empty case the rule is named for.
 * Returns true when the comparison may proceed.
 */
export function populated(label, ...sides) {
  const bad = sides
    .map((n, i) => [i, Number.isFinite(n) ? n : 0])
    .filter(([, n]) => n <= 0);
  if (!bad.length) return true;
  console.log(`  NO VERDICT — ${label}: population is `
    + sides.map(n => String(n)).join(' vs ')
    + '. An empty comparison is not a pass.');
  return false;
}
