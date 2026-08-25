import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { toolCallIdVariants } from "@acpio/shared";

export type CursorStoreEnrichment = {
  description?: string;
  prompt?: string;
  agentId?: string;
  result?: string;
  thinking?: string[];
  status?: "running" | "completed" | "failed";
};

const AGENT_ID_RE =
  /Agent ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const UUID_RE =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function blobText(data: unknown): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return Buffer.from(data).toString("utf8");
  return "";
}

/** Best-effort JSON object that mentions `toolCallId` inside a (possibly binary) blob. */
function parseJsonNearToolCall(text: string, toolCallId: string): Record<string, unknown> | null {
  if (!text.includes(toolCallId)) return null;
  const markers = ['{"role"', '{"id"', '{"type"'];
  for (const marker of markers) {
    let idx = text.indexOf(marker);
    while (idx >= 0) {
      const slice = text.slice(idx);
      if (!slice.includes(toolCallId)) {
        idx = text.indexOf(marker, idx + 1);
        continue;
      }
      try {
        return JSON.parse(slice) as Record<string, unknown>;
      } catch {
        // Truncate at last } and retry once (blob may have trailing noise).
        const end = slice.lastIndexOf("}");
        if (end > 0) {
          try {
            return JSON.parse(slice.slice(0, end + 1)) as Record<string, unknown>;
          } catch {
            /* continue */
          }
        }
      }
      idx = text.indexOf(marker, idx + 1);
    }
  }
  return null;
}

function thinkingFromSteps(steps: unknown): string[] {
  if (!Array.isArray(steps)) return [];
  const out: string[] = [];
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const s = step as Record<string, unknown>;
    const assistant = (s.assistantMessage ?? s.message) as Record<string, unknown> | undefined;
    const text = String(assistant?.text ?? s.text ?? "").trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function mergeEnrichment(into: CursorStoreEnrichment, patch: CursorStoreEnrichment): void {
  if (patch.description && !into.description) into.description = patch.description;
  if (patch.prompt && !into.prompt) into.prompt = patch.prompt;
  if (patch.agentId && !into.agentId) into.agentId = patch.agentId;
  if (patch.result) into.result = patch.result;
  if (patch.status) into.status = patch.status;
  if (patch.thinking?.length) {
    const merged = into.thinking ?? [];
    for (const block of patch.thinking) {
      if (!merged.includes(block)) merged.push(block);
    }
    into.thinking = merged;
  }
}

function enrichmentFromToolContent(
  content: unknown,
  toolCallId: string,
): CursorStoreEnrichment {
  const out: CursorStoreEnrichment = {};
  if (!Array.isArray(content)) return out;
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    const id = String(block.toolCallId ?? "");
    if (id && id !== toolCallId && !toolCallId.endsWith(id) && !id.endsWith(toolCallId)) {
      continue;
    }
    if (String(block.toolName ?? "") !== "Task" && block.toolName != null) continue;

    const args = (block.args ?? block.input ?? block.arguments) as Record<string, unknown> | undefined;
    if (args) {
      const desc = String(args.description ?? args.title ?? "").trim();
      const prompt = String(args.prompt ?? "").trim();
      if (desc) out.description = desc;
      if (prompt) out.prompt = prompt;
    }

    if (typeof block.result === "string" && block.result.trim()) {
      out.result = block.result.trim();
      const m = out.result.match(AGENT_ID_RE);
      if (m) out.agentId = m[1];
      if (/subagent is running in the background/i.test(out.result)) {
        out.status = "running";
      }
    }
  }
  return out;
}

function enrichmentFromProviderOptions(obj: Record<string, unknown>): CursorStoreEnrichment {
  const out: CursorStoreEnrichment = {};
  const hl =
    (obj.providerOptions as Record<string, unknown> | undefined)?.cursor as
      | Record<string, unknown>
      | undefined;
  const rich = hl?.highLevelToolCallResult as Record<string, unknown> | undefined;
  if (!rich) return out;
  const output = (rich.output ?? rich) as Record<string, unknown>;
  const success = (output.success ?? output) as Record<string, unknown>;
  if (typeof success.agentId === "string" && success.agentId.trim()) {
    out.agentId = success.agentId.trim();
  }
  const steps = thinkingFromSteps(success.conversationSteps);
  if (steps.length) out.thinking = steps;
  if (success.isBackground === true) out.status = "running";
  if (typeof success.durationMs === "number" && success.isBackground !== true) {
    out.status = "completed";
  }
  return out;
}

/**
 * Read Cursor `store.db` for one Task toolCallId. Returns null when the session
 * DB is missing or the call has not been flushed yet.
 */
export function enrichCursorToolFromStore(
  acpSessionId: string | null | undefined,
  toolCallId: string,
): CursorStoreEnrichment | null {
  const sessionId = String(acpSessionId ?? "").trim();
  const variants = toolCallIdVariants(toolCallId);
  if (!sessionId || !variants.length) return null;

  const dbPath = path.join(os.homedir(), ".cursor", "acp-sessions", sessionId, "store.db");
  if (!fs.existsSync(dbPath)) return null;

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }

  const out: CursorStoreEnrichment = {};
  try {
    const rows = db.prepare("SELECT data FROM blobs").all() as Array<{ data: unknown }>;
    for (const callId of variants) {
      for (const row of rows) {
        const text = blobText(row.data);
        if (!text.includes(callId)) continue;

        const agentMatch = text.match(AGENT_ID_RE);
        if (agentMatch) mergeEnrichment(out, { agentId: agentMatch[1], status: "running" });

        const obj = parseJsonNearToolCall(text, callId);
        if (!obj) {
          if (!out.description) {
            const around = text.slice(
              Math.max(0, text.indexOf(callId) - 400),
              text.indexOf(callId) + callId.length + 80,
            );
            const titled = around.match(
              /(?:^|[\x00\n])([A-Za-zА-Яа-яЁё0-9][^\\x00\n]{2,60})[\x00\n]/m,
            );
            if (titled?.[1] && !/tool_|composer-|Agent ID/i.test(titled[1])) {
              out.description = titled[1].trim();
            }
          }
          continue;
        }

        mergeEnrichment(out, enrichmentFromToolContent(obj.content, callId));
        mergeEnrichment(out, enrichmentFromProviderOptions(obj));
      }
      if (out.agentId && out.description) break;
    }
  } catch {
    return Object.keys(out).length ? out : null;
  } finally {
    db.close();
  }

  return Object.keys(out).length ? out : null;
}

/** Pull an Agent ID out of arbitrary tool update text/result. */
export function agentIdFromToolText(text: string): string | undefined {
  const m = text.match(AGENT_ID_RE);
  return m?.[1];
}
