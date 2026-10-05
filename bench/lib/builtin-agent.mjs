// Drives the in-process builtin agent the way a user does: the real acpio
// server, its HTTP API, `permissionPolicy=always`, a per-run temp database.
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { killTree, runProcess } from "./util.mjs";

/**
 * Degenerate-session fingerprint: a 200 response that silently lost its
 * tool-call chunks or carries NUL bytes inside tool arguments (free-endpoint
 * stream corruption, 2026-10-04 sweep: read/edit args arrived as
 * "lib/duration.mjs\0") ends the session while nothing honest happened.
 * The corruption is only visible in the disk transcript — the API detail
 * carries no tool-result bodies, and a failed call is not always marked
 * failed. The runner scans failed pairs with this and retries them once.
 * The store files are named by the ADAPTER's session id, not the API one,
 * so transcripts are matched by the workspace cwd they record. JSON escapes
 * NUL as the literal six characters \u0000.
 */
export async function sessionTranscriptHasNul(server, ws) {
  try {
    const dir = path.join(server.stateDir, "agent-sessions");
    // The store records cwd with forward slashes even on Windows.
    const marker = ws.replace(/\\/g, "/");
    for (const f of await readdir(dir)) {
      const text = await readFile(path.join(dir, f), "utf8");
      if (!text.includes(marker)) continue;
      if (text.includes("\\u0000") || text.includes("without null bytes")) return true;
    }
  } catch {
    // no transcripts (or no dir) — nothing corrupted on record
  }
  return false;
}

async function freePort() {
  for (let p = 4100 + Math.floor(Math.random() * 1500); ; p++) {
    const free = await new Promise((resolve) => {
      const s = createServer();
      s.once("error", () => resolve(false));
      s.listen(p, "127.0.0.1", () => s.close(() => resolve(true)));
    });
    if (free) return p;
  }
}

export class BenchServer {
  constructor({ repo, stateDir, provider, headers }) {
    this.repo = repo;
    this.stateDir = stateDir;
    this.provider = provider;
    this.headers = headers ?? [];
    this.port = 0;
    this.log = "";
    this.child = null;
  }

  get base() {
    return `http://127.0.0.1:${this.port}`;
  }

