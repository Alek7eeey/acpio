import https from "node:https";
import { spawn } from "node:child_process";
import type { McpServerConfig } from "@acpio/shared";
import {
  childProcessEnv,
  isMcpServerAttached,
  mcpHttpHeaders,
  mcpServerEndpoint,
  mcpStdioEnv,
  mcpStdioSpawn,
} from "@acpio/shared";
import { pluginMcpServers } from "./plugins.js";
import { appendDeepLog } from "./deepLogging.js";
import { ProcessTextDecoder } from "./processText.js";
import { getSettings } from "./settings.js";

const OK_TTL_MS = 30_000;
/** Failed probes expire fast so a temporarily-down server turns green shortly after recovery. */
const FAIL_TTL_MS = 10_000;
const PROBE_TIMEOUT_MS = 6_000;

/** Why a probe failed — the short label the deep log carries. */
export type McpProbeResult = {
  ok: boolean;
  /** Short machine-readable label, e.g. `http-401`, `timeout`, `spawn-error`. */
  reason?: string;
  /** Human-readable detail (response body, stderr tail, error message). */
  detail?: string;
};

/** id → { ok, at } of the last probe, keyed by server id. */
const cache = new Map<string, { ok: boolean; at: number; reason?: string; detail?: string }>();
/** Last logged probe snapshot — identical rounds are not logged twice. */
let lastProbeLog = "";
/** One in-flight probe for the current config; concurrent callers share it. */
let inflight: Promise<Map<string, boolean>> | null = null;

function enabledServers(settings: Awaited<ReturnType<typeof getSettings>>) {
  // Plugin servers are ordinary configs with a url on this same port, so the
  // same probe answers for them.
  return [...(settings.mcpServers ?? []), ...pluginMcpServers(settings)].filter(isMcpServerAttached);
}

function looksLikeInitializeResult(text: string): boolean {
  return text.includes("jsonrpc") && (text.includes("result") || text.includes("protocolVersion"));
}

const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "acpio", version: "0.1.0" },
  },
});

/**
 * Probe a single MCP-over-HTTP endpoint with a real JSON-RPC initialize.
 * A 2xx plus a "jsonrpc" payload (JSON or SSE) means the server is alive.
 */
async function probeHttp(s: McpServerConfig): Promise<McpProbeResult> {
  const url = s.url?.trim();
  if (!url) return { ok: false, reason: "no-url" };
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, PROBE_TIMEOUT_MS);
  const fail = (reason: string, detail?: string): McpProbeResult => ({ ok: false, reason, detail });
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    for (const row of mcpHttpHeaders(s)) {
      headers[row.name.toLowerCase()] = row.value;
    }
    const insecure = s.insecureTls && url.startsWith("https://");
    // Node's fetch cannot disable cert verification per request; use the
    // https module for self-signed / internal-CA endpoints.
    const res = insecure
      ? await probeHttpsInsecure(url, headers, INIT_BODY, controller.signal)
      : await fetch(url, { method: "POST", headers, body: INIT_BODY, signal: controller.signal })
          .then(async (r) => ({ status: r.status, text: await r.text().catch(() => "") }))
          .catch((err: unknown): { status: number; text: string } => {
            throw err;
          });
    if (res.status >= 400) return fail(`http-${res.status}`, res.text.slice(0, 300) || undefined);
    if (!looksLikeInitializeResult(res.text)) {
      return fail("unexpected-payload", res.text.slice(0, 300) || undefined);
    }
    return { ok: true };
  } catch (err) {
    if (timedOut) return fail("timeout", `no answer within ${PROBE_TIMEOUT_MS}ms`);
    return fail("request-error", errorText(err));
  } finally {
    clearTimeout(timer);
  }
}

/** Spawn a stdio MCP and send initialize; success if stdout carries a JSON-RPC result. */
export async function probeStdio(s: McpServerConfig): Promise<boolean> {
  return (await probeStdioDetailed(s)).ok;
}

