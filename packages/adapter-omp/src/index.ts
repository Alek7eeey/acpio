import {
  modelDisplayName,
  type AdapterProbeContext,
  type AdapterTranscriptClient,
  type HarnessAdapter,
  type ModelOption,
  type SubagentCardUpdate,
  type SubagentProgressUpdate,
  type SubagentTranscriptPage,
} from "@acpio/shared";

/** Registry lifecycle status → card status the UI understands. */
function cardStatus(raw: string): SubagentCardUpdate["status"] {
  if (raw === "aborted") return "failed";
  if (raw === "running") return "running";
  return "completed";
}

/** Compact spend/metrics line for the card body. */
function metricsSummary(metrics: Record<string, unknown> | undefined): string[] {
  if (!metrics) return [];
  const parts: string[] = [];
  for (const key of ["tokens", "requests", "tools"] as const) {
    if (typeof metrics[key] === "number") parts.push(`${key}: ${metrics[key]}`);
  }
  if (typeof metrics.durationMs === "number") parts.push(`время: ${Math.round(metrics.durationMs / 1000)} с`);
  if (typeof metrics.cost === "number") parts.push(`стоимость: $${metrics.cost.toFixed(4)}`);
  return parts.length ? [`— ${parts.join(", ")} —`] : [];
}

/**
 * Map one `_omp/agents/update` roster entry to a normalized card update.
 * The roster is a process-global snapshot (includes parked/idle agents from
 * earlier turns) — the core only spawns cards for running agents.
 */
function ompCardFromRoster(entry: Record<string, unknown>): SubagentCardUpdate | null {
  if (entry.kind !== "sub") return null;
  const id = String(entry.id ?? "");
  if (!id) return null;
  const rawStatus = String(entry.status ?? "");
  const status = cardStatus(rawStatus);
  const activity = typeof entry.activity === "string" ? entry.activity.trim() : "";
  // Prefer Task `description` / intent name over generic displayName ("task").
  const name = String(entry.displayName ?? "");
  const title =
    (id && !/^(tool|task|scout|subagent|агент|субагент|main)$/i.test(id) ? id : "") ||
    (name && !/^(tool|task|scout|subagent|агент|субагент)$/i.test(name) ? name : "") ||
    id ||
    name ||
    "Subagent";
  const metrics =
    entry.metrics && typeof entry.metrics === "object"
      ? (entry.metrics as Record<string, unknown>)
      : undefined;
  const body: string[] = [];
  if (activity) body.push(activity);
  if (rawStatus === "running") body.push("статус: выполняется");
  body.push(...metricsSummary(metrics));
  return {
    agentId: id,
    ...(entry.parentId ? { parentId: String(entry.parentId) } : {}),
    status,
    title,
    description: activity || title,
    ...(entry.resolvedModel ? { resolvedModel: String(entry.resolvedModel) } : {}),
    ...(metrics ? { metrics } : {}),
    ...(body.length ? { body: body.join("\n\n") } : {}),
    raw: entry,
  };
}

/**
 * Map one `_omp/agents/progress` snapshot to a normalized card update:
 * current intent, active tool, recent output, and spend.
 */
