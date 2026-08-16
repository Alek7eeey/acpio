import path from "node:path";
import { stat } from "node:fs/promises";
import {
  isModelAccessError,
  isSubagentToolCall,
  modelDisplayName,
  modelParamFamily,
  modelParamLabel,
  modelParamSectionName,
  parseModelWire,
  providerCommand,
  usesCloudModelCatalog,
  type AgentMode,
  type AgentProvider,
  type AppSettings,
  type McpServerConfig,
  type ModelParamDto,
  type SessionDetailDto,
} from "@acprocess/shared";
import { defaultSessionTitle, errorMessage, t } from "@acprocess/i18n";
import { getSettings, updateSettings } from "../services/settings.js";
import {
  appendPart,
  appendTextChunk,
  createMessage,
  getSessionDetail,
  replaceUserMessageText,
  truncateMessagesAfter,
  updatePart,
  updateSession,
} from "../services/sessions.js";
import { broadcastToSession } from "../services/wsHub.js";
import { reconcileModelCatalog } from "./cliModelCatalog.js";
import {
  AcpClient,
  findModeConfigOption,
  findModelConfigOption,
  isSwitchableModeList,
  listAgentModes,
  listModelParamOptions,
  type AcpRequest,
  type ConfigOption,
} from "./AcpClient.js";

/** Map agent-reported mode ids onto our Agent / Plan / Ask switcher. */
export function coerceUiMode(raw: string): AgentMode | null {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v) return null;
  if (v === "agent" || v === "plan" || v === "ask") return v;
  if (v === "code" || v === "edit" || v === "default" || v === "normal") return "agent";
  if (v === "architect") return "plan";
  if (v === "chat" || v === "readonly" || v === "read-only" || v === "read") return "ask";
  return null;
}

async function applyAgentReportedMode(rt: SessionRuntime, rawModeId: string) {
  const mode = coerceUiMode(rawModeId);
  if (!mode) return;
  rt.client?.applyReportedMode(mode);
  const detail = await getSessionDetail(rt.sessionId);
  if (detail?.mode === mode) return;
  await updateSettings({ defaultMode: mode });
  await updateSession(rt.sessionId, { mode });
}

export function textFromUnknown(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
      (trimmed.startsWith("{") && trimmed.endsWith("}"))
    ) {
      try {
        return textFromUnknown(JSON.parse(trimmed));
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => textFromUnknown(item))
      .filter(Boolean)
      .join("\n\n");
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.prompt === "string") return obj.prompt;
    if (typeof obj.output === "string") return obj.output;
    if (obj.content !== undefined) return textFromUnknown(obj.content);
    if (obj.result !== undefined) return textFromUnknown(obj.result);
  }
  return "";
}

export function subagentFieldsFromRaw(raw: Record<string, unknown>) {
  const prompt =
    textFromUnknown(raw.prompt) ||
    textFromUnknown((raw.rawInput as Record<string, unknown> | undefined)?.prompt) ||
    textFromUnknown((raw.arguments as Record<string, unknown> | undefined)?.prompt) ||
    textFromUnknown((raw.input as Record<string, unknown> | undefined)?.prompt);
  const result = textFromUnknown(raw.result) || textFromUnknown(raw.content);
  const titled = String(raw.title ?? raw.description ?? raw.name ?? raw.label ?? "").trim();
  const fromBody =
    result.match(/^###\s+([^\n\[]+?)(?:\s*\[|$)/m)?.[1]?.trim() ||
    result.match(/^\s*Label:\s*(.+)$/m)?.[1]?.trim() ||
    result.match(/<task-result\b[^>]*\bid="([^"]+)"/i)?.[1]?.trim() ||
    "";
  const niceTitle = [titled, fromBody].find((v) => v && !/^(tool|task|subagent|субагент)$/i.test(v));
  return {
    ...(prompt ? { prompt } : {}),
    ...(result ? { result } : {}),
    ...(niceTitle ? { title: niceTitle, description: niceTitle } : {}),
  };
}

function toModelParams(options: ConfigOption[]): ModelParamDto[] {
  const params = listModelParamOptions(options).map((o) => ({
    id: o.id,
    name: modelParamSectionName(o.id, o.name),
    currentValue: o.currentValue,
    options:
      o.options && o.options.length
        ? o.options.map((opt) => ({
            value: opt.value,
            name: modelParamLabel(o.id, opt.value, opt.name),
          }))
        : o.type === "boolean"
          ? [
              { value: "false", name: modelParamLabel(o.id, "false") },
              { value: "true", name: modelParamLabel(o.id, "true") },
            ]
          : [],
  }));

  // Prefer a stable Fast → Effort → Context order in the picker.
  const rank = (id: string) => {
    const family = modelParamFamily(id);
    if (family === "fast") return 0;
    if (family === "effort") return 1;
    if (family === "context") return 2;
    return 50;
  };
  params.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  return params;
}

type ModelOption = { value: string; name: string };
type ModeOption = { value: string; name: string };

function toModelList(options: ConfigOption[]): ModelOption[] {
  const modelOpt = findModelConfigOption(options);
  return (modelOpt?.options ?? []).map((o) => ({
    value: o.value,
    name: modelDisplayName(o.value, o.name),
  }));
}

function toModesList(options: ConfigOption[], provider: AgentProvider, sessionModes?: Array<{ value: string; name: string }>): ModeOption[] {
  const modes = listAgentModes(options, provider, sessionModes);
  // Hide non-switchable lists (OMP's lone "default") from the client catalog.
  return isSwitchableModeList(modes) ? modes : [];
}

const deniedModelsByProvider = new Map<AgentProvider, Set<string>>();

function filterDeniedModels(provider: AgentProvider, models: ModelOption[]): ModelOption[] {
  const denied = deniedModelsByProvider.get(provider);
  if (!denied?.size) return models;
  return models.filter((m) => !denied.has(m.value));
}

function denyModel(provider: AgentProvider, model: string) {
  let denied = deniedModelsByProvider.get(provider);
  if (!denied) {
    denied = new Set();
    deniedModelsByProvider.set(provider, denied);
  }
  if (denied.has(model)) return;
  denied.add(model);
  if (modelsCache?.provider === provider) {
    const models = filterDeniedModels(provider, modelsCache.models);
    const currentModel =
      modelsCache.currentModel && !denied.has(modelsCache.currentModel)
        ? modelsCache.currentModel
        : models[0]?.value;
    rememberModels(provider, currentModel, models, modelsCache.modelParams, modelsCache.modes);
  }
}

function modelsCacheTtlMs(provider: AgentProvider): number {
  return usesCloudModelCatalog(provider) ? 2 * 60_000 : 24 * 60_000;
}

async function finalizeModelList(
  provider: AgentProvider,
  settings: Awaited<ReturnType<typeof getSettings>>,
  acpModels: ModelOption[],
): Promise<ModelOption[]> {
  const reconciled = await reconcileModelCatalog(provider, settings, acpModels);
  return filterDeniedModels(provider, reconciled);
}

function pickCurrentModel(
  models: ModelOption[],
  preferred?: string,
): string | undefined {
  if (preferred && models.some((m) => m.value === preferred)) return preferred;
  return models[0]?.value;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  kind: AcpRequest["kind"];
  /** Original JSON-RPC id from the agent (number | string) — do not re-parse from the URL key. */
  rpcId: string | number;
};

type TurnOpts = {
  provider: AgentProvider;
  cwd: string;
  mode: AgentMode;
  titleHint?: string;
  /** Edit existing user message: truncate later turns and regenerate. */
  editMessageId?: string;
  /** Files to attach to a NEW user message (base64 payloads). */
  attachments?: AttachmentInput[];
};

/** Attachment chosen from the server machine — referenced or staged into the cwd. */
export type AttachmentInput = {
  name: string;
  /** Absolute path of the file on the server machine. */
  path: string;
};

