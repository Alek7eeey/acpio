// Drives the in-process builtin agent the way a user does: the real acpio
// server, its HTTP API, `permissionPolicy=always`, a per-run temp database.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { killTree, runProcess } from "./util.mjs";

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
  constructor({ repo, stateDir, provider }) {
    this.repo = repo;
    this.stateDir = stateDir;
    this.provider = provider;
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
    this.port = await freePort();
    this.child = spawn(process.execPath, [path.join(this.repo, "apps/server/dist/index.js")], {
      cwd: this.repo,
      env: { ...process.env, PORT: String(this.port), DATABASE_PATH: path.join(this.stateDir, "acpio.db") },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.on("data", (d) => (this.log = (this.log + d).slice(-8000)));
    this.child.stderr.on("data", (d) => (this.log = (this.log + d).slice(-8000)));

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await this.api("GET", "/api/health");
        break;
      } catch (err) {
        if (Date.now() > deadline) throw new Error(`bench server did not start: ${err.message}\n${this.log.slice(-2000)}`);
        await new Promise((r) => setTimeout(r, 300));
      }
    }

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
    });
    const probe = await this.api("POST", "/api/agent/probe", { provider: "builtin" });
    if (!probe?.ok) throw new Error(`builtin probe failed: ${probe?.message ?? "unknown"}`);
  }

  stop() {
    killTree(this.child);
    this.child = null;
  }
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** One builtin turn: create a chat on the workspace, prompt, wait it out. */
export async function runBuiltinAgent(server, { task, ws, timeoutMs }) {
  const t0 = Date.now();
  const session = await server.api("POST", "/api/sessions", {
    provider: "builtin",
    cwd: ws,
    mode: "agent",
  });
  await server.api("POST", `/api/sessions/${session.id}/prompt`, { text: task.prompt });

  const deadline = Date.now() + timeoutMs;
  let detail = null;
  let sawRunning = false;
  for (;;) {
    detail = await server.api("GET", `/api/sessions/${session.id}`);
    if (detail.status === "running") sawRunning = true;
    else if (sawRunning || Date.now() - t0 > 5000) break;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 500));
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
    contextTokens: num(usage?.contextWindow),
    cost: num(usage?.cost),
    finalText,
    stopReason: detail?.status ?? "",
    wallMs: Date.now() - t0,
    exitCode: detail?.status === "error" ? 1 : 0,
    timedOut: Date.now() > deadline,
    sessionId: session.id,
    stderrTail: server.log.slice(-1500),
  };
}

export { runProcess };