function ompCardFromProgress(entry: Record<string, unknown>): SubagentProgressUpdate {
  const id = String(entry.id ?? "");
  const rawStatus = String(entry.status ?? "");
  const status: SubagentProgressUpdate["status"] =
    rawStatus === "completed"
      ? "completed"
      : rawStatus === "failed" || rawStatus === "aborted"
        ? "failed"
        : "running";
  const intent = typeof entry.lastIntent === "string" ? entry.lastIntent.trim() : "";
  const description = typeof entry.description === "string" ? entry.description.trim() : "";
  const title = description || intent || id;
  const lines: string[] = [];
  if (intent) lines.push(intent);
  const tool = typeof entry.currentTool === "string" ? entry.currentTool.trim() : "";
  const toolArgs = typeof entry.currentToolArgs === "string" ? entry.currentToolArgs.trim() : "";
  if (Array.isArray(entry.recentOutput)) {
    for (const line of entry.recentOutput.slice(0, 5)) {
      if (typeof line === "string" && line.trim()) lines.push(line.trim().slice(0, 300));
    }
  }
  const metrics: string[] = [];
  for (const key of ["toolCount", "requests", "tokens"] as const) {
    const value = entry[key];
    if (typeof value === "number") metrics.push(`${key === "toolCount" ? "tools" : key}: ${value}`);
  }
  if (typeof entry.durationMs === "number") metrics.push(`время: ${Math.round((entry.durationMs as number) / 1000)} с`);
  if (typeof entry.cost === "number") metrics.push(`стоимость: $${(entry.cost as number).toFixed(4)}`);
  if (metrics.length) lines.push(`— ${metrics.join(", ")} —`);
  return {
    agentId: id,
    status,
    title,
    description: title,
    ...(entry.resolvedModel ? { resolvedModel: String(entry.resolvedModel) } : {}),
    ...(lines.length ? { body: lines.join("\n\n") } : {}),
    ...(tool
      ? {
          tools: [
            {
              name: tool,
              ...(toolArgs ? { args: toolArgs.slice(0, 200) } : {}),
              status: status === "running" ? "running" : "completed",
            },
          ],
        }
      : {}),
    raw: entry,
  };
}

/** One incremental page of a subagent transcript via `_omp/agents/messages`. */
async function readOmpTranscript(
  client: AdapterTranscriptClient,
  agentId: string,
  fromByte: number,
): Promise<SubagentTranscriptPage | undefined> {
  const res = (await client.requestAgent<SubagentTranscriptPage | undefined>(
    "_omp/agents/messages",
    { agentId, fromByte },
  )) ?? {};
  return {
    fromByte: res.fromByte,
    nextByte: res.nextByte,
    reset: res.reset,
    messages: res.messages,
  };
}

/** `omp models --json` — broader cloud-backed catalog than the ACP list. */
async function probeOmpModels(ctx: AdapterProbeContext): Promise<ModelOption[] | null> {
  const stdout = await ctx.runCli(["models", "--json"]);
  const parsed = JSON.parse(stdout) as {
    models?: Array<{ selector?: string; provider?: string; id?: string; name?: string }>;
  };
  const rows = parsed.models ?? [];
  return rows
    .map((row) => {
      const value =
        row.selector?.trim() ||
        (row.provider && row.id ? `${row.provider}/${row.id}` : row.id?.trim() || "");
      if (!value) return null;
      return {
        value,
        name: row.name?.trim() || modelDisplayName(value),
      };
    })
    .filter((m): m is ModelOption => m != null);
}

/**
 * OMP harness: ACP over the `omp` CLI. Session restore is a silent context
 * resume (`session/resume`, no history replay); subagent work streams in via
 * `_omp/agents/*` notifications with live transcript polling.
 */
export {
  findOmpSessionFile,
  listOmpSessions,
  ompSessionsRoot,
  readOmpSessionTranscript,
} from "./localSessions.js";
export type { OmpSessionInfo, OmpSessionTranscript, OmpTranscriptTurn } from "./localSessions.js";

export const ompAdapter: HarnessAdapter = {
  id: "omp",
  label: "OMP",
  descriptionKey: "settings.ompDesc",

  commandField: "ompCommand",
  argsField: "ompArgs",
  defaultCommand: "omp",
  defaultArgs: ["acp"],
  binaryNames: ["omp", "omp-acp"],
  binaryDirs: ["omp"],
  installHint:
    "Команда \"{command}\" не найдена. Убедитесь, что omp в PATH " +
    "(или поставьте omp-acp и укажите его в «CLI и права»).",

  restoreMode: "resume",
  suppressReplayOnLoad: false,

  parameterizedModelPicker: false,
  subagentStreaming: true,
  cloudCatalog: true,
  defaultModes: [],
  subagentToolKinds: [],

  requestKinds: {
    "session/request_permission": "permission",
    // When omp-acp bridges OMP select/input/ask elicitation to ACP, register here.
    "session/ask_question": "ask_question",
  },
  extensionKinds: {
    "_omp/agents/update": "subagent_roster",
    "_omp/agents/progress": "subagent_progress",
  },
  subagentCardFromRoster: ompCardFromRoster,
  subagentCardFromProgress: ompCardFromProgress,
  readSubagentTranscript: readOmpTranscript,
  probeModels: probeOmpModels,
};