/** Attachments are read in place from their server paths — no staging dir. */
function sanitizeFileName(name: string): string {
  const base = path.basename(name).replace(/[\\/:*?"<>|]/g, "_").trim();
  return (base || "file").slice(0, 120);
}

type SavedAttachment = {
  name: string;
  fileId: string;
  /** Absolute path on the server — the file is read in place, never copied. */
  absPath: string;
  /** Path shown to the agent: relative when inside the cwd, absolute otherwise. */
  relPath: string;
  size: number;
  mime: string;
};

/**
 * Resolve user-attached files (server paths). No copies are made: files
 * inside the session cwd are read via their relative path, files anywhere
 * else on the machine are added to the runtime's read-allowlist so the ACP
 * client lets the agent read the exact file (like attaching any file in
 * Cursor). Returns the list and records every path in `allowedFiles`.
 */
async function saveAttachments(
  sessionId: string,
  cwd: string,
  attachments: AttachmentInput[],
  allowedFiles: Set<string>,
): Promise<SavedAttachment[]> {
  const used = new Set<string>();
  const out: SavedAttachment[] = [];
  for (const att of attachments) {
    const source = att.path.trim();
    const abs = path.resolve(source);
    try {
      const size = (await stat(abs)).size;
      const name = sanitizeFileName(path.basename(abs));
      let fileId = name;
      let n = 2;
      while (used.has(fileId)) {
        fileId = `${path.basename(name, path.extname(name))}-${n}${path.extname(name)}`;
        n++;
      }
      used.add(fileId);
      const cwdRoot = path.resolve(cwd);
      const inCwd = abs === cwdRoot || abs.startsWith(cwdRoot + path.sep);
      allowedFiles.add(abs);
      out.push({
        name,
        fileId,
        absPath: abs,
        relPath: inCwd ? path.relative(cwdRoot, abs) : abs,
        size,
        mime: "application/octet-stream",
      });
    } catch {
      continue; // unreadable source — skip
    }
  }
  return out;
}

class SessionRuntime {
  client: AcpClient | null = null;
  /** Resolves when client.start() has finished (or failed). */
  clientReady: Promise<AcpClient> | null = null;
  /** Provider the live ACP process was started with. */
  provider: AgentProvider | null = null;
  /** Exact absolute paths of user-attached files the agent may read outside the cwd. */
  allowedAttachmentFiles = new Set<string>();
  assistantMessageId: string | null = null;
  openTextPartId: string | null = null;
  /** One thought block for the whole turn */
  turnThoughtPartId: string | null = null;
  openThoughtPartId: string | null = null;
  toolPartByCallId = new Map<string, string>();
  /**
   * toolCallIds that reached a terminal status (completed/failed). Async agent
   * progress (omp task jobs) can stream late `in_progress` updates after the
   * call finished — those must not clobber the terminal status.
   */
  terminalToolCallIds = new Set<string>();
  /** omp `_omp/agents/update` subagent cards, keyed by registry agent id. */
  subagentPartByAgentId = new Map<string, string>();
  /**
   * Live thinking stream per subagent id: an incremental transcript drain
   * (`_omp/agents/messages`, byte-offset) that appends new thinking blocks
   * to the card while the agent runs, then stops at its terminal state.
   */
  subagentThinkingPoll = new Map<string, SubagentThinkingPoll>();
  /** Subagents whose terminal transcript snapshot was already attached. */
  subagentTranscriptDone = new Set<string>();
  availableCommands: import("@acprocess/shared").SlashCommandDto[] = [];
  pending = new Map<string, PendingRequest>();
  running = false;
  /**
   * Prompts accepted while a turn is already running (multitask burst).
   * User messages are persisted immediately; the turns themselves run
   * strictly one at a time in FIFO order, so streams never interleave.
   */
  turnQueue: Array<{ userMessageId: string; text: string; opts: TurnOpts }> = [];
  /**
   * Active prompt generation. Bumped when a prompt starts.
   * Stream chunks captured under an older gen (or while acceptingStream=false) are dropped.
   */
  streamGen = 0;
  /** False after Stop until the next prompt starts — blocks late tokens. */
  acceptingStream = false;
  toolsHintSent = false;
  /** True while we intentionally tear down ACP (e.g. edit/regenerate). */
  disposing = false;
  /** MCP config changed while a turn was running — restart the agent when it idles. */
  restartOnIdle = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(public readonly sessionId: string) {}

  /** Serialize ACP update handlers to avoid racey part creation per token. */
  enqueue(task: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(task, task);
    return this.chain;
  }
}

const runtimes = new Map<string, SessionRuntime>();

function getRuntime(sessionId: string) {
  let rt = runtimes.get(sessionId);
  if (!rt) {
    rt = new SessionRuntime(sessionId);
    runtimes.set(sessionId, rt);
  }
  return rt;
}

export function requestIdFor(sessionId: string, rpcId: string | number) {
  return `${sessionId}:${String(rpcId)}`;
}

export function parseRpcId(requestId: string, sessionId: string): string | number {
  const rpcId = requestId.slice(sessionId.length + 1);
  const numericId = Number(rpcId);
  return Number.isFinite(numericId) && String(numericId) === rpcId ? numericId : rpcId;
}

/** Normalize ACP plan updates / create_plan payloads for the UI side panel. */
export function normalizePlanPartPayload(raw: Record<string, unknown>): Record<string, unknown> {
  const name = String(raw.name ?? raw.title ?? "").trim();
  const overview = String(raw.overview ?? "").trim();
  const plan = String(raw.plan ?? raw.content ?? "").trim();
  const todosFromField = Array.isArray(raw.todos) ? raw.todos : null;
  const entries = Array.isArray(raw.entries) ? raw.entries : null;
  const phases = Array.isArray(raw.phases) ? raw.phases : undefined;

  const todos =
    todosFromField ??
    (entries
      ? entries.map((item, i) => {
          const row = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
          return {
            id: String(row.id ?? `entry-${i}`),
            content: String(row.content ?? row.title ?? "").trim(),
            status: String(row.status ?? "pending"),
          };
        })
      : undefined);

  const cleanedTodos = todos?.filter((t) => String((t as { content?: string }).content ?? "").trim());

  return {
    ...raw,
    ...(name ? { name } : {}),
    ...(overview ? { overview } : {}),
    ...(plan ? { plan } : {}),
    ...(cleanedTodos?.length ? { todos: cleanedTodos } : {}),
    ...(phases ? { phases } : {}),
  };
}

export type RestoreMode = "new" | "resume" | "load";

/**
 * MCP servers a chat's agent session actually gets: globally enabled ones
 * minus the ids this chat disabled. Passed verbatim to session/new|resume|load.
 */
export function effectiveMcpServers(
  settings: AppSettings,
  disabledIds: string[] | null | undefined,
): McpServerConfig[] {
  const disabled = new Set(disabledIds ?? []);
  return (settings.mcpServers ?? []).filter(
    (s) => s.enabled && s.url?.trim() && !disabled.has(s.id),
  );
}

/**
 * Decide how a fresh ACP spawn should attach to the agent:
 * - "new"    — session/new (blank context); used when the toggle is off, the
 *              caller explicitly wants a fresh slate (edit/regenerate), the
 *              provider switched, or no stored agent session exists.
 * - "resume" — OMP: session/resume, silent context restore, no history replay.
 * - "load"   — Cursor: session/load, context restore WITH history replay
 *              (the client swallows the replay; our DB already has it).
 */
export function pickRestoreMode(input: {
  provider: AgentProvider;
  preferResume: boolean;
  toggle: boolean;
  hasStoredSession: boolean;
  cwdMatches: boolean;
}): RestoreMode {
  if (
    !input.preferResume ||
    !input.toggle ||
    !input.hasStoredSession ||
    !input.cwdMatches
  ) {
    return "new";
  }
  if (input.provider === "omp") return "resume";
  if (input.provider === "cursor") return "load";
  return "new";
}

function resolveRestoreMode(
  opts: { provider: AgentProvider; cwd: string },
  settings: AppSettings,
  preferResume: boolean,
  detail: SessionDetailDto | null,
): { mode: RestoreMode; storedSessionId?: string } {
  if (preferResume === false || !settings.resumeAgentContext) {
    return { mode: "new" };
  }
  if (opts.provider !== "omp" && opts.provider !== "cursor") {
    return { mode: "new" };
  }
  const mode = pickRestoreMode({
    provider: opts.provider,
    preferResume: true,
    toggle: true,
    hasStoredSession: Boolean(detail?.acpSessionId),
    cwdMatches: Boolean(detail && detail.cwd === opts.cwd && detail.provider === opts.provider),
  });
  return mode === "new"
    ? { mode }
    : { mode, storedSessionId: detail!.acpSessionId! };
}

export async function ensureAcp(
  sessionId: string,
  opts: { provider: AgentProvider; cwd: string; mode: AgentMode },
  boot?: {
    preferResume?: boolean;
    /** Re-apply this exact model at boot (defaults to settings.defaultModel). */
    model?: string;
    modelParams?: Record<string, string>;
  },
): Promise<AcpClient> {
  const rt = getRuntime(sessionId);
  // Switching Cursor ↔ OMP must replace the live process, not reuse it.
  if (rt.provider && rt.provider !== opts.provider) {
    resetAcpClient(rt);
  }
  if (rt.clientReady) return rt.clientReady;
  if (rt.client) return rt.client;

  const settings = await getSettings();
  const detail = await getSessionDetail(sessionId);
  const { mode: restoreMode, storedSessionId } = resolveRestoreMode(
    opts,
    settings,
    boot?.preferResume ?? true,
    detail,
  );
  // This chat's MCP list: globally enabled minus ids disabled for this chat.
  const mcpServers = effectiveMcpServers(settings, detail?.mcpDisabledIds);

  const startClient = async (mode: RestoreMode): Promise<AcpClient> => {
    const client = new AcpClient(opts.provider, settings, opts.cwd, opts.mode);
    rt.client = client;
    rt.provider = opts.provider;
    for (const f of rt.allowedAttachmentFiles) client.allowReadFile(f);

    client.on("log", (line: string) => {
      console.log(`[acp:${sessionId}]`, line.trim());
    });

    client.on("exit", async () => {
      const intentional = rt.disposing;
      rt.client = null;
      rt.clientReady = null;
      rt.provider = null;
      rt.running = false;
      rt.toolsHintSent = false;
      // An unexpected agent exit means the agent is not available right now.
      if (!intentional) {
        setAgentAvailable(opts.provider, false);
        await updateSession(sessionId, { status: "closed" });
      }
    });

    client.on("update", (update) => {
      const gen = rt.streamGen;
      void rt.enqueue(async () => {
        try {
          const isStream =
            update.kind === "agent_message_chunk" ||
            update.kind === "agent_thought_chunk" ||
            update.kind === "mixed_chunks";
          // Drop tokens from a cancelled / superseded prompt (including chunks that
          // arrive AFTER Stop — the old epoch check only ignored pre-queued ones).
          if (isStream && (!rt.acceptingStream || rt.streamGen !== gen)) {
            return;
          }
          await handleUpdate(rt, update);
        } catch (err) {
          console.error("update handler error", err);
        }
      });
    });

    // Permissions/questions must NOT hold the update queue while waiting for the user,
    // otherwise streaming/tool updates stall and follow-ups look broken.
    client.on("request", (req: AcpRequest) => {
      void handleIncomingRequest(rt, req).catch((err) => {
        console.error("request handler error", err);
      });
    });

    client.on("extension", (ext: { method: string; params: unknown }) => {
      void rt.enqueue(async () => {
        await handleExtension(rt, ext.method, (ext.params ?? {}) as Record<string, unknown>);
      });
    });

    rt.clientReady = (async () => {
      try {
        // Restore boots get a bigger budget: Cursor's session/load replays the
        // whole stored conversation before responding.
        await client.start(
          mode === "new" ? 45_000 : 120_000,
          mode === "new"
            ? { model: boot?.model, modelParams: boot?.modelParams, mcpServers }
            : {
                resume: { sessionId: storedSessionId!, mode },
                model: boot?.model,
                modelParams: boot?.modelParams,
                mcpServers,
              },
        );
        const settings = await getSettings();
        const models = await finalizeModelList(
          opts.provider,
          settings,
          toModelList(client.configOptions),
        );
        const modelParams = toModelParams(client.configOptions);
        const modes = toModesList(client.configOptions, opts.provider, client.sessionModes);
        const currentModel = pickCurrentModel(
          models,
          findModelConfigOption(client.configOptions)?.currentValue,
        );
        if (models.length || modelParams.length || modes.length) {
          rememberModels(opts.provider, currentModel, models, modelParams, modes);
        }
        await updateSession(sessionId, {
          acpSessionId: client.sessionId,
          // Don't clobber an in-flight prompt if warm-up finishes during runPrompt.
          ...(rt.running ? {} : { status: "idle" as const }),
        });
        return client;
      } catch (err) {
        rt.client = null;
        rt.clientReady = null;
        throw err;
      }
    })();

    try {
      return await rt.clientReady;
    } catch (err) {
      rt.client = null;
      rt.clientReady = null;
      // Restore is best-effort: an unknown/removed agent session, a CLI build
      // without the capability, or a broken replay must never brick the chat —
      // dispose the failed process and fall back to a fresh session/new.
      if (mode !== "new") {
        try {
          client.dispose();
        } catch {
          // process already gone
        }
        console.error(
          `[acp:${sessionId}] ${mode} failed (${err instanceof Error ? err.message : String(err)}) — starting fresh`,
        );
        return startClient("new");
      }
      throw err;
    }
  };

  return startClient(restoreMode);
}

/** Pre-spawn ACP for a session so the first prompt isn't blocked on cold start. */
export function warmAcp(
  sessionId: string,
  opts: { provider: AgentProvider; cwd: string; mode: AgentMode },
) {
  return ensureAcp(sessionId, opts).catch((err) => {
    console.error(`[acp:${sessionId}] warm failed`, err);
  });
}

async function ensureAssistantMessage(rt: SessionRuntime) {
  if (rt.assistantMessageId) return rt.assistantMessageId;
  const msg = await createMessage(rt.sessionId, "assistant");
  rt.assistantMessageId = msg.id;
  rt.openTextPartId = null;
  rt.openThoughtPartId = null;
  rt.turnThoughtPartId = null;
  return msg.id;
}

async function handleUpdate(rt: SessionRuntime, update: import("./AcpClient.js").AcpUpdate) {
  if (update.kind === "available_commands") {
    rt.availableCommands = parseAvailableCommands(update.raw);
    broadcastToSession(rt.sessionId, {
      type: "commands.updated",
      sessionId: rt.sessionId,
      commands: rt.availableCommands,
    });
    return;
  }

  if (update.kind === "current_mode") {
    await applyAgentReportedMode(rt, update.modeId);
    return;
  }

  if (update.kind === "config_options") {
    rt.client?.applyConfigOptionsUpdate(update.configOptions);
    const modeOpt = findModeConfigOption(rt.client?.configOptions ?? update.configOptions);
    if (modeOpt?.currentValue) {
      await applyAgentReportedMode(rt, String(modeOpt.currentValue));
    }
    return;
  }

  // Metadata-only updates should not create empty assistant bubbles
  if (
    update.kind === "session_info" ||
    update.kind === "other" ||
    update.kind === "user_message_chunk"
  ) {
    return;
  }

  if (update.kind === "agent_message_chunk") {
    if (!rt.acceptingStream) return;
    if (!update.text) return;
    const messageId = await ensureAssistantMessage(rt);
    // Continue same text part for the turn; tools may split later via clearing openTextPartId
    rt.openTextPartId = await appendTextChunk(
      rt.sessionId,
      messageId,
      "text",
      update.text,
      rt.openTextPartId,
    );
    return;
  }

  if (update.kind === "mixed_chunks") {
    if (!rt.acceptingStream) return;
    const messageId = await ensureAssistantMessage(rt);
    if (update.thought) {
      const partId = await appendTextChunk(
        rt.sessionId,
        messageId,
        "thought",
        update.thought,
        rt.turnThoughtPartId ?? rt.openThoughtPartId,
      );
      rt.turnThoughtPartId = partId;
      rt.openThoughtPartId = partId;
    }
    if (update.text) {
      rt.openTextPartId = await appendTextChunk(
        rt.sessionId,
        messageId,
        "text",
        update.text,
        rt.openTextPartId,
      );
    }
    return;
  }

  if (update.kind === "agent_thought_chunk") {
    if (!rt.acceptingStream) return;
    if (!update.text) return;
    const messageId = await ensureAssistantMessage(rt);
    // Always one reasoning block per turn
    const partId = await appendTextChunk(
      rt.sessionId,
      messageId,
      "thought",
      update.text,
      rt.turnThoughtPartId ?? rt.openThoughtPartId,
    );
    rt.turnThoughtPartId = partId;
    rt.openThoughtPartId = partId;
    return;
  }

  if (update.kind === "tool_call") {
    if (!rt.acceptingStream) return;
    const messageId = await ensureAssistantMessage(rt);
    rt.openTextPartId = null; // next text starts a new segment after tool
    const title = update.title ?? "Tool";
    const kind = String((update.raw.kind as string) ?? "");
    const isSubagent = isSubagentToolCall(kind);
    const extra = isSubagent ? subagentFieldsFromRaw(update.raw) : {};
    const payload: Record<string, unknown> = {
      toolCallId: update.toolCallId,
      title,
      description: title,
      subagentType: kind || (isSubagent ? "task" : undefined),
      status: update.status ?? "pending",
      kind,
      raw: update.raw,
      ...extra,
    };

    const existingId = update.toolCallId ? rt.toolPartByCallId.get(update.toolCallId) : undefined;
    if (existingId) {
      // cursor/task may have arrived first — enrich that one card without clobbering its title.
      const { title: _title, description: _description, ...rest } = payload;
      const named = title && !/^tool$/i.test(title) ? { title, description: title } : {};
      await updatePart(
        rt.sessionId,
        existingId,
        { ...rest, ...named },
        isSubagent ? "subagent" : undefined,
      );
      return;
    }

    const part = await appendPart(
      rt.sessionId,
      messageId,
      isSubagent ? "subagent" : "tool_call",
      payload,
    );
    if (update.toolCallId) rt.toolPartByCallId.set(update.toolCallId, part.id);
    return;
  }

  if (update.kind === "tool_call_update") {
    if (!rt.acceptingStream) return;
    const messageId = await ensureAssistantMessage(rt);
    const partId = rt.toolPartByCallId.get(update.toolCallId);
    const title = (update.raw.title as string) ?? "Tool";
    const status = update.status ?? "in_progress";
    const kind = String((update.raw.kind as string) ?? "");
    const isSubagent = isSubagentToolCall(kind);
    const extra = isSubagent ? subagentFieldsFromRaw(update.raw) : {};
    // Terminal status is final: late async progress must not reopen the card.
    if (status === "completed" || status === "failed") {
      if (update.toolCallId) rt.terminalToolCallIds.add(update.toolCallId);
    } else if (update.toolCallId && rt.terminalToolCallIds.has(update.toolCallId)) {
      return;
    }
    if (!partId) {
      const part = await appendPart(rt.sessionId, messageId, isSubagent ? "subagent" : "tool_call", {
        toolCallId: update.toolCallId,
        title,
        description: title,
        subagentType: kind || (isSubagent ? "task" : undefined),
        status,
        kind,
        raw: update.raw,
        ...extra,
      });
      rt.toolPartByCallId.set(update.toolCallId, part.id);
      return;
    }
    const named = title && !/^tool$/i.test(title) ? { title, description: title } : {};
    await updatePart(
      rt.sessionId,
      partId,
      {
        toolCallId: update.toolCallId,
        status,
        kind,
        raw: update.raw,
        ...extra,
        ...named,
      },
      isSubagent ? "subagent" : undefined,
    );
    return;
  }

  if (update.kind === "plan") {
    const messageId = await ensureAssistantMessage(rt);
    rt.openTextPartId = null;
    const payload = normalizePlanPartPayload(update.raw);
    await appendPart(rt.sessionId, messageId, "plan", payload);
    return;
  }
}

async function handleIncomingRequest(rt: SessionRuntime, req: AcpRequest) {
  const settings = await getSettings();
  const reqKey = requestIdFor(rt.sessionId, req.id);

  if (req.kind === "permission") {
    const options =
      ((req.params as { options?: Array<{ optionId: string; kind?: string }> }).options ??
        []) as Array<{ optionId: string; kind?: string }>;

    const pickAllow = () => {
      const byKind =
        options.find((o) => o.kind === "allow_always") ??
        options.find((o) => o.kind === "allow_once" || o.kind === "allow-once") ??
        options.find((o) => /allow[_-]?always/i.test(o.optionId)) ??
        options.find((o) => /allow/i.test(o.optionId));
      return byKind?.optionId ?? options[0]?.optionId ?? "allow_once";
    };

    if (settings.permissionPolicy === "always") {
      rt.client?.respond(req.id, { outcome: { outcome: "selected", optionId: pickAllow() } });
      return;
    }

    const toolName = String(
      (req.params as { toolCall?: { title?: string; kind?: string } }).toolCall?.title ??
        (req.params as { toolCall?: { kind?: string } }).toolCall?.kind ??
        "",
    );
    if (
      settings.permissionPolicy === "allowlist" &&
      settings.permissionAllowlist.some((x) => toolName.toLowerCase().includes(x.toLowerCase()))
    ) {
      rt.client?.respond(req.id, { outcome: { outcome: "selected", optionId: pickAllow() } });
      return;
    }

    await rt.enqueue(async () => {
      const messageId = await ensureAssistantMessage(rt);
      await appendPart(rt.sessionId, messageId, "permission", {
        requestId: reqKey,
        options,
        ...req.params,
      });
    });
    await updateSession(rt.sessionId, { status: "waiting" });
    broadcastToSession(rt.sessionId, {
      type: "permission.request",
      sessionId: rt.sessionId,
      requestId: reqKey,
      payload: { ...req.params, options },
    });

    console.log(`[acp:${rt.sessionId}] permission pending rpcId=${String(req.id)}`);
    await new Promise<void>((resolve) => {
      rt.pending.set(reqKey, {
        kind: "permission",
        rpcId: req.id,
        resolve: () => resolve(),
      });
    });
    return;
  }

  await rt.enqueue(async () => {
    const messageId = await ensureAssistantMessage(rt);
    const kind = req.kind === "ask_question" ? "question" : "plan";
    const payload =
      kind === "plan"
        ? normalizePlanPartPayload({ requestId: reqKey, pending: true, ...req.params })
        : { requestId: reqKey, pending: true, ...req.params };
    await appendPart(rt.sessionId, messageId, kind === "question" ? "question" : "plan", payload);
  });
  await updateSession(rt.sessionId, { status: "waiting" });
  broadcastToSession(rt.sessionId, {
    type: "question.request",
    sessionId: rt.sessionId,
    requestId: reqKey,
    kind: req.kind === "ask_question" ? "ask_question" : "create_plan",
    payload:
      req.kind === "create_plan"
        ? normalizePlanPartPayload(req.params as Record<string, unknown>)
        : req.params,
  });

  await new Promise<void>((resolve) => {
    rt.pending.set(reqKey, {
      kind: req.kind,
      rpcId: req.id,
      resolve: () => resolve(),
    });
  });
}

const MAX_SUBAGENT_THINKING_BLOCKS = 30;
const MAX_SUBAGENT_TRANSCRIPT_PAGES = 10;
/** Byte size of one thinking block we render in a card (bounded). */
const MAX_THINKING_BLOCK_CHARS = 2000;
/** Live thinking poll cadence per running subagent. */
const SUBAGENT_THINKING_POLL_MS = 1500;

interface SubagentMessagesResponse {
  fromByte?: number;
  nextByte?: number;
  reset?: boolean;
  messages?: Array<{ role?: string; content?: unknown[] }>;
}

interface SubagentThinkingPoll {
  timer: NodeJS.Timeout | undefined;
  /** Byte offset of the next incremental transcript drain. */
  lastByte: number;
  /** Thinking blocks already attached to the card (deduped, capped). */
  blocks: string[];
  /** True while a drain is in flight — skip ticks instead of stacking. */
  inFlight: boolean;
  /** True once the first snapshot (from byte 0) has been applied. */
  seeded: boolean;
}

function clearSubagentThinkingPoll(rt: SessionRuntime, id: string): void {
  const poll = rt.subagentThinkingPoll.get(id);
  if (!poll) return;
  clearInterval(poll.timer);
  rt.subagentThinkingPoll.delete(id);
}

/**
 * One incremental drain of a subagent's transcript via `_omp/agents/messages`.
 * Appends any new assistant `thinking` blocks to the card payload so the
 * reasoning streams into the card while the agent runs. Runs detached from
 * the update queue; failures are logged, never thrown into the stream.
 */
async function drainSubagentThinking(rt: SessionRuntime, id: string, poll: SubagentThinkingPoll): Promise<void> {
  const client = rt.client;
  if (!client) {
    clearSubagentThinkingPoll(rt, id);
    return;
  }
  if (poll.inFlight) return;
  poll.inFlight = true;
  try {
    let { lastByte, blocks } = poll;
    for (let page = 0; page < MAX_SUBAGENT_TRANSCRIPT_PAGES; page++) {
      const res = (await client.requestAgent<SubagentMessagesResponse | undefined>("_omp/agents/messages", {
        agentId: id,
        fromByte: lastByte,
      })) ?? {};
      if (res.reset || !poll.seeded) {
        // Transcript rewound (or first snapshot): rebuild the list from this
        // response instead of appending to a stale one.
        blocks = [];
        lastByte = 0;
        poll.seeded = true;
      }
      const from = res.fromByte ?? lastByte;
      for (const msg of res.messages ?? []) {
        if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
          const b = block as { type?: string; thinking?: string };
          if (b.type !== "thinking" || typeof b.thinking !== "string" || !b.thinking.trim()) continue;
          const text = b.thinking.trim().slice(0, MAX_THINKING_BLOCK_CHARS);
          if (!blocks.includes(text)) blocks.push(text);
          if (blocks.length >= MAX_SUBAGENT_THINKING_BLOCKS) break;
        }
      }
      blocks = blocks.slice(0, MAX_SUBAGENT_THINKING_BLOCKS);
      const next = res.nextByte ?? 0;
      if (blocks.length >= MAX_SUBAGENT_THINKING_BLOCKS || res.reset || next <= from) break;
      lastByte = next;
    }
    poll.blocks = blocks;
    poll.lastByte = lastByte;
    const partId = rt.subagentPartByAgentId.get(id);
    if (!partId) return;
    const updated = await updatePart(rt.sessionId, partId, { thinking: poll.blocks }, "subagent");
    if (!updated) clearSubagentThinkingPoll(rt, id);
  } catch (err) {
    console.error(`[subagent] thinking drain failed for ${id}`, err);
  } finally {
    poll.inFlight = false;
  }
}

/**
 * Start the live thinking stream for a running subagent: an immediate drain
 * (full snapshot from byte 0), then an incremental drain every poll tick.
 */
function startSubagentThinkingPoll(rt: SessionRuntime, id: string): void {
  if (rt.subagentThinkingPoll.has(id)) return;
  const poll: SubagentThinkingPoll = { timer: undefined, lastByte: 0, blocks: [], inFlight: false, seeded: false };
  rt.subagentThinkingPoll.set(id, poll);
  void drainSubagentThinking(rt, id, poll);
  poll.timer = setInterval(() => {
    void drainSubagentThinking(rt, id, poll);
  }, SUBAGENT_THINKING_POLL_MS);
  poll.timer.unref?.();
}

/**
 * Stop the live stream at a terminal state: one final drain catches any
 * blocks that landed after the last tick. For an agent that was never polled
 * while running (e.g. we joined mid-run) this is a single full snapshot.
 */
async function stopSubagentThinkingPoll(rt: SessionRuntime, id: string): Promise<void> {
  if (rt.subagentTranscriptDone.has(id)) return;
  const poll = rt.subagentThinkingPoll.get(id);
  clearSubagentThinkingPoll(rt, id);
  const partId = rt.subagentPartByAgentId.get(id);
  if (!partId) return;
  rt.subagentTranscriptDone.add(id);
  await drainSubagentThinking(rt, id, poll ?? { timer: undefined, lastByte: 0, blocks: [], inFlight: false, seeded: false });
}

async function handleExtension(
  rt: SessionRuntime,
  method: string,
  params: Record<string, unknown>,
) {
  const messageId = await ensureAssistantMessage(rt);
  if (method === "cursor/update_todos") {
    await appendPart(rt.sessionId, messageId, "todo", params);
    return;
  }
  if (method === "cursor/task") {
    const toolCallId = String(
      params.tool_call_id ?? params.toolCallId ?? params.toolCallID ?? "",
    );
    const title = String(
      params.title ?? params.description ?? params.name ?? params.subtitle ?? "",
    ).trim();
    const status = String(params.status ?? "").trim();
    const subagentType = String(
      params.subagent_type ?? params.subagentType ?? params.kind ?? params.type ?? "",
    ).trim();
    const extra = subagentFieldsFromRaw(params);
    const payload: Record<string, unknown> = {
      ...(toolCallId ? { toolCallId } : {}),
      ...(title ? { title, description: title } : {}),
      ...(status ? { status } : {}),
      ...(subagentType ? { subagentType } : {}),
      raw: params,
      ...extra,
    };

    // Same Task arrives as ACP tool_call + cursor/task — keep one card.
    const existingId = toolCallId ? rt.toolPartByCallId.get(toolCallId) : undefined;
    if (existingId) {
      await updatePart(rt.sessionId, existingId, payload, "subagent");
      return;
    }

    const part = await appendPart(rt.sessionId, messageId, "subagent", {
      title: title || "Субагент",
      description: title || "Субагент",
      ...payload,
    });
    if (toolCallId) rt.toolPartByCallId.set(toolCallId, part.id);
    return;
  }
  if (method === "cursor/generate_image") {
    await appendPart(rt.sessionId, messageId, "status", {
      kind: "image",
      ...params,
    });
  }
  if (method === "_omp/agents/update") {
    // omp roster snapshot: upsert one subagent card per registry agent id.
    const agents = Array.isArray(params.agents) ? (params.agents as Record<string, unknown>[]) : [];
    for (const agent of agents) {
      if (agent.kind !== "sub") continue;
      const id = String(agent.id ?? "");
      if (!id) continue;
      const rawStatus = String(agent.status ?? "");
      // Registry statuses are lifecycle states; the UI understands terminal
      // statuses as completed/failed (stops the "working" pulse).
      const status =
        rawStatus === "aborted"
          ? "failed"
          : rawStatus === "running"
            ? "running"
            : "completed";
      const activity = typeof agent.activity === "string" ? agent.activity.trim() : "";
      // `displayName` is the agent *type* ("scout", "task"); the id is the
      // intent-derived name ("SummaryPorting") — prefer it as the card title.
      const name = String(agent.displayName ?? "");
      const title = name && !/^(tool|task|scout|subagent|агент|субагент)$/i.test(name) ? name : id;
      const metrics =
        agent.metrics && typeof agent.metrics === "object"
          ? (agent.metrics as Record<string, unknown>)
          : undefined;
      const bodyParts: string[] = [];
      if (activity) bodyParts.push(activity);
      if (rawStatus === "running") bodyParts.push("статус: выполняется");
      if (metrics) {
        const parts: string[] = [];
        for (const key of ["tokens", "requests", "tools"] as const) {
          if (typeof metrics[key] === "number") parts.push(`${key}: ${metrics[key]}`);
        }
        if (typeof metrics.durationMs === "number") parts.push(`время: ${Math.round(metrics.durationMs / 1000)} с`);
        if (typeof metrics.cost === "number") parts.push(`стоимость: $${metrics.cost.toFixed(4)}`);
        if (parts.length) bodyParts.push(`— ${parts.join(", ")} —`);
      }
      const payload: Record<string, unknown> = {
        agentId: id,
        ...(agent.parentId ? { parentId: String(agent.parentId) } : {}),
        status,
        ...(agent.resolvedModel ? { resolvedModel: String(agent.resolvedModel) } : {}),
        ...(metrics ? { metrics } : {}),
        // `resolveSubagentBody` renders payload.prompt as the card body.
        ...(bodyParts.length ? { prompt: bodyParts.join("\n\n") } : {}),
        description: activity || title,
        raw: agent,
      };
      const existingId = rt.subagentPartByAgentId.get(id);
      if (existingId) {
        await updatePart(rt.sessionId, existingId, payload, "subagent");
      } else {
        // The roster snapshot is process-global and includes agents from
        // earlier turns (idle/parked). Only spawn a card for an agent that is
        // actually working (running); an idle-only sighting never re-creates
        // an old agent's card in a new message.
        if (status !== "running") continue;
        const part = await appendPart(rt.sessionId, messageId, "subagent", {
          title,
          description: activity || title,
          ...payload,
        });
        rt.subagentPartByAgentId.set(id, part.id);
      }
      // Stream the subagent's own transcript (thinking) into the card: a
      // live incremental drain while running, one final drain at terminal.
      if (status === "running") {
        startSubagentThinkingPoll(rt, id);
      } else {
        void stopSubagentThinkingPoll(rt, id);
      }
    }
    return;
  }
  if (method === "_omp/agents/progress") {
    // omp live work stream: one subagent progress snapshot. Upserts the same
    // per-agent card as `_omp/agents/update` and fills the body with the
    // current intent, active tool, recent output, and spend.
    const agent = (params.agent ?? {}) as Record<string, unknown>;
    const id = String(agent.id ?? "");
    if (!id) return;
    const rawStatus = String(agent.status ?? "");
    const status =
      rawStatus === "completed"
        ? "completed"
        : rawStatus === "failed" || rawStatus === "aborted"
          ? "failed"
          : "running";
    const title = id;
    const intent = typeof agent.lastIntent === "string" ? agent.lastIntent.trim() : "";
    const lines: string[] = [];
    if (intent) lines.push(intent);
    const tool = typeof agent.currentTool === "string" ? agent.currentTool : "";
    const toolArgs = typeof agent.currentToolArgs === "string" ? agent.currentToolArgs : "";
    if (tool) lines.push(`инструмент: \`${tool}\`${toolArgs ? ` (${toolArgs.slice(0, 120)})` : ""}`);
    if (Array.isArray(agent.recentOutput)) {
      for (const line of agent.recentOutput.slice(0, 5)) {
        if (typeof line === "string" && line.trim()) lines.push(line.trim().slice(0, 300));
      }
    }
    const metrics: string[] = [];
    for (const key of ["toolCount", "requests", "tokens"] as const) {
      const value = agent[key];
      if (typeof value === "number") metrics.push(`${key === "toolCount" ? "tools" : key}: ${value}`);
    }
    if (typeof agent.durationMs === "number") metrics.push(`время: ${Math.round((agent.durationMs as number) / 1000)} с`);
    if (typeof agent.cost === "number") metrics.push(`стоимость: $${(agent.cost as number).toFixed(4)}`);
    if (metrics.length) lines.push(`— ${metrics.join(", ")} —`);
    const payload: Record<string, unknown> = {
      agentId: id,
      status,
      ...(agent.resolvedModel ? { resolvedModel: String(agent.resolvedModel) } : {}),
      ...(lines.length ? { prompt: lines.join("\n\n") } : {}),
      description: intent || title,
      raw: agent,
    };
    const existingId = rt.subagentPartByAgentId.get(id);
    if (existingId) {
      await updatePart(rt.sessionId, existingId, payload, "subagent");
    } else if (status === "running") {
      // Progress for a terminal state without a known card means the agent
      // was never sighted while working — never create a stale card.
      const part = await appendPart(rt.sessionId, messageId, "subagent", {
        title,
        description: intent || title,
        ...payload,
      });
      rt.subagentPartByAgentId.set(id, part.id);
    }
    // Live thinking stream, same lifecycle as the update roster.
    if (status === "running") {
      startSubagentThinkingPoll(rt, id);
    } else {
      void stopSubagentThinkingPoll(rt, id);
    }
    return;
  }
}

function buildPriorTranscript(
  messages: Array<{ id: string; role: string; parts: Array<{ type: string; payload: Record<string, unknown> }> }>,
  upToExclusiveId: string,
) {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.id === upToExclusiveId) break;
    const text = msg.parts
      .filter((p) => p.type === "text")
      .map((p) => String(p.payload.text ?? ""))
      .join("\n")
      .trim();
    if (!text) continue;
    lines.push(`${msg.role === "user" ? "User" : "Assistant"}: ${text}`);
  }
  return lines.join("\n\n");
}