/** {@link probeStdio} plus the reason it failed (deep-log diagnostics). */
export function probeStdioDetailed(s: McpServerConfig): Promise<McpProbeResult> {
  const command = s.command?.trim();
  if (!command) return Promise.resolve({ ok: false, reason: "no-command" });
  const args = s.args ?? [];
  const extraEnv = Object.fromEntries(mcpStdioEnv(s).map((row) => [row.name, row.value]));
  // Same launch rule the agents use — a probe that cannot start the `.cmd` shim
  // would report a working server as dead.
  const launch = mcpStdioSpawn(command, args);

  return new Promise((resolve) => {
    let settled = false;
    // Decoded as the bytes arrive: Windows shims answer in OEM CP866, and a
    // JSON frame may be split across chunks.
    const outText = new ProcessTextDecoder();
    const errText = new ProcessTextDecoder();
    let stdoutText = "";
    let stderrText = "";
    const finish = (result: McpProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      if (result.ok) return resolve(result);
      // The child's own last words explain more than the exit code (a missing
      // shim says "not recognized"), so both go into the detail.
      const output = stderrText.trim().slice(-400) || stdoutText.trim().slice(-400);
      const detail = [result.detail, output].filter(Boolean).join(" | ") || undefined;
      resolve(detail ? { ...result, detail } : result);
    };

    const child = spawn(launch.command, launch.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...childProcessEnv(), ...extraEnv },
      windowsHide: true,
      shell: launch.shell,
    });
    const timer = setTimeout(
      () => finish({ ok: false, reason: "timeout", detail: `no initialize answer within ${PROBE_TIMEOUT_MS}ms` }),
      PROBE_TIMEOUT_MS,
    );
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrText += errText.decode(Buffer.from(chunk));
    });
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdoutText += outText.decode(Buffer.from(chunk));
      if (looksLikeInitializeResult(stdoutText)) finish({ ok: true });
    });
    child.on("error", (err) =>
      finish({ ok: false, reason: "spawn-error", detail: errorText(err) }),
    );
    child.on("exit", (code, signal) =>
      finish({
        ok: false,
        reason: "exited",
        detail: `exit code=${code ?? "null"} signal=${signal ?? "-"}`,
      }),
    );
    try {
      child.stdin?.write(`${INIT_BODY}\n`);
    } catch (err) {
      finish({ ok: false, reason: "stdin-error", detail: errorText(err) });
    }
  });
}

async function probeOne(s: McpServerConfig): Promise<McpProbeResult> {
  if (s.type === "stdio") return probeStdioDetailed(s);
  return probeHttp(s);
}

function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/** Raw https POST with TLS verification disabled (probe-only). */
function probeHttpsInsecure(
  url: string,
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: "POST",
        headers,
        rejectUnauthorized: false,
        signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Deep-log one probe round. The settings list says a server is on and the UI
 * still shows it, so the only trace of "the endpoint is dead" is the probe
 * itself — logged once per distinct outcome to keep the JSONL readable.
 */
function logProbeRound(rows: Array<Record<string, unknown>>) {
  const sorted = [...rows].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const key = JSON.stringify(sorted.map((r) => [r.name, r.ok, r.reason ?? null]));
  if (key === lastProbeLog) return;
  lastProbeLog = key;
  const failed = sorted.filter((r) => !r.ok).length;
  appendDeepLog({
    kind: "mcp-probe",
    data: { total: sorted.length, failed, servers: sorted },
  });
}

/** Probe the currently enabled MCP servers; returns id → ok. */
export async function refreshMcpStatus(): Promise<Record<string, boolean>> {
  const settings = await getSettings();
  const servers = enabledServers(settings);
  if (!servers.length) {
    cache.clear();
    lastProbeLog = "";
    return {};
  }
  if (!inflight) {
    inflight = (async () => {
      const out = new Map<string, boolean>();
      const rows: Array<Record<string, unknown>> = [];
      await Promise.all(
        servers.map(async (s) => {
          const started = Date.now();
          const probe = await probeOne(s);
          out.set(s.id, probe.ok);
          cache.set(s.id, { ok: probe.ok, at: Date.now(), reason: probe.reason, detail: probe.detail });
          rows.push({
            id: s.id,
            name: s.name,
            type: s.type,
            endpoint: mcpServerEndpoint(s),
            ok: probe.ok,
            ms: Date.now() - started,
            ...(probe.reason ? { reason: probe.reason } : {}),
            ...(probe.detail ? { detail: probe.detail } : {}),
          });
        }),
      );
      logProbeRound(rows);
      return out;
    })().finally(() => {
      inflight = null;
    });
  }
  const fresh = await inflight;
  const result: Record<string, boolean> = {};
  for (const s of servers) {
    result[s.id] = fresh.get(s.id) ?? cache.get(s.id)?.ok ?? false;
  }
  return result;
}

/** Live status for every enabled server, using the cache when it is fresh. */
export async function getMcpStatus(): Promise<Record<string, boolean>> {
  const settings = await getSettings();
  const servers = enabledServers(settings);
  const now = Date.now();
  const result: Record<string, boolean> = {};
  let stale = false;
  for (const s of servers) {
    const c = cache.get(s.id);
    const ttl = c?.ok ? OK_TTL_MS : FAIL_TTL_MS;
    if (c && now - c.at < ttl) {
      result[s.id] = c.ok;
    } else {
      stale = true;
    }
  }
  if (stale || !servers.length) {
    const fresh = await refreshMcpStatus();
    Object.assign(result, fresh);
  }
  return result;
}
