import fs from "node:fs/promises";
import path from "node:path";
import type { AppSettings } from "@acpio/shared";
import { resolveDiagnosticsDir } from "./diagnostics.js";

export type DeepLogContext = {
  sessionId?: string;
  provider?: string;
  cwd?: string;
  model?: string;
};

export type DeepLogEntry = DeepLogContext & {
  kind: string;
  direction?: "in" | "out";
  method?: string;
  data?: unknown;
};

const REDACT_KEY = /apikey|secret|token|password|authorization|cookie/i;
const MAX_STRING = 20_000;

let enabled = false;
let writeChain = Promise.resolve();

export function syncDeepLoggingFromSettings(settings: AppSettings) {
  enabled = Boolean(settings.diagnosticsDeepLogging);
}

export function isDeepLoggingEnabled() {
  return enabled;
}

export function sanitizeDeepLogValue(value: unknown, depth = 0): unknown {
  if (depth > 10) return "[max-depth]";
  if (value == null) return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDeepLogValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACT_KEY.test(key) ? "[redacted]" : sanitizeDeepLogValue(val, depth + 1);
    }
    return out;
  }
  return String(value);
}

export function appendDeepLog(entry: DeepLogEntry) {
  if (!enabled) return;
  const payload = {
    ts: new Date().toISOString(),
    ...entry,
    data: entry.data === undefined ? undefined : sanitizeDeepLogValue(entry.data),
  };
  writeChain = writeChain
    .then(async () => {
      const dir = await resolveDiagnosticsDir();
      await fs.mkdir(dir, { recursive: true });
      const day = payload.ts.slice(0, 10);
      const filePath = path.join(dir, `acpio-deep-${day}.jsonl`);
      await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf8");
    })
    .catch(() => {
      /* logging must never break the agent */
    });
}

export function rpcMethod(msg: unknown): string | undefined {
  if (!msg || typeof msg !== "object") return undefined;
  const method = (msg as Record<string, unknown>).method;
  return typeof method === "string" ? method : undefined;
}
