import path from "node:path";
import { stat } from "node:fs/promises";
import {
  isGenericToolTitle,
  isModelAccessError,
  isPlaceholderSubagentTitle,
  extractSubagentLiveContent,
  modelDisplayName,
  modelParamFamily,
  modelParamLabel,
  modelParamSectionName,
  normalizeToolCallId,
  parseModelWire,
  subagentFieldsFromRaw,
  textFromUnknown,
  toolDisplayTitle,
  type AdapterExtensionKind,
  type AcpUsage,
  type AgentMode,
  type AgentProvider,
  type AppSettings,
  type HarnessAdapter,
  type McpServerConfig,
  type ModelParamDto,
  type SessionDetailDto,
  type SubagentCardUpdate,
} from "@acprocess/shared";
import { defaultSessionTitle, errorMessage, t } from "@acprocess/i18n";
import { getSettings, updateSettings } from "../services/settings.js";
import {
  appendPart,
  appendTextChunk,
  createMessage,
  getPartPayload,
  getSessionDetail,
  replaceUserMessageText,
  truncateMessagesAfter,
  updatePart,
  updateSession,
  saveSessionUsage,
} from "../services/sessions.js";
import { broadcastToSession } from "../services/wsHub.js";
import { adapterCommand, getAdapter } from "../adapters/registry.js";
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
import {
  agentIdFromToolText,
  enrichCursorToolFromStore,
} from "./cursorSubagentLive.js";
import { findRecentCursorAgentId, findRecentCursorAgentIds } from "@acprocess/adapter-cursor";

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