export async function runPrompt(
  sessionId: string,
  text: string,
  opts: TurnOpts,
) {
  const settings = await getSettings();
  const locale = settings.locale ?? "ru";
  let rt = getRuntime(sessionId);

  let promptUserText = text;
  let priorTranscript = "";
  let userMessageId: string | null = null;

  if (opts.editMessageId) {
    const detailBefore = await getSessionDetail(sessionId);
    if (!detailBefore) {
      throw Object.assign(new Error("Session not found"), { statusCode: 404 });
    }
    const target = detailBefore.messages.find((m) => m.id === opts.editMessageId);
    if (!target || target.role !== "user") {
      throw Object.assign(new Error("User message not found"), { statusCode: 404 });
    }
    await truncateMessagesAfter(sessionId, opts.editMessageId);
    await replaceUserMessageText(sessionId, opts.editMessageId, text);
    const detailAfter = await getSessionDetail(sessionId);
    priorTranscript = buildPriorTranscript(detailAfter?.messages ?? [], opts.editMessageId);
    promptUserText = text;

    try {
      await cancelPrompt(sessionId);
    } catch {
      // ignore
    }
    disposeRuntime(sessionId);
    rt = getRuntime(sessionId);
  }

  // A deferred MCP restart (mid-turn MCP edit) must land BEFORE the next turn:
  // a direct prompt would otherwise run on the stale agent with the old MCP
  // list (the same race dequeueTurn already guards for queued turns).
  if (rt.restartOnIdle) {
    rt.restartOnIdle = false;
    const pendingDetail = await getSessionDetail(sessionId);
    if (pendingDetail?.provider && pendingDetail.status !== "closed") {
      const snapshot = liveModelSnapshot(rt);
      resetAcpClient(rt);
      try {
        await ensureAcp(
          sessionId,
          { provider: pendingDetail.provider, cwd: pendingDetail.cwd, mode: pendingDetail.mode },
          snapshot,
        );
      } catch (err) {
        console.error(`[acp:${sessionId}] deferred MCP restart failed`, err);
      }
    }
  }

  // Kick off ACP as early as possible (spawn overlaps with persisting the user message).
  // Edit/regenerate must NOT resume: the agent's on-disk session still holds the
  // OLD transcript (including the reply being replaced) — fresh context is correct.
  const acpReady = ensureAcp(sessionId, opts, { preferResume: !opts.editMessageId });
  if (!opts.editMessageId) {
    const userMsg = await createMessage(sessionId, "user");
    userMessageId = userMsg.id;
    const trimmed = text.trim();
    const slashMatch = trimmed.match(/^\/([a-z][\w-]*(?::[a-z][\w-]*)?)/i);
    await appendPart(sessionId, userMsg.id, "text", {
      text,
      ...(slashMatch
        ? { isSlashCommand: true, commandName: slashMatch[1] }
        : {}),
    });
    if (opts.attachments?.length) {
      const saved = await saveAttachments(
        sessionId,
        opts.cwd,
        opts.attachments,
        rt.allowedAttachmentFiles,
      );
      // The live ACP client (and any future one) may read the exact file paths.
      for (const f of saved) rt.client?.allowReadFile(f.absPath);
      for (const f of saved) {
        await appendPart(sessionId, userMsg.id, "file", {
          name: f.name,
          fileId: f.fileId,
          relPath: f.relPath,
          size: f.size,
          mime: f.mime,
          path: f.absPath,
        });
      }
      // The agent-facing text gets the file hint; the UI text part stays raw
      // (files render as separate chips).
      promptUserText += `\n\n[Прикреплённые файлы: ${saved
        .map((f) => f.relPath)
        .join(", ")} — прочитайте их при необходимости.]`;
    }
  } else {
    userMessageId = opts.editMessageId;
  }

  if (opts.titleHint) {
    await updateSession(sessionId, {
      title: opts.titleHint.slice(0, 80),
    });
  }

  if (rt.running) {
    // A turn is already running (multitask burst): the user message above is
    // persisted immediately; the agent turn itself runs FIFO once the current
    // turn finishes, so streams never interleave.
    rt.turnQueue.push({ userMessageId: userMessageId!, text: promptUserText, opts });
    return { queued: true };
  }

  return runTurn(rt, sessionId, promptUserText, priorTranscript, opts, settings, acpReady);
}

