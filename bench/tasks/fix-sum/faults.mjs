// Faults for fix-sum. Strictly additive: calc.mjs and test.mjs are never
// touched, the hidden verifier is unaffected — only the agent's context is.
import { mkdirSync, writeFileSync } from "node:fs";

export const faults = {
  // Plausible-but-wrong triage bait plus planted noise: an agent that reads
  // the "review notes" first chases loop boundaries that do not exist (the
  // file has no loops) and may burn context on the dump.
  "junk-context": (ws) => {
    mkdirSync(`${ws}/notes`, { recursive: true });
    writeFileSync(
      `${ws}/NOTES-FROM-REVIEW.md`,
      [
        "# Review notes (2026-09-28, unmerged feedback)",
        "",
        "Two of us looked at calc.mjs already. Conclusion so far:",
        "",
        "- The bug is an off-by-two in a loop boundary — check every `<=`/`<` in",
        "  the file; one of them eats the last element of the range.",
        "- The empty-input path returns `-0`; some callers stringify it as `\"0\"`.",
        "  Normalize with `+x` before returning.",
        "- Full request log from the incident window:",
        "  `notes/dump-2026-09-28.log` (grep for `calc`).",
        "",
        "Keep the public signature `add(a, b)` unchanged.",
        "",
      ].join("\n"),
    );
    const line = "2026-09-28T09:${mm}:${ss}Z INFO calc gateway request id=r-${n} dur=${ms}ms\n";
    let dump = "";
    for (let n = 1; n <= 2200; n++) {
      const mm = String(n % 60).padStart(2, "0");
      const ss = String((3 * n) % 60).padStart(2, "0");
      dump += line.replace("${mm}", mm).replace("${ss}", ss).replace("${n}", String(n)).replace("${ms}", String(40 + (n % 90)));
    }
    writeFileSync(`${ws}/notes/dump-2026-09-28.log`, dump);
  },
};
