import {
  normalizeToolCallId,
  subagentFieldsFromRaw,
  type HarnessAdapter,
  type SubagentCardUpdate,
} from "@acprocess/shared";
import { readCursorAgentTranscript } from "./localTranscript.js";

export {
  cursorProjectSlugs,
  findCursorAgentTranscript,
  findRecentCursorAgentId,
  findRecentCursorAgentIds,
} from "./localTranscript.js";

/** Map a `cursor/task` request to a normalized subagent card. */
function cursorTaskCard(
  params: Record<string, unknown>,
): { toolCallId?: string; card: SubagentCardUpdate } | null {
  const toolCallId = normalizeToolCallId(
    params.tool_call_id ?? params.toolCallId ?? params.toolCallID ?? "",
  );
  const realAgentId = String(params.agentId ?? params.agent_id ?? "").trim();
  const extra = subagentFieldsFromRaw(params);
  const title = String(
    params.title ?? params.description ?? params.name ?? params.subtitle ?? extra.title ?? "",
  ).trim();
  const status = String(params.status ?? "").trim().toLowerCase();
  const rawType = params.subagent_type ?? params.subagentType ?? params.kind ?? params.type;
  const subagentType =
    typeof rawType === "string"
      ? rawType.trim()
      : rawType && typeof rawType === "object"
        ? String((rawType as { custom?: string }).custom ?? "task")
        : "";
  const resultText = String(extra.result ?? "").trim();
  const backgroundRunning = /subagent is running in the background/i.test(resultText);
  const hasDuration = typeof params.durationMs === "number" || typeof params.duration_ms === "number";
  const terminal =
    status === "failed" ||
    status === "error" ||
    status === "completed" ||
    status === "cancelled" ||
    status === "canceled" ||
    (hasDuration && !backgroundRunning) ||
    (Boolean(resultText) && !backgroundRunning && status !== "running" && status !== "in_progress");

  return {
    ...(toolCallId ? { toolCallId } : {}),
    card: {
      // Prefer the real subagent UUID so transcript polling can resolve JSONL.
      agentId: realAgentId || toolCallId || title || "task",
      status:
        status === "failed" || status === "error"
          ? "failed"
          : terminal && status !== "running" && status !== "in_progress"
            ? "completed"
            : "running",
      title: title || "Subagent",
      description: title || "Subagent",
      ...(extra.result && !backgroundRunning ? { body: extra.result } : {}),
      ...(subagentType ? { subagentType } : {}),
      raw: params,
    },
  };
}

/** Cursor ACP tool `kind` values that denote a nested agent invocation. */
const SUBAGENT_TOOL_KINDS = [
  "task",
  "subagent",
  "explore",
  "browser",
  "generalPurpose",
  "ci-investigator",
  "bugbot",
  "security-review",
  "best-of-n",
] as const;

/** Reply envelope for Cursor extension requests (`outcome`). */
function cursorExtensionReply(method: string, params: Record<string, unknown>): unknown {
  if (method === "cursor/task") {
    return {
      outcome: {
        outcome: "completed",
        ...(typeof params.agentId === "string" ? { agentId: params.agentId } : {}),
        ...(typeof params.durationMs === "number" ? { durationMs: params.durationMs } : {}),
      },
    };
  }
  if (method === "cursor/update_todos") {
    const todos = Array.isArray(params.todos) ? params.todos : [];
    return { outcome: { outcome: "accepted", todos } };
  }
  // cursor/generate_image
  const filePath = typeof params.filePath === "string" ? params.filePath : "";
  return filePath
    ? { outcome: { outcome: "generated", filePath } }
    : { outcome: { outcome: "rejected", reason: "missing filePath" } };
}

/**
 * Cursor harness: ACP over the `cursor-agent` CLI. Session restore replays the
 * stored conversation (`session/load`), which the core swallows; subagent work
 * arrives as `cursor/task` requests with `outcome` reply envelopes.
 * Live Task progress is not on the ACP stream — we poll local agent transcripts.
 */
export const cursorAdapter: HarnessAdapter = {
  id: "cursor",
  label: "Cursor",
  descriptionKey: "settings.cursorDesc",

  commandField: "cursorCommand",
  argsField: "cursorArgs",
  apiKeyField: "cursorApiKey",
  envApiKeyName: "CURSOR_API_KEY",
  defaultCommand: "agent",
  defaultArgs: ["acp"],
  binaryNames: ["agent", "cursor-agent"],
  binaryDirs: ["cursor-agent", "omp"],
  installHint:
    "Команда \"{command}\" не найдена. Cursor IDE ≠ Cursor CLI. " +
    "Установите CLI (PowerShell): irm 'https://cursor.com/install?win32=true' | iex " +
    "затем выполните agent login. Или укажите полный путь в «CLI и права».",

  restoreMode: "load",
  suppressReplayOnLoad: true,
  authenticateMethodId: "cursor_login",

  parameterizedModelPicker: true,
  // Live cards come from ~/.cursor/projects/.../agent-transcripts (not ACP RPC).
  subagentStreaming: true,
  cloudCatalog: false,
  defaultModes: [
    { value: "agent", name: "Agent" },
    { value: "plan", name: "Plan" },
    { value: "ask", name: "Ask" },
  ],
  subagentToolKinds: SUBAGENT_TOOL_KINDS,

  requestKinds: {
    "session/request_permission": "permission",
    "cursor/ask_question": "ask_question",
    "cursor/create_plan": "create_plan",
  },
  extensionKinds: {
    "cursor/task": "subagent_task",
    "cursor/update_todos": "todos",
    "cursor/generate_image": "image",
  },
  extensionReply: cursorExtensionReply,
  subagentTaskCard: cursorTaskCard,
  readSubagentTranscript: readCursorAgentTranscript,
};
