// Live probe: does compactMessages fire with a reduced contextWindow and a
// big history? Credentials come from bench/.cache/swe-provider.json (the
// same file the runners read) or PROBE_URL / PROBE_KEY env overrides.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const providerDefaults = () => {
  try {
    const p = JSON.parse(readFileSync(path.join(REPO, "bench", ".cache", "swe-provider.json"), "utf8"));
    return { url: p.url, key: p.key };
  } catch {
    return { url: process.env.PROBE_URL ?? "", key: process.env.PROBE_KEY ?? "" };
  }
};
const defaults = providerDefaults();
const stateDir = path.join(REPO, "tmp", "compact-probe-state");
rmSync(stateDir, { recursive: true, force: true });
mkdirSync(stateDir, { recursive: true });

const freePort = async () => {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
};

const port = await freePort();
const child = spawn(process.execPath, [path.join(REPO, "apps/server/dist/index.js")], {
  cwd: REPO,
  env: { ...process.env, PORT: String(port), DATABASE_PATH: path.join(stateDir, "acpio.db") },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
const stderrLines = [];
child.stderr.on("data", (d) => {
  for (const line of String(d).split("\n")) {
    if (line.trim()) stderrLines.push(line);
    if (/compacted|error|Error/i.test(line)) console.log("[server-stderr]", line.trim().slice(0, 300));
  }
});

const base = `http://127.0.0.1:${port}`;
const api = async (method, p, body) => {
  const res = await fetch(base + p, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text.slice(0, 200)}`);
  return json;
};

for (let i = 0; i < 100; i++) {
  try { await api("GET", "/api/health"); break; } catch { await new Promise((r) => setTimeout(r, 300)); }
}
console.log("server up on", port);

await api("PUT", "/api/settings", {
  locale: "en",
  defaultProvider: "builtin",
  defaultMode: "agent",
  permissionPolicy: "always",
  builtinProviders: [
    {
      id: "probe-upstream",
      name: "probe-upstream",
      url: process.env.PROBE_URL ?? defaults.url,
      apiKey: process.env.PROBE_KEY ?? defaults.key,
      headers: [{ name: "x-opencode-session", value: "probe-{{sessionId}}" }],
      models: [{ id: "space-bunny-free", label: "space-bunny-free", contextWindow: 14000, enabled: true }],
    },
  ],
});
const probe = await api("POST", "/api/agent/probe", { provider: "builtin" });
console.log("probe:", JSON.stringify(probe).slice(0, 120));

const ws = path.join(REPO, "tmp", "compact-probe-ws");
rmSync(ws, { recursive: true, force: true });
mkdirSync(ws, { recursive: true });
writeFileSync(path.join(ws, "note.txt"), "hello\n");

const session = await api("POST", "/api/sessions", { provider: "builtin", cwd: ws, mode: "agent" });
console.log("session:", session.id);

const waitIdle = async (deadlineMs) => {
  for (;;) {
    const d = await api("GET", `/api/sessions/${session.id}`);
    if (d.status !== "running") return d;
    if (Date.now() > deadlineMs) return d;
    await new Promise((r) => setTimeout(r, 500));
  }
};

await api("POST", `/api/sessions/${session.id}/prompt`, { text: "Reply with exactly: ok" });
let d = await waitIdle(Date.now() + 90_000);
console.log("turn1 status:", d.status, "messages:", (d.messages ?? []).length);

const big = "lorem ipsum dolor sit amet ".repeat(3200); // ~80KB -> estimate ~20k+ tokens
console.log("big prompt chars:", big.length, "-> rough estimate tokens:", Math.ceil(JSON.stringify({ role: "user", content: big }).length / 4));
await api("POST", `/api/sessions/${session.id}/prompt`, {
  text: "Here is a large document:\n\n" + big + "\n\nReply with exactly: ok2",
});
d = await waitIdle(Date.now() + 180_000);
console.log("turn2 status:", d.status, "messages:", (d.messages ?? []).length);

console.log("compaction markers in stderr:", stderrLines.filter((l) => /compacted/i.test(l)).length);
child.kill();
process.exit(0);
