import type { McpServerConfig } from "@acprocess/shared";
import { mcpHttpHeaders } from "@acprocess/shared";
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
  return (settings.mcpServers ?? []).filter((s) => s.enabled && s.url?.trim());
}

/**
 * Probe a single MCP-over-HTTP endpoint with a real JSON-RPC initialize.
 * A 2xx plus a "jsonrpc" payload (JSON or SSE) means the server is alive.
 */
async function probeOne(s: McpServerConfig): Promise<boolean> {
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
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "acprocess", version: "0.1.0" },
          },
        }),
        signal: controller.signal,
      });
      if (!res.ok) return false;
      const text = await res.text();
      return text.includes("jsonrpc") && text.includes("result");
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
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
