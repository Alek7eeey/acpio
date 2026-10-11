import {
  type HarnessAdapter,
  type SubagentProgressUpdate,
  type SubagentToolEvent,
} from "@acpio/shared";

/**
 * OpenCode harness: ACP over the `opencode acp` server. Session restore is a
 * silent resume (`session/resume`); models and their config come back as ACP
 * `configOptions`. Child (subagent) sessions stream in as
 * `opencode/session/child_update` notifications — the core only sees them
 * because `initializeMeta` opts into `opencode/child-session-updates`
 * (`clientCapabilities._meta`), which keeps the child stream off the root
 * `session/update` channel.
 */

/** `type: "status"` frame status → card status. */
function childCardStatus(status: string): SubagentProgressUpdate["status"] {
  if (status === "completed") return "completed";
  if (status === "created" || status === "running") return "running";
  return "failed";
}

/** Plain text of an ACP content block, chunk or content array. */
function chunkText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.map(chunkText).filter(Boolean).join(" ").trim();
  if (content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (typeof c.text === "string") return c.text.trim();
    if (c.content !== undefined) return chunkText(c.content);
  }
  return "";
}

/** Tool arguments as a short display string. */
function argsText(raw: unknown): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  try {
    return JSON.stringify(raw);
  } catch {
    return "";
  }
}

/**
 * Map one `opencode/session/child_update` notification to a card upsert.
 * Frames: `type: "status"` owns the lifecycle (`created`/`running` → running,
 * `completed` → completed, anything else failed); `type: "update"` carries the
 * child's live stream (message/thought chunks, nested tool calls). Chunks with
 * nothing to show are skipped so usage/config noise never touches the card.
 */
export function opencodeCardFromProgress(
  entry: Record<string, unknown>,
): SubagentProgressUpdate | null {
  const agentId = String(entry.childSessionId ?? "").trim();
  if (!agentId) return null;
  const title = String(entry.title ?? "").trim() || "Subagent";

  const type = String(entry.type ?? "");
  let status: SubagentProgressUpdate["status"];
  const body: string[] = [];
  const tools: SubagentToolEvent[] = [];

  if (type === "status") {
    status = childCardStatus(String(entry.status ?? ""));
  } else if (type === "update") {
    status = "running";
    const update = (
      entry.update && typeof entry.update === "object" ? entry.update : {}
    ) as Record<string, unknown>;
    const kind = String(update.sessionUpdate ?? "");
    if (kind === "tool_call" || kind === "tool_call_update") {
      const rawStatus = String(update.status ?? "");
      const args = argsText(update.rawInput ?? update.input ?? update.arguments);
      tools.push({
        name: String(update.name ?? update.toolName ?? update.title ?? "tool"),
        ...(args ? { args: args.slice(0, 200) } : {}),
        status:
          rawStatus === "completed"
            ? "completed"
            : rawStatus === "failed"
              ? "failed"
              : "running",
      });
      const text = chunkText(update.content);
      if (text) body.push(text.slice(0, 300));
    } else if (kind === "tool_call_content_chunk") {
      const text = chunkText(update.content);
      if (text) body.push(text.slice(0, 300));
      else return null;
    } else if (
      kind === "agent_message_chunk" ||
      kind === "agent_message" ||
      kind === "user_message_chunk" ||
      kind === "user_message" ||
      kind === "agent_thought_chunk" ||
      kind === "agent_thought" ||
      kind === "reasoning" ||
      kind === "reasoning_chunk" ||
      kind === "message"
    ) {
      const text = chunkText(update.content);
      if (text) body.push(text.slice(0, 300));
      else return null;
    } else {
      return null;
    }
  } else {
    return null;
  }

  return {
    agentId,
    status,
    title,
    description: title,
    ...(body.length ? { body: body.join("\n") } : {}),
    ...(tools.length ? { tools } : {}),
    raw: entry,
  };
}

export const opencodeAdapter: HarnessAdapter = {
  id: "opencode",
  label: "OpenCode",
  descriptionKey: "settings.opencodeDesc",

  commandField: "opencodeCommand",
  argsField: "opencodeArgs",
  defaultCommand: "opencode",
  defaultArgs: ["acp"],
  binaryNames: ["opencode"],
  // npm's global shim lives in %APPDATA%\npm, which resolveCommand already
  // searches — no extra dirs.
  binaryDirs: [],
  installHint:
    'Команда "{command}" не найдена. Установите opencode (npm i -g opencode-ai) ' +
    "и проверьте PATH — или укажите полный путь в «CLI и права».",

  restoreMode: "resume",
  suppressReplayOnLoad: false,
  // No `authenticate`: opencode keeps credentials in `opencode auth login`,
  // and a boot-time authenticate could block on an interactive wizard.

  parameterizedModelPicker: false,
  subagentStreaming: false,
  cloudCatalog: true,
  defaultModes: [],
  // The parent spawn call arrives as a tool called "subagent" (kind "think").
  subagentToolKinds: ["subagent"],

  // Child-session streaming is opt-in per client.
  initializeMeta: { "opencode/child-session-updates": true },

  requestKinds: {
    "session/request_permission": "permission",
    "session/ask_question": "ask_question",
  },
  extensionKinds: {
    "opencode/session/child_update": "subagent_progress",
  },
  subagentCardFromProgress: opencodeCardFromProgress,
};
