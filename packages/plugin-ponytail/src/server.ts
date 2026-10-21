/**
 * ponytail — the app's own plugin, and the reason `skillPath` exists: the only
 * thing it contributes is its skill folder, which the host scans exactly like
 * one of the user's own (Settings → Skill folders).
 *
 * `supersedes` is declared here rather than in the SKILL.md, because the skill
 * text is the author's: the harness rule that says the same thing in fewer
 * words is dropped while ponytail is active, so the prompt states the idea once
 * (see agent.ts's `RULES` and skills.ts's `supersededRules`). The id list is
 * the one contract the two sides share.
 *
 * The folder is absolute and computed from this module, so it works both ways
 * the bundle is loaded (the `dist/server.js` the app runs, the `src/server.ts`
 * the development condition resolves): the skill folder is one level up from
 * the file. A shipped plugin is never copied into the plugin cache, so there is
 * no `home` to resolve relative paths against.
 */
import { fileURLToPath } from "node:url";
import type { PluginBundle } from "@acpio/plugin-api";

const skillsDir = fileURLToPath(new URL("../skills", import.meta.url));

const bundle: PluginBundle = () => ({
  id: "ponytail",
  extensions: [
    {
      skillPath: {
        path: skillsDir,
        // ponytail's own ladder ("The smallest complete change") is the longer,
        // stricter take on the harness rule "make the smallest change".
        supersedes: { ponytail: ["smallest-change"] },
      },
    },
  ],
});

export default bundle;