async function runTurn(
  rt: SessionRuntime,
  sessionId: string,
  promptUserText: string,
  priorTranscript: string,
  opts: TurnOpts,
  settings: AppSettings,
  acpReady: Promise<AcpClient>,
) {
  const locale = settings.locale ?? "ru";
  rt.running = true;
  rt.streamGen += 1;
  rt.acceptingStream = true;
  rt.assistantMessageId = null;
  rt.openTextPartId = null;
  rt.openThoughtPartId = null;
  rt.turnThoughtPartId = null;
  rt.toolPartByCallId.clear();
  await updateSession(sessionId, { status: "running" });
  // Create the assistant bubble immediately so the UI can show "Thinking…" without waiting
  // for the first ACP token (spawn/prompt can take a while).
  await ensureAssistantMessage(rt);

  try {
    const client = await acpReady;
    // UI shows the raw user text; agent gets a tools reminder so it doesn't refuse web lookups.
    let promptText = promptUserText;
    if (priorTranscript) {
      promptText =
        `Earlier conversation (for context only):\n${priorTranscript}\n\n` +
        `The user edited their last message. Continue from this message:\n${promptUserText}`;
    }
    if (!rt.toolsHintSent) {
      rt.toolsHintSent = true;
      promptText = `${promptText}\n\n${t(locale, "agent.toolsHint")}`;
    }
    // Measure the actual ACP request, not time spent creating UI/DB messages.
    const agentStartedAt = Date.now();
    const result = await client.prompt(promptText);
    setAgentAvailable(opts.provider, true);
    // Stop was pressed — don't peel/append more content for this turn.
    if (!rt.acceptingStream || result.stopReason === "cancelled") {
      await updateSession(sessionId, { status: "idle" });
      return result;
    }
    // Let in-flight update handlers settle briefly before finalizing.
    await rt.enqueue(async () => undefined);
    await new Promise((r) => setTimeout(r, 50));
    await rt.enqueue(async () => undefined);

    const detail = await import("../services/sessions.js").then((m) => m.getSessionDetail(sessionId));
    const lastAssistant = detail?.messages.filter((m) => m.role === "assistant").at(-1);
    const hasContent = lastAssistant?.parts.some((p) =>
      ["text", "thought", "tool_call", "error"].includes(p.type),
    );

    if (lastAssistant) {
      const thoughtPart = lastAssistant.parts.find((p) => p.type === "thought");
      if (thoughtPart) {
        await updatePart(sessionId, thoughtPart.id, {
          durationMs: Math.max(0, Date.now() - agentStartedAt),
        });
      }
    }

    if (!hasContent) {
      const model =
        client.configOptions.find((o) => o.id === "model")?.currentValue ?? "(неизвестно)";
      const hint =
        `Агент завершил ход без текста (stopReason=${result.stopReason ?? "unknown"}). ` +
        `Модель: ${model}. В Настройках выбери модель с API (не local-ollama, если Ollama не запущена) и сохрани ключ.`;
      const assistantId = await ensureAssistantMessage(rt);
      await appendPart(sessionId, assistantId, "error", { message: hint });
    }

    await updateSession(sessionId, { status: "idle" });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isModelAccessError(message)) {
      const currentModel =
        (rt.client && findModelConfigOption(rt.client.configOptions)?.currentValue) ||
        settings.defaultModel;
      if (currentModel) denyModel(opts.provider, currentModel);
    }
    try {
      const assistantId = await ensureAssistantMessage(rt);
      await appendPart(sessionId, assistantId, "error", { message });
    } catch {
      // ignore secondary failures
    }
    await updateSession(sessionId, { status: "error" });
    broadcastToSession(sessionId, { type: "error", sessionId, message });
    // Broken ACP process → recreate next time
    if (/exited|spawn|ENOENT|таймаут|timeout/i.test(message)) {
      rt.client?.dispose();
      rt.client = null;
      rt.clientReady = null;
    }
    throw err;
  } finally {
    rt.running = false;
    rt.acceptingStream = false;
    void dequeueTurn(rt);
  }
}

