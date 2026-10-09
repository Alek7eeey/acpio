import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * node-pty@1.1.0 is patched on install (see scripts/patch-node-pty.mjs +
 * the root "postinstall" hook) to fix two ConPTY bugs on Windows:
 *   - "AttachConsole failed" stack traces from conpty_console_list_agent, and
 *   - shell child processes surviving pty.kill() (console tree never enumerated).
 * Installs with --ignore-scripts skip the patch, so guard it here.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const patchedFiles = [
  "conpty_console_list_agent.js",
  "windowsPtyAgent.js",
];

describe("node-pty ConPTY patch", () => {
  it("is applied to every installed node-pty copy", () => {
    const libDir = path.join(root, "node_modules", "node-pty", "lib");
    if (!fs.existsSync(libDir)) return; // dependency not installed (e.g. docs-only checkout)
    for (const file of patchedFiles) {
      const src = fs.readFileSync(path.join(libDir, file), "utf8");
      expect(
        src.includes("acpio-patch:"),
        `${file} is not patched — run: node scripts/patch-node-pty.mjs ` +
          `(otherwise console kill orphans child processes and logs "AttachConsole failed")`,
      ).toBe(true);
    }
  });
});
