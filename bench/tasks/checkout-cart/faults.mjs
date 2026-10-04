// Faults for checkout-cart. Strictly additive: src/ is never touched and the
// hidden verifier only imports ./src/index.mjs — the bait files change nothing
// about the graded path.
import { mkdirSync, writeFileSync } from "node:fs";

export const faults = {
  // Stale internal docs that contradict the code: an agent that trusts the
  // changelog hunts for tax logic in discounts.mjs and discounts applied
  // after tax — the real defect (per the hidden verifier's expectations) is
  // the percent rounding in money.mjs, applied before tax.
  "stale-notes": (ws) => {
    mkdirSync(`${ws}/receipts`, { recursive: true });
    writeFileSync(
      `${ws}/CHANGELOG-WIP.md`,
      [
        "# CHANGELOG (WIP — PR not merged yet)",
        "",
        "## v0.9.0 — 2026-09-27 (merged to main, expected on disk)",
        "",
        "- Refactor: tax computation moved from tax.mjs into discounts.mjs.",
        "- Pricing order changed: coupons are now applied AFTER tax, so line",
        "  totals should be computed as (price + tax) - discount.",
        "- money.mjs is deprecated and kept only for `formatCents` compat — do",
        "  not invest there.",
        "",
        "> NOTE (release): staging totals looked off during the rollout; one of",
        "> the above may not have landed. Check against receipts if unsure.",
        "",
      ].join("\n"),
    );
    writeFileSync(
      `${ws}/receipts/2026-09-27.receipt.txt`,
      [
        "RECEIPT 2026-09-27 #1043 (archived snapshot, v0.8.x)",
        "note-07 x1  $92.50",
        "book-02 x1  $27.50",
        "SUBTOTAL    $120.00",
        "TAX 8%      $9.60",
        "TOTAL       $129.60",
        "",
      ].join("\n"),
    );
  },
};