/** Start the next FIFO-queued turn, if any (after the current turn finished). */
async function dequeueTurn(rt: SessionRuntime) {
  if (rt.running) return;
  // MCP servers were re-configured while the previous turn was running — the
  // OMP/Cursor protocol only accepts mcpServers at session/new, so swap in a
  // fresh agent before the next queued turn picks up the old MCP list.
  if (rt.restartOnIdle) {
    rt.restartOnIdle = false;
    try {
      const detail = await import("../services/sessions.js").then((m) =>
        m.getSessionDetail(rt.sessionId),
      );
      if (detail?.provider && detail.status !== "closed") {
        const snapshot = liveModelSnapshot(rt);
        resetAcpClient(rt);
        await ensureAcp(
          rt.sessionId,
          { provider: detail.provider, cwd: detail.cwd, mode: detail.mode },
          snapshot,
        );
      }
    } catch (err) {
      console.error(`[acp:${rt.sessionId}] restart after MCP change failed`, err);
    }
  }
  const next = rt.turnQueue.shift();
  if (!next) return;
  try {
    const settings = await getSettings();
    const acpReady = ensureAcp(rt.sessionId, next.opts);
    await runTurn(rt, rt.sessionId, next.text, "", next.opts, settings, acpReady);
  } catch (err) {
    console.error(`[acp:${rt.sessionId}] queued turn failed`, err);
  }
}

