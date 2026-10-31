/**
 * The one place the end-to-end suite's world is described: where the repo is,
 * which agent answers, and what the app's settings are before every test.
 *
 * Plain .mjs on purpose — `support/server.mjs` reads it at runtime and the TS
 * specs import it, so both see the same values instead of a second copy.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** API + WebSocket + the built UI — one port, the layout a release ships. */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 18761);
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

/** The suite's own database and attachment folder (gitignored, wiped per run). */
export const E2E_DATA_DIR = path.join(REPO_ROOT, "tmp", "e2e");

/**
 * The ACP agent the chats talk to: the deterministic fake the server's own
 * integration suite already drives (apps/server/test/fake-agent.mjs). Its
 * default answer is the thought "thinking hard" and the text `echo: <prompt>`,
 * which is what the specs assert on — no network, no model, no key.
 */
export const E2E_AGENT_ID = "e2e-fake";
export const E2E_AGENT_LABEL = "E2E Fake";
export const FAKE_AGENT_PATH = path.join(REPO_ROOT, "apps", "server", "test", "fake-agent.mjs");

/** Cache-busting marker the specs use for prompts and titles. */
export const E2E_AGENT_ECHO = (text) => `echo: ${text}`;

/**
 * Settings the server is seeded with once, before the first test: English and
 * light so assertions can name the UI by its labels, no boot splash over the
 * shell, the three real CLIs off (nobody has them on a CI runner) and the fake
 * agent as the default provider.
 */
export const E2E_SETTINGS = {
  locale: "en",
  theme: "light",
  showBootSplash: false,
  disabledProviders: ["cursor", "omp", "opencode"],
  defaultProvider: E2E_AGENT_ID,
  customAgents: [
    {
      id: E2E_AGENT_ID,
      label: E2E_AGENT_LABEL,
      command: process.execPath,
      args: [FAKE_AGENT_PATH],
    },
  ],
};

/**
 * What a test may have changed by hand (a theme or a language is a global app
 * setting, not a per-tab one) — put back before every test so one spec's
 * click never colors the next one's assertions.
 */
export const E2E_RESET_SETTINGS = {
  locale: "en",
  theme: "light",
};
