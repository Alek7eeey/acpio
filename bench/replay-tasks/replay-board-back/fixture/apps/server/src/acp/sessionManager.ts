import path from "node:path";
import { stat } from "node:fs/promises";
import {
  isGenericToolTitle,
  isModelAccessError,
  isTokenizerEncodingError,
  tokenizerEncodingErrorHint,
  isPlaceholderSubagentTitle,
  extractSubagentLiveContent,
  modelDisplayName,
  modelForProvider,
  modelForSession,
  modelParamFamily,
  modelParamLabel,
  modelParamSectionName,
  modelParamsForProvider,
  modelParamsForSession,
  modelProviderFromValue,
  normalizeToolCallId,
  parseModelWire,
  modelIdFromValue,
  subagentFieldsFromRaw,
  textFromUnknown,
  toolDisplayTitle,
  type AdapterExtensionKind,
  type AcpUsage,
  type AgentMode,
  type AgentProvider,
  type AppSettings,
  type HarnessAdapter,
  type HarnessSessionDto,
  type ModelOption,
  type ModelParamDto,
  type SessionDetailDto,
  type SessionDto,
  type SlashCommandDto,
  type SubagentCardUpdate,
  titleFromUserText,
  effectiveMcpServers,
  mcpServerEndpoint,
  mcpServersFingerprint,
  permissionOptionsLookLikeQuestion,
  questionPayloadFromPermission,
  elicitationResponseFromUiOutcome,
  elicitationSchemaToQuestionPayload,
  summarizeQuestionAnswer,
  type ElicitationQuestionPayload,
  type ElicitationRequestedSchema,
} from "@acpio/shared";
import { defaultSessionTitle, errorMessage, t } from "@acpio/i18n";
import { getSettings, updateSettings } from "../services/settings.js";
import { discoverProjectMcp } from "../services/projectMcp.js";
import { appendDeepLog } from "../services/deepLogging.js";
import {
  appendPart,
  appendTextChunk,
  createMessage,
  createSession,
  getPartPayload,
  getSessionDetail,
  listSessions,
  replaceUserMessageText,
  truncateMessagesAfter,
  updatePart,
  updateSession,
  saveSessionUsage,
  markBoardTaskStarted,
} from "../services/sessions.js";
import { broadcastToSession } from "../services/wsHub.js";
import { adapterCommand, adapters, getAdapter } from "../adapters/registry.js";
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
import { findRecentCursorAgentId, findRecentCursorAgentIds, listCursorAcpSessions } from "@acpio/adapter-cursor";
import { listOmpSessions, readOmpSessionTranscript } from "@acpio/adapter-omp";
import {
  isAgentSlashPrompt,
  mergeSlashCommandLists,
  parseAvailableCommands,
  parseSlashPrompt,
} from "./slashCommands.js";

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
      client: rt.client ?? null,
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