export async function cancelPrompt(sessionId: string) {
  const rt = runtimes.get(sessionId);
  if (rt) {
    rt.acceptingStream = false;
    rt.running = false;
    // Stop drops every queued turn too — the user asked to halt work.
    rt.turnQueue = [];
    rt.openTextPartId = null;
    rt.openThoughtPartId = null;
    // Mark in-flight tool/subagent calls as cancelled so their spinners stop
    // (the agent won't send final statuses for calls it was interrupted on).
    for (const [, partId] of rt.toolPartByCallId) {
      try {
        await updatePart(sessionId, partId, { status: "cancelled", interrupted: true });
      } catch {
        // ignore secondary failures
      }
    }
    for (const [reqKey, p] of rt.pending) {
      const id = p.rpcId ?? parseRpcId(reqKey, sessionId);
      try {
        if (p.kind === "permission") {
          rt.client?.respond(id, { outcome: { outcome: "cancelled" } });
        } else {
          // ask_question / create_plan
          rt.client?.respond(id, { outcome: { outcome: "cancelled" } });
        }
      } catch {
        // ignore respond failures
      }
      p.resolve(undefined);
    }
    rt.pending.clear();
    try {
      await rt.client?.cancel();
    } catch {
      // ignore
    }
    // A deferred MCP restart (restartOnIdle) still needs to run even though
    // the queue was cleared — otherwise the old MCP list survives Stop.
    void dequeueTurn(rt);
  }
  await updateSession(sessionId, { status: "idle" });
}

export async function probeAgent(
  provider?: AgentProvider,
  opts?: { catalogOnly?: boolean },
) {
  const settings = await getSettings();
  const selected = provider ?? settings.defaultProvider;
  const client = new AcpClient(
    selected,
    settings,
    settings.defaultCwd || process.cwd(),
    settings.defaultMode,
  );
  const logs: string[] = [];
  client.on("log", (line: string) => logs.push(line));
  try {
    await client.start(opts?.catalogOnly ? 20_000 : 30_000, {
      catalogOnly: opts?.catalogOnly,
    });
    const acpModels = toModelList(client.configOptions);
    const models = await finalizeModelList(selected, settings, acpModels);
    const modelParams = toModelParams(client.configOptions);
    const modes = toModesList(client.configOptions, selected, client.sessionModes);
    const sessionId = client.sessionId ?? undefined;
    const rawCurrent = findModelConfigOption(client.configOptions)?.currentValue;
    const currentModel = pickCurrentModel(models, rawCurrent);
    if (models.length || modelParams.length || modes.length) {
      rememberModels(selected, currentModel, models, modelParams, modes);
    }
    client.dispose();
    setAgentAvailable(selected, true);
    const paramSummary = modelParams
      .map((p) => `${p.name}: ${modelParamLabel(p.id, p.currentValue ?? "", undefined)}`)
      .filter((s) => !s.endsWith(": "))
      .join(", ");
    return {
      ok: true,
      provider: selected,
      command: providerCommand(settings, selected),
      message: currentModel
        ? `ACP OK. Model: ${modelDisplayName(currentModel)}${paramSummary ? ` · ${paramSummary}` : ""}`
        : `ACP OK — session ${sessionId}`,
      details: logs.join("\n").slice(-1500),
      sessionId,
      currentModel,
      models,
      modelParams,
      modes,
    };
  } catch (err) {
    client.dispose();
    setAgentAvailable(selected, false);
    return {
      ok: false,
      provider: selected,
      command: providerCommand(settings, selected),
      message: err instanceof Error ? err.message : String(err),
      details: `${logs.join("\n")}\n${client.lastStderr}`.slice(-2000),
    };
  }
}

