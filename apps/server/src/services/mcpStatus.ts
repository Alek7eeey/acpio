import https from "node:https";
import { spawn } from "node:child_process";
import type { McpServerConfig } from "@acpio/shared";
import { isMcpServerAttached, mcpHttpHeaders, mcpStdioEnv } from "@acpio/shared";
import { getSettings } from "./settings.js";

const OK_TTL_MS = 30_000;
/** Failed probes expire fast so a temporarily-down server turns green shortly after recovery. */
const FAIL_TTL_MS = 10_000;
const PROBE_TIMEOUT_MS = 6_000;

/** id → { ok, at } of the last probe, keyed by server id. */
const cache = new Map<string, { ok: boolean; at: number }>();
/** One in-flight probe for the current config; concurrent callers share it. */
let inflight: Promise<Map<string, boolean>> | null = null;

function enabledServers(settings: Awaited<ReturnType<typeof getSettings>>) {
  return (settings.mcpServers ?? []).filter(isMcpServerAttached);
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
async function probeHttp(s: McpServerConfig): Promise<boolean> {
  const url = s.url?.trim();
  if (!url) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    for (const row of mcpHttpHeaders(s)) {
      headers[row.name.toLowerCase()] = row.value;
    }
    try {
      if (s.insecureTls && url.startsWith("https://")) {
        // Node's fetch cannot disable cert verification per request; use the
        // https module for self-signed / internal-CA endpoints.
        const text = await probeHttpsInsecure(url, headers, INIT_BODY, controller.signal);
        return looksLikeInitializeResult(text);
      }
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: INIT_BODY,
        signal: controller.signal,
      });
      if (!res.ok) return false;
      const text = await res.text();
      return looksLikeInitializeResult(text);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/** Spawn a stdio MCP and send initialize; success if stdout carries a JSON-RPC result. */
export function probeStdio(s: McpServerConfig): Promise<boolean> {
  const command = s.command?.trim();
  if (!command) return Promise.resolve(false);
  const args = s.args ?? [];
  const extraEnv = Object.fromEntries(mcpStdioEnv(s).map((row) => [row.name, row.value]));
  const winLooseCmd =
    process.platform === "win32" &&
    !command.includes("/") &&
    !command.includes("\\") &&
    !/\.exe$/i.test(command);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve(ok);
    };

    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
      shell: winLooseCmd,
    });
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    let buf = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      buf += String(chunk);
      if (looksLikeInitializeResult(buf)) finish(true);
    });
    child.on("error", () => finish(false));
    child.on("exit", () => finish(false));
    try {
      child.stdin?.write(`${INIT_BODY}\n`);
    } catch {
      finish(false);
    }
  });
}

async function probeOne(s: McpServerConfig): Promise<boolean> {
  if (s.type === "stdio") return probeStdio(s);
  return probeHttp(s);
}

/** Raw https POST with TLS verification disabled (probe-only). */
function probeHttpsInsecure(
  url: string,
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal,
): Promise<string> {
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
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** Probe the currently enabled MCP servers; returns id → ok. */
export async function refreshMcpStatus(): Promise<Record<string, boolean>> {
  const settings = await getSettings();
  const servers = enabledServers(settings);
  if (!servers.length) {
    cache.clear();
    return {};
  }
  if (!inflight) {
    inflight = (async () => {
      const out = new Map<string, boolean>();
      await Promise.all(
        servers.map(async (s) => {
          const ok = await probeOne(s);
          out.set(s.id, ok);
          cache.set(s.id, { ok, at: Date.now() });
        }),
      );
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
