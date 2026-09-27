// Regression: two ensureAcp callers in the same tick must share ONE agent boot.
// The dedupe guards used to run before the async lookups that reserve the boot
// slot, so a chat created and prompted together booted two agents, left
// `rt.client` pointing at the second, and hung the first one's permission
// answers (they were routed through rt.client to the idle impostor).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentMode, AgentProvider } from "@acpio/shared";
import { ensureSchema } from "../db/ensureSchema.js";
import { disposeRuntime, ensureAcp } from "./sessionManager.js";

const cwd = mkdtempSync(path.join(tmpdir(), "acpio-ensure-"));
const sessionId = "ensure-boot-reservation";
const opts: { provider: AgentProvider; cwd: string; mode: AgentMode } = {
  provider: "builtin",
  cwd,
  mode: "agent",
};

beforeAll(async () => {
  await ensureSchema();
});

afterAll(() => {
  disposeRuntime(sessionId);
  rmSync(cwd, { recursive: true, force: true });
});

describe("ensureAcp boot reservation", () => {
  it("gives concurrent callers the same agent instead of booting twice", async () => {
    const [first, second] = await Promise.all([
      ensureAcp(sessionId, opts),
      ensureAcp(sessionId, opts),
    ]);
    expect(second).toBe(first);
    // A later caller reuses the completed boot.
    expect(await ensureAcp(sessionId, opts)).toBe(first);
  });
});