  async api(method, p, body) {
    const res = await fetch(this.base + p, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text.slice(0, 300)}`);
    return json;
  }

  async start(timeoutMs = 30_000) {
    // The server may ignore the handed-out port: `ACPIO_PORT` beats `PORT`, and
    // an inherited value survives the env spread (one sweep lost four pairs to
    // a server that sat on 18741 while the runner health-checked a dead port).
    // So ACPIO_PORT is set explicitly, the banner is parsed for the port the
    // server actually took, and one respawn covers a spawn that died at boot.
    for (let attempt = 1; ; attempt++) {
      this.port = await freePort();
      this.log = "";
      this.child = spawn(process.execPath, [path.join(this.repo, "apps/server/dist/index.js")], {
        cwd: this.repo,
        env: {
          ...process.env,
          PORT: String(this.port),
          ACPIO_PORT: String(this.port),
          DATABASE_PATH: path.join(this.stateDir, "acpio.db"),
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      this.child.stdout.on("data", (d) => (this.log = (this.log + d).slice(-8000)));
      this.child.stderr.on("data", (d) => (this.log = (this.log + d).slice(-8000)));

      const deadline = Date.now() + timeoutMs;
      let healthy = false;
      let lastErr = "";
      while (Date.now() <= deadline) {
        try {
          await this.api("GET", "/api/health");
          healthy = true;
          break;
        } catch (err) {
          lastErr = String(err?.message ?? err);
          // Alive but on a different port than handed out — adopt the banner's.
          const banner = this.log.match(/Acpio server on http:\/\/[^/]+:(\d+)/);
          if (banner && Number(banner[1]) !== this.port) {
            this.port = Number(banner[1]);
            continue;
          }
          if (this.child.exitCode !== null) break; // died at boot — respawn below
          await new Promise((r) => setTimeout(r, 300));
        }
      }
      if (healthy) break;
      this.child?.kill();
      if (attempt >= 2) {
        throw new Error(`bench server did not start: ${lastErr}\n${this.log.slice(-2000)}`);
      }
    }

    await this.configure();
    const probe = await this.api("POST", "/api/agent/probe", { provider: "builtin" });
    if (!probe?.ok) throw new Error(`builtin probe failed: ${probe?.message ?? "unknown"}`);
  }

  /**
   * Point the running server at `url`. A slot server is reused across pairs,
   * and the pair's wire label lives in the provider URL — without a re-PUT
   * every later pair on the slot rides the first pair's label on the wire.
   */
  async configure(url = this.provider.baseUrl) {
    this.provider.baseUrl = url;
    await this.api("PUT", "/api/settings", {
      locale: "en",
      defaultProvider: "builtin",
      defaultMode: "agent",
      permissionPolicy: "always",
      builtinProviders: [
        {
          id: this.provider.provider,
          name: this.provider.provider,
          url: this.provider.baseUrl,
          apiKey: this.provider.apiKey,
          headers: this.headers,
          models: [
            {
              id: this.provider.modelId,
              label: this.provider.modelId,
              contextWindow: this.provider.contextWindow,
              enabled: true,
            },
          ],
        },
      ],
      // A/B switch for the subagents feature: `BENCH_SUBAGENTS=on` arms the
      // task tool with the default roster (ad-hoc allowed, empty user roster).
      ...(process.env.BENCH_SUBAGENTS === "on"
        ? { builtinSubagents: { enabled: true, allowAdhoc: true, agents: [] } }
        : {}),
    });
  }

  stop() {
    killTree(this.child);
    this.child = null;
  }
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * One in-process-agent session: create a chat on the workspace, prompt, wait
 * it out. `prompts` (multi-prompt mode) sends several user turns into the
 * SAME session — a turn boundary is what the server's compaction cuts at, so
 * with a single prompt per session it can never engage. The overall budget
 * is still the one `timeoutMs`; if it runs out mid-way, the remaining turns
 * are simply unsent and the cancel logic below reaps the live turn.
 */
export async function runBuiltinAgent(server, { task, ws, timeoutMs, prompts }) {
  const turns = prompts?.length ? prompts : [task.prompt];
  const t0 = Date.now();
  const session = await server.api("POST", "/api/sessions", {
    provider: "builtin",
    cwd: ws,
    mode: "agent",
  });

  const deadline = t0 + timeoutMs;
  let detail = null;
  let sawRunning = false;
  let turnsSent = 0;
  for (const text of turns) {
    if (Date.now() > deadline) break;
    const turnT0 = Date.now();
    await server.api("POST", `/api/sessions/${session.id}/prompt`, { text });
    turnsSent += 1;
    for (;;) {
      detail = await server.api("GET", `/api/sessions/${session.id}`);
      if (detail.status === "running") sawRunning = true;
      else if (sawRunning || Date.now() - turnT0 > 5000) break;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    sawRunning = false;
  }

  // A turn the poller gave up on is still live server-side: without a cancel it
  // keeps calling the model under the NEXT task's proxy label and poisons that
  // row (this happened once: a timed-out run leaked 9 calls across three
  // later tasks). Cancel and wait, bounded, until the session is really idle.
  if (detail?.status === "running") {
    try {
      await server.api("POST", `/api/sessions/${session.id}/cancel`);
    } catch {}
    const idleBy = Date.now() + 60_000;
    while (Date.now() < idleBy) {
      try {
        detail = await server.api("GET", `/api/sessions/${session.id}`);
      } catch {
        break;
      }
      if (detail.status !== "running") break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  const parts = detail?.messages?.flatMap((m) => m.parts ?? []) ?? [];
  const toolParts = parts.filter((p) => p.type === "tool_call");
  const toolNames = {};
  let toolErrors = 0;
  for (const p of toolParts) {
    // ACP `tool_call` carries no toolName; the builtin writes `<name> <subject>`
    // into `title`, so the first token is the tool.
    const title = String(p.payload?.title ?? "");
    const name =
      String(p.payload?.raw?.toolName ?? p.payload?.toolName ?? title.split(/\s+/)[0] ?? "") || "?";
    toolNames[name] = (toolNames[name] || 0) + 1;
    if (p.payload?.status === "failed") toolErrors += 1;
  }
  const lastAssistant = [...(detail?.messages ?? [])].reverse().find((m) => m.role === "assistant");
  const finalText = (lastAssistant?.parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => String(p.payload?.text ?? ""))
    .join("");
  const usage = detail?.usage ?? null;

  return {
    modelCalls: null,
    toolCalls: toolParts.length,
    toolErrors,
    toolNames,
    tokensIn: num(usage?.inputTokens),
    tokensOut: num(usage?.outputTokens),
    tokensTotal: num(usage?.usedTokens) || num(usage?.inputTokens) + num(usage?.outputTokens),
    tokensCached: num(usage?.cachedInputTokens),
    contextTokens: num(usage?.contextWindow),
    cost: num(usage?.cost),
    finalText,
    stopReason: detail?.status ?? "",
    wallMs: Date.now() - t0,
    exitCode: detail?.status === "error" ? 1 : 0,
    timedOut: Date.now() > deadline,
    // Multi-prompt sessions only: a plain one-prompt session must not leak a
    // constant turns:1 into every row (it spread into the md note column).
    ...(turns.length > 1 ? { turns: turns.length, turnsSent } : {}),
    sessionId: session.id,
    stderrTail: server.log.slice(-1500),
  };
}

export { runProcess };