async function applyAgentReportedMode(
  rt: SessionRuntime,
  rawModeId: string,
  opts?: { promptable?: boolean },
) {
  const mode = coerceUiMode(rawModeId);
  if (!mode) return;

  // First report from the agent is the session baseline — apply silently so we
  // don't pop a consent window on every connect/resume or mode echo.
  if (!rt.modeSynced) {
    rt.client?.applyReportedMode(mode);
    rt.modeSynced = true;
    const detail = await getSessionDetail(rt.sessionId);
    if (detail?.mode !== mode) {
      await updateSession(rt.sessionId, { mode });
      await updateSettings({ defaultMode: mode });
    }
    return;
  }

  const detail = await getSessionDetail(rt.sessionId);
  const current = (detail?.mode ?? "agent") as AgentMode;
  // Idempotent echo (e.g. config_options repeating the active mode) — no prompt.
  if (current === mode) {
    rt.client?.applyReportedMode(mode);
    return;
  }

  // Non-promptable genuine change (config sync) — apply silently.
  if (!opts?.promptable) {
    rt.client?.applyReportedMode(mode);
    await updateSession(rt.sessionId, { mode });
    await updateSettings({ defaultMode: mode });
    return;
  }

  // Genuine agent-initiated switch mid-conversation → ask the user first.
  const previousMode = current;
  const rpcId = `switch-mode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const reqKey = requestIdFor(rt.sessionId, rpcId);

  broadcastToSession(rt.sessionId, {
    type: "question.request",
    sessionId: rt.sessionId,
    requestId: reqKey,
    kind: "switch_mode",
    payload: { mode, previousMode },
  });
  await updateSession(rt.sessionId, { status: "waiting" });

  const answer = await new Promise<{ outcome?: string } | undefined>((resolve) => {
    rt.pending.set(reqKey, {
      kind: "switch_mode",
      rpcId: reqKey,
      mode,
      previousMode,
      resolve: (v) => resolve(v as { outcome?: string } | undefined),
    });
  });

  if (answer && answer.outcome === "accepted") {
    rt.client?.applyReportedMode(mode);
    await updateSession(rt.sessionId, { mode });
    await updateSettings({ defaultMode: mode });
  } else {
    // Rejected or cancelled: keep the current mode, best-effort revert on agent side.
    try {
      await rt.client?.setMode(previousMode);
    } catch {
      /* agent may not support a live set_mode */
    }
  }
}

/** Whether an ACP tool `kind` denotes a nested agent for this harness. */
function isSubagentToolKind(adapter: HarnessAdapter | null, kind: string): boolean {
  return adapter ? adapter.subagentToolKinds.includes(kind.trim().toLowerCase()) : false;
}

/** Whether an ACP tool update denotes a nested agent for this harness. */
function isSubagentToolUpdate(
  adapter: HarnessAdapter | null,
  kind: string,
  toolName?: string,
  title?: string,
  raw?: Record<string, unknown>,
): boolean {
  // OMP: the parent Task tool_call is only a spawn shell. Real cards (and live
  // tools) come from `_omp/agents/update` + `_omp/agents/progress`. Treating
  // Task as a subagent left a 3rd card once the shell completed before roster.
  if (adapter?.id === "omp") return false;
  if (isSubagentToolKind(adapter, kind)) return true;
  const name = (toolName ?? "").trim().toLowerCase();
  if (name && (isSubagentToolKind(adapter, name) || name === "task")) return true;
  // Cursor sometimes labels the spawn tool "Task: Subagent task" without kind.
  if (/^task\s*:/i.test((title ?? "").trim())) return true;
  // Cursor Task often arrives as kind=other with description+prompt args.
  if (kind.trim().toLowerCase() === "other" && raw) {
    const args = argsFromRaw(raw) as Record<string, unknown> | undefined;
    if (
      typeof args?.description === "string" &&
      args.description.trim() &&
      typeof args?.prompt === "string" &&
      args.prompt.trim()
    ) {
      return true;
    }
  }
  return false;
}

/** Real tool name from an ACP tool update's raw payload (runtime-narrowed). */
function toolNameFromRaw(raw: Record<string, unknown> | undefined): string | undefined {
  const name = raw?.toolName;
  return typeof name === "string" ? name : undefined;
}

/** Tool call arguments from an ACP update raw (Cursor: `rawInput`). */
function argsFromRaw(raw: Record<string, unknown> | undefined): unknown {
  return raw?.rawInput ?? raw?.input ?? raw?.arguments;
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
  return params.length ? params : paramsFromModelWire(options);
}

/**
 * Cursor embeds per-model params directly in the model option values
 * ("composer-2.5[fast=true]", "grok-4.6[effort=high,fast=true]") instead of
 * exposing separate config options. Synthesize the picker entries from those
 * wires when the agent offers no standalone param options (OMP path above).
 *
 * Cursor only accepts EXACT listed wires, so a param's choices are the values
 * present in the wires of the current model's base — never a cross-model union
 * (a choice that is not listed would be silently rejected on apply).
 */
export function paramsFromModelWire(options: ConfigOption[]): ModelParamDto[] {
  const modelOpt = findModelConfigOption(options);
  const values = (modelOpt?.options ?? []).map((o) => o.value);
  const currentWire = String(modelOpt?.currentValue ?? "");
  const currentBase = parseModelWire(currentWire).base;
  if (!values.length || !currentBase) return [];

  const baseWires = values.filter((v) => parseModelWire(v).base === currentBase);
  if (!baseWires.length) return [];

  // param id → values seen in the current base's wires, in order of appearance.
  const byId = new Map<string, { seen: Map<string, number>; order: number }>();
  let order = 0;
  for (const value of baseWires) {
    for (const [id, v] of Object.entries(parseModelWire(value).params)) {
      let row = byId.get(id);
      if (!row) {
        row = { seen: new Map(), order: order++ };
        byId.set(id, row);
      }
      row.seen.set(v, (row.seen.get(v) ?? 0) + 1);
    }
  }
  if (!byId.size) return [];

  const current = parseModelWire(currentWire).params;
  const rank = (id: string) => {
    const family = modelParamFamily(id);
    if (family === "fast") return 0;
    if (family === "effort") return 1;
    if (family === "context") return 2;
    return 50;
  };
  const out: ModelParamDto[] = [];
  for (const [id, row] of [...byId.entries()].sort(
    (a, b) => rank(a[0]) - rank(b[0]) || a[1].order - b[1].order,
  )) {
    const optionValues = [...row.seen.keys()];
    if (!optionValues.length) continue;
    out.push({
      id,
      name: modelParamSectionName(id, undefined),
      currentValue: current[id] ?? optionValues[0],
      options: optionValues.map((value) => ({
        value,
        name: modelParamLabel(id, value, undefined),
      })),
    });
  }
  return out;
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

function toModesList(
  options: ConfigOption[],
  defaultModes: Array<{ value: string; name: string }>,
  sessionModes?: Array<{ value: string; name: string }>,
): ModeOption[] {
  const modes = listAgentModes(options, defaultModes, sessionModes);
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
  const adapter = getAdapter(provider);
  return adapter.cloudCatalog ? 2 * 60_000 : 24 * 60_000;
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
  kind: AcpRequest["kind"] | "switch_mode";
  /** Original JSON-RPC id from the agent (number | string) — do not re-parse from the URL key. */
  rpcId: string | number;
  /** For synthetic switch_mode consents: requested and previous session mode. */
  mode?: AgentMode;
  previousMode?: AgentMode;
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
  /** Harness adapter for the live ACP process. */
  adapter: HarnessAdapter | null = null;
  /** Exact absolute paths of user-attached files the agent may read outside the cwd. */
  allowedAttachmentFiles = new Set<string>();
  assistantMessageId: string | null = null;
  openTextPartId: string | null = null;
  /** One thought block for the whole turn */
  turnThoughtPartId: string | null = null;
  openThoughtPartId: string | null = null;
  toolPartByCallId = new Map<string, string>();
  /**
   * Raw payload of the first `tool_call` event per call id. Status updates
   * omit the identifying fields (title/toolName/rawInput) — keep the start's
   * fields so display can fall back to a real name or the call's subject.
   */
  toolStartRawByCallId = new Map<string, Record<string, unknown>>();
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
  /** Cursor store.db polls keyed by toolCallId (title/agentId before ACP completes). */
  cursorStorePoll = new Map<string, { timer: NodeJS.Timeout | undefined; inFlight: boolean }>();
  /** Subagents whose terminal transcript snapshot was already attached. */
  subagentTranscriptDone = new Set<string>();
  /** True once the agent has reported its initial mode — later changes prompt for consent. */
  modeSynced = false;
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
  /** Latest ACP-reported token/context usage (null until/if the harness sends it). */
  usage: AcpUsage | null = null;
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
  restoreMode: RestoreMode;
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
  return input.restoreMode;
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
  const adapter = getAdapter(opts.provider);
  if (adapter.restoreMode === "new") {
    return { mode: "new" };
  }
  const mode = pickRestoreMode({
    provider: opts.provider,
    restoreMode: adapter.restoreMode,
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
    const adapter = getAdapter(opts.provider);
    const client = new AcpClient(adapter, settings, opts.cwd, opts.mode);
    rt.client = client;
    rt.provider = opts.provider;
    rt.adapter = adapter;
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

    client.on(
      "extension",
      (ext: { method: string; kind: AdapterExtensionKind; params: Record<string, unknown> }) => {
        void rt.enqueue(async () => {
          await handleExtension(rt, ext);
        });
      },
    );

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
        const modes = toModesList(client.configOptions, getAdapter(opts.provider).defaultModes, client.sessionModes);
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
  if (update.kind === "usage") {
    rt.usage = update.usage;
    await saveSessionUsage(rt.sessionId, update.usage);
    broadcastToSession(rt.sessionId, {
      type: "session.usage",
      sessionId: rt.sessionId,
      usage: update.usage,
    });
    return;
  }

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
    await applyAgentReportedMode(rt, update.modeId, { promptable: true });
    return;
  }

  if (update.kind === "config_options") {
    rt.client?.applyConfigOptionsUpdate(update.configOptions);
    const modeOpt = findModeConfigOption(rt.client?.configOptions ?? update.configOptions);
    if (modeOpt?.currentValue) {
      await applyAgentReportedMode(rt, String(modeOpt.currentValue), { promptable: false });
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
    // Reasoning phases are separate blocks: close the current thought part so
    // thinking emitted after this tool renders as its own "Мысли" block after
    // the tool row, not appended to the pre-tool blob.
    rt.turnThoughtPartId = null;
    rt.openThoughtPartId = null;
    const toolCallId = normalizeToolCallId(update.toolCallId);
    // OMP labels MCP tools generically ("MCP: tool"); the real name rides in
    // `toolName`. Cursor sends neither — its MCP calls only carry the args, so
    // the display falls back to the call's own subject (query/path/…).
    if (toolCallId) rt.toolStartRawByCallId.set(toolCallId, update.raw);
    const title =
      toolDisplayTitle(update.title ?? "", toolNameFromRaw(update.raw), argsFromRaw(update.raw)) ||
      "Tool";
    const kind = String((update.raw.kind as string) ?? "");
    const toolName = toolNameFromRaw(update.raw);
    // OMP Task spawn is redundant with roster cards — skip the shell row.
    if (
      rt.adapter?.id === "omp" &&
      (toolName?.trim().toLowerCase() === "task" || /^task\s*:/i.test((update.title ?? title).trim()))
    ) {
      return;
    }
    const isSubagent = isSubagentToolUpdate(
      rt.adapter,
      kind,
      toolName,
      update.title ?? title,
      update.raw,
    );
    const extra = isSubagent ? subagentFieldsFromRaw(update.raw) : {};
    const kindKey = kind.trim().toLowerCase();
    const displayTitle =
      (extra.title && !isPlaceholderSubagentTitle(extra.title) ? extra.title : "") ||
      (title && !isPlaceholderSubagentTitle(title) && !isGenericToolTitle(title) ? title : "") ||
      (isSubagent ? "Subagent" : title);
    const payload: Record<string, unknown> = {
      toolCallId,
      subagentType:
        (kindKey && kindKey !== "other" ? kind : "") || (isSubagent ? "task" : undefined),
      status:
        isSubagent && (update.status === "pending" || update.status === "in_progress" || !update.status)
          ? "running"
          : (update.status ?? "pending"),
      kind,
      raw: update.raw,
      ...extra,
      // Resolved display title wins over ACP placeholders from extra/raw.
      title: displayTitle,
      description: displayTitle,
    };

    const existingId = toolCallId ? rt.toolPartByCallId.get(toolCallId) : undefined;
    if (existingId) {
      // cursor/task may have arrived first — enrich that one card without clobbering its title.
      const { title: _title, description: _description, ...rest } = payload;
      const named =
        displayTitle && !isPlaceholderSubagentTitle(displayTitle)
          ? { title: displayTitle, description: displayTitle }
          : {};
      await updatePart(
        rt.sessionId,
        existingId,
        { ...rest, ...named },
        isSubagent ? "subagent" : undefined,
      );
      if (isSubagent && toolCallId) {
        rt.subagentPartByAgentId.set(toolCallId, existingId);
        startCursorStorePoll(rt, toolCallId, existingId);
      }
      return;
    }

    const part = await appendPart(
      rt.sessionId,
      messageId,
      isSubagent ? "subagent" : "tool_call",
      payload,
    );
    if (toolCallId) rt.toolPartByCallId.set(toolCallId, part.id);
    if (isSubagent && toolCallId) {
      rt.subagentPartByAgentId.set(toolCallId, part.id);
      startCursorStorePoll(rt, toolCallId, part.id);
    }
    return;
  }

  if (update.kind === "tool_call_update") {
    if (!rt.acceptingStream) return;
    const messageId = await ensureAssistantMessage(rt);
    // Tool boundary — same reasoning-phase split as `tool_call` (idempotent;
    // consecutive thought parts still coalesce on the client).
    rt.turnThoughtPartId = null;
    rt.openThoughtPartId = null;
    const toolCallId = normalizeToolCallId(update.toolCallId);
    const partId = rt.toolPartByCallId.get(toolCallId);
    // Merge with the start event so identifying fields (title/toolName/
    // rawInput/kind) survive the status updates that omit them.
    const startRaw = toolCallId ? rt.toolStartRawByCallId.get(toolCallId) : undefined;
    const mergedRaw = { ...(startRaw ?? {}), ...update.raw };
    if (toolCallId) rt.toolStartRawByCallId.set(toolCallId, mergedRaw);
    const title =
      toolDisplayTitle(
        String(mergedRaw.title ?? ""),
        toolNameFromRaw(mergedRaw),
        argsFromRaw(mergedRaw),
      ) || "Tool";
    const status = update.status ?? "in_progress";
    const kind = String(mergedRaw.kind ?? "");
    const toolName = toolNameFromRaw(mergedRaw);
    // OMP Task spawn shell — no card/row; roster+progress own the UI.
    if (
      rt.adapter?.id === "omp" &&
      !partId &&
      (toolName?.trim().toLowerCase() === "task" || /^task\s*:/i.test(String(mergedRaw.title ?? title).trim()))
    ) {
      return;
    }
    const isSubagent = isSubagentToolUpdate(
      rt.adapter,
      kind,
      toolName,
      String(mergedRaw.title ?? title),
      mergedRaw,
    );
    const extra = isSubagent ? subagentFieldsFromRaw(mergedRaw) : {};
    const kindKey = kind.trim().toLowerCase();
    const displayTitle =
      (extra.title && !isPlaceholderSubagentTitle(extra.title) ? extra.title : "") ||
      (title && !isPlaceholderSubagentTitle(title) && !isGenericToolTitle(title) ? title : "") ||
      (isSubagent ? "Subagent" : title);
    const normalizedStatus =
      isSubagent && (status === "pending" || status === "in_progress")
        ? "running"
        : status;
    // Prefer this update's content when present (ACP replacement snapshot); otherwise
    // fall back to the merged start+update raw so we still see prior chunks.
    const liveRaw =
      update.raw.content !== undefined || update.raw.result !== undefined || update.raw.output !== undefined
        ? update.raw
        : mergedRaw;
    const live = isSubagent ? extractSubagentLiveContent(liveRaw) : { thinking: [], result: "" };
    // Terminal status is final: late async progress must not reopen the card.
    if (status === "completed" || status === "failed") {
      if (toolCallId) rt.terminalToolCallIds.add(toolCallId);
    } else if (toolCallId && rt.terminalToolCallIds.has(toolCallId)) {
      return;
    }
    const livePatch: Record<string, unknown> = {};
    if (live.result) livePatch.result = live.result;
    if (live.thinking.length) {
      if (update.raw.content !== undefined) {
        // Full content snapshot replaces prior thinking from this tool call.
        livePatch.thinking = live.thinking;
      } else if (partId) {
        const prevPayload = await getPartPayload(partId);
        const prev = Array.isArray(prevPayload?.thinking)
          ? (prevPayload!.thinking as string[])
          : [];
        const merged = [...prev];
        for (const block of live.thinking) {
          if (!merged.includes(block)) merged.push(block);
        }
        livePatch.thinking = merged;
      } else {
        livePatch.thinking = live.thinking;
      }
    }
    if (!partId) {
      const part = await appendPart(rt.sessionId, messageId, isSubagent ? "subagent" : "tool_call", {
        toolCallId,
        subagentType:
          (kindKey && kindKey !== "other" ? kind : "") || (isSubagent ? "task" : undefined),
        status: normalizedStatus,
        kind,
        raw: mergedRaw,
        ...extra,
        ...livePatch,
        title: displayTitle,
        description: displayTitle,
      });
      rt.toolPartByCallId.set(toolCallId, part.id);
      if (isSubagent) startCursorStorePoll(rt, toolCallId, part.id);
      return;
    }
    const named =
      displayTitle && !isPlaceholderSubagentTitle(displayTitle)
        ? { title: displayTitle, description: displayTitle }
        : {};
    const agentFromLive =
      isSubagent
        ? agentIdFromToolText(live.result) ||
          agentIdFromToolText(textFromUnknown(mergedRaw.result)) ||
          agentIdFromToolText(textFromUnknown(update.raw.content)) ||
          (typeof mergedRaw.agentId === "string" ? mergedRaw.agentId.trim() : "")
        : undefined;
    if (agentFromLive) {
      rt.subagentPartByAgentId.set(agentFromLive, partId);
      if (rt.adapter?.subagentStreaming && CURSOR_AGENT_UUID_RE.test(agentFromLive)) {
        startSubagentThinkingPoll(rt, agentFromLive);
      }
    }
    await updatePart(
      rt.sessionId,
      partId,
      {
        toolCallId,
        status: normalizedStatus,
        kind,
        raw: mergedRaw,
        ...extra,
        ...livePatch,
        ...named,
        ...(agentFromLive ? { agentId: agentFromLive } : {}),
      },
      isSubagent ? "subagent" : undefined,
    );
    if (isSubagent) {
      if (normalizedStatus === "completed" || normalizedStatus === "failed") {
        clearCursorStorePoll(rt, toolCallId);
        const agentId = agentFromLive || String((await getPartPayload(partId))?.agentId ?? "");
        if (agentId) void stopSubagentThinkingPoll(rt, agentId);
      } else {
        startCursorStorePoll(rt, toolCallId, partId);
      }
    }
    return;
  }

  if (update.kind === "tool_call_content_chunk") {
    if (!rt.acceptingStream) return;
    const toolCallId = normalizeToolCallId(update.toolCallId);
    const partId = rt.toolPartByCallId.get(toolCallId);
    if (!partId) return;
    if (rt.terminalToolCallIds.has(toolCallId)) return;
    const live = extractSubagentLiveContent({ content: update.content });
    if (!live.result && !live.thinking.length) return;
    const prevPayload = await getPartPayload(partId);
    const prevThinking = Array.isArray(prevPayload?.thinking)
      ? (prevPayload!.thinking as string[])
      : [];
    const thinking = [...prevThinking];
    for (const block of live.thinking) {
      if (!thinking.includes(block)) thinking.push(block);
    }
    const prevResult = String(prevPayload?.result ?? "").trim();
    const result = live.result
      ? prevResult
        ? prevResult.endsWith(live.result)
          ? prevResult
          : `${prevResult}\n\n${live.result}`
        : live.result
      : prevResult;
    await updatePart(
      rt.sessionId,
      partId,
      {
        ...(result ? { result } : {}),
        ...(thinking.length ? { thinking } : {}),
        status: "running",
      },
      "subagent",
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

    // Cursor often exposes Task args on the permission request before tool_call
    // content streams — spawn the subagent card immediately with the real title.
    const toolCall = (req.params as { toolCall?: Record<string, unknown> }).toolCall;
    if (toolCall && rt.adapter?.id === "cursor") {
      const kind = String(toolCall.kind ?? "");
      const title = String(toolCall.title ?? "");
      const toolName = toolNameFromRaw(toolCall);
      if (isSubagentToolUpdate(rt.adapter, kind, toolName, title, toolCall)) {
        const toolCallId = String(
          toolCall.toolCallId ?? toolCall.toolCallID ?? toolCall.id ?? "",
        );
        const extra = subagentFieldsFromRaw(toolCall);
        const cardTitle =
          (extra.title && !isPlaceholderSubagentTitle(extra.title) ? extra.title : "") ||
          (title && !isPlaceholderSubagentTitle(title) ? title : "") ||
          "Subagent";
        await rt.enqueue(async () => {
          const messageId = await ensureAssistantMessage(rt);
          await applySubagentCard(
            rt,
            messageId,
            {
              agentId: toolCallId || cardTitle,
              status: "running",
              title: cardTitle,
              description: cardTitle,
              subagentType: "task",
              raw: toolCall,
            },
            toolCallId || undefined,
          );
        });
      }
    }

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
/** Live thinking poll cadence per running subagent. */
const SUBAGENT_THINKING_POLL_MS = 1500;
/** Cursor store.db poll cadence for Task title/agentId while ACP is silent. */
const CURSOR_STORE_POLL_MS = 400;
const CURSOR_AGENT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function clearCursorStorePoll(rt: SessionRuntime, toolCallId: string): void {
  const poll = rt.cursorStorePoll.get(toolCallId);
  if (!poll) return;
  clearInterval(poll.timer);
  rt.cursorStorePoll.delete(toolCallId);
}

/**
 * While Cursor Task runs, ACP often has empty rawInput and no content chunks.
 * Poll `~/.cursor/acp-sessions/<id>/store.db` for description + agentId, then
 * kick off the JSONL transcript drain once the real agent UUID appears.
 */
function startCursorStorePoll(rt: SessionRuntime, toolCallId: string, partId: string): void {
  if (rt.adapter?.id !== "cursor") return;
  if (rt.cursorStorePoll.has(toolCallId)) return;
  const poll = { timer: undefined as NodeJS.Timeout | undefined, inFlight: false };
  rt.cursorStorePoll.set(toolCallId, poll);
  rt.subagentPartByAgentId.set(toolCallId, partId);
  const startedAt = Date.now();

  const tick = async () => {
    if (poll.inFlight) return;
    if (rt.terminalToolCallIds.has(toolCallId)) {
      clearCursorStorePoll(rt, toolCallId);
      return;
    }
    poll.inFlight = true;
    try {
      const detail = await getSessionDetail(rt.sessionId);
      const acpSessionId = rt.client?.sessionId || detail?.acpSessionId || null;
      const prev = (await getPartPayload(partId)) ?? {};
      let enrich = enrichCursorToolFromStore(acpSessionId, toolCallId);
      if (!enrich?.agentId) {
        const bound = new Set(
          [...rt.subagentPartByAgentId.keys()].filter((k) => CURSOR_AGENT_UUID_RE.test(k)),
        );
        const guessed =
          findRecentCursorAgentId({
            cwd: detail?.cwd,
            prompt: String(prev.prompt ?? ""),
            description:
              String(prev.description ?? prev.title ?? "").trim() &&
              !isPlaceholderSubagentTitle(String(prev.description ?? prev.title ?? ""))
                ? String(prev.description ?? prev.title ?? "")
                : "",
            newerThanMs: startedAt - 5_000,
          }) ||
          findRecentCursorAgentIds({
            cwd: detail?.cwd,
            newerThanMs: startedAt - 5_000,
            limit: 4,
            exclude: bound,
          })[0];
        if (guessed) enrich = { ...(enrich ?? {}), agentId: guessed, status: "running" };
      }
      if (!enrich) return;
      const patch: Record<string, unknown> = {};
      if (enrich.description && !isPlaceholderSubagentTitle(enrich.description)) {
        patch.title = enrich.description;
        patch.description = enrich.description;
      }
      if (enrich.prompt && !prev.prompt) patch.prompt = enrich.prompt;
      if (enrich.thinking?.length) patch.thinking = enrich.thinking.slice(0, MAX_SUBAGENT_THINKING_BLOCKS);
      if (enrich.result && enrich.status !== "running") patch.result = enrich.result;
      if (enrich.status) patch.status = enrich.status;
      if (enrich.agentId) {
        patch.agentId = enrich.agentId;
        rt.subagentPartByAgentId.set(enrich.agentId, partId);
        if (rt.adapter?.subagentStreaming && CURSOR_AGENT_UUID_RE.test(enrich.agentId)) {
          startSubagentThinkingPoll(rt, enrich.agentId);
        }
      }
      if (Object.keys(patch).length) {
        const updated = await updatePart(rt.sessionId, partId, patch, "subagent");
        if (!updated) {
          clearCursorStorePoll(rt, toolCallId);
          return;
        }
      }
      if (enrich.status === "completed" || enrich.status === "failed") {
        clearCursorStorePoll(rt, toolCallId);
        if (enrich.agentId) void stopSubagentThinkingPoll(rt, enrich.agentId);
      }
    } catch (err) {
      console.error(`[subagent] cursor store poll failed for ${toolCallId}`, err);
    } finally {
      poll.inFlight = false;
    }
  };

  void tick();
  poll.timer = setInterval(() => {
    void tick();
  }, CURSOR_STORE_POLL_MS);
  poll.timer.unref?.();
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
  const readTranscript = rt.adapter?.readSubagentTranscript;
  if (!client || !readTranscript) {
    clearSubagentThinkingPoll(rt, id);
    return;
  }
  if (poll.inFlight) return;
  poll.inFlight = true;
  try {
    const detail = await getSessionDetail(rt.sessionId);
    const transcriptClient = {
      requestAgent: <T,>(method: string, params: Record<string, unknown>) =>
        client.requestAgent<T>(method, params),
      cwd: detail?.cwd,
      acpSessionId: client.sessionId ?? detail?.acpSessionId ?? undefined,
    };
    let { lastByte, blocks } = poll;
    const tools: Array<{ name: string; args?: string; status?: string }> = [];
    for (let page = 0; page < MAX_SUBAGENT_TRANSCRIPT_PAGES; page++) {
      const res = (await readTranscript(transcriptClient, id, lastByte)) ?? {};
      if (res.reset || !poll.seeded) {
        blocks = [];
        lastByte = 0;
        poll.seeded = true;
      }
      const from = res.fromByte ?? lastByte;
      for (const msg of res.messages ?? []) {
        if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
          const b = block as {
            type?: string;
            thinking?: string;
            name?: string;
            args?: unknown;
            arguments?: unknown;
            input?: unknown;
          };
          const blockType = String(b.type ?? "").toLowerCase().replace(/_/g, "");
          // OMP: `toolCall`; Cursor/Anthropic-style: `tool_use` / `tool-call`.
          if (blockType === "toolcall" || blockType === "tooluse") {
            const name = String(b.name ?? "tool").trim() || "tool";
            const rawArgs = b.args ?? b.arguments ?? b.input;
            const args =
              typeof rawArgs === "string"
                ? rawArgs.trim()
                : rawArgs && typeof rawArgs === "object"
                  ? JSON.stringify(rawArgs).slice(0, 200)
                  : "";
            const prev = tools[tools.length - 1];
            if (!prev || prev.name !== name || prev.args !== args) {
              if (prev?.status === "running") prev.status = "completed";
              tools.push({ name, ...(args ? { args } : {}), status: "running" });
            }
          }
          const thought =
            (b.type === "thinking" || b.type === "reasoning" || b.type === "tool_use") &&
            typeof b.thinking === "string"
              ? b.thinking
              : typeof b.thinking === "string"
                ? b.thinking
                : "";
          const text = thought.trim();
          if (!text) continue;
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
    const prevPayload = await getPartPayload(partId);
    const prevTools = Array.isArray(prevPayload?.tools)
      ? (prevPayload!.tools as Array<{ name: string; args?: string; status?: string }>)
      : [];
    const mergedTools = prevTools.slice();
    for (const tool of tools) {
      const last = mergedTools[mergedTools.length - 1];
      if (last && last.name === tool.name && last.args === tool.args) {
        last.status = tool.status;
      } else {
        if (last?.status === "running") last.status = "completed";
        mergedTools.push(tool);
      }
    }
    const updated = await updatePart(
      rt.sessionId,
      partId,
      {
        thinking: poll.blocks,
        ...(mergedTools.length ? { tools: mergedTools.slice(-40) } : {}),
      },
      "subagent",
    );
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
 * Cursor may flush `agent-transcripts` a beat after Task completes — retry briefly.
 */
async function stopSubagentThinkingPoll(rt: SessionRuntime, id: string): Promise<void> {
  if (rt.subagentTranscriptDone.has(id)) return;
  const poll = rt.subagentThinkingPoll.get(id);
  clearSubagentThinkingPoll(rt, id);
  const partId = rt.subagentPartByAgentId.get(id);
  if (!partId) {
    rt.subagentTranscriptDone.add(id);
    return;
  }
  const empty = { timer: undefined, lastByte: 0, blocks: [], inFlight: false, seeded: false };
  for (let attempt = 0; attempt < 6; attempt++) {
    await drainSubagentThinking(rt, id, poll ?? empty);
    const payload = await getPartPayload(partId);
    const thinking = Array.isArray(payload?.thinking) ? payload!.thinking.length : 0;
    const tools = Array.isArray(payload?.tools) ? payload!.tools.length : 0;
    if (thinking > 0 || tools > 0) break;
    await new Promise((r) => setTimeout(r, 350));
  }
  const finalPayload = await getPartPayload(partId);
  if (Array.isArray(finalPayload?.tools) && finalPayload!.tools.length) {
    const tools = (finalPayload!.tools as Array<Record<string, unknown>>).map((tool) =>
      String(tool.status ?? "") === "running" ? { ...tool, status: "completed" } : tool,
    );
    await updatePart(rt.sessionId, partId, { tools }, "subagent");
  }
  rt.subagentTranscriptDone.add(id);
}

async function handleExtension(
  rt: SessionRuntime,
  ext: { method: string; kind: AdapterExtensionKind; params: Record<string, unknown> },
) {
  const messageId = await ensureAssistantMessage(rt);
  const adapter = rt.adapter;
  switch (ext.kind) {
    case "todos": {
      await appendPart(rt.sessionId, messageId, "todo", ext.params);
      return;
    }
    case "image": {
      await appendPart(rt.sessionId, messageId, "status", { kind: "image", ...ext.params });
      return;
    }
    case "subagent_task": {
      const mapped = adapter?.subagentTaskCard?.(ext.params);
      if (!mapped) return;
      await applySubagentCard(rt, messageId, mapped.card, mapped.toolCallId);
      return;
    }
    case "subagent_roster": {
      const agents = Array.isArray(ext.params.agents)
        ? (ext.params.agents as Record<string, unknown>[])
        : [];
      for (const entry of agents) {
        const card = adapter?.subagentCardFromRoster?.(entry);
        if (!card) continue;
        await applySubagentCard(rt, messageId, card);
      }
      return;
    }
    case "subagent_progress": {
      const entry = (ext.params.agent ?? {}) as Record<string, unknown>;
      const card = adapter?.subagentCardFromProgress?.(entry);
      if (!card) return;
      await applySubagentCard(rt, messageId, card);
      return;
    }
  }
}

/** Card payload the core stores on a subagent part. */
function subagentPayload(card: SubagentCardUpdate): Record<string, unknown> {
  return {
    agentId: card.agentId,
    ...(card.parentId ? { parentId: card.parentId } : {}),
    status: card.status,
    title: card.title,
    description: card.description ?? card.title,
    // Completion / live body — UI reads `result` (not the Task launch `prompt`).
    ...(card.body ? { result: card.body } : {}),
    ...(card.tools?.length ? { tools: card.tools } : {}),
    ...(card.subagentType ? { subagentType: card.subagentType } : {}),
    ...(card.metrics ? { metrics: card.metrics } : {}),
    ...(card.resolvedModel ? { resolvedModel: card.resolvedModel } : {}),
    raw: card.raw,
  };
}

/** Soft-merge so progress ticks don't wipe a better title / prior tools. */
async function mergeSubagentPayload(
  partId: string,
  card: SubagentCardUpdate,
): Promise<Record<string, unknown>> {
  const prev = (await getPartPayload(partId)) ?? {};
  const next = subagentPayload(card);
  const prevTitle = String(prev.title ?? prev.description ?? "").trim();
  const nextTitle = String(next.title ?? next.description ?? "").trim();
  const keepTitle =
    prevTitle &&
    !isPlaceholderSubagentTitle(prevTitle) &&
    (isPlaceholderSubagentTitle(nextTitle) || nextTitle === card.agentId);
  if (keepTitle) {
    next.title = prevTitle;
    next.description = prevTitle;
  }
  const prevTools = Array.isArray(prev.tools) ? (prev.tools as unknown[]) : [];
  const nextTools = Array.isArray(next.tools) ? (next.tools as unknown[]) : [];
  if (nextTools.length && prevTools.length) {
    const merged = prevTools.slice() as Array<Record<string, unknown>>;
    for (const tool of nextTools as Array<Record<string, unknown>>) {
      const name = String(tool.name ?? "");
      const args = String(tool.args ?? "");
      const last = merged[merged.length - 1];
      if (last && String(last.name ?? "") === name && String(last.args ?? "") === args) {
        last.status = tool.status ?? last.status;
      } else {
        if (String(last?.status ?? "") === "running") last.status = "completed";
        merged.push(tool);
      }
    }
    next.tools = merged.slice(-40);
  } else if (!nextTools.length && prevTools.length) {
    // Later roster/progress ticks often omit currentTool — keep what we already saw.
    const kept = prevTools.slice(-40) as Array<Record<string, unknown>>;
    if (card.status === "completed" || card.status === "failed") {
      for (const tool of kept) {
        if (String(tool.status ?? "") === "running") tool.status = "completed";
      }
    }
    next.tools = kept;
  }
  return next;
}

/** Running Task card from this turn that is not yet bound to a registry agent id. */
function findOrphanRunningSubagentPart(rt: SessionRuntime): string | undefined {
  for (const [callId, partId] of rt.toolPartByCallId) {
    // Only Task/subagent shells — never adopt a Shell/Read tool_call as a card.
    if (!rt.subagentPartByAgentId.has(callId)) continue;
    if (rt.terminalToolCallIds.has(callId)) continue;
    // Prefer cards still keyed only by toolCallId (OMP progress uses a different id).
    const bound = [...rt.subagentPartByAgentId.entries()].filter(([, id]) => id === partId);
    const onlyToolKey = bound.length === 0 || bound.every(([key]) => key === callId);
    if (onlyToolKey) return partId;
  }
  return undefined;
}

/** Upsert one normalized subagent card, with the harness's card lifecycle. */
async function applySubagentCard(
  rt: SessionRuntime,
  messageId: string,
  card: SubagentCardUpdate,
  toolCallId?: string,
): Promise<void> {
  let partId: string | undefined;
  // cursor/task and the parallel ACP tool_call share the toolCallId — one card.
  if (toolCallId) {
    const existingToolPart = rt.toolPartByCallId.get(toolCallId);
    if (existingToolPart) {
      await updatePart(
        rt.sessionId,
        existingToolPart,
        await mergeSubagentPayload(existingToolPart, card),
        "subagent",
      );
      partId = existingToolPart;
    }
  }
  if (!partId) {
    const existingId = rt.subagentPartByAgentId.get(card.agentId);
    if (existingId) {
      await updatePart(
        rt.sessionId,
        existingId,
        await mergeSubagentPayload(existingId, card),
        "subagent",
      );
      partId = existingId;
    } else if (card.status === "running" || toolCallId) {
      // OMP: progress/roster id ≠ parent Task toolCallId — adopt the orphan Task card.
      if (!toolCallId) {
        const orphan = findOrphanRunningSubagentPart(rt);
        if (orphan) {
          await updatePart(rt.sessionId, orphan, await mergeSubagentPayload(orphan, card), "subagent");
          partId = orphan;
        }
      }
      if (!partId) {
        const part = await appendPart(rt.sessionId, messageId, "subagent", {
          title: card.title,
          description: card.description ?? card.title,
          ...subagentPayload(card),
        });
        partId = part.id;
        if (toolCallId) rt.toolPartByCallId.set(toolCallId, part.id);
      }
      rt.subagentPartByAgentId.set(card.agentId, partId);
    }
  }
  if (partId) {
    rt.subagentPartByAgentId.set(card.agentId, partId);
    if (toolCallId) rt.subagentPartByAgentId.set(toolCallId, partId);
  }
  // Live thinking stream: drain while running, one final snapshot at terminal.
  if (rt.adapter?.subagentStreaming && partId) {
    if (card.status === "running") {
      if (toolCallId && rt.adapter.id === "cursor") {
        startCursorStorePoll(rt, toolCallId, partId);
      }
      // Cursor JSONL is keyed by agent UUID — don't poll with a toolCallId stand-in.
      if (rt.adapter.id !== "cursor" || CURSOR_AGENT_UUID_RE.test(card.agentId)) {
        startSubagentThinkingPoll(rt, card.agentId);
      }
    } else {
      void stopSubagentThinkingPoll(rt, card.agentId);
      if (toolCallId) clearCursorStorePoll(rt, toolCallId);
    }
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
  rt.toolStartRawByCallId.clear();
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
      ["text", "thought", "tool_call"].includes(p.type),
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
      // Surface only via the composer banner — do not embed in the message thread.
      broadcastToSession(sessionId, { type: "error", sessionId, message: hint });
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
    getAdapter(selected),
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
    const modes = toModesList(client.configOptions, getAdapter(selected).defaultModes, client.sessionModes);
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
      command: adapterCommand(getAdapter(selected), settings),
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
      command: adapterCommand(getAdapter(selected), settings),
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

export function setAgentAvailable(provider: AgentProvider | null | undefined, available: boolean) {
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
    const modes = toModesList(client.configOptions, getAdapter(detail.provider).defaultModes, client.sessionModes);
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
    getAdapter(provider),
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

  // switch_mode is a synthetic consent (the agent already switched on its
  // side), so there is no ACP request to answer — just resolve the waiter.
  if (pending.kind === "switch_mode") {
    pending.resolve(result);
    rt.pending.delete(requestId);
    void updateSession(sessionId, { status: "running" });
    return;
  }

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
    for (const poll of rt.cursorStorePoll.values()) {
      clearInterval(poll.timer);
    }
    rt.cursorStorePoll.clear();
    rt.client?.dispose();
  }
  runtimes.delete(sessionId);
}