function parseAvailableCommands(raw: Record<string, unknown>) {
  const list = (raw.availableCommands ?? raw.commands ?? []) as unknown[];
  if (!Array.isArray(list)) return [];
  const hidden = new Set(["plugins", "plugin", "manage-plugins", "manage_plugins"]);
  const out: import("@acprocess/shared").SlashCommandDto[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const cmd = item as Record<string, unknown>;
    const name = String(cmd.name ?? "").trim().replace(/^\//, "");
    // Names may carry a `namespace:name` form (OMP skills arrive as `skill:<name>`).
    if (!name || !/^[a-z][\w-]*(?::[a-z][\w-]*)?$/i.test(name)) continue;
    if (hidden.has(name.toLowerCase())) continue;
    const description = String(cmd.description ?? "").trim();
    if (/manage\s+plugins?/i.test(description)) continue;
    if (/^\[[^\]]*\|[^\]]*\]/.test(description)) continue;
    const input = cmd.input;
    const hasInput = Boolean(input && typeof input === "object" && !Array.isArray(input));
    let inputHint = "";
    if (hasInput) {
      const hint = (input as { hint?: string }).hint;
      if (typeof hint === "string") inputHint = hint.trim();
    }
    if (inputHint && /^\[[^\]]*\|[^\]]*\]/.test(inputHint)) {
      inputHint = "";
    }
    out.push({
      name,
      description: description || name,
      ...(hasInput ? { requiresInput: true } : {}),
      ...(inputHint ? { inputHint } : {}),
    });
  }
  return out;
}

function resetAcpClient(rt: SessionRuntime) {
  rt.clientReady = null;
  try {
    rt.client?.dispose();
  } catch {
    // ignore
  }
  rt.client = null;
  rt.provider = null;
  rt.toolsHintSent = false;
  rt.availableCommands = [];
}

/** Last MCP server list we already applied to live sessions (name-keyed). */
let lastMcpSnapshot = "";

/**
 * Restart live ACP sessions so a changed MCP server list actually takes
 * effect. The OMP/Cursor protocol only accepts mcpServers at session/new —
 * there is no runtime update — so a running agent keeps its old MCP tools
 * until its process is re-created. Sessions mid-turn are restarted when they
 * idle (their current turn finishes against the old agent, which is safer
 * than killing a running prompt). Idempotent: no-op unless the effective
 * list changed.
 */
/** Model + params the runtime currently runs with — preserved across restarts. */
function liveModelSnapshot(
  rt: SessionRuntime,
): { model?: string; modelParams?: Record<string, string> } {
  const client = rt.client;
  if (!client) return {};
  const model = findModelConfigOption(client.configOptions)?.currentValue;
  const modelParams: Record<string, string> = {};
  for (const o of listModelParamOptions(client.configOptions)) {
    if (o.currentValue != null && o.currentValue !== "") {
      modelParams[o.id] = o.currentValue;
    }
  }
  return {
    ...(model ? { model } : {}),
    ...(Object.keys(modelParams).length ? { modelParams } : {}),
  };
}

/** Restart one session's agent so it picks up a new MCP list (idle → now, mid-turn → on idle). Returns true when a restart was scheduled. */
export async function restartSessionMcp(sessionId: string): Promise<boolean> {
  const rt = runtimes.get(sessionId);
  if (!rt?.client && !rt?.clientReady) return false; // no live agent
  if (rt.running) {
    rt.restartOnIdle = true;
    return true;
  }
  const detail = await getSessionDetail(sessionId);
  if (!detail?.provider || detail.status === "closed") return false;
  const snapshot = liveModelSnapshot(rt);
  resetAcpClient(rt);
  try {
    await ensureAcp(
      sessionId,
      { provider: detail.provider, cwd: detail.cwd, mode: detail.mode },
      snapshot,
    );
    return true;
  } catch (err) {
    console.error(`[acp:${sessionId}] restart after MCP change failed`, err);
    return false;
  }
}

/**
 * The MCP list is only accepted at session/new|resume|load — a changed config
 * forces a fresh agent process. The resumed session reconnects the new MCP
 * servers, and the current model/params are re-applied verbatim so an MCP
 * edit never silently resets the picker. Sessions mid-turn are restarted when
 * they idle (their current turn finishes against the old agent, which is safer
 * than killing a running prompt). Idempotent: no-op unless the effective
 * list changed.
 */
export async function restartSessionsForMcpChange(): Promise<void> {
  const settings = await getSettings();
  const desired = (settings.mcpServers ?? [])
    .filter((s) => s.enabled && s.url?.trim())
    .map((s) => `${s.name}|${s.type}|${s.url!.trim()}|${s.token ?? ""}`)
    .sort()
    .join("\u0000");
  if (desired === lastMcpSnapshot) return;
  lastMcpSnapshot = desired;

  let restarted = 0;
  for (const sessionId of runtimes.keys()) {
    if (await restartSessionMcp(sessionId)) restarted += 1;
  }
  console.log(`[mcp] config changed — restarted ${restarted} live session(s)`);
}

export function getSessionSlashCommands(sessionId: string) {
  return runtimes.get(sessionId)?.availableCommands ?? [];
}

/**
 * Last known real availability per provider: true only after a successful ACP
 * probe or a completed prompt turn; false on spawn/exit failures. Drives the
 * header indicator — a connected provider is not the same as a working agent.
 */
const agentAvailability = new Map<AgentProvider, boolean>();

function setAgentAvailable(provider: AgentProvider | null | undefined, available: boolean) {
  if (!provider) return;
  const prev = agentAvailability.get(provider);
  if (prev === available) return;
  agentAvailability.set(provider, available);
  broadcastToSession(provider, {
    type: "agent.availability",
    provider,
    available,
  });
}

export function getAgentAvailability(provider?: AgentProvider | null): boolean {
  return provider ? Boolean(agentAvailability.get(provider)) : false;
}

/** Align chat row + ACP with the user's connected agent (if any). */
export async function syncSessionAgent(
  sessionId: string,
  preferredProvider?: AgentProvider | null,
) {
  const detail = await getSessionDetail(sessionId);
  if (!detail) return null;
  const settings = await getSettings();
  const provider = preferredProvider ?? settings.defaultProvider;
  if (!preferredProvider) return detail;
  if (detail.provider === provider) return detail;

  const rt = runtimes.get(sessionId);
  if (rt) resetAcpClient(rt);
  // The stored ACP session belongs to the old provider — a resume would load
  // the wrong agent's context.
  const updated = await updateSession(sessionId, { provider, acpSessionId: null });
  return updated
    ? { ...detail, ...updated, messages: detail.messages }
    : { ...detail, provider };
}