function sortModelParams<T extends { id: string }>(params: T[]): T[] {
  const rank = (id: string) => {
    const family = modelParamFamily(id);
    if (family === "fast") return 0;
    if (family === "effort") return 1;
    if (family === "context") return 2;
    return 50;
  };
  return [...params].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

export function toModelParams(options: ConfigOption[]): ModelParamDto[] {
  const standalone = listModelParamOptions(options).map((o) => ({
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
  const fromWire = paramsFromModelWire(options);
  if (!standalone.length) return fromWire;
  if (!fromWire.length) return sortModelParams(standalone);

  const seenIds = new Set(standalone.map((p) => p.id));
  const seenFamilies = new Set(
    standalone.map((p) => modelParamFamily(p.id)).filter((f): f is NonNullable<typeof f> => f != null),
  );
  const extra = fromWire.filter((p) => {
    if (seenIds.has(p.id)) return false;
    const family = modelParamFamily(p.id);
    if (family && seenFamilies.has(family)) return false;
    return true;
  });
  return sortModelParams([...standalone, ...extra]);
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

type ModeOption = { value: string; name: string };

function toModelList(options: ConfigOption[]): ModelOption[] {
  const modelOpt = findModelConfigOption(options);
  return (modelOpt?.options ?? []).map((o) => ({
    value: o.value,
    name: modelDisplayName(o.value, o.name),
    provider: modelProviderFromValue(o.value),
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
  if (modelsCacheFor(provider)) {
    const cache = modelsCacheFor(provider)!;
    const models = filterDeniedModels(provider, cache.models);
    const currentModel =
      cache.currentModel && !denied.has(cache.currentModel)
        ? cache.currentModel
        : models[0]?.value;
    rememberModels(provider, currentModel, models, cache.modelParams, cache.modes);
  }
}

function modelsCacheTtlMs(provider: AgentProvider): number {
  // A session may outlive its custom agent; fall back to the quiet TTL.
  const adapter = adapters.get(provider);
  return adapter?.cloudCatalog ? 2 * 60_000 : 24 * 60_000;
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
  /**
   * ACP client the request belongs to. A different (or missing) live client
   * means the original RPC is gone — a restarted server or respawned harness —
   * so the reply cannot be delivered and the turn must be re-driven instead.
   */
  client?: AcpClient | null;
  /** Question UI shown, but the ACP reply must use permission outcome shape. */
  respondAsPermission?: boolean;
  /** Form elicitation/create mapped to the inline question UI. */
  respondAsElicitation?: boolean;
  elicitationPayload?: ElicitationQuestionPayload;
  /** Set when this turn showed at least one form elicitation prompt. */
  elicitationTurn?: boolean;
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
  availableCommands: import("@acpio/shared").SlashCommandDto[] = [];
  pending = new Map<string, PendingRequest>();
  running = false;
  /** True from the moment a prompt is accepted until its turn actually starts.
   *  The ACP cold start (spawn + initialize) can take seconds, and `running` is
   *  only set inside runTurn — without this flag both `GET /sessions/:id/turn`
   *  and the warm-up boot write believe nothing is happening, so a reloaded tab
   *  paints a starting agent as finished until the first WS status arrives. */
  startingTurn = false;
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
  /** Last session/update that belongs to the current prompt (tools included). */
  lastStreamAt = 0;
  /** Persist session/load replay into an empty local chat (imported harness session). */
  ingestingReplay = false;
  ingestLastRole: "user" | "assistant" | null = null;
  ingestUserMessageId: string | null = null;
  ingestUserPartId: string | null = null;
  toolsHintSent = false;
  /** True when the current turn registered an ACP form elicitation prompt. */
  elicitationThisTurn = false;
  /** Latest ACP-reported token/context usage (null until/if the harness sends it). */
  usage: AcpUsage | null = null;
  /** True while we intentionally tear down ACP (e.g. edit/regenerate). */
  disposing = false;
  /** This turn received an answer text chunk (vs. only thinking so far). */
  turnHasText = false;
  /** This turn received a thinking chunk. */
  turnHasThought = false;
  /** In-flight tool/subagent calls for this turn (drives stream settle). */
  inFlightToolCalls = 0;
  toolStatusByCallId = new Map<string, string>();
  /** Set when the user answers an elicitation — OMP may spawn /review work seconds later. */
  interactiveAnswerAt: number | null = null;
  /** True once ACP streamed thought/text/tools after the interactive answer. */
  streamedAfterInteractiveAnswer = false;
  /** MCP config changed while a turn was running — restart the agent when it idles. */
  restartOnIdle = false;
  /** Model+params to apply on the idle restart (set alongside restartOnIdle by setSessionModel). */
  restartOnIdleModel: { model: string; modelParams?: Record<string, string> } | undefined =
    undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(public readonly sessionId: string) {}

  /** Serialize ACP update handlers to avoid racey part creation per token. */
  enqueue(task: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(task, task);
    return this.chain;
  }
}

const runtimes = new Map<string, SessionRuntime>();

/**
 * MCP list fingerprint currently applied to each live agent session. Needed to
 * restart only the chats whose effective list actually changed — a folder edit
 * must not respawn agents in unrelated folders.
 */
const appliedMcpFingerprints = new Map<string, string>();

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
  forceRestore?: boolean;
}): RestoreMode {
  if (input.forceRestore && input.hasStoredSession) {
    return input.restoreMode === "new" ? "new" : input.restoreMode;
  }
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
  forceRestore = false,
): { mode: RestoreMode; storedSessionId?: string } {
  if (!forceRestore && (preferResume === false || !settings.resumeAgentContext)) {
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
    forceRestore,
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
    /** Open a stored harness session even if resume-on-restart is off. */
    forceRestore?: boolean;
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
  const bootModel =
    boot?.model ??
    (detail ? modelForSession(settings, detail) : modelForProvider(settings, opts.provider));
  const bootParams =
    boot?.modelParams ??
    (detail
      ? modelParamsForSession(settings, detail)
      : modelParamsForProvider(settings, opts.provider));
  const bootModelOpts = {
    model: bootModel || undefined,
    modelParams: Object.keys(bootParams).length ? bootParams : undefined,
  };
  const { mode: restoreMode, storedSessionId } = resolveRestoreMode(
    opts,
    settings,
    boot?.preferResume ?? true,
    detail,
    boot?.forceRestore,
  );
  // This chat's MCP list: global (minus folder-disabled ids, plus the
  // folder's own servers and the servers its MCP files declare) minus ids
  // disabled for this chat.
  const mcpServers = effectiveMcpServers(settings, detail?.mcpDisabledIds, opts.cwd, [
    ...(await discoverProjectMcp(opts.cwd, settings.mcpProjectFiles)).servers,
  ]);
  appliedMcpFingerprints.set(sessionId, mcpServersFingerprint(mcpServers));

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
      // Deliberate restart (MCP/model/provider change): drop the dead prompts so
      // a deferred restart and the turn queue aren't wedged. The question parts
      // stay in the DB and remain answerable — answering one re-drives the turn.
      if (intentional) {
        for (const [reqKey, p] of rt.pending) {
          if (p.client && p.client !== client) continue;
          p.resolve(undefined);
          rt.pending.delete(reqKey);
        }
      }
      // One chat's process dying is not "the harness is gone" — a parallel
      // probe or a Cursor singleton restart used to flip the header LED.
      // A crash with an open question is a different thing: the session stays
      // "waiting" so the question can still be answered (see runTurn's catch).
      if (!intentional && rt.pending.size === 0) {
        await updateSession(sessionId, { status: "closed" });
      }
    });

    client.on("update", (update) => {
      const gen = rt.streamGen;
      if (
        rt.acceptingStream &&
        (update.kind === "agent_message_chunk" ||
          update.kind === "agent_thought_chunk" ||
          update.kind === "mixed_chunks" ||
          update.kind === "tool_call" ||
          update.kind === "tool_call_update" ||
          update.kind === "tool_call_content_chunk")
      ) {
        rt.lastStreamAt = Date.now();
      }
      void rt.enqueue(async () => {
        try {
          const isStream =
            update.kind === "agent_message_chunk" ||
            update.kind === "agent_thought_chunk" ||
            update.kind === "mixed_chunks";
          // Drop tokens from a cancelled / superseded prompt (including chunks that
          // arrive AFTER Stop — the old epoch check only ignored pre-queued ones).
          if (isStream && !rt.ingestingReplay && (!rt.acceptingStream || rt.streamGen !== gen)) {
            return;
          }
          if (
            rt.interactiveAnswerAt != null &&
            (update.kind === "agent_message_chunk" ||
              update.kind === "agent_thought_chunk" ||
              update.kind === "mixed_chunks" ||
              update.kind === "tool_call" ||
              update.kind === "tool_call_update" ||
              update.kind === "tool_call_content_chunk")
          ) {
            rt.streamedAfterInteractiveAnswer = true;
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
        const ingestReplay = mode !== "new" && (detail?.messages.length ?? 0) === 0;
        rt.ingestingReplay = ingestReplay;
        rt.ingestLastRole = null;
        rt.ingestUserMessageId = null;
        rt.ingestUserPartId = null;
        try {
          // Restore boots get a bigger budget: Cursor's session/load replays the
          // whole stored conversation before responding.
          await client.start(
            mode === "new" ? 45_000 : 120_000,
            mode === "new"
              ? { ...bootModelOpts, mcpServers }
              : {
                  resume: { sessionId: storedSessionId!, mode },
                  ingestReplay,
                  ...bootModelOpts,
                  mcpServers,
                },
          );
        } finally {
          rt.ingestingReplay = false;
        }
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
        client.logContext = {
          sessionId,
          provider: opts.provider,
          cwd: opts.cwd,
          model: currentModel,
        };
        appendDeepLog({
          kind: "session-boot",
          sessionId,
          provider: opts.provider,
          cwd: opts.cwd,
          model: currentModel,
          data: {
            acpSessionId: client.sessionId,
            mode: opts.mode,
            restoreMode: mode,
            mcpServers: mcpServers.map((s) => ({
              name: s.name,
              type: s.type,
              endpoint: mcpServerEndpoint(s),
            })),
            model: bootModelOpts.model,
            modelParams: bootModelOpts.modelParams,
          },
        });
        setAgentAvailable(opts.provider, true);
        if (paramsProbe?.provider === opts.provider) disposeParamsProbe();
        await updateSession(sessionId, {
          acpSessionId: client.sessionId,
          // Don't clobber an in-flight prompt if warm-up finishes during runPrompt,
          // and don't unlock a chat that is parked on an unanswered question —
          // merely opening it must not pretend the agent is done asking. `startingTurn`
          // covers the gap before runTurn flips `running`: the POST /prompt's own
          // cold start finishing here would otherwise write "idle" over its
          // "running", and a reloaded tab would restore the chat as finished.
          ...(rt.running || rt.startingTurn || hasPendingQuestion(detail)
            ? {}
            : { status: "idle" as const }),
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
      const locale = (await getSettings()).locale ?? "en";
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
        const failLabel =
          locale === "ru"
            ? "⚠ Не удалось возобновить сессию — запускаем новую…"
            : "⚠ Resume failed — starting a new session…";
        console.error(`[acp:${sessionId}] ${failLabel}`);
        // Import/restore must keep the stored harness id. Falling back to
        // session/new would replace it with an empty conversation.
        if (boot?.forceRestore) throw err;
        return startClient("new");
      }
      const errText = err instanceof Error ? err.message : String(err);
      const errLabel =
        locale === "ru" ? `Ошибка запуска агента: ${errText}` : `Agent start failed: ${errText}`;
      console.error(`[acp:${sessionId}] ${errLabel}`);
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

/** Harness sessions that are not already rows in the chat tree. */
export async function listUnlinkedHarnessSessions(
  provider: AgentProvider,
  cwd?: string,
): Promise<HarnessSessionDto[]> {
  const byId = new Map<string, HarnessSessionDto>();

  try {
    const known = await listSessions();
    const exclude = new Set(
      known.map((s) => s.acpSessionId).filter((id): id is string => Boolean(id)),
    );

    // Disk is the source of truth. Live `session/list` only sees the current
    // ACP process (sessions created in this app) and crowds out native CLI/TUI chats.

    if (provider === "omp") {
      try {
        for (const row of await listOmpSessions({ cwd, excludeIds: exclude, limit: 24 })) {
          if (byId.has(row.sessionId)) {
            const prev = byId.get(row.sessionId)!;
            byId.set(row.sessionId, {
              ...prev,
              cwd: prev.cwd || row.cwd,
              title: prev.title || row.title,
              updatedAt: prev.updatedAt || row.updatedAt,
            });
          } else {
            byId.set(row.sessionId, {
              provider,
              acpSessionId: row.sessionId,
              cwd: row.cwd,
              title: row.title,
              updatedAt: row.updatedAt,
            });
          }
        }
      } catch (err) {
        console.log(`[acp] omp session scan failed: ${String(err)}`);
      }
    }

    if (provider === "cursor") {
      try {
        for (const row of await listCursorAcpSessions({ cwd, excludeIds: exclude, limit: 24 })) {
          if (byId.has(row.sessionId)) {
            const prev = byId.get(row.sessionId)!;
            byId.set(row.sessionId, {
              ...prev,
              cwd: prev.cwd || row.cwd,
              title: prev.title || row.title,
              updatedAt: prev.updatedAt || row.updatedAt,
            });
          } else {
            byId.set(row.sessionId, {
              provider,
              acpSessionId: row.sessionId,
              cwd: row.cwd,
              title: row.title,
              updatedAt: row.updatedAt,
            });
          }
        }
      } catch (err) {
        console.log(`[acp] cursor session scan failed: ${String(err)}`);
      }
    }
  } catch (err) {
    console.error("[acp] listUnlinkedHarnessSessions failed", err);
    return [];
  }

  return [...byId.values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 24);
}

export async function importHarnessSession(input: {
  provider: AgentProvider;
  acpSessionId: string;
  cwd?: string;
  title?: string;
}): Promise<SessionDetailDto | SessionDto> {
  const acpSessionId = input.acpSessionId.trim();
  if (!acpSessionId) {
    throw Object.assign(new Error("acpSessionId required"), { statusCode: 400 });
  }
  const known = await listSessions();
  const existing = known.find((s) => s.acpSessionId === acpSessionId);
  if (existing) {
    throw Object.assign(new Error("alreadyInTree"), { statusCode: 409, sessionId: existing.id });
  }
  const settings = await getSettings();
  const disk =
    input.provider === "omp" ? await readOmpSessionTranscript(acpSessionId) : null;
  const cwd = (input.cwd || disk?.cwd || settings.defaultCwd || process.cwd()).trim();
  const title = (
    input.title ||
    disk?.title ||
    disk?.turns.find((turn) => turn.role === "user")?.text.split(/\r?\n/)[0] ||
    ""
  )
    .trim()
    .slice(0, 500);
  const session = await createSession({
    title: title || undefined,
    provider: input.provider,
    cwd,
    mode: settings.defaultMode,
    acpSessionId,
  });
  if (disk?.turns.length) {
    try {
      await ingestImportedTranscript(session.id, disk.turns);
    } catch (err) {
      console.error(`[acp:${session.id}] omp transcript import failed`, err);
    }
  }
  void ensureAcp(
    session.id,
    { provider: session.provider, cwd: session.cwd, mode: session.mode },
    { preferResume: true, forceRestore: true },
  ).catch((err) => {
    console.error(`[acp:${session.id}] import warm failed`, err);
  });
  return (await getSessionDetail(session.id)) ?? session;
}

async function ingestImportedTranscript(
  sessionId: string,
  turns: Array<{ role: "user" | "assistant"; text: string; thought?: string }>,
) {
  for (const turn of turns) {
    const msg = await createMessage(sessionId, turn.role);
    if (turn.role === "assistant" && turn.thought?.trim()) {
      await appendPart(sessionId, msg.id, "thought", { text: turn.thought });
    }
    if (turn.text.trim()) {
      await appendPart(sessionId, msg.id, "text", { text: turn.text });
    }
  }
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
    const parsed = parseAvailableCommands(update.raw);
    rt.availableCommands = mergeSlashCommandLists(rt.availableCommands, parsed);
    rememberSessionCommands(rt.sessionId, rt.availableCommands);
    appendDeepLog({
      kind: "available-commands",
      sessionId: rt.sessionId,
      provider: rt.provider ?? undefined,
      data: {
        commands: parsed.map((cmd) => ({
          name: cmd.name,
          kind: cmd.kind,
          description: cmd.description,
        })),
        skills: parsed.filter((cmd) => cmd.kind === "skill").map((cmd) => cmd.name),
      },
    });
    broadcastToSession(rt.sessionId, {
      type: "commands.updated",
      sessionId: rt.sessionId,
      commands: getSessionSlashCommands(rt.sessionId),
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
  if (update.kind === "session_info" || update.kind === "other") {
    return;
  }

  if (update.kind === "user_message_chunk") {
    if (!rt.ingestingReplay || !update.text) return;
    if (rt.ingestLastRole !== "user" || !rt.ingestUserMessageId) {
      const msg = await createMessage(rt.sessionId, "user");
      rt.ingestUserMessageId = msg.id;
      rt.ingestUserPartId = null;
      rt.assistantMessageId = null;
      rt.openTextPartId = null;
      rt.ingestLastRole = "user";
    }
    rt.ingestUserPartId = await appendTextChunk(
      rt.sessionId,
      rt.ingestUserMessageId,
      "text",
      update.text,
      rt.ingestUserPartId,
    );
    return;
  }

  if (update.kind === "agent_message_chunk") {
    if (!rt.acceptingStream && !rt.ingestingReplay) return;
    if (!update.text) return;
    if (rt.ingestingReplay) {
      rt.ingestLastRole = "assistant";
      rt.ingestUserMessageId = null;
    }
    const messageId = await ensureAssistantMessage(rt);
    // Continue same text part for the turn; tools may split later via clearing openTextPartId
    rt.turnHasText = true;
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
    if (!rt.acceptingStream && !rt.ingestingReplay) return;
    if (rt.ingestingReplay) {
      rt.ingestLastRole = "assistant";
      rt.ingestUserMessageId = null;
    }
    const messageId = await ensureAssistantMessage(rt);
    if (update.thought) {
      rt.turnHasThought = true;
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
      rt.turnHasText = true;
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
    if (!rt.acceptingStream && !rt.ingestingReplay) return;
    if (!update.text) return;
    if (rt.ingestingReplay) {
      rt.ingestLastRole = "assistant";
      rt.ingestUserMessageId = null;
    }
    const messageId = await ensureAssistantMessage(rt);
    // Always one reasoning block per turn
    rt.turnHasThought = true;
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
      trackToolFlight(rt, toolCallId, update.status ?? "pending");
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
    trackToolFlight(rt, toolCallId, String(payload.status ?? "pending"));
    return;
  }

  if (update.kind === "tool_call_update") {
    const status = update.status ?? "in_progress";
    const terminal = status === "completed" || status === "failed";
    // Late completion can arrive after runTurn flipped acceptingStream off (elicitation race).
    if (!rt.acceptingStream && !terminal) return;
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
    const kind = String(mergedRaw.kind ?? "");
    const toolName = toolNameFromRaw(mergedRaw);
    // OMP Task spawn shell — no card/row; roster+progress own the UI.
    if (
      rt.adapter?.id === "omp" &&
      !partId &&
      (toolName?.trim().toLowerCase() === "task" || /^task\s*:/i.test(String(mergedRaw.title ?? title).trim()))
    ) {
      trackToolFlight(rt, toolCallId, status);
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
      trackToolFlight(rt, toolCallId, String(normalizedStatus));
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
    trackToolFlight(rt, toolCallId, String(normalizedStatus));
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

  if (req.kind === "elicitation") {
    rt.lastStreamAt = Date.now();
    rt.elicitationThisTurn = true;
    const mode = String(req.params.mode ?? "form");
    if (mode !== "form") {
      rt.client?.respond(req.id, { action: "decline" });
      return;
    }
    const boundSessionId = String(req.params.sessionId ?? "");
    if (boundSessionId && rt.client?.sessionId && boundSessionId !== rt.client.sessionId) {
      rt.client?.respond(req.id, { action: "cancel" });
      return;
    }
    const message = String(req.params.message ?? "");
    const requestedSchema = (req.params.requestedSchema ?? {
      type: "object",
      properties: {},
    }) as ElicitationRequestedSchema;
    const elicitationPayload = elicitationSchemaToQuestionPayload(message, requestedSchema);
    const uiPayload = {
      title: elicitationPayload.title,
      questions: elicitationPayload.questions,
      elicitation: true,
    };
    // Register pending before any await — runTurn can return from session/prompt
    // while elicitation is still in flight; settlePromptStream must see pending>0.
    const answered = registerInteractivePending(rt, reqKey, {
      kind: "elicitation",
      rpcId: req.id,
      respondAsElicitation: true,
      elicitationPayload,
    });
    appendDeepLog({
      kind: "elicitation-create",
      sessionId: rt.sessionId,
      data: { requestId: reqKey, message, requestedSchema },
    });
    const messageId = await ensureAssistantMessage(rt);
    await appendPart(rt.sessionId, messageId, "question", {
      requestId: reqKey,
      pending: true,
      ...uiPayload,
    });
    await updateSession(rt.sessionId, { status: "waiting" });
    broadcastToSession(rt.sessionId, {
      type: "question.request",
      sessionId: rt.sessionId,
      requestId: reqKey,
      kind: "ask_question",
      payload: uiPayload,
    });
    await answered;
    return;
  }

  if (req.kind === "permission") {
    const options =
      ((req.params as { options?: Array<{ optionId: string; kind?: string; name?: string }> }).options ??
        []) as Array<{ optionId: string; kind?: string; name?: string }>;

    const coercedQuestion =
      rt.adapter?.coercePermissionToQuestion?.(req.params) ??
      (permissionOptionsLookLikeQuestion(options)
        ? questionPayloadFromPermission(req.params, options)
        : null);
    if (coercedQuestion) {
      const answered = registerInteractivePending(rt, reqKey, {
        kind: "ask_question",
        rpcId: req.id,
        respondAsPermission: true,
      });
      await rt.enqueue(async () => {
        const messageId = await ensureAssistantMessage(rt);
        await appendPart(rt.sessionId, messageId, "question", {
          requestId: reqKey,
          pending: true,
          ...coercedQuestion,
        });
      });
      await updateSession(rt.sessionId, { status: "waiting" });
      broadcastToSession(rt.sessionId, {
        type: "question.request",
        sessionId: rt.sessionId,
        requestId: reqKey,
        kind: "ask_question",
        payload: coercedQuestion,
      });
      await answered;
      return;
    }

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

    console.log(`[acp:${rt.sessionId}] permission pending rpcId=${String(req.id)}`);
    const permissionAnswered = registerInteractivePending(rt, reqKey, {
      kind: "permission",
      rpcId: req.id,
    });
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
    await permissionAnswered;
    return;
  }

  const interactiveAnswered = registerInteractivePending(rt, reqKey, {
    kind: req.kind,
    rpcId: req.id,
  });
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

  await interactiveAnswered;
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
      let enrich = await enrichCursorToolFromStore(acpSessionId, toolCallId);
      if (!enrich?.agentId) {
        const bound = new Set(
          [...rt.subagentPartByAgentId.keys()].filter((k) => CURSOR_AGENT_UUID_RE.test(k)),
        );
        const guessed =
          (await findRecentCursorAgentId({
            cwd: detail?.cwd,
            prompt: String(prev.prompt ?? ""),
            description:
              String(prev.description ?? prev.title ?? "").trim() &&
              !isPlaceholderSubagentTitle(String(prev.description ?? prev.title ?? ""))
                ? String(prev.description ?? prev.title ?? "")
                : "",
            newerThanMs: startedAt - 5_000,
          })) ||
          (
            await findRecentCursorAgentIds({
              cwd: detail?.cwd,
              newerThanMs: startedAt - 5_000,
              limit: 4,
              exclude: bound,
            })
          )[0];
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
  const locale = settings.locale ?? "en";
  let rt = getRuntime(sessionId);
  // Claim the turn BEFORE any await: from here on, both `GET /sessions/:id/turn`
  // and the warm-up boot write must treat this chat as busy. The row itself is
  // flipped to "running" right after — a reload that races the cold start then
  // restores "working" from the list/detail fetch alone, not only from a later
  // WS frame. runTurn's own running=true takes over; every early exit clears it.
  rt.startingTurn = true;
  // Persist the busy state too (not just in memory): a reload reads the list and
  // the detail row, and both must already say "running".
  await updateSession(sessionId, { status: "running" }).catch(() => {});
  // Board task: the first claimed turn stamps the Todo ⇄ Wait "work began" mark.
  await markBoardTaskStarted(sessionId).catch(() => {});
  let promptUserText = text;
  let priorTranscript = "";
  let userMessageId: string | null = null;

  if (opts.editMessageId) {
    const detailBefore = await getSessionDetail(sessionId);
    if (!detailBefore) {
      rt.startingTurn = false;
      await updateSession(sessionId, { status: "idle" }).catch(() => {});
      throw Object.assign(new Error("Session not found"), { statusCode: 404 });
    }
    const target = detailBefore.messages.find((m) => m.id === opts.editMessageId);
    if (!target || target.role !== "user") {
      rt.startingTurn = false;
      await updateSession(sessionId, { status: "idle" }).catch(() => {});
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
    rt.startingTurn = true;
  }

  // A deferred restart (mid-turn MCP/model edit) must land BEFORE the next
  // turn: a direct prompt would otherwise run on the stale agent with the old
  // MCP list/model (the same race dequeueTurn already guards for queued turns).
  if (rt.restartOnIdle) {
    rt.restartOnIdle = false;
    await applyDeferredRestart(rt);
  }

  // Kick off ACP as early as possible (spawn overlaps with persisting the user message).
  // Edit/regenerate must NOT resume: the agent's on-disk session still holds the
  // OLD transcript (including the reply being replaced) — fresh context is correct.
  const acpReady = ensureAcp(sessionId, opts, { preferResume: !opts.editMessageId });
  // Failures before runTurn never hit its finalize path — without restoring the
  // row here, a rejected cold start (or any persist error) would strand the chat
  // in "running" forever and lock the composer. Once runTurn owns the turn it
  // finalizes status itself, so the claim is only released while `startingTurn`
  // is still set.
  const settlePreTurnClaim = () => {
    if (!rt.startingTurn) return;
    rt.startingTurn = false;
    void updateSession(sessionId, { status: rt.pending.size > 0 ? "waiting" : "idle" }).catch(
      () => {},
    );
  };
  try {
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
    const title = titleFromUserText(opts.titleHint);
    if (title) {
      await updateSession(sessionId, { title });
    }
  }
  } catch (err) {
    settlePreTurnClaim();
    throw err;
  }
  // A rejected cold start never reaches runTurn's finalize path — release the
  // claim if boot failed before the turn took it over.
  acpReady.catch(settlePreTurnClaim);

  if (rt.running || rt.pending.size > 0) {
    // A turn is already running (multitask burst): the user message above is
    // persisted immediately; the agent turn itself runs FIFO once the current
    // turn finishes, so streams never interleave. The active turn owns the
    // busy flag now — ours arrives later via dequeueTurn. If the chat was
    // parked on a question, restore that status: our early write said
    // "running", but the visible state is still "waiting".
    settlePreTurnClaim();
    rt.turnQueue.push({ userMessageId: userMessageId!, text: promptUserText, opts });
    if (!rt.running && rt.pending.size > 0) {
      await updateSession(sessionId, { status: "waiting" }).catch(() => {});
    }
    return { queued: true };
  }

  try {
    return await runTurn(rt, sessionId, promptUserText, priorTranscript, opts, settings, acpReady);
  } finally {
    rt.startingTurn = false;
  }
}

const STREAM_SETTLE_QUIET_MS = 450;
/**
 * Cursor batches its final answer after a long pause: the thinking stream
 * stops, then the reply (often with the thinking tail) arrives in one update
 * seconds later. The short quiet window alone would settle the turn early and
 * unlock the composer as if answered. While the turn has thinking but no text
 * yet, tolerate a much longer quiet gap; once the answer text has started
 * (or nothing arrived at all), the short window applies again.
 */
const STREAM_SETTLE_ANSWER_QUIET_MS = 4_000;
/** After answer text is visible, Cursor may still pause before more thoughts/tools. */
const STREAM_SETTLE_CURSOR_TEXT_QUIET_MS = 2_000;
/** Default cap for adapters that stream in one burst (OMP). */
const STREAM_SETTLE_MAX_MS = 12_000;
/** Cursor turns can run for many minutes with multi-second gaps between tool rounds. */
const STREAM_SETTLE_CURSOR_MAX_MS = 1_800_000;
/** OMP /review can keep tool/subagent traffic going for many minutes. */
const STREAM_SETTLE_TOOL_MAX_MS = 600_000;
/** After elicitation answer, OMP may pause before /review (or similar) starts streaming. */
const POST_ELICITATION_SPAWN_WAIT_MS = 8_000;
const POST_ELICITATION_IDLE_BREAK_MS = 4_000;
/** Brief wait for elicitation/create that races past session/prompt resolution. */
const LATE_INTERACTIVE_GRACE_MS = 400;
const LATE_INTERACTIVE_OMP_GRACE_MS = 1_200;
const STUCK_TURN_PART = new Set(["pending", "in_progress", "running"]);

function isActiveToolStatus(status: string | undefined): boolean {
  const s = String(status ?? "pending").toLowerCase();
  if (!s) return true;
  return STUCK_TURN_PART.has(s);
}

/** How long the stream must be quiet before we treat the turn as finished. */
function streamSettleQuietThresholdMs(rt: SessionRuntime): number {
  const waitingForAnswer =
    rt.turnHasThought && !rt.turnHasText && rt.inFlightToolCalls === 0;
  const waitingForFirstToken =
    !rt.turnHasThought && !rt.turnHasText && rt.inFlightToolCalls === 0;
  if (rt.adapter?.id === "cursor") {
    // Cursor often returns session/prompt before the first thought chunk, and
    // leaves multi-second gaps between narration text and the next reasoning
    // phase. Never settle on the short window until we have seen real activity
    // and then only after a Cursor-sized quiet gap.
    if (waitingForFirstToken || waitingForAnswer || rt.inFlightToolCalls > 0) {
      return STREAM_SETTLE_ANSWER_QUIET_MS;
    }
    // Final answer text is on screen and tools are done — still allow a brief
    // Cursor pause before unlocking (450ms was cutting mid-turn narration).
    return STREAM_SETTLE_CURSOR_TEXT_QUIET_MS;
  }
  if (waitingForAnswer) return STREAM_SETTLE_ANSWER_QUIET_MS;
  return STREAM_SETTLE_QUIET_MS;
}

function streamSettleMaxMs(rt: SessionRuntime): number {
  return rt.adapter?.id === "cursor" ? STREAM_SETTLE_CURSOR_MAX_MS : STREAM_SETTLE_MAX_MS;
}

function stopTurnSideEffects(rt: SessionRuntime) {
  for (const poll of rt.subagentThinkingPoll.values()) {
    clearInterval(poll.timer);
  }
  rt.subagentThinkingPoll.clear();
  for (const toolCallId of [...rt.cursorStorePoll.keys()]) {
    clearCursorStorePoll(rt, toolCallId);
  }
}

async function finalizeTurn(
  sessionId: string,
  rt: SessionRuntime,
  agentStartedAt: number,
  status: "idle" | "error" = "idle",
) {
  stopTurnSideEffects(rt);
  await completeDanglingTurnParts(sessionId);
  await stampThoughtDurations(sessionId, Math.max(0, Date.now() - agentStartedAt));
  await finishTurnSessionStatus(sessionId, rt, status);
}

function trackToolFlight(rt: SessionRuntime, toolCallId: string, status: string | undefined) {
  if (!toolCallId) return;
  const next = String(status ?? "pending").toLowerCase();
  const prev = rt.toolStatusByCallId.get(toolCallId);
  rt.toolStatusByCallId.set(toolCallId, next);
  const wasActive = prev != null ? isActiveToolStatus(prev) : false;
  const nowActive = isActiveToolStatus(next);
  if (nowActive && !wasActive) rt.inFlightToolCalls++;
  else if (!nowActive && wasActive) rt.inFlightToolCalls = Math.max(0, rt.inFlightToolCalls - 1);
}

function syncInFlightToolCalls(rt: SessionRuntime) {
  let count = 0;
  for (const status of rt.toolStatusByCallId.values()) {
    if (isActiveToolStatus(status)) count += 1;
  }
  rt.inFlightToolCalls = count;
}

function isInteractiveAskToolPayload(payload: Record<string, unknown>): boolean {
  const raw = (payload.raw ?? {}) as Record<string, unknown>;
  const toolName = String(raw.toolName ?? raw.name ?? payload.toolName ?? "").trim().toLowerCase();
  const title = String(payload.title ?? payload.description ?? raw.title ?? "").trim();
  return toolName === "ask" || /^ask\b/i.test(title) || /asking about/i.test(title);
}

/** OMP ask elicitations finish the ask tool without a terminal tool_call_update. */
async function completeInteractiveAskTools(rt: SessionRuntime, sessionId: string) {
  const detail = await getSessionDetail(sessionId);
  const last = detail?.messages.filter((m) => m.role === "assistant").at(-1);
  for (const part of last?.parts ?? []) {
    if (part.type !== "tool_call" && part.type !== "subagent") continue;
    if (!isInteractiveAskToolPayload(part.payload as Record<string, unknown>)) continue;
    if (!isActiveToolStatus(String(part.payload.status ?? "").toLowerCase())) continue;
    await updatePart(sessionId, part.id, { status: "completed" });
    const toolCallId = normalizeToolCallId(
      String(
        part.payload.toolCallId ??
          (part.payload.raw as { toolCallId?: string } | undefined)?.toolCallId ??
          "",
      ),
    );
    if (toolCallId) rt.toolStatusByCallId.set(toolCallId, "completed");
  }
  syncInFlightToolCalls(rt);
  rt.lastStreamAt = Date.now();
}

function markInteractiveAnswer(rt: SessionRuntime) {
  rt.interactiveAnswerAt = Date.now();
  rt.streamedAfterInteractiveAnswer = false;
  rt.lastStreamAt = Date.now();
}

/** Legacy alias — only completes ask tools, never review subagents. */
async function finalizeInteractiveToolWait(rt: SessionRuntime, sessionId: string) {
  if (rt.interactiveAnswerAt == null) markInteractiveAnswer(rt);
  await completeInteractiveAskTools(rt, sessionId);
}

/** Wait until ACP updates stop arriving after session/prompt returns. */
async function settlePromptStream(rt: SessionRuntime) {
  const started = Date.now();
  rt.lastStreamAt = Math.max(rt.lastStreamAt, started);
  while (rt.acceptingStream) {
    if (rt.pending.size > 0 || rt.client?.isPromptPending()) {
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }
    if (rt.inFlightToolCalls > 0) {
      const quietThreshold = streamSettleQuietThresholdMs(rt);
      const quiet = Date.now() - rt.lastStreamAt;
      if (quiet >= quietThreshold) {
        // Cursor sometimes never sends a terminal update for an abandoned tool row.
        break;
      }
      const elapsed = Date.now() - started;
      if (elapsed >= STREAM_SETTLE_TOOL_MAX_MS) {
        const stalled = Date.now() - rt.lastStreamAt;
        if (stalled >= STREAM_SETTLE_QUIET_MS * 8) break;
      }
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }
    const quietThreshold = streamSettleQuietThresholdMs(rt);
    if (
      Date.now() - started >= streamSettleMaxMs(rt) &&
      rt.interactiveAnswerAt == null
    ) {
      // Absolute cap only when the stream is already quiet — long /review runs
      // can stream for minutes after an elicitation answer.
      const stalled = Date.now() - rt.lastStreamAt;
      if (stalled >= quietThreshold) break;
    }
    const quiet = Date.now() - rt.lastStreamAt;
    if (quiet >= quietThreshold) {
      if (rt.interactiveAnswerAt != null && rt.inFlightToolCalls === 0) {
        const sinceAnswer = Date.now() - rt.interactiveAnswerAt;
        if (sinceAnswer < POST_ELICITATION_SPAWN_WAIT_MS) {
          await new Promise((r) => setTimeout(r, 50));
          continue;
        }
        if (quiet < POST_ELICITATION_IDLE_BREAK_MS) {
          await new Promise((r) => setTimeout(r, 50));
          continue;
        }
        rt.interactiveAnswerAt = null;
      }
      break;
    }
    await rt.enqueue(async () => undefined);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function waitForPendingClientRequests(rt: SessionRuntime) {
  while (rt.pending.size > 0) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** session/prompt can resolve before elicitation/create is registered on our side. */
async function waitForLateInteractiveRequests(rt: SessionRuntime) {
  // Only poll briefly. The old 5s grace blocked EVERY normal turn end even when
  // no elicitation was coming — felt like a multi-second freeze after the prompt.
  const graceMs =
    rt.adapter?.id === "omp" || rt.elicitationThisTurn
      ? LATE_INTERACTIVE_OMP_GRACE_MS
      : LATE_INTERACTIVE_GRACE_MS;
  const deadline = Date.now() + graceMs;
  while (rt.pending.size === 0 && Date.now() < deadline && rt.acceptingStream) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** OMP often keeps streaming after an elicitation answer while session/prompt already returned. */
async function drainPostInteractiveStream(rt: SessionRuntime) {
  if (!rt.acceptingStream) return;
  // Skip the second settle on ordinary turns — resetting lastStreamAt here used to
  // force another full quiet wait and freeze the UI for seconds after every prompt.
  if (!rt.elicitationThisTurn && rt.interactiveAnswerAt == null) return;
  rt.lastStreamAt = Date.now();
  await settlePromptStream(rt);
  await waitForPendingClientRequests(rt);
}

/** Re-open the stream window when an interactive answer arrives after runTurn already exited. */
async function resumeStreamAfterInteractiveAnswer(rt: SessionRuntime, sessionId: string) {
  await finalizeInteractiveToolWait(rt, sessionId);
  if (rt.acceptingStream) return;
  // Same turn as the elicitation — do not bump streamGen (queued chunks would be dropped).
  rt.acceptingStream = true;
  rt.running = true;
  await updateSession(sessionId, { status: "running" });
  try {
    await drainPostInteractiveStream(rt);
    stopTurnSideEffects(rt);
    await completeDanglingTurnParts(sessionId);
    await finishTurnSessionStatus(sessionId, rt, "idle");
  } finally {
    rt.running = false;
    rt.acceptingStream = false;
    void dequeueTurn(rt);
  }
}

function registerInteractivePending(
  rt: SessionRuntime,
  reqKey: string,
  entry: Omit<PendingRequest, "resolve">,
): Promise<void> {
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  rt.pending.set(reqKey, {
    ...entry,
    client: entry.client ?? rt.client ?? null,
    resolve: () => release(),
  });
  return done;
}

async function finishTurnSessionStatus(sessionId: string, rt: SessionRuntime, status: "idle" | "error") {
  if (rt.pending.size > 0) {
    await updateSession(sessionId, { status: "waiting" });
    return;
  }
  await updateSession(sessionId, { status });
}

async function completeDanglingTurnParts(sessionId: string) {
  const detail = await getSessionDetail(sessionId);
  const last = detail?.messages.filter((m) => m.role === "assistant").at(-1);
  if (!last) return;
  for (const part of last.parts) {
    if (part.type !== "tool_call" && part.type !== "subagent") continue;
    if (!STUCK_TURN_PART.has(String(part.payload.status ?? "").toLowerCase())) continue;
    await updatePart(sessionId, part.id, { status: "completed" });
  }
}

/**
 * Stamp the measured turn duration onto every thinking block of the last
 * assistant message. Runs on every end path (success, stop, error) — a turn
 * whose thoughts lack durationMs would otherwise fall back to an elapsed-
 * since-createdAt display on the client that grows with every reload.
 */
async function stampThoughtDurations(sessionId: string, durationMs: number) {
  const detail = await getSessionDetail(sessionId);
  const last = detail?.messages.filter((m) => m.role === "assistant").at(-1);
  if (!last) return;
  for (const part of last.parts) {
    if (part.type !== "thought") continue;
    await updatePart(sessionId, part.id, { durationMs });
  }
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
  const locale = settings.locale ?? "en";
  rt.running = true;
  rt.streamGen += 1;
  rt.acceptingStream = true;
  rt.lastStreamAt = Date.now();
  rt.assistantMessageId = null;
  rt.openTextPartId = null;
  rt.openThoughtPartId = null;
  rt.turnThoughtPartId = null;
  rt.turnHasText = false;
  rt.turnHasThought = false;
  rt.inFlightToolCalls = 0;
  rt.toolStatusByCallId.clear();
  rt.interactiveAnswerAt = null;
  rt.streamedAfterInteractiveAnswer = false;
  rt.elicitationThisTurn = false;
  rt.toolPartByCallId.clear();
  rt.toolStartRawByCallId.clear();
  // Measure the actual ACP request, not time spent creating UI/DB messages.
  let agentStartedAt = Date.now();
  await updateSession(sessionId, { status: "running" });
  // Create the assistant bubble immediately so the UI can show "Thinking…" without waiting
  // for the first ACP token (spawn/prompt can take a while).
  await ensureAssistantMessage(rt);

  try {
    const client = await acpReady;
    if (!client.sessionId) {
      const deadline = Date.now() + 8_000;
      while (!client.sessionId && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (!client.sessionId) {
      throw new Error("Agent session is not ready");
    }
    let promptText = isAgentSlashPrompt(promptUserText) ? promptUserText.trim() : promptUserText;
    if (priorTranscript && !isAgentSlashPrompt(promptUserText)) {
      promptText =
        `Earlier conversation (for context only):\n${priorTranscript}\n\n` +
        `The user edited their last message. Continue from this message:\n${promptUserText}`;
    }
    if (!rt.toolsHintSent && !isAgentSlashPrompt(promptUserText)) {
      rt.toolsHintSent = true;
      promptText = `${promptText}\n\n${t(locale, "agent.toolsHint")}`;
    }
    const modelOpt = findModelConfigOption(client.configOptions);
    const model = modelOpt?.currentValue ? String(modelOpt.currentValue) : undefined;
    client.logContext = {
      sessionId,
      provider: opts.provider,
      cwd: opts.cwd,
      model,
    };
    const slash = parseSlashPrompt(promptUserText);
    appendDeepLog({
      kind: "user-prompt",
      sessionId,
      provider: opts.provider,
      cwd: opts.cwd,
      model,
      data: {
        userText: promptUserText,
        promptText,
        slashCommand: slash?.name,
        slashArgs: slash?.args,
        isSkill: slash ? /^skill:/i.test(slash.name) : false,
        edit: Boolean(opts.editMessageId),
      },
    });
    // Measure the actual ACP request, not time spent creating UI/DB messages.
    agentStartedAt = Date.now();
    const result = await client.prompt(promptText);
    appendDeepLog({
      kind: "prompt-complete",
      sessionId,
      provider: opts.provider,
      cwd: opts.cwd,
      model,
      data: result,
    });
    setAgentAvailable(opts.provider, true);
    if (!rt.acceptingStream) {
      await finalizeTurn(sessionId, rt, agentStartedAt);
      return result;
    }
    // Agents often resolve session/prompt before the last tool/text updates
    // arrive. Keep the turn live until the stream is quiet, or those chunks
    // are dropped and the UI unlocks with spinning tools and no answer.
    await waitForLateInteractiveRequests(rt);
    await settlePromptStream(rt);
    await waitForPendingClientRequests(rt);
    if (!rt.acceptingStream) {
      await finalizeTurn(sessionId, rt, agentStartedAt);
      return result;
    }
    await drainPostInteractiveStream(rt);
    if (!rt.acceptingStream) {
      await finalizeTurn(sessionId, rt, agentStartedAt);
      return result;
    }

    const detail = await import("../services/sessions.js").then((m) => m.getSessionDetail(sessionId));
    let lastAssistant = detail?.messages.filter((m) => m.role === "assistant").at(-1);
    let hasContent = lastAssistant?.parts.some((p) =>
      ["text", "thought", "tool_call", "subagent", "plan"].includes(p.type),
    );

    if (!hasContent) {
      await new Promise((r) => setTimeout(r, 400));
      const retry = await getSessionDetail(sessionId);
      lastAssistant = retry?.messages.filter((m) => m.role === "assistant").at(-1);
      hasContent = lastAssistant?.parts.some((p) =>
        ["text", "thought", "tool_call", "subagent", "plan"].includes(p.type),
      );
    }

    if (!hasContent && !isAgentSlashPrompt(promptUserText)) {
      const model =
        client.configOptions.find((o) => o.id === "model")?.currentValue ?? "(неизвестно)";
      const stderrTail = client.lastStderr?.trim();
      let hint =
        `Агент завершил ход без текста (stopReason=${result.stopReason ?? "unknown"}). ` +
        `Модель: ${model}.`;
      hint +=
        " В Настройках выбери модель с API (не local-ollama, если Ollama не запущена) и сохрани ключ.";
      if (stderrTail) {
        hint += `\n\nПоследние строки stderr агента:\n${stderrTail.slice(-1200)}`;
      }
      if (isTokenizerEncodingError(stderrTail ?? "")) {
        hint += `\n\n${tokenizerEncodingErrorHint(settings.locale === "ru" ? "ru" : "en")}`;
      }
      // Surface only via the composer banner — do not embed in the message thread.
      broadcastToSession(sessionId, { type: "error", sessionId, message: hint });
    } else if (!hasContent && isAgentSlashPrompt(promptUserText)) {
      appendDeepLog({
        kind: "slash-empty-turn",
        sessionId,
        provider: opts.provider,
        cwd: opts.cwd,
        model,
        data: {
          slashCommand: parseSlashPrompt(promptUserText)?.name,
          stopReason: result.stopReason,
          elicitation: rt.elicitationThisTurn,
          stderrTail: client.lastStderr?.trim()?.slice(-1200),
        },
      });
    }

    await finalizeTurn(sessionId, rt, agentStartedAt);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stopTurnSideEffects(rt);
    await completeDanglingTurnParts(sessionId);
    await stampThoughtDurations(sessionId, Math.max(0, Date.now() - agentStartedAt));
    if (isModelAccessError(message)) {
      const currentModel =
        (rt.client && findModelConfigOption(rt.client.configOptions)?.currentValue) ||
        settings.defaultModel;
      if (currentModel) denyModel(opts.provider, currentModel);
    }
    const userMessage = isTokenizerEncodingError(message)
      ? `${message}\n\n${tokenizerEncodingErrorHint(settings.locale === "ru" ? "ru" : "en")}`
      : message;
    // A turn that died while an agent question was open must not be buried in
    // "error": the question part is the durable, answerable state, and the user
    // may come back days later. Answering it re-drives the turn.
    await updateSession(sessionId, {
      status: rt.pending.size > 0 ? "waiting" : "error",
    });
    broadcastToSession(sessionId, { type: "error", sessionId, message: userMessage });
    // Broken ACP process → recreate next time
    if (/exited|spawn|ENOENT|таймаут|timeout/i.test(message)) {
      rt.client?.dispose();
      rt.client = null;
      rt.clientReady = null;
    }
    throw err;
  } finally {
    stopTurnSideEffects(rt);
    rt.running = false;
    rt.acceptingStream = false;
    void dequeueTurn(rt);
  }
}

/**
 * Apply a deferred agent restart (MCP list or model changed while a turn was
 * running). Prefers an explicit pending model (setSessionModel) over the
 * current live snapshot. No-op when the session is gone/closed.
 */
async function applyDeferredRestart(rt: SessionRuntime) {
  const detail = await getSessionDetail(rt.sessionId);
  if (!detail?.provider || detail.status === "closed") return;
  const pendingModel = rt.restartOnIdleModel;
  rt.restartOnIdleModel = undefined;
  const snapshot = pendingModel ?? liveModelSnapshot(rt);
  resetAcpClient(rt);
  try {
    await ensureAcp(
      rt.sessionId,
      { provider: detail.provider, cwd: detail.cwd, mode: detail.mode },
      snapshot,
    );
  } catch (err) {
    console.error(`[acp:${rt.sessionId}] deferred restart failed`, err);
  }
}

/** Start the next FIFO-queued turn, if any (after the current turn finished). */
async function dequeueTurn(rt: SessionRuntime) {
  if (rt.running) return;
  if (rt.pending.size > 0) return;
  // MCP servers / the model were re-configured while the previous turn was
  // running — the OMP/Cursor protocol only accepts those at session/new, so
  // swap in a fresh agent before the next queued turn picks up the old ones.
  if (rt.restartOnIdle) {
    rt.restartOnIdle = false;
    await applyDeferredRestart(rt);
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
        } else if (p.kind === "elicitation") {
          rt.client?.respond(id, { action: "cancel" });
        } else {
          // ask_question / create_plan
          rt.client?.respond(id, { outcome: { outcome: "cancelled" } });
        }
      } catch {
        // ignore respond failures
      }
      p.resolve(undefined);
      // Stop ends the question too: leaving the part "pending" would keep it
      // answerable (and the session parked across restarts) after the user
      // explicitly halted the turn.
      if (p.kind === "elicitation" || p.kind === "ask_question") {
        void markQuestionPartAnswered(sessionId, reqKey, {
          outcome: { outcome: "cancelled" },
        });
      }
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

function liveAcpClient(provider: AgentProvider): AcpClient | null {
  for (const rt of runtimes.values()) {
    if (rt.provider === provider && rt.client) return rt.client;
  }
  return null;
}

async function probeResultFromClient(
  selected: AgentProvider,
  client: AcpClient,
  details: string,
  live: boolean,
) {
  const settings = await getSettings();
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
  setAgentAvailable(selected, true);
  const paramSummary = modelParams
    .map((p) => `${p.name}: ${modelParamLabel(p.id, p.currentValue ?? "", undefined)}`)
    .filter((s) => !s.endsWith(": "))
    .join(", ");
  // Report the same label the model picker shows — a raw agent id may be opaque
  // (ZCode's JSON tuple), so re-deriving it from the value alone reads as noise.
  const currentModelLabel = currentModel
    ? models.find((m) => m.value === currentModel)?.name ?? modelDisplayName(currentModel)
    : undefined;
  return {
    ok: true as const,
    provider: selected,
    command: adapterCommand(getAdapter(selected), settings),
    message: currentModelLabel
      ? `ACP OK${live ? " (live)" : ""}. Model: ${currentModelLabel}${paramSummary ? ` · ${paramSummary}` : ""}`
      : `ACP OK${live ? " (live)" : ""} — session ${sessionId}`,
    details: details.slice(-1500),
    sessionId,
    currentModel,
    models,
    modelParams,
    modes,
  };
}

const probeInflight = new Map<AgentProvider, Promise<Awaited<ReturnType<typeof probeAgentOnce>>>>();

async function probeAgentOnce(
  selected: AgentProvider,
  opts?: { catalogOnly?: boolean },
) {
  const live = liveAcpClient(selected);
  if (live) {
    return probeResultFromClient(selected, live, "", true);
  }

  const settings = await getSettings();
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
    const result = await probeResultFromClient(selected, client, logs.join("\n"), false);
    client.dispose();
    return result;
  } catch (err) {
    client.dispose();
    const stillLive = liveAcpClient(selected);
    if (stillLive) {
      return probeResultFromClient(selected, stillLive, logs.join("\n"), true);
    }
    setAgentAvailable(selected, false);
    return {
      ok: false as const,
      provider: selected,
      command: adapterCommand(getAdapter(selected), settings),
      message: err instanceof Error ? err.message : String(err),
      details: `${logs.join("\n")}\n${client.lastStderr}`.slice(-2000),
      currentModel: undefined,
      models: [] as ModelOption[],
      modelParams: [] as ModelParamDto[],
      modes: [] as ModeOption[],
    };
  }
}

export async function probeAgent(
  provider?: AgentProvider,
  opts?: { catalogOnly?: boolean },
) {
  const settings = await getSettings();
  const selected = provider ?? settings.defaultProvider;
  // Disabled harnesses must never spawn a process just to be checked.
  if (settings.disabledProviders.includes(selected)) {
    return {
      ok: false as const,
      provider: selected,
      command: adapterCommand(getAdapter(selected), settings),
      message: `Агент "${getAdapter(selected).label}" отключён в настройках`,
      details: "",
      currentModel: undefined,
      models: [] as ModelOption[],
      modelParams: [] as ModelParamDto[],
      modes: [] as ModeOption[],
    };
  }
  const existing = probeInflight.get(selected);
  if (existing) return existing;
  const work = probeAgentOnce(selected, opts).finally(() => {
    if (probeInflight.get(selected) === work) probeInflight.delete(selected);
  });
  probeInflight.set(selected, work);
  return work;
}

export function resetAllAgentSessions() {
  for (const rt of runtimes.values()) {
    resetAcpClient(rt);
  }
  rememberedSlashCommands.clear();
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
  const rows = new Map((await listSessions()).map((s) => [s.id, s]));
  let restarted = 0;
  for (const sessionId of [...runtimes.keys()]) {
    const rt = runtimes.get(sessionId);
    if (!rt?.client && !rt?.clientReady) continue;
    const row = rows.get(sessionId);
    if (!row) continue;
    // Only sessions whose OWN effective list changed (a folder edit must not
    // respawn agents opened in other folders).
    const desired = mcpServersFingerprint(
      effectiveMcpServers(settings, row.mcpDisabledIds, row.cwd, [
        ...(await discoverProjectMcp(row.cwd, settings.mcpProjectFiles)).servers,
      ]),
    );
    if (appliedMcpFingerprints.get(sessionId) === desired) continue;
    if (await restartSessionMcp(sessionId)) restarted += 1;
  }
  if (restarted) {
    console.log(`[mcp] config changed — restarted ${restarted} live session(s)`);
  }
}

const rememberedSlashCommands = new Map<
  string,
  import("@acpio/shared").SlashCommandDto[]
>();

function rememberSessionCommands(sessionId: string, commands: SlashCommandDto[]) {
  const merged = mergeSlashCommandLists(rememberedSlashCommands.get(sessionId), commands);
  if (merged.length) rememberedSlashCommands.set(sessionId, merged);
}

export function getSessionSlashCommands(sessionId: string) {
  const rt = runtimes.get(sessionId);
  return mergeSlashCommandLists(rt?.availableCommands, rememberedSlashCommands.get(sessionId));
}

export function forgetSessionSlashCommands(sessionId: string) {
  rememberedSlashCommands.delete(sessionId);
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
  // the wrong agent's context. The pinned model belongs to the old harness
  // too: re-pin it to the new provider's default instead of leaving a model
  // id the new agent does not know.
  const updated = await updateSession(sessionId, {
    provider,
    acpSessionId: null,
    model: modelForProvider(settings, provider),
    modelParams: modelParamsForProvider(settings, provider),
  });
  return updated
    ? { ...detail, ...updated, messages: detail.messages }
    : { ...detail, provider };
}

export async function setSessionModel(
  sessionId: string,
  model: string,
  params?: Record<string, string>,
) {
  const detail = await getSessionDetail(sessionId);
  await updateSession(sessionId, {
    model,
    ...(params ? { modelParams: params } : {}),
  });

  const rt = runtimes.get(sessionId);
  if (rt?.running) {
    // A turn is generating on the live ACP process. Killing it mid-stream
    // aborts the answer with "ACP process exited (SIGTERM)" — persist the new
    // model now and restart the agent with it when the turn idles, exactly
    // like MCP changes. Queued follow-up prompts pick it up automatically.
    rt.restartOnIdle = true;
    rt.restartOnIdleModel = { model, ...(params ? { modelParams: params } : {}) };
    return { ok: true, model, appliedLive: false, pending: true };
  }
  // Mid-session set_config_option often leaves OMP/Cursor in a broken state
  // ("Model is unavailable"). Restart ACP so the new model applies like a new chat.
  if (rt) resetAcpClient(rt);

  if (!detail) {
    return { ok: true, model, appliedLive: false };
  }

  try {
    const client = await ensureAcp(
      sessionId,
      {
        provider: detail.provider,
        cwd: detail.cwd,
        mode: detail.mode,
      },
      { model, modelParams: params },
    );
    const settings = await getSettings();
    const models = await finalizeModelList(
      detail.provider,
      settings,
      toModelList(client.configOptions),
    );
    const modelParams = toModelParams(client.configOptions);
    const modes = toModesList(client.configOptions, getAdapter(detail.provider).defaultModes, client.sessionModes);
    // Trust only what the agent reports as current — never echo the pick back.
    const reported = findModelConfigOption(client.configOptions)?.currentValue;
    const currentModel = pickCurrentModel(models, reported);
    rememberModels(detail.provider, currentModel, models, modelParams, modes);
    if (reported && !modelSelectionApplied(client.configOptions, model)) {
      // The agent rejected the pick and kept its own model. Restore the chat's
      // previous pick so the stored model stays the one that actually runs,
      // and tell the composer so it rolls its optimistic state back too.
      await updateSession(sessionId, {
        ...(detail.model ? { model: detail.model } : {}),
        ...(detail.modelParams ? { modelParams: detail.modelParams } : {}),
      });
      return {
        ok: true,
        model,
        appliedLive: false,
        restarted: true,
        currentModel: reported,
        models,
        modelParams,
        modes,
        message: t(settings.locale ?? "en", "modelPickRejected", {
          model,
          actual: reported,
        }),
      };
    }
    return {
      ok: true,
      model,
      appliedLive: true,
      restarted: true,
      currentModel: currentModel ?? model,
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

type ModelsCacheEntry = {
  provider: AgentProvider;
  currentModel?: string;
  models: ModelOption[];
  modelParams: ModelParamDto[];
  modes: ModeOption[];
  at: number;
};

const modelsCacheByProvider = new Map<AgentProvider, ModelsCacheEntry>();

function modelsCacheFor(provider: AgentProvider): ModelsCacheEntry | undefined {
  return modelsCacheByProvider.get(provider);
}

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
  modelsCacheByProvider.set(provider, {
    provider,
    currentModel: resolvedCurrent,
    models: filtered,
    modelParams,
    modes,
    at: Date.now(),
  });
}

export function clearModelsCache(provider?: AgentProvider) {
  if (!provider) modelsCacheByProvider.clear();
  else modelsCacheByProvider.delete(provider);
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
  const live = liveAcpClient(provider);
  if (live) return live;

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
    if (settings.disabledProviders.includes(selected)) return;
    const inflight = probeInflight.get(selected);
    if (inflight) await inflight;
    if (liveAcpClient(selected)) return;
    await warmParamsProbeClient(selected);
  })().catch(() => {
    // best-effort
  });
}

function configOptionsMatchModel(options: ConfigOption[], model: string): boolean {
  const models = toModelList(options);
  const rawCurrent = findModelConfigOption(options)?.currentValue;
  const currentModel = pickCurrentModel(models, rawCurrent);
  const { base } = parseModelWire(model);
  const currentBase = parseModelWire(String(rawCurrent ?? currentModel ?? "")).base;
  return (
    currentModel === model ||
    currentModel === base ||
    rawCurrent === model ||
    rawCurrent === base ||
    (Boolean(base) && currentBase === base)
  );
}

/**
 * True when the agent reports running `model` — exactly or under another
 * provider prefix (applyModelSelection legitimately translates a pick to the
 * agent's own enumerated wire, e.g. "opencode-go/x" → "alibaba-token-plan/x").
 */
function modelSelectionApplied(options: ConfigOption[], model: string): boolean {
  if (configOptionsMatchModel(options, model)) return true;
  const reported = findModelConfigOption(options)?.currentValue;
  if (!reported) return false;
  const wanted = modelIdFromValue(parseModelWire(model).base);
  return Boolean(wanted) && modelIdFromValue(parseModelWire(reported).base) === wanted;
}

async function probeModelParams(provider: AgentProvider, model: string): Promise<ModelParamDto[]> {
  const live = liveAcpClient(provider);
  if (live && configOptionsMatchModel(live.configOptions, model)) {
    // Never set_config_option on the user's live chat process.
    return toModelParams(live.configOptions);
  }
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
  const cache = modelsCacheFor(provider);
  if (cache) {
    modelsCacheByProvider.set(provider, { ...cache, modelParams: params, at: Date.now() });
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

  if (!configOptionsMatchModel(client.configOptions, model)) return null;

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
  const modelsCache = modelsCacheFor(selected);
  if (
    !force &&
    modelsCache &&
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
  const preferred =
    settings.defaultModelByProvider?.[selected] || settings.defaultModel || probed.currentModel;
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
  const detail = await getSessionDetail(sessionId);
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
  const pending = rt?.pending.get(requestId);
  // No live request to answer (server restarted, harness respawned) — the
  // permission card is only meaningful while its ACP prompt exists.
  if (!rt || !pending) throw new Error("Permission request not found");

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

async function markQuestionPartAnswered(
  sessionId: string,
  requestId: string,
  result: Record<string, unknown>,
) {
  const detail = await getSessionDetail(sessionId);
  if (!detail) return;
  for (let mi = detail.messages.length - 1; mi >= 0; mi -= 1) {
    const msg = detail.messages[mi];
    if (!msg) continue;
    for (let pi = msg.parts.length - 1; pi >= 0; pi -= 1) {
      const part = msg.parts[pi];
      if (part?.type !== "question") continue;
      if (String(part.payload.requestId ?? "") !== requestId) continue;
      const answerSummary = summarizeQuestionAnswer({
        ...(part.payload as Record<string, unknown>),
        result,
      });
      await updatePart(sessionId, part.id, { pending: false, result, answerSummary });
      return;
    }
  }
}

/** Payload of the still-unanswered question part `requestId` belongs to. */
function findPendingQuestionPayload(
  detail: SessionDetailDto,
  requestId: string,
): Record<string, unknown> | null {
  for (let mi = detail.messages.length - 1; mi >= 0; mi -= 1) {
    const msg = detail.messages[mi];
    if (!msg) continue;
    for (let pi = msg.parts.length - 1; pi >= 0; pi -= 1) {
      const part = msg.parts[pi];
      if (part?.type !== "question") continue;
      if (!part.payload.pending) continue;
      if (String(part.payload.requestId ?? "") !== requestId) continue;
      return part.payload as Record<string, unknown>;
    }
  }
  return null;
}

/** True when the chat holds an unanswered question (its durable parked state). */
function hasPendingQuestion(detail: SessionDetailDto | null): boolean {
  if (!detail) return false;
  for (const message of detail.messages) {
    for (const part of message.parts) {
      if (part.type === "question" && part.payload.pending) return true;
    }
  }
  return false;
}

/** Payload of the still-unanswered permission part `requestId` belongs to,
 *  reshaped back into the `permission.request` broadcast payload. */
function findPendingPermissionPayload(
  detail: SessionDetailDto,
  requestId: string,
): Record<string, unknown> | null {
  for (let mi = detail.messages.length - 1; mi >= 0; mi -= 1) {
    const msg = detail.messages[mi];
    if (!msg) continue;
    for (let pi = msg.parts.length - 1; pi >= 0; pi -= 1) {
      const part = msg.parts[pi];
      if (part?.type !== "permission") continue;
      if (String(part.payload.requestId ?? "") !== requestId) continue;
      const { requestId: _rid, options, ...params } = part.payload as Record<string, unknown>;
      return { ...params, ...(options !== undefined ? { options } : {}) };
    }
  }
  return null;
}

/**
 * Re-broadcast interactive requests that are still waiting on the user. The
 * originals went out live over WS; a client whose socket died and came back
 * (phone slept, network hopped) missed them and would show a stalled turn
 * with no prompt to answer. Client-side handlers dedupe by requestId, so a
 * replay to a client that never lost them is harmless.
 */
export function replayPendingInteractive(sessionId: string) {
  const rt = runtimes.get(sessionId);
  if (!rt || rt.pending.size === 0) return;
  void (async () => {
    const detail = await getSessionDetail(sessionId).catch(() => null);
    if (!detail || rt.pending.size === 0) return;
    for (const [reqKey, p] of [...rt.pending]) {
      if (p.kind === "permission") {
        const payload = findPendingPermissionPayload(detail, reqKey);
        if (!payload) continue;
        broadcastToSession(sessionId, {
          type: "permission.request",
          sessionId,
          requestId: reqKey,
          payload,
        });
        continue;
      }
      if (p.kind === "switch_mode") {
        if (p.mode == null) continue;
        broadcastToSession(sessionId, {
          type: "question.request",
          sessionId,
          requestId: reqKey,
          kind: "switch_mode",
          payload: { mode: p.mode, previousMode: p.previousMode },
        });
        continue;
      }
      const payload = findPendingQuestionPayload(detail, reqKey);
      if (!payload) continue;
      broadcastToSession(sessionId, {
        type: "question.request",
        sessionId,
        requestId: reqKey,
        kind: p.kind === "create_plan" ? "create_plan" : "ask_question",
        payload,
      });
    }
  })();
}

/**
 * What the server actually has in memory for a session, as the client's
 * `isClientTurnLive` needs it. The DB row can lag behind a live runtime (a warm-up
 * `idle` write racing a prompt start), and no further `session.updated` follows —
 * status only changes on change — so a reload would show a streaming agent with no
 * Stop button. A client that just subscribed asks this directly. `startingTurn`
 * covers the accepted-but-not-yet-started gap (ACP cold start).
 */
export function getLiveTurnState(sessionId: string): { running: boolean; waiting: boolean } | null {
  const rt = runtimes.get(sessionId);
  if (!rt) return null;
  return {
    running: rt.running || rt.acceptingStream || rt.startingTurn,
    waiting: rt.pending.size > 0,
  };
}

/**
 * Answer to a question whose ACP request is gone — the server was restarted (or
 * the harness process died) while the agent was parked on the user. The pending
 * request is unrecoverable, so persist the answer on the question part and
 * re-drive the turn with the answer as text: on resume the agent gets the
 * answer instead of the chat staying parked on a question forever.
 *
 * Returns false when no unanswered question with that requestId exists.
 */
async function redriveAnsweredQuestion(
  sessionId: string,
  requestId: string,
  result: Record<string, unknown>,
): Promise<boolean> {
  const detail = await getSessionDetail(sessionId);
  if (!detail) return false;
  const payload = findPendingQuestionPayload(detail, requestId);
  if (!payload) return false;

  await markQuestionPartAnswered(sessionId, requestId, result);
  const settings = await getSettings();
  const locale = settings.locale ?? "en";
  const question = String(payload.title ?? "").trim();
  const answer = summarizeQuestionAnswer({ ...payload, result }).trim();
  const text = t(locale, "agent.answerToQuestion", { question, answer: answer || "—" });
  appendDeepLog({
    kind: "question-redrive",
    sessionId,
    provider: detail.provider,
    cwd: detail.cwd,
    data: { requestId, question, answer, text },
  });
  // A turn runs for minutes — answer the click now and let the reply stream in,
  // exactly like POST /prompt. Errors surface through the session banner.
  void runPrompt(sessionId, text, {
    provider: detail.provider,
    cwd: detail.cwd,
    mode: detail.mode,
  }).catch((err) => {
    broadcastToSession(sessionId, {
      type: "error",
      sessionId,
      message: err instanceof Error ? err.message : String(err),
    });
  });
  return true;
}

export async function answerQuestion(
  sessionId: string,
  requestId: string,
  result: Record<string, unknown>,
) {
  const rt = runtimes.get(sessionId);
  const pending = rt?.pending.get(requestId);
  // No live ACP request behind this answer: the server was restarted (or the
  // harness respawned) while the agent waited on the user. The question part is
  // still the fixed, answerable state — persist the answer and resume the turn
  // instead of failing the click.
  if (!rt || !pending) {
    const redriven = await redriveAnsweredQuestion(sessionId, requestId, result);
    if (!redriven) throw new Error("Question request not found");
    return;
  }

  // switch_mode is a synthetic consent (the agent already switched on its
  // side), so there is no ACP request to answer — just resolve the waiter.
  if (pending.kind === "switch_mode") {
    pending.resolve(result);
    rt.pending.delete(requestId);
    void updateSession(sessionId, { status: "running" });
    void markQuestionPartAnswered(sessionId, requestId, result);
    return;
  }

  // The client that received the request is gone (respawned harness, provider
  // switch): the RPC id is meaningless on the live process. Resume the turn.
  if (pending.client && pending.client !== rt.client) {
    pending.resolve(result);
    rt.pending.delete(requestId);
    const redriven = await redriveAnsweredQuestion(sessionId, requestId, result);
    if (!redriven) throw new Error("Question request not found");
    return;
  }

  const id = pending.rpcId ?? parseRpcId(requestId, sessionId);
  rt.lastStreamAt = Date.now();

  if (pending.respondAsPermission) {
    const outcome = (result as { outcome?: { answers?: Array<{ selectedOptionIds?: string[] }> } })
      .outcome;
    const optionId = outcome?.answers?.[0]?.selectedOptionIds?.[0] ?? "allow_once";
    rt.client?.respond(id, { outcome: { outcome: "selected", optionId } });
    markInteractiveAnswer(rt);
    pending.resolve(result);
    rt.pending.delete(requestId);
    void updateSession(sessionId, { status: "running" });
    void markQuestionPartAnswered(sessionId, requestId, result).then(async () => {
      await finalizeInteractiveToolWait(rt, sessionId);
      void resumeStreamAfterInteractiveAnswer(rt, sessionId);
    });
    return;
  }

  if (pending.respondAsElicitation && pending.elicitationPayload) {
    const response = elicitationResponseFromUiOutcome(
      pending.elicitationPayload,
      result as { outcome?: Record<string, unknown> },
    );
    appendDeepLog({
      kind: "elicitation-answer",
      sessionId,
      data: { requestId, response },
    });
    const content = (response as { content?: Record<string, unknown> }).content;
    console.log(
      `[acp:${sessionId}] elicitation answer rpcId=${String(id)} action=${String((response as { action?: string }).action ?? "")} value=${String(content?.value ?? "")}`,
    );
    rt.client?.respond(id, response);
    if (response.action === "accept") markInteractiveAnswer(rt);
    pending.resolve(result);
    rt.pending.delete(requestId);
    void updateSession(sessionId, { status: "running" });
    void markQuestionPartAnswered(sessionId, requestId, result).then(async () => {
      await finalizeInteractiveToolWait(rt, sessionId);
      void resumeStreamAfterInteractiveAnswer(rt, sessionId);
    });
    return;
  }

  rt.client?.respond(id, result);
  pending.resolve(result);
  rt.pending.delete(requestId);
  void updateSession(sessionId, { status: "running" });
  void markQuestionPartAnswered(sessionId, requestId, result);
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
  appliedMcpFingerprints.delete(sessionId);
}