export async function setSessionModel(
  sessionId: string,
  model: string,
  params?: Record<string, string>,
) {
  const patch: { defaultModel: string; defaultModelParams?: Record<string, string> } = {
    defaultModel: model,
  };
  if (params) patch.defaultModelParams = params;
  await updateSettings(patch);

  const detail = await syncSessionAgent(sessionId);
  const rt = runtimes.get(sessionId);
  // Mid-session set_config_option often leaves OMP/Cursor in a broken state
  // ("Model is unavailable"). Restart ACP so the new model applies like a new chat.
  if (rt) resetAcpClient(rt);

  if (!detail) {
    return { ok: true, model, appliedLive: false };
  }

  try {
    const client = await ensureAcp(sessionId, {
      provider: detail.provider,
      cwd: detail.cwd,
      mode: detail.mode,
    });
    const settings = await getSettings();
    const models = await finalizeModelList(
      detail.provider,
      settings,
      toModelList(client.configOptions),
    );
    const modelParams = toModelParams(client.configOptions);
    const modes = toModesList(client.configOptions, detail.provider, client.sessionModes);
    const currentModel = pickCurrentModel(
      models,
      findModelConfigOption(client.configOptions)?.currentValue ?? model,
    );
    rememberModels(detail.provider, currentModel, models, modelParams, modes);
    return {
      ok: true,
      model,
      appliedLive: true,
      restarted: true,
      currentModel,
      models,
      modelParams,
      modes,
    };
  } catch (err) {
    console.error(`[acp:${sessionId}] setSessionModel restart failed`, err);
    return {
      ok: true,
      model,
      appliedLive: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

let modelsCache: {
  provider: AgentProvider;
  currentModel?: string;
  models: Array<{ value: string; name: string }>;
  modelParams: ModelParamDto[];
  modes: ModeOption[];
  at: number;
} | null = null;

export function rememberModels(
  provider: AgentProvider,
  currentModel: string | undefined,
  models: ModelOption[],
  modelParams: ModelParamDto[] = [],
  modes: ModeOption[] = [],
) {
  const filtered = filterDeniedModels(provider, models);
  const resolvedCurrent =
    currentModel && filtered.some((m) => m.value === currentModel)
      ? currentModel
      : filtered[0]?.value;
  modelsCache = {
    provider,
    currentModel: resolvedCurrent,
    models: filtered,
    modelParams,
    modes,
    at: Date.now(),
  };
}

export function clearModelsCache(provider?: AgentProvider) {
  if (!provider || modelsCache?.provider === provider) {
    modelsCache = null;
  }
  if (!provider || paramsProbe?.provider === provider) {
    disposeParamsProbe();
  }
  if (!provider) {
    modelParamsCache.clear();
    modelParamsInflight.clear();
    return;
  }
  for (const key of modelParamsCache.keys()) {
    if (key.startsWith(`${provider}:`)) modelParamsCache.delete(key);
  }
  for (const key of modelParamsInflight.keys()) {
    if (key.startsWith(`${provider}:`)) modelParamsInflight.delete(key);
  }
}

const modelParamsCache = new Map<string, { params: ModelParamDto[]; at: number }>();
const modelParamsInflight = new Map<string, Promise<ModelParamDto[]>>();

let paramsProbe: {
  provider: AgentProvider;
  client: AcpClient;
  boot: Promise<AcpClient>;
} | null = null;

function disposeParamsProbe() {
  if (!paramsProbe) return;
  try {
    paramsProbe.client.dispose();
  } catch {
    // ignore
  }
  paramsProbe = null;
}

async function warmParamsProbeClient(provider: AgentProvider): Promise<AcpClient> {
  if (paramsProbe?.provider === provider) {
    try {
      return await paramsProbe.boot;
    } catch {
      disposeParamsProbe();
    }
  } else if (paramsProbe) {
    disposeParamsProbe();
  }

  const settings = await getSettings();
  const client = new AcpClient(
    provider,
    settings,
    settings.defaultCwd || process.cwd(),
    settings.defaultMode,
  );
  const boot = client
    .start(18_000, { catalogOnly: true })
    .then(() => client)
    .catch((err) => {
      disposeParamsProbe();
      throw err;
    });
  paramsProbe = { provider, client, boot };
  return boot;
}

/** Pre-spawn ACP for Effort/Fast lookups (reused across models). */
export function warmModelParamsProbe(provider?: AgentProvider) {
  void (async () => {
    const settings = await getSettings();
    const selected = provider ?? settings.connectedProvider ?? settings.defaultProvider;
    await warmParamsProbeClient(selected);
  })().catch(() => {
    // best-effort
  });
}

async function probeModelParams(provider: AgentProvider, model: string): Promise<ModelParamDto[]> {
  const client = await warmParamsProbeClient(provider);
  await client.applyModelSelection(model, {});
  return toModelParams(client.configOptions);
}

function modelParamsKey(provider: AgentProvider, model: string) {
  return `${provider}:${model}`;
}

function storeModelParamsCache(provider: AgentProvider, model: string, params: ModelParamDto[]) {
  if (!params.length) return;
  modelParamsCache.set(modelParamsKey(provider, model), { params, at: Date.now() });
  if (modelsCache?.provider === provider) {
    modelsCache = { ...modelsCache, modelParams: params, at: Date.now() };
  }
}

async function readLiveModelParams(sessionId: string, model: string): Promise<ModelParamDto[] | null> {
  const rt = runtimes.get(sessionId);
  if (!rt?.clientReady) return null;
  let client: AcpClient | null = null;
  try {
    client = await rt.clientReady;
  } catch {
    return null;
  }
  if (!client) return null;

  const models = toModelList(client.configOptions);
  const rawCurrent = findModelConfigOption(client.configOptions)?.currentValue;
  const currentModel = pickCurrentModel(models, rawCurrent);
  const { base } = parseModelWire(model);
  const matches =
    currentModel === model ||
    currentModel === base ||
    rawCurrent === model ||
    rawCurrent === base;
  if (!matches) return null;

  const params = toModelParams(client.configOptions);
  return params.length ? params : null;
}

/** Fast Effort/Fast lookup — does not restart the live chat session. */
export async function resolveModelParams(
  provider: AgentProvider,
  model: string,
  opts?: { sessionId?: string; force?: boolean },
): Promise<{ ok: boolean; modelParams: ModelParamDto[]; cached: boolean; live?: boolean; message?: string }> {
  const wire = model.trim();
  if (!wire) return { ok: false, modelParams: [], cached: false, message: "model required" };

  if (!opts?.force && opts?.sessionId) {
    const live = await readLiveModelParams(opts.sessionId, wire);
    if (live?.length) {
      storeModelParamsCache(provider, wire, live);
      return { ok: true, modelParams: live, cached: true, live: true };
    }
  }

  const key = modelParamsKey(provider, wire);
  const ttl = modelsCacheTtlMs(provider);
  if (!opts?.force) {
    const hit = modelParamsCache.get(key);
    if (hit && Date.now() - hit.at < ttl && hit.params.length) {
      return { ok: true, modelParams: hit.params, cached: true };
    }
    const inflight = modelParamsInflight.get(key);
    if (inflight) {
      const params = await inflight;
      return { ok: true, modelParams: params, cached: true };
    }
  } else {
    modelParamsCache.delete(key);
  }

  const probe = (async () => {
    try {
      return await probeModelParams(provider, wire);
    } finally {
      modelParamsInflight.delete(key);
    }
  })();

  modelParamsInflight.set(key, probe);
  try {
    const params = await probe;
    storeModelParamsCache(provider, wire, params);
    return { ok: true, modelParams: params, cached: false };
  } catch (err) {
    return {
      ok: false,
      modelParams: [],
      cached: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function listModels(
  provider?: AgentProvider,
  opts?: { force?: boolean },
) {
  const settings = await getSettings();
  const selected = provider ?? settings.defaultProvider;
  const force = opts?.force === true;
  const cacheTtl = modelsCacheTtlMs(selected);
  if (
    !force &&
    modelsCache &&
    modelsCache.provider === selected &&
    Date.now() - modelsCache.at < cacheTtl &&
    // Empty params may be a cold partial — don't stick for the full TTL.
    (modelsCache.modelParams.length > 0 || Date.now() - modelsCache.at < 20_000) &&
    // Cursor always exposes modes; refresh if an older cache omitted them.
    (selected !== "cursor" || modelsCache.modes.length > 0)
  ) {
    const cache = modelsCache;
    const models = filterDeniedModels(selected, cache.models);
    const preferred = settings.defaultModel || cache.currentModel;
    const currentModel =
      preferred && models.some((m) => m.value === preferred)
        ? preferred
        : cache.currentModel && models.some((m) => m.value === cache.currentModel)
          ? cache.currentModel
          : models[0]?.value;
    warmModelParamsProbe(selected);
    return {
      ok: true,
      provider: selected,
      currentModel,
      models,
      modelParams: cache.modelParams,
      modes: cache.modes,
      cached: true,
    };
  }
  warmModelParamsProbe(selected);
  const probed = await probeAgent(selected, { catalogOnly: !force });
  if (probed.ok && (probed.models?.length || probed.modelParams?.length || probed.modes?.length)) {
    rememberModels(
      selected,
      probed.currentModel,
      probed.models ?? [],
      probed.modelParams ?? [],
      probed.modes ?? [],
    );
  }
  const models = filterDeniedModels(selected, probed.models ?? []);
  const preferred = settings.defaultModel || probed.currentModel;
  const currentModel =
    preferred && models.some((m) => m.value === preferred)
      ? preferred
      : probed.currentModel && models.some((m) => m.value === probed.currentModel)
        ? probed.currentModel
        : models[0]?.value;
  return {
    ok: probed.ok,
    provider: selected,
    currentModel,
    models,
    modelParams: probed.modelParams ?? [],
    modes: probed.modes ?? [],
    message: probed.message,
    cached: false,
  };
}

export async function setSessionMode(sessionId: string, mode: AgentMode) {
  await updateSettings({ defaultMode: mode });
  const detail = await syncSessionAgent(sessionId);
  if (!detail) {
    return { ok: true, mode, appliedLive: false };
  }

  const updated = await updateSession(sessionId, { mode });
  const rt = runtimes.get(sessionId);

  if (rt?.client?.sessionId) {
    // Wait for ACP to accept the mode. Applying in the background let a stale
    // `agent` mode event race back and overwrite the Plan selection in the UI.
    try {
      await rt.client.setMode(mode);
      return { ok: true, mode, appliedLive: true, session: updated };
    } catch (err) {
      console.error(`[acp:${sessionId}] setMode live failed`, err);
      if (!rt.running) {
        resetAcpClient(rt);
        void ensureAcp(sessionId, {
          provider: detail.provider,
          cwd: detail.cwd,
          mode,
        }).catch((warmErr) => {
          console.error(`[acp:${sessionId}] setSessionMode warm failed`, warmErr);
        });
      }
      return { ok: true, mode, appliedLive: false, session: updated };
    }
  }
  if (rt?.running) {
    return { ok: true, mode, appliedLive: false, session: updated };
  }
  if (rt) {
    resetAcpClient(rt);
  }

  // Don't block the UI on a cold ACP spawn — mode is already persisted.
  void ensureAcp(sessionId, {
    provider: detail.provider,
    cwd: detail.cwd,
    mode,
  }).catch((err) => {
    console.error(`[acp:${sessionId}] setSessionMode warm failed`, err);
  });
  return { ok: true, mode, appliedLive: false, session: updated };
}

export function answerPermission(sessionId: string, requestId: string, optionId: string) {
  const rt = runtimes.get(sessionId);
  if (!rt) throw new Error("Runtime not found");
  const pending = rt.pending.get(requestId);
  if (!pending) throw new Error("Permission request not found");

  const id = pending.rpcId ?? parseRpcId(requestId, sessionId);
  console.log(
    `[acp:${sessionId}] permission answer rpcId=${String(id)} optionId=${optionId}`,
  );

  rt.client?.respond(id, {
    outcome: { outcome: "selected", optionId },
  });
  pending.resolve(optionId);
  rt.pending.delete(requestId);
  void updateSession(sessionId, { status: "running" });
}

export function answerQuestion(
  sessionId: string,
  requestId: string,
  result: Record<string, unknown>,
) {
  const rt = runtimes.get(sessionId);
  if (!rt) throw new Error("Runtime not found");
  const pending = rt.pending.get(requestId);
  if (!pending) throw new Error("Question request not found");

  const id = pending.rpcId ?? parseRpcId(requestId, sessionId);

  rt.client?.respond(id, result);
  pending.resolve(result);
  rt.pending.delete(requestId);
  void updateSession(sessionId, { status: "running" });
}

export function disposeRuntime(sessionId: string) {
  const rt = runtimes.get(sessionId);
  if (rt) {
    rt.disposing = true;
    rt.clientReady = null;
    for (const poll of rt.subagentThinkingPoll.values()) {
      clearInterval(poll.timer);
    }
    rt.subagentThinkingPoll.clear();
    rt.client?.dispose();
  }
  runtimes.delete(sessionId);
}
