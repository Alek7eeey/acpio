import { create } from "zustand";
import type {
  AgentProvider,
  AppLocale,
  AppSettings,
  ChatThemeDto,
  MessageDto,
  MessagePartDto,
  ModelOption,
  ModelParamDto,
  ProjectMcpInfo,
  SessionDetailDto,
  SessionDto,
  SlashCommandDto,
  Theme,
  WsServerEvent,
} from "@acpio/shared";
import {
  DEFAULT_SETTINGS,
  isModelAccessError,
  isShellSession,
  mergeClientAppSettings,
  modelProviderFromValue,
  SHELL_SESSION_PROVIDER,
  summarizeQuestionAnswer,
  type AdapterMetaDto,
} from "@acpio/shared";
import { api } from "./api";
import { turnStillHasLiveTools } from "./assistantTurnTimeline.js";
import { groupByFolder } from "./sessionTitle";
import { createTranslator } from "./translator";
import { normalizeCwd } from "./pathSegments";
import { migrateExpandedStepsMessageId } from "./expandedSteps";
import { applyAppearance } from "./appearance";
import {
  CHAT_PANE_MAX,
  chatSplitAllowed,
  readStoredChatPanes,
  sanitizeChatPanes,
  writeStoredChatPanes,
  type ChatPaneSlot,
} from "./chatPanes";
import { pickCreateProvider, type AgentAvailabilityMap, hasStoredAgentAvailability, readStoredAgentAvailability, writeStoredAgentAvailability } from "./harness";
import { rememberDiagnosticsError, submitAutoErrorDump } from "./diagnostics";
import {
  hydrateSessionSlashCommands,
  mergeIncomingSlashCommands,
  preferSessionSlashCommands,
  rememberSessionSlashCommands,
  slashCommandsKey,
  slashListStillLoading,
} from "./sessionSlashCommands";
import { readConsoleOpenSessions, removeConsoleOpenSession, persistConsoleOpen } from "./sessionConsole";
import { destroyConsoleTerminal } from "./consoleTerminalCache";
import {
  readGitPanelOpenSessions,
  removeGitPanelOpenSession,
  persistGitPanelOpen,
} from "./sessionGitPanel";
import {
  composerDraftSnapshot,
  forgetComposerDraft,
  seedComposerDrafts,
  setComposerDraftPersistSink,
} from "./composerDrafts";

// Shell output is never persisted — drop legacy log key if present.
if (typeof window !== "undefined") {
  try {
    localStorage.removeItem("acpio.consoleLog.v1");
    // The git panel is docked only now; drop the removed side/full-screen choice.
    localStorage.removeItem("acpio.gitPanelPresentation.v1");
  } catch {
    /* ignore */
  }
}

const MODELS_CACHE_KEY = "acpio.modelsCatalog.v7";
const MODELS_CACHE_KEY_LEGACY = "acpio.modelsCatalog.v6";
const MODELS_SESSION_KEY = "acpio.modelsCatalog.session.v1";
const ACTIVE_SESSION_KEY = "acpio.activeSessionId";
/** Soft TTL: serve instantly, refresh quietly in background after this. */
const MODELS_SOFT_TTL_MS = 30 * 60_000;
const MODELS_CLOUD_SOFT_TTL_MS = 30_000;
/** Hard TTL: force a blocking reload only after this. */
const MODELS_HARD_TTL_MS = 7 * 24 * 60_000;
const MODELS_CLOUD_HARD_TTL_MS = 2 * 60_000;

/** Meta of a registered adapter (falls back to cursor-like when not loaded). */
export function adapterMeta(provider: AgentProvider): AdapterMetaDto | undefined {
  return useAppStore.getState().adapters.find((a) => a.id === provider);
}

function modelsHardTtl(provider: AgentProvider): number {
  return adapterMeta(provider)?.cloudCatalog ? MODELS_CLOUD_HARD_TTL_MS : MODELS_HARD_TTL_MS;
}

function modelsSoftTtl(provider: AgentProvider): number {
  return adapterMeta(provider)?.cloudCatalog ? MODELS_CLOUD_SOFT_TTL_MS : MODELS_SOFT_TTL_MS;
}

export type ModelsCatalog = {
  provider: AgentProvider;
  models: ModelOption[];
  modelParams: ModelParamDto[];
  /** Session modes (Agent / Plan / Ask) when the agent supports them. */
  modes: Array<{ value: string; name: string }>;
  currentModel?: string;
  at: number;
};

/** Cursor trio must not stick to OMP catalogs after an agent switch. */
export function sanitizeCatalogModes(
  provider: AgentProvider,
  modes: Array<{ value: string; name: string }> | undefined | null,
): Array<{ value: string; name: string }> {
  const list = Array.isArray(modes) ? modes : [];
  if (provider === "cursor") {
    return list.filter(
      (m) => m.value === "agent" || m.value === "plan" || m.value === "ask",
    );
  }
  // OMP only advertises a lone "default" — never a switcher.
  return [];
}

export function cachedModelsFor(provider: AgentProvider): ModelsCatalog | null {
  const sessionHit = readSessionModelsMap()[provider];
  if (sessionHit?.models.length) return sessionHit;
  const active = useAppStore.getState().modelsCatalog;
  if (active?.provider === provider && active.models.length) return active;
  return readStoredModelsCatalog(provider);
}

type ModelsCatalogMap = Partial<Record<AgentProvider, ModelsCatalog>>;

type PendingPermission = {
  sessionId: string;
  requestId: string;
  payload: Record<string, unknown>;
};

/** Live socket status — drives the header chip. */
export type ConnectionState = "connecting" | "open" | "reconnecting" | "offline";

type PendingQuestion = {
  sessionId: string;
  requestId: string;
  kind: "ask_question" | "create_plan" | "switch_mode";
  payload: Record<string, unknown>;
};

function pendingQuestionFromDetail(detail: SessionDetailDto): PendingQuestion | null {
  if (detail.status !== "waiting") return null;
  for (let mi = detail.messages.length - 1; mi >= 0; mi -= 1) {
    const msg = detail.messages[mi];
    if (!msg) continue;
    for (let pi = msg.parts.length - 1; pi >= 0; pi -= 1) {
      const part = msg.parts[pi];
      if (part?.type !== "question") continue;
      if (!part.payload.pending) continue;
      const requestId = String(part.payload.requestId ?? "");
      if (!requestId) continue;
      return {
        sessionId: detail.id,
        requestId,
        kind: "ask_question",
        payload: part.payload as Record<string, unknown>,
      };
    }
  }
  return null;
}

/** File pending in the composer — always a path on the server machine. */
export type PendingAttachment = {
  name: string;
  path: string;
};

type AppState = {
  settings: AppSettings;
  /** Server OS from /api/health (null until loaded). */
  serverPlatform: string | null;
  sessions: SessionDto[];
  themes: ChatThemeDto[];
  activeSessionId: string | null;
  activeSession: SessionDetailDto | null;
  /**
   * Desktop split: 1–4 slots. Null = empty column. Mobile always uses a
   * single slot equal to activeSessionId.
   */
  chatPaneIds: ChatPaneSlot[];
  focusedPaneIndex: number;
  /** Folders that have ever held chats (server-backed, empty ones kept). */
  knownFolders: string[];
  refreshFolders: () => Promise<void>;
  deleteFolder: (cwd: string) => Promise<void>;
  /**
   * MCP servers discovered in each folder's own files, keyed by canonical cwd
   * (`normalizeCwd`). Refreshed from the server; an unfetched folder simply
   * contributes nothing to the chat until it is scanned.
   */
  projectMcp: Record<string, ProjectMcpInfo>;
  /** Rescan folder MCP files — one folder, or every known one. */
  refreshProjectMcp: (cwd?: string | null) => Promise<void>;
  reorderFolders: (items: Array<{ cwd: string; sortOrder: number }>) => Promise<void>;
  /** Live details for open split panes (and the focused chat). */
  sessionDetails: Record<string, SessionDetailDto>;
  setChatPaneCount: (count: number) => void;
  focusChatPane: (index: number) => void;
  closeChatPane: (index: number) => void;
  /** Drop back to the focused chat only (settings off, mobile, unsplit). */
  collapseToSinglePane: () => void;
  openSessionInNewPane: (id: string) => Promise<void>;
  /** Transient: message to scroll to/highlight once its session renders. */
  focusMessageId: string | null;
  /** True while a session detail is being fetched (skeleton shown). */
  sessionLoading: boolean;
  /** Imported harness chat waiting for transcript (ACP replay / disk ingest). */
  restoringSessionIds: Record<string, true>;
  /** Just-created chats whose agent runtime has not answered yet. */
  initializingSessionIds: Record<string, true>;
  /** Message currently being read aloud ("" = silent). Drives the stop button. */
  speakingMessageId: string | null;
  /** True while the TTS engine is generating audio (stop button shows a spinner). */
  ttsLoading: boolean;
  modelsCatalog: ModelsCatalog | null;
  /** Every registered harness, including disabled ones (Settings → Connect). */
  allAdapters: AdapterMetaDto[];
  /** Enabled harnesses only (from /api/adapters) — drives pickers and forms. */
  adapters: AdapterMetaDto[];
  /** True once /api/adapters answered; empty `adapters` then means "all off". */
  adaptersLoaded: boolean;
  loadAdapters: () => Promise<void>;
  modelsLoading: boolean;
  sidebarOpen: boolean;
  connected: boolean;
  /** Fine-grained socket state for the toolbar chip; `connected` mirrors it. */
  connection: ConnectionState;
  /** True when the focused chat's harness (or any harness) last probed OK. */
  agentAvailable: boolean;
  /** Per-harness: true / false / null while probing. */
  agentAvailability: AgentAvailabilityMap;
  agentProbing: Partial<Record<AgentProvider, boolean>>;
  agentGateDismissed: boolean;
  probeAllAgents: (opts?: { quiet?: boolean; reportOffline?: boolean; force?: boolean }) => Promise<void>;
  dismissAgentGate: () => void;
  /** Harnesses that were online last time and went offline on this reload. */
  agentOfflineWarning: AgentProvider[];
  dismissAgentOfflineWarning: () => void;
  pendingPermission: PendingPermission | null;
  /** Extra permission prompts waiting behind the one shown in the UI. */
  permissionQueue: PendingPermission[];
  pendingQuestion: PendingQuestion | null;
  /** Settings search box text, shared by the sidebar tree and the page rows. */
  settingsQuery: string;
  setSettingsQuery: (query: string) => void;
  /** Bumped on each send; cancel stamps cancelledPromptEpoch to ignore late WS parts. */
  promptEpoch: number;
  cancelledPromptEpoch: number;
  /**
   * Requests the user sent while the agent was busy. Items leave the queue the
   * moment they are handed to the server (the server FIFO-runs them), so
   * everything still listed here can still be edited or deleted.
   */
  promptQueue: Array<{
    id: string;
    text: string;
    sessionId: string;
    editMessageId?: string | null;
    attachments?: PendingAttachment[];
  }>;
  /** Prompts handed to the server whose turns have not completed yet (legacy sum). */
  inflight: number;
  inflightBySession: Record<string, number>;
  promptEpochBySession: Record<string, number>;
  cancelledPromptEpochBySession: Record<string, number>;
  /** Background chats whose turn finished while the user was elsewhere. */
  unseenFinishedTurns: Record<string, true>;
  loading: boolean;
  /**
   * True once the first bootstrap payload has been applied. `settings` is
   * DEFAULT_SETTINGS before that, so a page mounting early must mirror the
   * payload when this flips — and never again afterwards (the store re-sets
   * `settings` around every save).
   */
  bootstrapped: boolean;
  error: string | null;
  setTheme: (theme: Theme) => Promise<void>;
  applyTheme: (theme: Theme) => void;
  setLocale: (locale: AppLocale) => Promise<void>;
  applyLocale: (locale: AppLocale) => void;
  loadBootstrap: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  refreshThemes: () => Promise<void>;
  selectSession: (id: string | null) => Promise<void>;
  setFocusMessageId: (id: string | null) => void;
  setSpeakingMessageId: (id: string | null) => void;
  setTtsLoading: (loading: boolean) => void;
  createSession: (cwd?: string, provider?: AgentProvider, model?: string) => Promise<SessionDto>;
  importHarnessSession: (input: {
    provider: AgentProvider;
    acpSessionId: string;
    cwd?: string;
    title?: string;
  }) => Promise<SessionDto>;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  /** Toggle pin/archive flags (optimistic PATCH). */
  setSessionFlags: (
    id: string,
    patch: { pinned?: boolean; archived?: boolean; mcpDisabledIds?: string[] },
  ) => Promise<void>;
  /** Archive several chats at once (folder menu). The focused chat goes last. */
  archiveSessions: (ids: string[]) => Promise<void>;
  reorderSessions: (
    items: Array<{ id: string; themeId: string | null; sortOrder: number }>,
  ) => Promise<void>;
  sendPrompt: (
    text: string,
    opts?: { editMessageId?: string; attachments?: PendingAttachment[]; sessionId?: string },
  ) => Promise<void>;
  /** Internal: actually hand one prompt to the server (optimistic pair optional). */
  runSendPrompt: (
    text: string,
    opts?: { editMessageId?: string; attachments?: PendingAttachment[]; sessionId?: string },
    flags?: { optimistic?: boolean },
  ) => Promise<void>;
  removeQueuedPrompt: (id: string) => void;
  updateQueuedPrompt: (id: string, text: string) => void;
  drainPromptQueue: () => Promise<void>;
  /** Optimistic local toggle; the save happens in the background. */
  setMultitask: (value: boolean) => Promise<void>;
  cancelPrompt: (sessionId?: string) => Promise<void>;
  setSidebarOpen: (open: boolean) => void;
  setConnection: (connection: ConnectionState) => void;
  /** Re-read server-owned state after the socket returns (missed events are never replayed). */
  resyncAfterReconnect: () => Promise<void>;
  setAgentAvailable: (provider: AgentProvider, available: boolean) => void;
  handleWsEvent: (event: WsServerEvent) => void;
  answerPermission: (optionId: string) => Promise<void>;
  answerQuestion: (result: Record<string, unknown>) => Promise<void>;
  answerQuestionFor: (
    sessionId: string,
    requestId: string,
    result: Record<string, unknown>,
  ) => Promise<void>;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
  /** Add/remove a model from the per-harness favorites list (right-click in the picker). */
  toggleFavoriteModel: (provider: AgentProvider, model: string) => void;
  rememberModelsCatalog: (catalog: ModelsCatalog) => void;
  ensureModels: (
    provider: AgentProvider,
    opts?: { force?: boolean },
  ) => Promise<ModelsCatalog | null>;
  /** Load a harness catalog without blocking the UI when a cache already exists. */
  fetchProviderModels: (provider: AgentProvider) => Promise<ModelsCatalog | null>;
  /** Session shell console panel open state. */
  consoleOpen: boolean;
  setConsoleOpen: (open: boolean) => void;
  toggleConsoleOpen: () => void;
  /** Git changes side panel open state. */
  gitPanelOpen: boolean;
  setGitPanelOpen: (open: boolean) => void;
  toggleGitPanelOpen: () => void;
};

function normalizeCatalog(parsed: Partial<ModelsCatalog> | null | undefined): ModelsCatalog | null {
  if (!parsed?.provider || !Array.isArray(parsed.models)) return null;
  return {
    provider: parsed.provider,
    models: parsed.models.map((m) => ({
      ...m,
      provider: m.provider || modelProviderFromValue(m.value),
    })),
    modelParams: Array.isArray(parsed.modelParams) ? parsed.modelParams : [],
    modes: sanitizeCatalogModes(parsed.provider, parsed.modes),
    currentModel: parsed.currentModel,
    at: typeof parsed.at === "number" ? parsed.at : 0,
  };
}

function readStoredModelsMap(): ModelsCatalogMap {
  try {
    const raw = localStorage.getItem(MODELS_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { byProvider?: ModelsCatalogMap } | ModelsCatalog;
      if (parsed && "byProvider" in parsed && parsed.byProvider) {
        const map: ModelsCatalogMap = {};
        for (const [, value] of Object.entries(parsed.byProvider)) {
          const cat = normalizeCatalog(value as Partial<ModelsCatalog>);
          if (cat) map[cat.provider] = cat;
        }
        return map;
      }
      const legacySingle = normalizeCatalog(parsed as ModelsCatalog);
      if (legacySingle) return { [legacySingle.provider]: legacySingle };
    }
    const legacy = localStorage.getItem(MODELS_CACHE_KEY_LEGACY);
    if (legacy) {
      const cat = normalizeCatalog(JSON.parse(legacy) as ModelsCatalog);
      if (cat) return { [cat.provider]: cat };
    }
  } catch {
    /* ignore */
  }
  return {};
}

function readSessionModelsMap(): ModelsCatalogMap {
  try {
    if (typeof sessionStorage === "undefined") return {};
    const raw = sessionStorage.getItem(MODELS_SESSION_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { byProvider?: ModelsCatalogMap };
    if (!parsed?.byProvider) return {};
    const map: ModelsCatalogMap = {};
    for (const value of Object.values(parsed.byProvider)) {
      const cat = normalizeCatalog(value as Partial<ModelsCatalog>);
      if (cat) map[cat.provider] = cat;
    }
    return map;
  } catch {
    return {};
  }
}

function writeSessionModelsMap(map: ModelsCatalogMap) {
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(MODELS_SESSION_KEY, JSON.stringify({ byProvider: map }));
  } catch {
    /* ignore */
  }
}

function readStoredModelsCatalog(provider?: AgentProvider): ModelsCatalog | null {
  const sessionMap = readSessionModelsMap();
  const disk = readStoredModelsMap();
  if (!Object.keys(sessionMap).length && Object.keys(disk).length) {
    writeSessionModelsMap(disk);
  }
  const map = { ...disk, ...sessionMap };
  if (provider) return map[provider] ?? null;
  const values = Object.values(map).filter(Boolean) as ModelsCatalog[];
  if (!values.length) return null;
  return values.sort((a, b) => b.at - a.at)[0] ?? null;
}

function writeStoredModelsCatalog(catalog: ModelsCatalog | null, clearProvider?: AgentProvider) {
  try {
    const map = readStoredModelsMap();
    if (clearProvider) delete map[clearProvider];
    if (catalog) map[catalog.provider] = catalog;
    localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify({ byProvider: map }));
    localStorage.removeItem(MODELS_CACHE_KEY_LEGACY);
    writeSessionModelsMap(map);
  } catch {
    // ignore quota / private mode
  }
}

function upsertPart(parts: MessagePartDto[], part: MessagePartDto) {
  const idx = parts.findIndex((p) => p.id === part.id);
  if (idx === -1) return [...parts, part].sort((a, b) => a.order - b.order);
  const next = [...parts];
  next[idx] = mergeMessagePart(parts[idx]!, part);
  return next;
}

function mergeMessagePart(existing: MessagePartDto, incoming: MessagePartDto): MessagePartDto {
  const prev = existing.payload ?? {};
  const patch = incoming.payload ?? {};
  const mergedPayload = { ...prev, ...patch };
  if (existing.type === "question" && incoming.type === "question") {
    if (prev.result && patch.result == null) mergedPayload.result = prev.result;
    if (prev.answerSummary && patch.answerSummary == null) {
      mergedPayload.answerSummary = prev.answerSummary;
    }
    if (prev.questions && patch.questions == null) mergedPayload.questions = prev.questions;
    if (prev.title && patch.title == null) mergedPayload.title = prev.title;
    if (prev.pending === false && patch.pending === true) {
      mergedPayload.pending = false;
      mergedPayload.result = prev.result ?? mergedPayload.result;
      mergedPayload.answerSummary = prev.answerSummary ?? mergedPayload.answerSummary;
    }
  }
  return { ...incoming, payload: mergedPayload };
}

function applyQuestionAnswerLocally(
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
  sessionId: string,
  requestId: string,
  result: Record<string, unknown>,
) {
  const state = get();
  const current = liveDetail(state, sessionId);
  if (!current) return;
  let touched = false;
  const messages = current.messages.map((message) => {
    if (message.role !== "assistant") return message;
    const parts = message.parts.map((part) => {
      if (part.type !== "question") return part;
      if (String(part.payload.requestId ?? "") !== requestId) return part;
      touched = true;
      const payload = {
        ...part.payload,
        pending: false,
        result,
        answerSummary: summarizeQuestionAnswer({ ...part.payload, result }),
      };
      return { ...part, payload };
    });
    return touched ? { ...message, parts } : message;
  });
  if (!touched) return;
  commitDetail(get, set, { ...current, messages });
}

function mergeSessionQuestionAnswers(
  local: SessionDetailDto,
  remote: SessionDetailDto,
): SessionDetailDto {
  const messages = remote.messages.map((remoteMsg) => {
    const localMsg = local.messages.find((m) => m.id === remoteMsg.id);
    if (!localMsg) return remoteMsg;
    const parts = remoteMsg.parts.map((remotePart) => {
      const localPart = localMsg.parts.find((p) => p.id === remotePart.id);
      if (!localPart) return remotePart;
      return mergeMessagePart(localPart, remotePart);
    });
    return { ...remoteMsg, parts };
  });
  return { ...remote, messages };
}

function upsertMessagePart(message: MessageDto, part: MessagePartDto): MessagePartDto[] {
  // An optimistic user message already has its one text part. The persisted
  // `part.appended` event has a new server id, so replacing by part id alone
  // would render the same prompt twice in the one bubble.
  if (isLocalUserId(message.id) && part.type === "text") {
    const localTextIdx = message.parts.findIndex((item) => item.type === "text");
    if (localTextIdx >= 0) {
      const next = [...message.parts];
      next[localTextIdx] = {
        ...part,
        // Keep the local key stable; the server part is only confirmation.
        id: next[localTextIdx]!.id,
        messageId: message.id,
      };
      return next;
    }
  }
  return upsertPart(message.parts, part);
}

function isLocalUserId(id: string) {
  return id.startsWith("local-user-");
}

function isLocalAssistantId(id: string) {
  return id.startsWith("local-assistant-");
}

/** Last error part in the thread — used only for the composer banner. */
function lastAssistantErrorMessage(session: SessionDetailDto): string | null {
  for (let i = session.messages.length - 1; i >= 0; i -= 1) {
    const msg = session.messages[i];
    if (msg?.role !== "assistant") continue;
    for (let j = msg.parts.length - 1; j >= 0; j -= 1) {
      const part = msg.parts[j];
      if (part?.type !== "error") continue;
      const text = String(part.payload?.message ?? "").trim();
      if (text) return text;
    }
  }
  return null;
}

/**
 * Server message ids → stable client ids so optimistic bubbles never remount.
 * Entries are session-scoped: an in-flight turn's bridge must survive the user
 * switching chats (otherwise returning re-creates a duplicate assistant
 * message from late WS parts next to the optimistic one).
 */
const serverToClientMessageId = new Map<string, { clientId: string; sessionId: string }>();
/** One prompt may be active at a time. Map its server messages only to its pair. */
let pendingOptimisticPair: { userId: string; assistantId: string; sessionId: string } | null = null;
/** Sessions for which the server has confirmed running/waiting this turn.
 *  Stale `session.updated` idle from createMessage must not clobber optimistic running. */
const serverConfirmedBusy = new Set<string>();
const delayedIdleTimers = new Map<string, number>();

function sessionHasActiveTurnParts(messages: MessageDto[]) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    return turnStillHasLiveTools(msg.parts);
  }
  return false;
}

function turnCancelledForSession(state: AppState, sessionId: string) {
  const cancelled =
    state.cancelledPromptEpochBySession?.[sessionId] ??
    (state.activeSession?.id === sessionId ? state.cancelledPromptEpoch : -2);
  const epoch =
    state.promptEpochBySession?.[sessionId] ??
    (state.activeSession?.id === sessionId ? state.promptEpoch : 0);
  return cancelled === epoch && epoch !== 0;
}

/** True only while this tab has an in-flight user prompt for the session. */
function isClientTurnLive(state: AppState, sessionId: string) {
  if (turnCancelledForSession(state, sessionId)) return false;
  if ((state.inflightBySession?.[sessionId] ?? 0) > 0) return true;
  if (serverConfirmedBusy.has(sessionId)) return true;
  const pane = liveDetail(state, sessionId);
  return pane?.status === "running" || pane?.status === "waiting";
}

function reviveRunningIfTurnActive(
  sessionId: string,
  messages: MessageDto[],
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
) {
  const state = get();
  if (!isClientTurnLive(state, sessionId)) return;
  if (!sessionHasActiveTurnParts(messages)) return;
  const pane = liveDetail(state, sessionId);
  if (!pane || pane.status === "running" || pane.status === "waiting") return;
  clearDelayedIdle(sessionId);
  const nextSessions = state.sessions.map((s) =>
    s.id === sessionId ? { ...s, status: "running" as const } : s,
  );
  set({ sessions: nextSessions });
  if (state.activeSession?.id === sessionId) {
    commitDetail(get, set, { ...state.activeSession, status: "running", messages });
  } else {
    commitDetail(get, set, { ...pane, status: "running", messages });
  }
}

/**
 * Adopt a status the server itself reported. `inflightBySession` only counts prompts
 * this tab sent, so after a reload it is 0 and Stop would vanish for a turn still
 * running in the server process; this set is what keeps the button alive across it.
 */
function confirmServerBusy(sessionId: string, status: "running" | "waiting") {
  clearDelayedIdle(sessionId);
  serverConfirmedBusy.add(sessionId);
  useAppStore.setState((state) => ({
    sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, status } : s)),
  }));
}

/** Ask the server process whether a turn is still live for this chat and adopt that
 *  status. The DB row can lag behind it (a warm-up `idle` write racing a prompt
 *  start), so trusting the row alone left a reloaded tab streaming with no Stop. */
async function adoptLiveTurnStatus(sessionId: string) {
  try {
    const live = await api.getLiveTurn(sessionId);
    if (!live.running) return;
    confirmServerBusy(sessionId, live.waiting ? "waiting" : "running");
    const state = useAppStore.getState();
    const pane = liveDetail(state, sessionId);
    if (pane && pane.status !== "running" && pane.status !== "waiting") {
      commitDetail(useAppStore.getState, useAppStore.setState, {
        ...pane,
        status: live.waiting ? "waiting" : "running",
      });
    }
  } catch {
    // Server unreachable — nothing to reconcile; the next WS event decides.
  }
}

/** After a fresh list, ask the server which chats actually have a live turn and
 *  adopt that status. Only upgrades idle→running/waiting — a downgrade would
 *  fight the WS `session.updated` flow, which owns the terminal transitions. */
async function reconcileLiveTurnStatuses(sessions: SessionDto[]): Promise<void> {
  const candidates = sessions.filter(
    (s) => s.status !== "running" && s.status !== "waiting" && !isShellSession(s.provider),
  );
  if (!candidates.length) return;
  await Promise.all(
    candidates.map(async (s) => {
      try {
        const live = await api.getLiveTurn(s.id);
        if (!live.running) return;
        // A newer WS frame may have settled this chat while we were asking.
        const cur = useAppStore.getState().sessions.find((x) => x.id === s.id);
        if (!cur || cur.status === "running" || cur.status === "waiting") return;
        confirmServerBusy(s.id, live.waiting ? "waiting" : "running");
      } catch {
        // Server unreachable — the next list/WS event decides.
      }
    }),
  );
}

function clearDelayedIdle(sessionId: string) {
  const timer = delayedIdleTimers.get(sessionId);
  if (timer) window.clearTimeout(timer);
  delayedIdleTimers.delete(sessionId);
}
let probeAllAgentsInflight: Promise<void> | null = null;
let lastProbeAllAgentsAt = 0;
const PROBE_ALL_COOLDOWN_MS = 45_000;
const OFFLINE_HOLD_MS = 2500;
const offlineHoldTimers: Partial<Record<AgentProvider, number>> = {};

function resolveClientMessageId(messageId: string, sessionId?: string) {
  const entry = serverToClientMessageId.get(messageId);
  if (!entry) return messageId;
  if (sessionId && entry.sessionId !== sessionId) return messageId;
  return entry.clientId;
}

function clearMessageIdAliases(sessionId?: string) {
  if (sessionId) {
    for (const [key, entry] of serverToClientMessageId) {
      if (entry.sessionId === sessionId) serverToClientMessageId.delete(key);
    }
    if (pendingOptimisticPair?.sessionId === sessionId) pendingOptimisticPair = null;
    serverConfirmedBusy.delete(sessionId);
    clearDelayedIdle(sessionId);
    return;
  }
  serverToClientMessageId.clear();
  pendingOptimisticPair = null;
  serverConfirmedBusy.clear();
  for (const timer of delayedIdleTimers.values()) window.clearTimeout(timer);
  delayedIdleTimers.clear();
}

function upsertMessage(messages: MessageDto[], message: MessageDto) {
  const clientMessageId = resolveClientMessageId(message.id, message.sessionId);
  const idx = messages.findIndex((m) => m.id === clientMessageId);
  if (idx >= 0) {
    const next = messages.slice();
    const previous = next[idx]!;
    next[idx] = {
      ...message,
      id: previous.id,
      // `message.created` is empty; a detail refresh has the canonical parts.
      parts: message.parts.length ? message.parts : previous.parts,
    };
    return next;
  }

  const pair = pendingOptimisticPair?.sessionId === message.sessionId ? pendingOptimisticPair : null;
  const pendingId =
    message.role === "user"
      ? pair?.userId
      : message.role === "assistant"
        ? pair?.assistantId
        : null;
  if (pendingId && messages.some((item) => item.id === pendingId)) {
    serverToClientMessageId.set(message.id, { clientId: pendingId, sessionId: message.sessionId });
    const next = messages.slice();
    const index = next.findIndex((item) => item.id === pendingId);
    const previous = next[index]!;
    next[index] = {
      ...message,
      id: pendingId,
      // `message.created` is intentionally empty; never wipe locally received parts.
      parts: message.parts.length ? message.parts : previous.parts,
    };
    if (message.role === "assistant") {
      migrateExpandedStepsMessageId(message.id, pendingId);
      pendingOptimisticPair = null;
    }
    return next;
  }

  return [...messages, message];
}

/** Keep recently opened chats warm so tree → chat feels instant. */
const sessionDetailCache = new Map<string, SessionDetailDto>();
/** Agent slash commands often arrive over WS before GET / selectSession. */
const slashCommandsCache = new Map<string, SlashCommandDto[]>();
const slashPollSeq = new Map<string, number>();
let selectSessionSeq = 0;

function readCachedSessionDetail(id: string): SessionDetailDto | undefined {
  const cached = sessionDetailCache.get(id);
  if (!cached) return undefined;
  return hydrateSessionSlashCommands(cached, slashCommandsCache) ?? undefined;
}

function rememberSessionDetail(detail: SessionDetailDto | null | undefined) {
  if (!detail?.id) return;
  const next = rememberSessionSlashCommands(detail, slashCommandsCache);
  sessionDetailCache.set(next.id, next);
  if (sessionDetailCache.size <= 24) return;
  const oldest = sessionDetailCache.keys().next().value;
  if (oldest) sessionDetailCache.delete(oldest);
}

function markRestoringDone(
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
  sessionId: string,
) {
  if (!get().restoringSessionIds[sessionId]) return;
  const next = { ...get().restoringSessionIds };
  delete next[sessionId];
  set({ restoringSessionIds: next });
}

/** In-flight POST /api/sessions per optimistic row, so a prompt sent before the
 *  server confirms the row waits for it instead of racing a 404. */
const pendingCreateById = new Map<string, Promise<unknown>>();
/** Safety net when nothing else reports a freshly created chat as ready. */
const INITIALIZING_TIMEOUT_MS = 15_000;

/** RFC 4122 v4 id; the server accepts it as the row's primary key. */
function newSessionId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = c.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Same string the server stores for a titleless chat (i18n defaultSessionTitle). */
function sessionPlaceholderTitle(locale: AppLocale | undefined): string {
  return createTranslator(locale ?? "en")("common.newChat");
}

function nextSessionSortOrder(sessions: SessionDto[]): number {
  return sessions.reduce((max, s) => Math.max(max, s.sortOrder ?? 0), -1) + 1;
}

function markSessionInitialized(
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
  sessionId: string,
) {
  if (!get().initializingSessionIds[sessionId]) return;
  const next = { ...get().initializingSessionIds };
  delete next[sessionId];
  set({ initializingSessionIds: next });
}

/** Fresh chat rows stay marked until the agent runtime answers (or the safety
 *  timeout fires) so the pane can say "Инициализация…" instead of looking idle. */
function scheduleInitializingTimeout(
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
  sessionId: string,
) {
  if (typeof window === "undefined") return;
  window.setTimeout(() => markSessionInitialized(get, set, sessionId), INITIALIZING_TIMEOUT_MS);
}

/** Undo an optimistic create whose POST failed: drop the row and give the
 *  selection back to whatever chat was open before (if any). */
function rollbackOptimisticSession(
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
  id: string,
  previousActiveId: string | null,
) {
  const state = get();
  const details = { ...(state.sessionDetails ?? {}) };
  delete details[id];
  sessionDetailCache.delete(id);
  slashCommandsCache.delete(id);
  const wasActive = state.activeSessionId === id;
  const previousDetail =
    wasActive && previousActiveId
      ? (details[previousActiveId] ?? sessionDetailCache.get(previousActiveId) ?? null)
      : null;
  set({
    sessions: state.sessions.filter((s) => s.id !== id),
    sessionDetails: details,
    ...(wasActive
      ? { activeSessionId: previousActiveId, activeSession: previousDetail, sessionLoading: false }
      : {}),
  });
  if (!wasActive) return;
  if (previousActiveId) {
    syncPanesOnSelect(get, set, previousActiveId);
    return;
  }
  persistPanes([null], 0);
  set({ chatPaneIds: [null], focusedPaneIndex: 0 });
}

async function pollImportedTranscript(
  sessionId: string,
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
) {
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 400));
    if (!get().restoringSessionIds[sessionId]) return;
    try {
      const detail = await api.getSession(sessionId);
      if (!detail.messages.length) continue;
      const live = liveDetail(get(), sessionId);
      const merged: SessionDetailDto = {
        ...detail,
        messages:
          live && live.messages.length > detail.messages.length ? live.messages : detail.messages,
      };
      commitDetail(get, set, merged);
      markRestoringDone(get, set, sessionId);
      return;
    } catch {
      /* keep waiting */
    }
  }
  markRestoringDone(get, set, sessionId);
}

/** Session detail with warm slash-command cache applied (for UI selectors). */
export function selectLiveSessionDetail(
  state: Pick<AppState, "activeSession" | "sessionDetails">,
  sessionId: string | null | undefined,
): SessionDetailDto | null {
  if (!sessionId) return state.activeSession;
  const detail =
    state.activeSession?.id === sessionId
      ? state.activeSession
      : (state.sessionDetails ?? {})[sessionId] ?? sessionDetailCache.get(sessionId) ?? null;
  return hydrateSessionSlashCommands(detail, slashCommandsCache);
}

function liveDetail(state: AppState, sessionId: string): SessionDetailDto | null {
  return selectLiveSessionDetail(state, sessionId);
}

function paneSlots(state: Pick<AppState, "chatPaneIds"> | AppState): ChatPaneSlot[] {
  return Array.isArray(state.chatPaneIds) ? state.chatPaneIds : [null];
}

function commitDetail(
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
  next: SessionDetailDto,
) {
  rememberSessionDetail(next);
  const state = get();
  const keep =
    paneSlots(state).includes(next.id) ||
    state.activeSessionId === next.id ||
    Boolean((state.sessionDetails ?? {})[next.id]);
  set({
    sessionDetails: keep
      ? { ...(state.sessionDetails ?? {}), [next.id]: next }
      : (state.sessionDetails ?? {}),
    ...(state.activeSession?.id === next.id ? { activeSession: next } : {}),
  });
  if (next.messages.length) markRestoringDone(get, set, next.id);
  // A live detail that already carries agent commands means the runtime is up.
  if (!slashListStillLoading(next.slashCommands)) markSessionInitialized(get, set, next.id);
}

function preferSlashCommands(
  fetched: SessionDetailDto,
  live?: SessionDetailDto | null,
): SessionDetailDto {
  return preferSessionSlashCommands(fetched, live, slashCommandsCache);
}

function pollSlashCommands(
  sessionId: string,
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
) {
  const seq = (slashPollSeq.get(sessionId) ?? 0) + 1;
  slashPollSeq.set(sessionId, seq);
  const settled = () => markSessionInitialized(get, set, sessionId);
  void (async () => {
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setTimeout(r, 400));
      if (slashPollSeq.get(sessionId) !== seq) return;
      const live = liveDetail(get(), sessionId);
      const hydrated = hydrateSessionSlashCommands(live, slashCommandsCache);
      if (!slashListStillLoading(hydrated?.slashCommands)) {
        settled();
        return;
      }
      try {
        const fetched = preferSlashCommands(
          await api.getSession(sessionId),
          hydrated ?? live,
        );
        if (slashPollSeq.get(sessionId) !== seq) return;
        if (slashListStillLoading(fetched.slashCommands)) continue;
        const cur = hydrateSessionSlashCommands(liveDetail(get(), sessionId), slashCommandsCache);
        const next = { ...(cur ?? fetched), slashCommands: fetched.slashCommands };
        rememberSessionDetail(next);
        commitDetail(get, set, next);
        settled();
        return;
      } catch {
        settled();
        return;
      }
    }
    // Gave up polling — stop claiming the chat is still starting up.
    settled();
  })();
}

function persistPanes(ids: ChatPaneSlot[], focus: number) {
  writeStoredChatPanes(ids, focus);
}

function syncPanesOnSelect(get: () => AppState, set: (partial: Partial<AppState>) => void, id: string) {
  if (!chatSplitAllowed(get().settings.chatSplit)) {
    persistPanes([id], 0);
    set({ chatPaneIds: [id], focusedPaneIndex: 0 });
    return;
  }
  const panes = [...paneSlots(get())];
  const existing = panes.findIndex((slot) => slot === id);
  if (existing >= 0) {
    persistPanes(panes, existing);
    set({ focusedPaneIndex: existing });
    return;
  }
  if (panes.length === 0) {
    persistPanes([id], 0);
    set({ chatPaneIds: [id], focusedPaneIndex: 0 });
    return;
  }
  const idx = Math.max(0, Math.min(panes.length - 1, get().focusedPaneIndex));
  panes[idx] = id;
  persistPanes(panes, idx);
  set({ chatPaneIds: panes, focusedPaneIndex: idx });
}

/** Cheap equality so a quiet background refresh can skip a React paint. */
function sessionDetailQuickEqual(
  a: SessionDetailDto | null | undefined,
  b: SessionDetailDto | null | undefined,
) {
  if (!a || !b) return a === b;
  return (
    a.id === b.id &&
    a.updatedAt === b.updatedAt &&
    a.status === b.status &&
    a.title === b.title &&
    a.mode === b.mode &&
    a.messages.length === b.messages.length &&
    a.messages.at(-1)?.id === b.messages.at(-1)?.id &&
    (a.slashCommands?.length ?? 0) === (b.slashCommands?.length ?? 0) &&
    slashCommandsKey(a.slashCommands) === slashCommandsKey(b.slashCommands)
  );
}

/** Coalesce rapid token WS events into one React paint per frame. */
type PendingPartEvent = Extract<WsServerEvent, { type: "part.appended" | "part.updated" }>;
let pendingPartEvents: PendingPartEvent[] = [];
let pendingPartRaf = 0;

function flushPendingPartEvents(get: () => AppState, set: (partial: Partial<AppState>) => void) {
  pendingPartRaf = 0;
  const batch = pendingPartEvents;
  pendingPartEvents = [];
  if (!batch.length) return;

  const grouped = new Map<string, PendingPartEvent[]>();
  for (const event of batch) {
    const list = grouped.get(event.sessionId);
    if (list) list.push(event);
    else grouped.set(event.sessionId, [event]);
  }

  for (const [sessionId, events] of grouped) {
    const state = get();
    const current = liveDetail(state, sessionId);
    if (!current) continue;
    const epoch = state.promptEpochBySession?.[sessionId] ?? state.promptEpoch;
    const cancelled = state.cancelledPromptEpochBySession?.[sessionId] ?? state.cancelledPromptEpoch;
    if (cancelled === epoch && epoch !== 0) continue;

    let messages = current.messages;
    let touched = false;
    for (const event of events) {
      let messageId = resolveClientMessageId(event.messageId, current.id);
      if (messageId === event.messageId) {
        const optimisticId =
          pendingOptimisticPair?.sessionId === current.id ? pendingOptimisticPair.assistantId : null;
        if (optimisticId && messages.some((message) => message.id === optimisticId)) {
          serverToClientMessageId.set(event.messageId, {
            clientId: optimisticId,
            sessionId: current.id,
          });
          messageId = optimisticId;
        }
      }
      let found = false;
      messages = messages.map((m) => {
        if (m.id !== messageId) return m;
        found = true;
        touched = true;
        return { ...m, parts: upsertMessagePart(m, { ...event.part, messageId }) };
      });
      if (!found) {
        touched = true;
        messages = [
          ...messages,
          {
            id: messageId,
            sessionId: event.sessionId,
            role: "assistant",
            createdAt: new Date().toISOString(),
            parts: [{ ...event.part, messageId }],
          },
        ];
      }
    }
    if (!touched) continue;
    commitDetail(get, set, { ...current, messages });
    reviveRunningIfTurnActive(sessionId, messages, get, set);
  }
}

function queuePartEvent(
  event: PendingPartEvent,
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
) {
  pendingPartEvents.push(event);
  if (pendingPartRaf) return;
  pendingPartRaf = requestAnimationFrame(() => flushPendingPartEvents(get, set));
}

function reconcileFinishedTurn(
  sessionId: string,
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
) {
  window.setTimeout(() => {
    void api
      .getSession(sessionId)
      .then((detail) => {
        const state = get();
        const current = liveDetail(state, sessionId);
        if (!current) return;
        commitDetail(get, set, mergeSessionQuestionAnswers(current, detail));
        clearMessageIdAliases(sessionId);
      })
      .catch(() => {
        // The live WS already rendered what it could; a later selection retries.
      });
  }, 120);
}

function markUnseenFinishedIfAway(
  sessionId: string,
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
) {
  const state = get();
  if (state.activeSessionId === sessionId) return;
  if (state.unseenFinishedTurns[sessionId]) return;
  set({ unseenFinishedTurns: { ...state.unseenFinishedTurns, [sessionId]: true } });
}

function clearUnseenFinished(
  sessionId: string,
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
) {
  const state = get();
  if (!state.unseenFinishedTurns[sessionId]) return;
  const next = { ...state.unseenFinishedTurns };
  delete next[sessionId];
  set({ unseenFinishedTurns: next });
}

/** Debounce typing into a composer from hitting the settings row on each key. */
const DRAFT_PERSIST_DELAY_MS = 600;
let draftPersistTimer: number | null = null;

function scheduleComposerDraftPersist(get: () => AppState) {
  if (typeof window === "undefined") return;
  if (draftPersistTimer !== null) window.clearTimeout(draftPersistTimer);
  draftPersistTimer = window.setTimeout(() => {
    draftPersistTimer = null;
    const current = get().settings.composerDrafts ?? {};
    const next = composerDraftSnapshot();
    let changed = Object.keys(current).length !== Object.keys(next).length;
    if (!changed) {
      for (const [k, v] of Object.entries(next)) {
        if (current[k] !== v) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) return;
    void get().saveSettings({ composerDrafts: next });
  }, DRAFT_PERSIST_DELAY_MS);
}

setComposerDraftPersistSink(() => scheduleComposerDraftPersist(useAppStore.getState));


async function loadAppData(
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
) {
  const storedTheme = localStorage.getItem("acpio.theme") as Theme | null;
  const storedLocale = localStorage.getItem("acpio.locale") as AppLocale | null;
  const settings = mergeClientAppSettings(await api.getSettings());
  const theme = storedTheme ?? settings.theme ?? "light";
  const locale =
    storedLocale === "en" || storedLocale === "ru" ? storedLocale : settings.locale ?? "en";
  get().applyTheme(theme);
  get().applyLocale(locale);
  applyAppearance(settings);
  const sessions = await api.listSessions();
  let serverPlatform: string | null = null;
  try {
    const health = await api.health();
    serverPlatform = health.platform;
  } catch {
    /* ignore */
  }
  // Restore persisted composer text before any pane mounts, so the first paint
  // already shows the draft (the pane reads the registry on session bind).
  seedComposerDrafts(settings.composerDrafts);
  set({ settings: { ...settings, theme, locale }, sessions, themes: [], serverPlatform });
  void get().probeAllAgents({
    quiet: hasStoredAgentAvailability(get().agentAvailability),
    reportOffline: hasStoredAgentAvailability(get().agentAvailability),
  });
  const storedId =
    typeof window !== "undefined" ? localStorage.getItem(ACTIVE_SESSION_KEY) : null;
  const pick =
    storedId && sessions.some((s) => s.id === storedId)
      ? storedId
      : sessions[0]?.id ?? null;
  if (pick) {
    const known = new Set(sessions.map((s) => s.id));
    const stored = readStoredChatPanes();
    const splitOn = chatSplitAllowed(get().settings.chatSplit);
    const ids = splitOn
      ? sanitizeChatPanes(stored?.ids ?? [pick], known, pick)
      : [pick];
    const focus = splitOn
      ? Math.max(0, Math.min(ids.length - 1, stored?.focus ?? 0))
      : 0;
    const focusId = ids[focus] ?? pick;
    writeStoredChatPanes(ids, focus);
    set({
      activeSessionId: focusId,
      sessionLoading: true,
      chatPaneIds: ids,
      focusedPaneIndex: focus,
    });
    void get().selectSession(focusId);
    for (const id of ids) {
      if (!id || id === focusId) continue;
      void api
        .getSession(id)
        .then((detail) => commitDetail(get, set, detail))
        .catch(() => {
          /* pane will retry when focused */
        });
    }
  } else {
    set({ activeSessionId: null, activeSession: null, chatPaneIds: [null], focusedPaneIndex: 0 });
  }
}

// Theme-scoped CSS lives under [data-theme=...] — set it synchronously at
// module load so the first paint (and any failed settings fetch) still shows
// the persisted theme instead of falling back to base variables.
if (typeof document !== "undefined") {
  try {
    const storedTheme = localStorage.getItem("acpio.theme") as Theme | null;
    document.documentElement.setAttribute("data-theme", storedTheme === "dark" ? "dark" : "light");
  } catch {
    /* ignore */
  }
}

const initialActiveSessionId =
  typeof window !== "undefined" ? localStorage.getItem(ACTIVE_SESSION_KEY) : null;
const initialConsoleOpenSessions = readConsoleOpenSessions();
const initialGitPanelOpenSessions = readGitPanelOpenSessions();

function resolveExclusiveSidePanels(
  consoleOpen: boolean,
  gitPanelOpen: boolean,
): { consoleOpen: boolean; gitPanelOpen: boolean } {
  if (consoleOpen && gitPanelOpen) return { consoleOpen: true, gitPanelOpen: false };
  return { consoleOpen, gitPanelOpen };
}

const initialSidePanels = resolveExclusiveSidePanels(
  Boolean(initialActiveSessionId && initialConsoleOpenSessions.has(initialActiveSessionId)),
  Boolean(initialActiveSessionId && initialGitPanelOpenSessions.has(initialActiveSessionId)),
);

export const useAppStore = create<AppState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  serverPlatform: null,
  sessions: [],
  themes: [],
  activeSessionId: null,
  activeSession: null,
  chatPaneIds: [null],
  focusedPaneIndex: 0,
  sessionDetails: {},
  consoleOpen: initialSidePanels.consoleOpen,
  gitPanelOpen: initialSidePanels.gitPanelOpen,
  knownFolders: [],
  refreshFolders: async () => {
    try {
      const folders = await api.listFolders();
      // One-time migration: folders remembered in localStorage (the previous
      // client-only list) are pushed to the server so they survive across
      // devices, then the local copy is dropped.
      try {
        const raw = localStorage.getItem("acpio.knownFolders.v1");
        if (raw) {
          const parsed = JSON.parse(raw) as unknown;
          const legacy = Array.isArray(parsed)
            ? parsed.filter((v): v is string => typeof v === "string")
            : [];
          const legacyOnly = legacy.filter((f) => !folders.includes(f));
          if (legacyOnly.length > 0) {
            void api.rememberFolders(legacyOnly).then(() => {
              try {
                localStorage.removeItem("acpio.knownFolders.v1");
              } catch {
                // ignore
              }
            });
          } else {
            localStorage.removeItem("acpio.knownFolders.v1");
          }
        }
      } catch {
        // ignore malformed local data
      }
      set({ knownFolders: folders });
      void get().refreshProjectMcp();
    } catch {
      // server offline — keep the current list
    }
  },
  projectMcp: {},
  refreshProjectMcp: async (cwd) => {
    try {
      const folders = await api.projectMcp(cwd);
      set((s) => ({ projectMcp: { ...s.projectMcp, ...folders } }));
    } catch {
      // server offline — keep the last known discovery
    }
  },
  deleteFolder: async (cwd) => {
    try {
      await api.deleteFolder(cwd);
      set((s) => ({ knownFolders: s.knownFolders.filter((f) => f !== cwd) }));
      void get().refreshSessions();
    } catch {
      // server offline — keep the folder
    }
  },
  reorderFolders: async (items) => {
    try {
      const folders = await api.reorderFolders(items);
      set({ knownFolders: folders });
    } catch {
      // server offline — keep the current list
    }
  },
  focusMessageId: null,
  sessionLoading: false,
  restoringSessionIds: {},
  initializingSessionIds: {},
  speakingMessageId: null,
  ttsLoading: false,
  modelsCatalog: typeof window !== "undefined" ? readStoredModelsCatalog() : null,
  modelsLoading:
    typeof window !== "undefined"
      ? !(readStoredModelsCatalog()?.models?.length)
      : true,
  allAdapters: [],
  adapters: [],
  adaptersLoaded: false,
  sidebarOpen: typeof window !== "undefined" ? window.innerWidth >= 900 : true,
  connected: false,
  connection: "connecting",
  agentAvailable: false,
  agentAvailability: typeof window !== "undefined" ? readStoredAgentAvailability() : {},
  agentProbing: {},
  agentGateDismissed:
    typeof window !== "undefined" && hasStoredAgentAvailability(),
  agentOfflineWarning: [],
  pendingPermission: null,
  permissionQueue: [],
  pendingQuestion: null,
  settingsQuery: "",
  setSettingsQuery: (query) => set({ settingsQuery: query }),
  promptEpoch: 0,
  cancelledPromptEpoch: -1,
  promptQueue: [],
  inflight: 0,
  inflightBySession: {},
  promptEpochBySession: {},
  cancelledPromptEpochBySession: {},
  unseenFinishedTurns: {},
  loading: false,
  bootstrapped: false,
  error: null,

  // Apply the persisted theme before the first paint: theme-scoped rules
  // (e.g. the sidebar "New chat" button) must be correct even when the
  // settings fetch fails or races, which would otherwise leave the app on
  // default (light) variables with no data-theme attribute.
  applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("acpio.theme", theme);
  },

  applyLocale(locale) {
    document.documentElement.lang = locale;
    localStorage.setItem("acpio.locale", locale);
  },

  async loadAdapters() {
    try {
      const all = await api.fetchAdapters();
      set({
        allAdapters: all,
        adapters: all.filter((a) => a.enabled !== false),
        adaptersLoaded: true,
      });
    } catch {
      // The static registry is served at boot; a failure leaves the UI with
      // the default (cursor/omp) provider forms.
    }
  },

  dismissAgentGate() {
    set({ agentGateDismissed: true });
  },

  dismissAgentOfflineWarning() {
    set({ agentOfflineWarning: [] });
  },

  async probeAllAgents(opts) {
    const force = opts?.force === true;
    if (probeAllAgentsInflight) return probeAllAgentsInflight;
    if (
      !force &&
      lastProbeAllAgentsAt > 0 &&
      Date.now() - lastProbeAllAgentsAt < PROBE_ALL_COOLDOWN_MS
    ) {
      return;
    }
    probeAllAgentsInflight = (async () => {
    if (!get().adaptersLoaded) {
      await get().loadAdapters();
    }
    const ids = get().adapters.map((a) => a.id) as AgentProvider[];
    const quiet = opts?.quiet === true;
    const reportOffline = opts?.reportOffline === true;
    const snapshot: AgentAvailabilityMap = { ...get().agentAvailability };
    const probing: Partial<Record<AgentProvider, boolean>> = { ...get().agentProbing };
    for (const id of ids) probing[id] = true;
    if (quiet) {
      set({ agentProbing: probing });
    } else {
      const availability: AgentAvailabilityMap = { ...get().agentAvailability };
      for (const id of ids) {
        if (availability[id] !== true && availability[id] !== false) availability[id] = null;
      }
      set({ agentProbing: probing, agentAvailability: availability });
    }
    const results: Partial<Record<AgentProvider, boolean>> = {};
    await Promise.all(
      ids.map(async (id) => {
        let next: boolean;
        try {
          next = (await api.probeAgent(id)).ok;
        } catch {
          next = false;
        }
        results[id] = next;
        const prev = get().agentAvailability[id];
        if (prev !== next) get().setAgentAvailable(id, next);
        set({
          agentProbing: { ...get().agentProbing, [id]: false },
        });
      }),
    );
    writeStoredAgentAvailability(get().agentAvailability);
    if (reportOffline) {
      const wentOffline = ids.filter(
        (id) => snapshot[id] === true && results[id] === false,
      );
      if (wentOffline.length) set({ agentOfflineWarning: wentOffline });
    }
    const online = ids.filter(
      (id) => results[id] === true || get().agentAvailability[id] === true,
    );
    const settings = get().settings;
    const nextDefault =
      settings.defaultProvider && online.includes(settings.defaultProvider)
        ? settings.defaultProvider
        : (online[0] ?? null);
    if (nextDefault) {
      const patch: Partial<typeof settings> = {};
      if (settings.connectedProvider !== nextDefault) patch.connectedProvider = nextDefault;
      if (Object.keys(patch).length) {
        try {
          const saved = await api.updateSettings(patch);
          set({ settings: saved });
        } catch {
          /* keep local */
        }
      }
      const focus = get().activeSession?.provider ?? nextDefault;
      void get().ensureModels(focus);
    } else if (settings.connectedProvider) {
      try {
        const saved = await api.updateSettings({ connectedProvider: null });
        set({ settings: saved });
      } catch {
        /* keep local */
      }
    }
    })().finally(() => {
      lastProbeAllAgentsAt = Date.now();
      probeAllAgentsInflight = null;
    });
    return probeAllAgentsInflight;
  },

  rememberModelsCatalog(catalog) {
    const cleaned: ModelsCatalog = {
      ...catalog,
      modes: sanitizeCatalogModes(catalog.provider, catalog.modes),
    };
    writeStoredModelsCatalog(cleaned);
    set({ modelsCatalog: cleaned, modelsLoading: false });
  },

  async ensureModels(provider, opts) {
    const force = opts?.force === true;
    const active = get().modelsCatalog;
    const cachedForProvider =
      active?.provider === provider ? active : readStoredModelsCatalog(provider);
    const existing = cachedForProvider;
    const providerMismatch = active != null && active.provider !== provider;
    const freshEnough =
      existing &&
      existing.provider === provider &&
      existing.models.length > 0 &&
      Date.now() - existing.at < modelsHardTtl(provider);
    const missingParams = (existing?.modelParams?.length ?? 0) === 0;
    const missingModes = provider === "cursor" && (existing?.modes?.length ?? 0) === 0;

    // Instantly show the last catalog for this agent (Fast/Effort) when switching.
    if (providerMismatch) {
      set({
        modelsCatalog:
          existing?.provider === provider
            ? {
                ...existing,
                modes: sanitizeCatalogModes(provider, existing.modes),
              }
            : null,
        modelsLoading: !(existing?.models?.length),
      });
    }

    // Don't keep Cursor Agent/Plan/Ask chips on OMP after a switch.
    const staleCursorModes =
      provider !== "cursor" &&
      (existing?.modes?.some(
        (m) =>
          m.value === "agent" ||
          m.value === "plan" ||
          m.value === "ask" ||
          /^default$/i.test(m.value),
      ) ??
        false);

    if (freshEnough && !force && !missingParams && !missingModes && !staleCursorModes) {
      const cleanedModes = sanitizeCatalogModes(provider, existing.modes);
      const cleaned =
        cleanedModes.length === existing.modes.length
          ? existing
          : { ...existing, modes: cleanedModes };
      if (cleaned !== existing || active?.provider !== provider) {
        get().rememberModelsCatalog(cleaned);
      } else {
        set({ modelsLoading: false });
      }
      const softStale = Date.now() - existing.at >= modelsSoftTtl(provider);
      if (softStale) {
        void api
          .listModels(provider)
          .then((res) => {
            if (!res.ok && !(res.models?.length)) return;
            get().rememberModelsCatalog({
              provider,
              models: res.models ?? [],
              modelParams: res.modelParams ?? [],
              modes: sanitizeCatalogModes(provider, res.modes),
              currentModel: res.currentModel,
              at: Date.now(),
            });
          })
          .catch(() => {
            /* keep cache */
          });
      }
      set({ modelsLoading: false });
      return cleaned;
    }

    const hasModels = Boolean(existing?.models?.length);
    const agentBusy =
      get().activeSession?.status === "running" || get().activeSession?.status === "waiting";
    // Keep prior catalog for this provider while reloading so Effort doesn't blink away.
    // If the agent is already answering (or we already have models), don't block the UI.
    // Drop stale Cursor mode chips immediately when switching to OMP/etc.
    set({
      modelsCatalog:
        existing?.provider === provider
          ? staleCursorModes
            ? { ...existing, modes: [] }
            : existing
          : null,
      modelsLoading: hasModels || agentBusy ? false : true,
    });

    try {
      const res = await api.listModels(provider, { force });
      const catalog: ModelsCatalog = {
        provider,
        models: res.models ?? [],
        modelParams: res.modelParams ?? [],
        modes: sanitizeCatalogModes(provider, res.modes),
        currentModel: res.currentModel,
        at: Date.now(),
      };
      if (catalog.models.length || catalog.modelParams.length || catalog.modes.length) {
        get().rememberModelsCatalog(catalog);
      } else {
        set({ modelsLoading: false });
      }
      return catalog;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      rememberDiagnosticsError(message, "models");
      set({
        modelsLoading: false,
        error: message,
      });
      return get().modelsCatalog;
    }
  },

  async fetchProviderModels(provider) {
    const activeCatalog = get().modelsCatalog;
    const existing =
      activeCatalog?.provider === provider && activeCatalog.models.length
        ? activeCatalog
        : readStoredModelsCatalog(provider);

    const apply = (catalog: ModelsCatalog) => {
      const cleaned = {
        ...catalog,
        modes: sanitizeCatalogModes(catalog.provider, catalog.modes),
      };
      writeStoredModelsCatalog(cleaned);
      if (get().modelsCatalog?.provider === cleaned.provider) {
        set({ modelsCatalog: cleaned, modelsLoading: false });
      }
      return cleaned;
    };

    const refresh = async () => {
      const res = await api.listModels(provider);
      const catalog: ModelsCatalog = {
        provider,
        models: res.models ?? [],
        modelParams: res.modelParams ?? [],
        modes: sanitizeCatalogModes(provider, res.modes),
        currentModel: res.currentModel,
        at: Date.now(),
      };
      if (catalog.models.length || catalog.modelParams.length || catalog.modes.length) {
        return apply(catalog);
      }
      return existing;
    };

    if (existing?.models.length) {
      if (Date.now() - existing.at >= modelsHardTtl(provider)) {
        void refresh().catch(() => {
          /* keep cache */
        });
      }
      return existing;
    }

    try {
      return await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      rememberDiagnosticsError(message, "models");
      return null;
    }
  },

  async setTheme(theme) {
    get().applyTheme(theme);
    const settings = await api.updateSettings({ theme });
    set({ settings });
    applyAppearance(settings);
  },

  async setLocale(locale) {
    get().applyLocale(locale);
    const settings = await api.updateSettings({ locale });
    set({ settings });
  },

  async loadBootstrap() {
    set({ loading: true, error: null });
    try {
      void get().loadAdapters();
      void get().refreshFolders();
      await loadAppData(set, get);
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      set({ loading: false, bootstrapped: true });
    }
  },

  async refreshSessions() {
    const sessions = await api.listSessions();
    set({ sessions });
    // The list is raw DB rows. A turn the server accepted but has not started
    // yet (ACP cold start) still reads "idle" there for a moment, and any row
    // whose status write raced is stale too — ask the live runtime about every
    // non-terminal row so the tree's running icon survives a reload even for
    // chats that are not open in a pane (nothing else polls their /turn).
    void reconcileLiveTurnStatuses(sessions);
  },

  async refreshThemes() {
    const themes = await api.listThemes();
    set({ themes });
  },

  setFocusMessageId(id) {
    set({ focusMessageId: id });
  },

  setSpeakingMessageId(id) {
    set({ speakingMessageId: id });
  },

  setTtsLoading(loading) {
    set({ ttsLoading: loading });
  },

  setConsoleOpen(open) {
    const sessionId = get().activeSessionId;
    const active = get().activeSession;
    const listRow = sessionId ? get().sessions.find((s) => s.id === sessionId) : undefined;
    if (isShellSession(active?.provider ?? listRow?.provider)) return;
    set({ consoleOpen: open, ...(open ? { gitPanelOpen: false } : {}) });
    if (sessionId) persistConsoleOpen(sessionId, open);
    if (open && sessionId) persistGitPanelOpen(sessionId, false);
  },

  toggleConsoleOpen() {
    const open = !get().consoleOpen;
    get().setConsoleOpen(open);
  },

  setGitPanelOpen(open) {
    const sessionId = get().activeSessionId;
    set({ gitPanelOpen: open, ...(open ? { consoleOpen: false } : {}) });
    if (sessionId) persistGitPanelOpen(sessionId, open);
    if (open && sessionId) persistConsoleOpen(sessionId, false);
  },

  toggleGitPanelOpen() {
    const open = !get().gitPanelOpen;
    get().setGitPanelOpen(open);
  },

  async selectSession(id) {
    if (!id) {
      localStorage.removeItem(ACTIVE_SESSION_KEY);
      set({
        activeSessionId: null,
        activeSession: null,
        sessionLoading: false,
        pendingPermission: null,
        permissionQueue: [],
        pendingQuestion: null,
      });
      return;
    }

    localStorage.setItem(ACTIVE_SESSION_KEY, id);
    clearUnseenFinished(id, get, set);
    const seq = ++selectSessionSeq;
    const listRow = get().sessions.find((s) => s.id === id);
    const cachedForPanels = readCachedSessionDetail(id);
    const shellSession = isShellSession(listRow?.provider ?? cachedForPanels?.provider);
    if (shellSession) removeConsoleOpenSession(id);
    set({
      ...resolveExclusiveSidePanels(
        !shellSession && readConsoleOpenSessions().has(id),
        readGitPanelOpenSessions().has(id),
      ),
    });
    const cached = cachedForPanels;
    const current = get().activeSession;
    const alreadyWarm =
      get().activeSessionId === id &&
      current?.id === id &&
      (Boolean(cached) || !get().sessionLoading);

    // Re-clicking the open chat (or StrictMode re-select): refresh quietly —
    // no empty stub, no skeleton flash, no keyed thread remount.
    if (alreadyWarm) {
      try {
        const detail = preferSlashCommands(await api.getSession(id), liveDetail(get(), id));
        rememberSessionDetail(detail);
        if (slashListStillLoading(detail.slashCommands)) pollSlashCommands(id, get, set);
        if (seq !== selectSessionSeq || get().activeSessionId !== id) return;
        const live = get().activeSession;
        if (live?.status === "running") {
          set({
            sessionLoading: false,
            activeSession: {
              ...live,
              ...detail,
              status: "running",
              messages: live.messages.length ? live.messages : detail.messages,
            },
          });
          return;
        }
        // The server is authoritative about a turn this tab did not start: after a
        // reload `inflight` is 0, and without this the fetched running status would
        // be dropped and Stop never reappear.
        if (detail.status === "running" || detail.status === "waiting") {
          confirmServerBusy(id, detail.status);
        } else {
          await adoptLiveTurnStatus(id);
        }
        if (sessionDetailQuickEqual(live, detail)) {
          if (get().sessionLoading) set({ sessionLoading: false });
          return;
        }
        set({
          activeSession: detail,
          sessionLoading: false,
          error: detail.status === "error" ? lastAssistantErrorMessage(detail) : null,
        });
        // Wiping aliases also drops the adopted server-busy marker — skip it when a
        // live turn was just confirmed for this chat.
        if (!serverConfirmedBusy.has(id)) clearMessageIdAliases(id);
      } catch (err) {
        if (seq !== selectSessionSeq || get().activeSessionId !== id) return;
        set({
          error: err instanceof Error ? err.message : String(err),
          sessionLoading: false,
        });
      }
      return;
    }

    // Prefer a warm cache / same-session detail. Never invent `{ messages: [] }`
    // from a list row — that remounts an empty keyed thread, then refills it
    // when GET lands (double paint before the first send).
    const optimistic: SessionDetailDto | null =
      cached ?? (current?.id === id ? current : null);

    // Note: message-id aliases are deliberately NOT cleared here — an
    // in-flight optimistic turn in another chat must keep its bridge so
    // returning mid-stream never spawns a duplicate assistant message.

    set({
      activeSessionId: id,
      // When switching without a cache hit, keep the previous thread under the
      // skeleton instead of mounting an empty placeholder for `id`.
      ...(optimistic ? { activeSession: optimistic } : {}),
      sessionLoading: !cached,
      pendingPermission: null,
      permissionQueue: [],
      pendingQuestion: null,
      // Composer banner is per active chat — don't carry another session's error.
      error: null,
      ...(optimistic
        ? { sessionDetails: { ...(get().sessionDetails ?? {}), [id]: optimistic } }
        : {}),
    });
    syncPanesOnSelect(get, set, id);

    try {
      const detail = preferSlashCommands(await api.getSession(id), liveDetail(get(), id));
      rememberSessionDetail(detail);
      if (slashListStillLoading(detail.slashCommands)) pollSlashCommands(id, get, set);
      if (seq !== selectSessionSeq || get().activeSessionId !== id) return;
      const live = get().activeSession;
      if (detail.messages.length === 0 && live?.id === id && live.messages.length > 0) {
        set({
          sessionLoading: false,
          activeSession: { ...detail, messages: live.messages },
        });
        return;
      }
      // Don't clobber an in-flight optimistic turn with a stale GET snapshot —
      // but still deliver the fetched messages so a fresh load of a running
      // session isn't left with an empty thread (skeleton would vanish first).
      if (get().activeSession?.status === "running" && get().activeSession?.id === id) {
        const live = get().activeSession!;
        set({
          sessionLoading: false,
          activeSession: {
            ...live,
            ...detail,
            status: "running",
            messages: live.messages.length ? live.messages : detail.messages,
          },
        });
        return;
      }
      // Same as the warm path: a reload must not lose a turn the server is still
      // running just because this tab never sent its prompt.
      if (detail.status === "running" || detail.status === "waiting") {
        confirmServerBusy(id, detail.status);
      } else {
        await adoptLiveTurnStatus(id);
      }
      if (sessionDetailQuickEqual(get().activeSession, detail) && !get().sessionLoading) {
        return;
      }
      set({
        activeSession: detail,
        sessionLoading: false,
        error: detail.status === "error" ? lastAssistantErrorMessage(detail) : null,
        sessionDetails: { ...(get().sessionDetails ?? {}), [id]: detail },
        pendingQuestion: pendingQuestionFromDetail(detail) ?? get().pendingQuestion,
      });
      if (detail.messages.length) markRestoringDone(get, set, id);
      // The fetched detail is server-authoritative: the optimistic aliases for
      // this session are obsolete (their local messages are gone).
      if (!serverConfirmedBusy.has(id)) clearMessageIdAliases(id);
    } catch (err) {
      if (seq !== selectSessionSeq || get().activeSessionId !== id) return;
      set({
        error: err instanceof Error ? err.message : String(err),
        sessionLoading: false,
      });
    }
  },

  collapseToSinglePane() {
    const id = get().activeSessionId;
    const ids = paneSlots(get());
    if (ids.length === 1 && ids[0] === id && get().focusedPaneIndex === 0) return;
    persistPanes([id], 0);
    set({ chatPaneIds: [id], focusedPaneIndex: 0 });
  },

  setChatPaneCount(count) {
    const n = Math.max(1, Math.min(CHAT_PANE_MAX, Math.round(count)));
    const state = get();
    if (n === 1) {
      get().collapseToSinglePane();
      return;
    }
    if (!chatSplitAllowed(state.settings.chatSplit)) return;
    const wasSingle = paneSlots(state).length <= 1;
    let ids = [...paneSlots(state)];
    if (ids.length === 0) ids = [state.activeSessionId];
    const known = state.sessions.filter((s) => !s.archived);
    while (ids.length < n) {
      const take = known.find((s) => !ids.includes(s.id));
      ids.push(take?.id ?? null);
    }
    ids = ids.slice(0, n);
    const focus = Math.min(state.focusedPaneIndex, n - 1);
    persistPanes(ids, focus);
    if (wasSingle) set({ chatPaneIds: ids, focusedPaneIndex: focus, consoleOpen: false, gitPanelOpen: false });
    else set({ chatPaneIds: ids, focusedPaneIndex: focus });
    const focusId = ids[focus];
    if (focusId && focusId !== state.activeSessionId) void get().selectSession(focusId);
    for (const paneId of ids) {
      if (!paneId || paneId === get().activeSessionId || get().sessionDetails?.[paneId]) continue;
      void api
        .getSession(paneId)
        .then((detail) => commitDetail(get, set, detail))
        .catch(() => {});
    }
  },

  focusChatPane(index) {
    const ids = paneSlots(get());
    if (index < 0 || index >= ids.length) return;
    persistPanes(ids, index);
    set({ focusedPaneIndex: index });
    const paneId = ids[index];
    if (paneId && paneId !== get().activeSessionId) void get().selectSession(paneId);
  },

  closeChatPane(index) {
    const ids = [...paneSlots(get())];
    if (ids.length <= 1) return;
    ids.splice(index, 1);
    const focus = Math.min(get().focusedPaneIndex, ids.length - 1);
    persistPanes(ids, focus);
    set({ chatPaneIds: ids, focusedPaneIndex: focus });
    const paneId = ids[focus];
    if (paneId) void get().selectSession(paneId);
  },

  async openSessionInNewPane(id) {
    if (!chatSplitAllowed(get().settings.chatSplit)) {
      await get().selectSession(id);
      return;
    }
    const ids = [...paneSlots(get())];
    const wasSingle = ids.length <= 1;
    const existing = ids.findIndex((slot) => slot === id);
    if (existing >= 0) {
      persistPanes(ids, existing);
      set({ focusedPaneIndex: existing });
      await get().selectSession(id);
      return;
    }
    const empty = ids.findIndex((slot) => !slot);
    if (empty >= 0) {
      ids[empty] = id;
      persistPanes(ids, empty);
      set({
        chatPaneIds: ids,
        focusedPaneIndex: empty,
        ...(wasSingle && ids.length > 1 ? { consoleOpen: false, gitPanelOpen: false } : {}),
      });
      await get().selectSession(id);
      return;
    }
    if (ids.length < CHAT_PANE_MAX) {
      ids.push(id);
      persistPanes(ids, ids.length - 1);
      set({
        chatPaneIds: ids,
        focusedPaneIndex: ids.length - 1,
        ...(wasSingle ? { consoleOpen: false, gitPanelOpen: false } : {}),
      });
      await get().selectSession(id);
      return;
    }
    await get().selectSession(id);
  },

  async createSession(cwd, provider, model) {
    const trimmedCwd = cwd?.trim();
    const shell = isShellSession(provider);
    const ids = get().adapters.map((a) => a.id) as AgentProvider[];
    const chosen = shell
      ? SHELL_SESSION_PROVIDER
      : provider ??
        pickCreateProvider(get().agentAvailability, ids, get().settings.defaultProvider);
    if (!chosen) {
      throw new Error("noAgentsOnline");
    }

    // Save the chosen provider as the last selected provider in localStorage
    if (!shell && typeof localStorage !== "undefined") {
      try {
        localStorage.setItem("acpio.lastSelectedProvider.v1", chosen);
      } catch {
        // ignore
      }
    }

    // Render the chat NOW and let the POST land in the background: creating the
    // agent runtime takes seconds on a cold provider, and the user must not
    // stare at a dead sidebar/tree until then. The row keeps the client id so
    // the server can adopt it verbatim.
    const previousActiveId = get().activeSessionId;
    const id = newSessionId();
    const now = new Date().toISOString();
    const cwdValue = normalizeCwd(trimmedCwd ?? get().settings.defaultCwd ?? "");
    const pinnedModel = model?.trim();
    const optimistic: SessionDto = {
      id,
      title: shell
        ? cwdValue.split("/").filter(Boolean).pop() || sessionPlaceholderTitle(get().settings.locale)
        : sessionPlaceholderTitle(get().settings.locale),
      provider: chosen,
      cwd: cwdValue,
      mode: get().settings.defaultMode,
      status: "idle",
      acpSessionId: null,
      themeId: null,
      sortOrder: nextSessionSortOrder(get().sessions),
      pinned: false,
      archived: false,
      mcpDisabledIds: [],
      usage: null,
      model: pinnedModel ?? "",
      modelParams: {},
      createdAt: now,
      updatedAt: now,
      lastMessageAt: "",
    };
    const detail: SessionDetailDto = { ...optimistic, messages: [], slashCommands: [] };
    rememberSessionDetail(detail);
    if (shell) removeConsoleOpenSession(id);
    set({
      sessions: [optimistic, ...get().sessions.filter((s) => s.id !== id)],
      activeSessionId: id,
      activeSession: detail,
      sessionLoading: false,
      sessionDetails: { ...(get().sessionDetails ?? {}), [id]: detail },
      initializingSessionIds: { ...get().initializingSessionIds, [id]: true },
      error: null,
      ...(shell ? { consoleOpen: false, gitPanelOpen: false } : {}),
    });
    syncPanesOnSelect(get, set, id);
    scheduleInitializingTimeout(get, set, id);

    const createPromise = (async (): Promise<SessionDto> => {
      try {
        const session = await api.createSession({
          id,
          themeId: null,
          provider: chosen,
          ...(cwdValue ? { cwd: cwdValue } : {}),
          ...(pinnedModel ? { model: pinnedModel } : {}),
        } as Partial<SessionDto>);
        if (session.id !== id) {
          // A server that ignores the optimistic id (older build) mints its own;
          // drop the local placeholder and open the row it actually created.
          rollbackOptimisticSession(get, set, id, previousActiveId);
          markSessionInitialized(get, set, id);
          await get().refreshSessions();
          await get().selectSession(session.id);
          return session;
        }
        // Server row is canonical (title, sortOrder, timestamps) — keep whatever
        // the stream already pushed (commands) on top of it.
        const live = liveDetail(get(), id);
        const reconciled: SessionDetailDto = {
          ...session,
          messages: live?.messages ?? [],
          slashCommands: live?.slashCommands ?? [],
        };
        rememberSessionDetail(reconciled);
        set({
          sessions: get().sessions.map((s) => (s.id === id ? session : s)),
          ...(get().activeSessionId === id ? { activeSession: reconciled } : {}),
          sessionDetails: { ...(get().sessionDetails ?? {}), [id]: reconciled },
        });
        void get().refreshSessions();
        void get().refreshFolders();
        if (shell || !slashListStillLoading(reconciled.slashCommands)) {
          markSessionInitialized(get, set, id);
        } else {
          // Readiness signal: the runtime answers with its slash commands.
          pollSlashCommands(id, get, set);
        }
        return session;
      } catch (err) {
        rollbackOptimisticSession(get, set, id, previousActiveId);
        markSessionInitialized(get, set, id);
        throw err;
      }
    })();
    pendingCreateById.set(id, createPromise);
    void createPromise
      .catch(() => undefined)
      .finally(() => pendingCreateById.delete(id));
    return createPromise;
  },

  async importHarnessSession(input) {
    const session = await api.importHarnessSession(input);
    await get().refreshSessions();
    const detail: SessionDetailDto = {
      ...session,
      messages: session.messages ?? [],
      slashCommands: session.slashCommands ?? [],
    };
    rememberSessionDetail(detail);
    if (!detail.messages.length) {
      set({ restoringSessionIds: { ...get().restoringSessionIds, [detail.id]: true } });
    }
    await get().selectSession(session.id);
    if (!detail.messages.length) {
      void pollImportedTranscript(detail.id, get, set);
    }
    return session;
  },

  async deleteSession(id) {
    await destroyConsoleTerminal(id);
    await api.deleteSession(id);
    const { activeSessionId } = get();
    await get().refreshSessions();
    const panes = paneSlots(get()).map((slot) => (slot === id ? null : slot));
    const remaining = panes.filter(Boolean);
    if (remaining.length === 0) {
      persistPanes(panes.length ? panes : [null], 0);
      set({ chatPaneIds: panes.length ? panes : [null], focusedPaneIndex: 0 });
    } else if (panes !== get().chatPaneIds) {
      const focus = Math.min(get().focusedPaneIndex, panes.length - 1);
      persistPanes(panes, focus);
    }
    const details = { ...get().sessionDetails };
    delete details[id];
    slashCommandsCache.delete(id);
    forgetComposerDraft(id);
    sessionDetailCache.delete(id);
    const unseen = { ...get().unseenFinishedTurns };
    delete unseen[id];
    removeConsoleOpenSession(id);
    removeGitPanelOpenSession(id);
    set({ sessionDetails: details, unseenFinishedTurns: unseen });
    markSessionInitialized(get, set, id);
    markRestoringDone(get, set, id);
    if (activeSessionId === id) {
      const next =
        panes.find((slot) => slot && slot !== id) ?? get().sessions[0]?.id ?? null;
      await get().selectSession(next);
    }
  },

  async renameSession(id, title) {
    const trimmed = title.trim();
    if (!trimmed) return;
    const prev = get().sessions.find((s) => s.id === id);
    const updated = await api.updateSession(id, { title: trimmed });
    if (!updated) return;
    // Metadata PATCH must not rewrite tree activity (lastMessageAt).
    const merged = {
      ...updated,
      lastMessageAt: prev?.lastMessageAt ?? updated.lastMessageAt,
      updatedAt: prev?.updatedAt ?? updated.updatedAt,
    };
    set({
      sessions: get().sessions.map((s) => (s.id === id ? { ...s, ...merged, title: updated.title } : s)),
      activeSession:
        get().activeSession?.id === id
          ? { ...get().activeSession!, title: updated.title }
          : get().activeSession,
    });
  },

  async setSessionFlags(id, patch) {
    const isArchivingActive = patch.archived === true && get().activeSessionId === id;
    let nextSessionId: string | null = null;

    if (isArchivingActive) {
      const oldFoldersList = groupByFolder(
        get().sessions.filter((s) => !s.archived),
        get().knownFolders
      );
      const oldVisibleSessions = oldFoldersList.flatMap((f) => f.sessions);
      const oldIndex = oldVisibleSessions.findIndex((s) => s.id === id);

      const remainingSessions = oldVisibleSessions.filter((s) => s.id !== id);
      if (remainingSessions.length > 0) {
        const nextSession =
          remainingSessions[oldIndex] ??
          remainingSessions[oldIndex - 1] ??
          remainingSessions[0];
        nextSessionId = nextSession.id;
      }
    }

    // Optimistic flip, then reconcile flags — never activity stamps.
    const apply = (s: SessionDto) => (s.id === id ? { ...s, ...patch } : s);
    set({
      sessions: get().sessions.map(apply),
      activeSession:
        get().activeSession?.id === id
          ? { ...get().activeSession!, ...patch }
          : get().activeSession,
    });

    if (isArchivingActive) {
      await get().selectSession(nextSessionId);
    }

    try {
      const updated = await api.updateSession(id, patch);
      if (!updated) return;
      set({
        sessions: get().sessions.map((s) =>
          s.id === id
            ? {
                ...s,
                pinned: updated.pinned,
                archived: updated.archived,
                mcpDisabledIds: updated.mcpDisabledIds ?? s.mcpDisabledIds,
                // Keep the client activity stamp (last user message).
                lastMessageAt: s.lastMessageAt,
                updatedAt: s.updatedAt,
              }
            : s,
        ),
        activeSession:
          get().activeSession?.id === id
            ? {
                ...get().activeSession!,
                pinned: updated.pinned,
                archived: updated.archived,
                mcpDisabledIds: updated.mcpDisabledIds ?? get().activeSession!.mcpDisabledIds,
                lastMessageAt: get().activeSession!.lastMessageAt,
                updatedAt: get().activeSession!.updatedAt,
              }
            : get().activeSession,
      });
    } catch {
      // keep the optimistic value
    }
  },

  async archiveSessions(ids) {
    const active = get().activeSessionId;
    const targets = ids.filter((id) => {
      const row = get().sessions.find((s) => s.id === id);
      return row != null && !row.archived;
    });
    if (!targets.length) return;
    // The focused chat goes last: setSessionFlags hands focus to a survivor of
    // the tree, and that pick must already see the rest of the batch archived
    // so it can never land on a chat this same call is about to archive.
    await Promise.all(
      targets
        .filter((id) => id !== active)
        .map((id) => get().setSessionFlags(id, { archived: true })),
    );
    if (active && targets.includes(active)) {
      await get().setSessionFlags(active, { archived: true });
    }
  },

  async reorderSessions(items) {
    const sessions = await api.reorderSessions(items);
    const active = get().activeSession;
    const nextActive = active ? sessions.find((s) => s.id === active.id) : null;
    set({
      sessions,
      activeSession: active && nextActive ? { ...active, ...nextActive } : active,
    });
  },

  /**
   * Send a prompt, or queue it when the agent is busy. Queued items stay in
   * `promptQueue` (editable/deletable) until a slot frees up; the drain then
   * hands them to the server one at a time (serial) or up to two at once when
   * multitask is enabled.
   */
  async sendPrompt(text, opts) {
    const sid = opts?.sessionId ?? get().activeSessionId;
    const limit = get().settings.multitask ? 2 : 1;
    const detail = sid ? liveDetail(get(), sid) : get().activeSession;
    const listed = sid ? get().sessions.find((s) => s.id === sid) : null;
    const status = detail?.status ?? listed?.status;
    const inf = sid ? (get().inflightBySession?.[sid] ?? 0) : get().inflight;
    const queued = sid
      ? get().promptQueue.filter((q) => q.sessionId === sid)
      : get().promptQueue;
    const busy =
      inf >= limit || queued.length > 0 || status === "running" || status === "waiting";
    if (busy) {
      if (!sid) return;
      set({
        promptQueue: [
          ...get().promptQueue,
          {
            id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            text,
            sessionId: sid,
            editMessageId: opts?.editMessageId ?? null,
            attachments: opts?.attachments,
          },
        ],
      });
      await new Promise((r) => setTimeout(r, 80));
      void get().drainPromptQueue();
      return;
    }
    if (sid) {
      // A new prompt starts a fresh turn: drop the busy marker adopted from an
      // earlier reload probe. Its delayed-idle path still clears inflight, but
      // the set would keep `isClientTurnLive` true after this turn finishes.
      serverConfirmedBusy.delete(sid);
      const inflightBySession = { ...get().inflightBySession, [sid]: inf + 1 };
      set({
        inflightBySession,
        inflight: Object.values(inflightBySession).reduce((a, b) => a + b, 0),
      });
    } else {
      set({ inflight: get().inflight + 1 });
    }
    await get().runSendPrompt(text, opts, { optimistic: true });
  },

  removeQueuedPrompt(id) {
    set({ promptQueue: get().promptQueue.filter((item) => item.id !== id) });
  },

  updateQueuedPrompt(id, text) {
    set({
      promptQueue: get().promptQueue.map((item) => (item.id === id ? { ...item, text } : item)),
    });
  },

  async setMultitask(value) {
    set({ settings: { ...get().settings, multitask: value } });
    try {
      await api.updateSettings({ multitask: value });
    } catch {
      // keep the local toggle; a later form save persists it
    }
  },

  async drainPromptQueue() {
    const limit = get().settings.multitask ? 2 : 1;
    const q = get().promptQueue;
    if (!q.length) return;
    const idx = q.findIndex((item) => {
      const inf = get().inflightBySession?.[item.sessionId] ?? 0;
      if (inf >= limit) return false;
      const detail = liveDetail(get(), item.sessionId);
      const listed = get().sessions.find((s) => s.id === item.sessionId);
      const status = detail?.status ?? listed?.status;
      if (limit === 1 && (status === "running" || status === "waiting")) return false;
      return true;
    });
    if (idx < 0) return;
    const item = q[idx];
    const rest = q.filter((_, i) => i !== idx);
    const inf = (get().inflightBySession?.[item.sessionId] ?? 0) + 1;
    const inflightBySession = { ...get().inflightBySession, [item.sessionId]: inf };
    set({
      promptQueue: rest,
      inflightBySession,
      inflight: Object.values(inflightBySession).reduce((a, b) => a + b, 0),
    });
    try {
      await get().runSendPrompt(
        item.text,
        {
          sessionId: item.sessionId,
          ...(item.editMessageId ? { editMessageId: item.editMessageId } : {}),
          ...(item.attachments?.length ? { attachments: item.attachments } : {}),
        },
        { optimistic: inf <= 1 },
      );
    } catch {
      const cur = Math.max(0, (get().inflightBySession?.[item.sessionId] ?? 1) - 1);
      const next = { ...get().inflightBySession, [item.sessionId]: cur };
      set({
        inflightBySession: next,
        inflight: Object.values(next).reduce((a, b) => a + b, 0),
      });
    }
    void get().drainPromptQueue();
  },

  async runSendPrompt(text, opts, { optimistic = true } = {}) {
    const id = opts?.sessionId ?? get().activeSessionId;
    set({ error: null });
    // The text is now a real message; its composer draft must not linger in the
    // persisted map (or resurrect after a reload). Drop it from the live
    // registry too, so a later keystroke cannot re-persist the sent text.
    if (id) forgetComposerDraft(id);
    // A chat created moments ago may still be in flight to the server; sending
    // now would 404 on the missing row. Wait for the POST, then proceed.
    const pendingCreate = id ? pendingCreateById.get(id) : undefined;
    if (pendingCreate) {
      try {
        await pendingCreate;
      } catch {
        // The row was rolled back, so nothing is in flight for this chat.
        if (id) {
          const inflightBySession = { ...get().inflightBySession, [id]: 0 };
          set({
            inflightBySession,
            inflight: Object.values(inflightBySession).reduce((a, b) => a + b, 0),
          });
        }
        return;
      }
    }
    // The user is talking to the chat now — stop claiming it is still starting.
    if (id) markSessionInitialized(get, set, id);

    const buildOptimisticPair = (sessionId: string, baseMessages: MessageDto[]) => {
      const epoch = (get().promptEpochBySession?.[sessionId] ?? get().promptEpoch) + 1;
      const now = new Date().toISOString();
      const userId = `local-user-${epoch}`;
      const assistantId = `local-assistant-${epoch}`;
      const trimmed = text.trim();
      const slashMatch = trimmed.match(/^\/([\w-]+)/);
      const userMsg: MessageDto = {
        id: userId,
        sessionId,
        role: "user",
        createdAt: now,
        parts: [
          {
            id: `${userId}-text`,
            messageId: userId,
            type: "text",
            order: 0,
            payload: {
              text,
              ...(slashMatch
                ? { isSlashCommand: true, commandName: slashMatch[1] }
                : {}),
            },
            createdAt: now,
          },
          ...(opts?.attachments ?? []).map((a, i) => ({
            id: `${userId}-file-${i}`,
            messageId: userId,
            type: "file" as const,
            order: i + 1,
            payload: {
              name: a.name,
              size: 0,
            },
            createdAt: now,
          })),
        ],
      };
      const assistantMsg: MessageDto = {
        id: assistantId,
        sessionId,
        role: "assistant",
        createdAt: now,
        parts: [],
      };
      return {
        epoch,
        userId,
        assistantId,
        messages: [...baseMessages, userMsg, assistantMsg] as MessageDto[],
      };
    };

    const commitRunning = (sessionId: string, messages: MessageDto[] | null, epoch: number) => {
      const current = liveDetail(get(), sessionId);
      serverConfirmedBusy.delete(sessionId);
      set({
        modelsLoading: false,
        promptEpoch: epoch,
        promptEpochBySession: { ...get().promptEpochBySession, [sessionId]: epoch },
        sessions: get().sessions.map((s) =>
          s.id === sessionId ? { ...s, status: "running" as const } : s,
        ),
      });
      if (current) {
        commitDetail(get, set, {
          ...current,
          status: "running",
          ...(messages ? { messages } : {}),
        });
      }
    };

    if (!id) {
      const session = await get().createSession();
      const active = get().activeSession;
      const pair = buildOptimisticPair(session.id, active?.id === session.id ? active.messages : []);
      pendingOptimisticPair = { userId: pair.userId, assistantId: pair.assistantId, sessionId: session.id };
      commitRunning(session.id, pair.messages, pair.epoch);
      await api.prompt(session.id, text);
      return;
    }

    if (opts?.editMessageId && id) {
      const current = liveDetail(get(), id);
      if (current) {
      const msgs = current.messages;
      const idx = msgs.findIndex((m) => m.id === opts.editMessageId);
      if (idx >= 0) {
        const trimmed = text.trim();
        const slashMatch = trimmed.match(/^\/([\w-]+)/);
        const truncated = msgs.slice(0, idx + 1).map((m, i) => {
          if (i !== idx) return m;
          return {
            ...m,
            parts: [
              {
                id: m.parts[0]?.id ?? `local-${m.id}`,
                messageId: m.id,
                type: "text" as const,
                order: 0,
                payload: {
                  text,
                  ...(slashMatch
                    ? { isSlashCommand: true, commandName: slashMatch[1] }
                    : {}),
                },
                createdAt: m.parts[0]?.createdAt ?? m.createdAt,
              },
            ],
          };
        });
        const epoch = get().promptEpoch + 1;
        const now = new Date().toISOString();
        const assistantId = `local-assistant-${epoch}`;
        const userId = msgs[idx]!.id;
        pendingOptimisticPair = { userId, assistantId, sessionId: id };
        commitRunning(
          id,
          [
            ...truncated,
            {
              id: assistantId,
              sessionId: id,
              role: "assistant",
              createdAt: now,
              parts: [],
            },
          ],
          epoch,
        );
        await api.prompt(id, text, { editMessageId: opts.editMessageId });
        return;
      }
      }
    }

    const current = id ? liveDetail(get(), id) : null;
    if (current && optimistic) {
      const pair = buildOptimisticPair(id, current.messages);
      pendingOptimisticPair = { userId: pair.userId, assistantId: pair.assistantId, sessionId: id };
      commitRunning(id, pair.messages, pair.epoch);
    } else {
      commitRunning(id, null, (get().promptEpochBySession?.[id ?? ""] ?? get().promptEpoch) + 1);
    }
    await api.prompt(id, text, opts?.editMessageId ? { editMessageId: opts.editMessageId } : { ...(opts?.attachments?.length ? { attachments: opts.attachments } : {}) });
  },

  async cancelPrompt(sessionId) {
    const id = sessionId ?? get().activeSessionId;
    if (!id) return;
    const state = get();
    const current = liveDetail(state, id);
    const STUCK = new Set(["pending", "in_progress", "running"]);
    const messages = (current?.messages ?? []).map((m) => ({
      ...m,
      parts: m.parts.map((p) =>
        (p.type === "tool_call" || p.type === "subagent") &&
        STUCK.has(String(p.payload.status ?? ""))
          ? { ...p, payload: { ...p.payload, status: "cancelled", interrupted: true } }
          : p,
      ),
    }));
    const epoch = state.promptEpochBySession?.[id] ?? state.promptEpoch;
    const inflightBySession = { ...state.inflightBySession, [id]: 0 };
    clearDelayedIdle(id);
    set({
      cancelledPromptEpoch: epoch,
      cancelledPromptEpochBySession: { ...state.cancelledPromptEpochBySession, [id]: epoch },
      promptQueue: state.promptQueue.filter((item) => item.sessionId !== id),
      inflightBySession,
      inflight: Object.values(inflightBySession).reduce((a, b) => a + b, 0),
      pendingPermission:
        state.pendingPermission?.sessionId === id ? null : state.pendingPermission,
      permissionQueue: state.permissionQueue.filter((p) => p.sessionId !== id),
      pendingQuestion: state.pendingQuestion?.sessionId === id ? null : state.pendingQuestion,
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, status: "idle" as const } : s)),
    });
    if (current) {
      commitDetail(get, set, { ...current, status: "idle", messages });
    }
    serverConfirmedBusy.delete(id);
    try {
      await api.cancel(id);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  setSidebarOpen(open) {
    set({ sidebarOpen: open });
  },

  setConnection(connection) {
    set({ connection, connected: connection === "open" });
  },

  async resyncAfterReconnect() {
    // The socket only carries live traffic: whatever was broadcast while it was
    // down is lost. Re-read what the server owns — the list plus the open chat.
    void get().refreshSessions().catch(() => {});
    const id = get().activeSessionId;
    if (!id) return;
    let detail: SessionDetailDto;
    try {
      detail = preferSlashCommands(await api.getSession(id), liveDetail(get(), id));
    } catch {
      // Socket is back; the next selection retries the fetch.
      return;
    }
    if (get().activeSessionId !== id) return;
    // The local thread is not merged in: it is missing everything the agent
    // produced while the device slept, which is the window this resync exists to
    // repair. The optimistic placeholders and their id aliases are obsolete
    // against a full snapshot — keeping them would map replayed parts onto
    // dropped ids.
    clearMessageIdAliases(id);
    const live = get().activeSession;
    if (detail.messages.length === 0 && live?.id === id && live.messages.length > 0) {
      // The snapshot raced the persist of the turn we are watching — keep the
      // live thread instead of blanking it out; the stream fills the rest.
      rememberSessionDetail(live);
      set({ sessionLoading: false });
      return;
    }
    rememberSessionDetail(detail);
    if (slashListStillLoading(detail.slashCommands)) pollSlashCommands(id, get, set);
    const question = pendingQuestionFromDetail(detail);
    set({
      sessionLoading: false,
      activeSession: detail,
      sessionDetails: { ...(get().sessionDetails ?? {}), [id]: detail },
      error: detail.status === "error" ? lastAssistantErrorMessage(detail) : null,
      ...(question ? { pendingQuestion: question } : {}),
    });
    // Same as the warm path: the DB row can lag a turn still live in the server
    // process, so let the runtime settle the status when the row says idle.
    if (detail.status === "running" || detail.status === "waiting") {
      confirmServerBusy(id, detail.status);
    } else {
      await adoptLiveTurnStatus(id);
    }
  },

  setAgentAvailable(provider, available) {
    const pending = offlineHoldTimers[provider];
    if (pending) {
      window.clearTimeout(pending);
      delete offlineHoldTimers[provider];
    }
    const apply = (next: boolean) => {
      const agentAvailability: AgentAvailabilityMap = {
        ...get().agentAvailability,
        [provider]: next,
      };
      const focus = get().activeSession?.provider;
      const focusOnline = focus ? agentAvailability[focus] === true : false;
      set({
        agentAvailability,
        agentAvailable: focus ? focusOnline : Object.values(agentAvailability).some((v) => v === true),
      });
      writeStoredAgentAvailability(agentAvailability);
    };
    if (available) {
      apply(true);
      return;
    }
    // Transient spawn/probe failures flip the LED for a second; wait them out.
    offlineHoldTimers[provider] = window.setTimeout(() => {
      delete offlineHoldTimers[provider];
      apply(false);
    }, OFFLINE_HOLD_MS);
  },

  handleWsEvent(event) {
    if (event.type !== "part.appended" && event.type !== "part.updated") {
      if (pendingPartRaf) {
        cancelAnimationFrame(pendingPartRaf);
        pendingPartRaf = 0;
      }
      if (pendingPartEvents.length) {
        flushPendingPartEvents(get, set);
      }
    }

    const state = get();

    if (event.type === "session.updated") {
      // Ignore transient "closed" from intentional ACP dispose during edit/regenerate.
      if (
        event.session.status === "closed" &&
        state.activeSession?.id === event.sessionId &&
        state.activeSession.status === "running"
      ) {
        set({
          sessions: state.sessions.map((s) =>
            s.id === event.sessionId
              ? { ...event.session, status: "running", lastMessageAt: s.lastMessageAt }
              : s,
          ),
          activeSession: {
            ...state.activeSession,
            ...event.session,
            status: "running",
            lastMessageAt: state.activeSession.lastMessageAt,
            messages: state.activeSession.messages,
          },
        });
        return;
      }
      // After Stop, don't let a late "running"/"waiting" event revive the stream UI.
      const cancelled =
        (state.cancelledPromptEpochBySession?.[event.sessionId] ??
          (state.activeSession?.id === event.sessionId ? state.cancelledPromptEpoch : -1)) ===
        (state.promptEpochBySession?.[event.sessionId] ??
          (state.activeSession?.id === event.sessionId ? state.promptEpoch : 0));
      let session =
        cancelled && (event.session.status === "running" || event.session.status === "waiting")
          ? { ...event.session, status: "idle" as const }
          : event.session;
      if (session.status === "running" || session.status === "waiting") {
        confirmServerBusy(event.sessionId, session.status);
      }
      // createMessage (and similar) used to broadcast idle while the client had
      // already painted optimistic running — that hid/reshowed the Steps header.
      const listedBefore = state.sessions.find((s) => s.id === event.sessionId);
      const clientBusy =
        listedBefore?.status === "running" ||
        listedBefore?.status === "waiting" ||
        (state.activeSession?.id === event.sessionId &&
          (state.activeSession.status === "running" || state.activeSession.status === "waiting"));
      const turnStillOpen =
        state.activeSession?.id === event.sessionId &&
        state.promptEpoch !== state.cancelledPromptEpoch;
      if (
        session.status === "idle" &&
        clientBusy &&
        turnStillOpen &&
        !cancelled &&
        !serverConfirmedBusy.has(event.sessionId)
      ) {
        session = {
          ...session,
          status: (listedBefore?.status === "waiting" || state.activeSession?.status === "waiting"
            ? "waiting"
            : "running") as typeof session.status,
        };
      }
      const liveMessages =
        (state.activeSession?.id === event.sessionId ? state.activeSession.messages : null) ??
        liveDetail(state, event.sessionId)?.messages ??
        [];
      if (
        session.status === "idle" &&
        !cancelled &&
        isClientTurnLive(state, event.sessionId) &&
        sessionHasActiveTurnParts(liveMessages)
      ) {
        session = { ...session, status: "running" as typeof session.status };
        clearDelayedIdle(event.sessionId);
        delayedIdleTimers.set(
          event.sessionId,
          window.setTimeout(() => {
            delayedIdleTimers.delete(event.sessionId);
            const latest = get();
            if (!isClientTurnLive(latest, event.sessionId)) return;
            const pane = liveDetail(latest, event.sessionId);
            if (!pane) return;
            if (sessionHasActiveTurnParts(pane.messages)) {
              reconcileFinishedTurn(event.sessionId, get, set);
            }
            if (!isClientTurnLive(get(), event.sessionId)) return;
            if (sessionHasActiveTurnParts(liveDetail(get(), event.sessionId)?.messages ?? [])) {
              return;
            }
            const nextSessions = latest.sessions.map((s) =>
              s.id === event.sessionId ? { ...s, status: "idle" as const } : s,
            );
            const inflightBySession = { ...latest.inflightBySession, [event.sessionId]: 0 };
            markUnseenFinishedIfAway(event.sessionId, get, set);
            set({
              sessions: nextSessions,
              inflight: Object.values(inflightBySession).reduce((a, b) => a + b, 0),
              inflightBySession,
            });
            if (latest.activeSession?.id === event.sessionId) {
              commitDetail(get, set, { ...latest.activeSession, status: "idle" });
            } else if (pane) {
              commitDetail(get, set, { ...pane, status: "idle" });
            }
            serverConfirmedBusy.delete(event.sessionId);
            void get().drainPromptQueue();
          }, 800),
        );
      }
      if (session.status === "idle" || session.status === "error" || session.status === "closed") {
        serverConfirmedBusy.delete(event.sessionId);
      }
      const busy = session.status === "running" || session.status === "waiting";
      const prevActive = state.activeSession;
      const wasBusy =
        listedBefore?.status === "running" || listedBefore?.status === "waiting";
      if (busy) clearUnseenFinished(event.sessionId, get, set);
      if (
        !busy &&
        wasBusy &&
        !cancelled &&
        (session.status === "idle" || session.status === "error")
      ) {
        markUnseenFinishedIfAway(event.sessionId, get, set);
      }
      const nextSessions = state.sessions.map((s) => {
        if (s.id !== event.sessionId) return s;
        // Tree activity (lastMessageAt) is owned by message.created — never by
        // session.updated. Open/warm/status echoes used to look like "turn
        // finished" when the list still said running, and promoted the row.
        if (
          s.status === session.status &&
          s.title === session.title &&
          s.mode === session.mode &&
          s.cwd === session.cwd &&
          s.provider === session.provider &&
          s.pinned === session.pinned &&
          s.archived === session.archived &&
          s.acpSessionId === session.acpSessionId
        ) {
          return s;
        }
        return {
          ...s,
          status: session.status,
          title: session.title,
          mode: session.mode,
          cwd: session.cwd,
          provider: session.provider,
          pinned: session.pinned,
          archived: session.archived,
          acpSessionId: session.acpSessionId,
          themeId: session.themeId,
          mcpDisabledIds: session.mcpDisabledIds,
          usage: session.usage ?? s.usage,
          model: session.model ?? s.model,
          modelParams: session.modelParams ?? s.modelParams,
          // Keep prior activity stamp — do not take session.lastMessageAt.
          lastMessageAt: s.lastMessageAt,
          updatedAt: s.updatedAt,
        };
      });
      const sessionsChanged = nextSessions.some((s, i) => s !== state.sessions[i]);

      // Keep the same activeSession reference when only the tree sort key
      // moved — otherwise the chat pane re-renders (fake "double paint")
      // every time a finished turn promotes the row.
      let nextActive = prevActive;
      if (prevActive?.id === event.sessionId) {
        const chatUiChanged =
          prevActive.status !== session.status ||
          prevActive.title !== session.title ||
          prevActive.mode !== session.mode ||
          prevActive.cwd !== session.cwd ||
          prevActive.provider !== session.provider ||
          prevActive.pinned !== session.pinned ||
          prevActive.archived !== session.archived ||
          prevActive.model !== session.model;
        if (chatUiChanged) {
          nextActive = {
            ...prevActive,
            status: session.status,
            title: session.title,
            mode: session.mode,
            cwd: session.cwd,
            provider: session.provider,
            pinned: session.pinned,
            archived: session.archived,
            acpSessionId: session.acpSessionId,
            themeId: session.themeId,
            mcpDisabledIds: session.mcpDisabledIds,
            usage: session.usage ?? prevActive.usage,
            model: session.model ?? prevActive.model,
            modelParams: session.modelParams ?? prevActive.modelParams,
            lastMessageAt: prevActive.lastMessageAt,
            messages: prevActive.messages,
          };
        }
      }

      const patch: Partial<AppState> = {};
      if (busy) patch.modelsLoading = false;
      if (session.mode && session.mode !== state.settings.defaultMode) {
        patch.settings = { ...state.settings, defaultMode: session.mode };
      }
      if (nextActive !== prevActive) patch.activeSession = nextActive;
      const paneLive = liveDetail(state, event.sessionId);
      if (paneLive && paneLive !== nextActive && nextActive?.id !== event.sessionId) {
        // keep pane thread in sync when it is not the focused chat
      }
      if (paneLive && event.sessionId !== prevActive?.id) {
        const chatUiChanged =
          paneLive.status !== session.status ||
          paneLive.title !== session.title ||
          paneLive.mode !== session.mode;
        if (chatUiChanged) {
          patch.sessionDetails = {
            ...state.sessionDetails,
            [event.sessionId]: {
              ...paneLive,
              status: session.status,
              title: session.title,
              mode: session.mode,
              cwd: session.cwd,
              provider: session.provider,
              pinned: session.pinned,
              archived: session.archived,
              acpSessionId: session.acpSessionId,
              themeId: session.themeId,
              mcpDisabledIds: session.mcpDisabledIds,
              usage: session.usage ?? paneLive.usage,
              model: session.model ?? paneLive.model,
              modelParams: session.modelParams ?? paneLive.modelParams,
              lastMessageAt: paneLive.lastMessageAt,
              messages: paneLive.messages,
            },
          };
        }
      }
      // Apply chat-pane updates first. Tree reorder goes on a microtask so the
      // right pane never re-renders from a sessions-list identity change.
      if (Object.keys(patch).length) set(patch);
      if (sessionsChanged) {
        queueMicrotask(() => {
          set({ sessions: nextSessions });
        });
      }

      // A few ACP adapters finish their RPC before the final WS part has
      // crossed the proxy. Reconcile only after a real in-flight turn goes idle
      // — not on every warm/open session.updated.
      if (
        session.status === "idle" &&
        wasBusy &&
        liveDetail(get(), event.sessionId) &&
        !cancelled
      ) {
        reconcileFinishedTurn(event.sessionId, get, set);
        const inflightBySession = { ...get().inflightBySession, [event.sessionId]: 0 };
        set({
          inflightBySession,
          inflight: Object.values(inflightBySession).reduce((a, b) => a + b, 0),
        });
        void get().drainPromptQueue();
      }
      return;
    }

    if (event.type === "session.usage") {
      const sessions = state.sessions.map((s) =>
        s.id === event.sessionId ? { ...s, usage: event.usage } : s,
      );
      const activeSession =
        state.activeSession?.id === event.sessionId
          ? { ...state.activeSession, usage: event.usage }
          : state.activeSession;
      if (activeSession && state.activeSession?.id === event.sessionId) {
        rememberSessionDetail(activeSession);
      }
      set({ sessions, activeSession });
      return;
    }
    if (event.type === "message.created") {
      // Only user messages stamp tree activity / order. Assistant bubbles during
      // a turn must not reshuffle the sidebar; open/warm never creates users.
      const stampActivity = event.message.role === "user";
      const nextSessions = state.sessions.map((s) =>
        s.id === event.sessionId && stampActivity
          ? {
              ...s,
              lastMessageAt: event.message.createdAt,
              updatedAt: event.message.createdAt,
            }
          : s,
      );
      if (state.activeSession?.id !== event.sessionId) {
        const current = liveDetail(state, event.sessionId);
        if (current) {
          commitDetail(get, set, {
            ...current,
            ...(stampActivity
              ? {
                  lastMessageAt: event.message.createdAt,
                  updatedAt: event.message.createdAt,
                }
              : {}),
            messages: upsertMessage(current.messages, event.message),
          });
        }
        if (stampActivity) set({ sessions: nextSessions });
        markRestoringDone(get, set, event.sessionId);
        return;
      }
      const nextActive = {
        ...state.activeSession!,
        ...(stampActivity
          ? {
              lastMessageAt: event.message.createdAt,
              updatedAt: event.message.createdAt,
            }
          : {}),
        messages: upsertMessage(state.activeSession!.messages, event.message),
      };
      rememberSessionDetail(nextActive);
      set({
        ...(stampActivity ? { sessions: nextSessions } : {}),
        activeSession: nextActive,
      });
      markRestoringDone(get, set, event.sessionId);
      return;
    }

    if (event.type === "messages.truncated" || event.type === "messages.replaced") {
      const current = liveDetail(state, event.sessionId);
      if (!current) return;
      commitDetail(get, set, { ...current, messages: event.messages });
      return;
    }

    if (event.type === "part.appended" || event.type === "part.updated") {
      if (!liveDetail(state, event.sessionId)) return;
      const epoch = state.promptEpochBySession?.[event.sessionId] ?? state.promptEpoch;
      const cancelledAt =
        state.cancelledPromptEpochBySession?.[event.sessionId] ??
        (state.activeSession?.id === event.sessionId ? state.cancelledPromptEpoch : -2);
      if (cancelledAt === epoch && epoch !== 0) return;
      // Error parts are not rendered in the thread; lift them to the banner.
      if (event.part.type === "error") {
        const message = String(event.part.payload?.message ?? "").trim();
        if (message) {
          set({ error: message });
          rememberDiagnosticsError(message, "part");
          void submitAutoErrorDump(message);
        }
      }
      if (event.type === "part.updated" && event.part.type === "question" && !event.part.payload.pending) {
        const pending = get().pendingQuestion;
        const requestId = String(event.part.payload.requestId ?? "");
        if (
          pending?.sessionId === event.sessionId &&
          pending.requestId === requestId &&
          pending.kind === "ask_question"
        ) {
          set({ pendingQuestion: null });
        }
      }
      queuePartEvent(event, get, set);
      return;
    }

    if (event.type === "permission.request") {
      const next: PendingPermission = {
        sessionId: event.sessionId,
        requestId: event.requestId,
        payload: event.payload,
      };
      const cur = state.pendingPermission;
      // Don't drop a still-open prompt when the agent asks for another tool at once.
      if (
        cur &&
        cur.requestId !== next.requestId &&
        !state.permissionQueue.some((p) => p.requestId === next.requestId)
      ) {
        set({ permissionQueue: [...state.permissionQueue, next] });
        return;
      }
      if (cur?.requestId === next.requestId) return;
      set({ pendingPermission: next });
      return;
    }

    if (event.type === "question.request") {
      set({
        pendingQuestion: {
          sessionId: event.sessionId,
          requestId: event.requestId,
          kind: event.kind,
          payload: event.payload,
        },
      });
      return;
    }

    if (event.type === "commands.updated") {
      const live = liveDetail(get(), event.sessionId);
      const merged = mergeIncomingSlashCommands(
        event.sessionId,
        event.commands ?? [],
        live,
        slashCommandsCache,
      );
      if (!merged.length) return;
      slashCommandsCache.set(event.sessionId, merged);
      const base =
        live ??
        readCachedSessionDetail(event.sessionId) ??
        (get().activeSession?.id === event.sessionId ? get().activeSession : null);
      if (base) commitDetail(get, set, { ...base, slashCommands: merged });
      return;
    }

    if (event.type === "agent.availability") {
      get().setAgentAvailable(event.provider, event.available);
      return;
    }

    if (event.type === "error") {
      set({ error: event.message });
      rememberDiagnosticsError(event.message, "ws");
      void submitAutoErrorDump(event.message);
      const provider = get().activeSession?.provider ?? get().settings.defaultProvider;
      if (provider && isModelAccessError(event.message)) {
        void get().ensureModels(provider, { force: true });
      }
      return;
    }
  },

  async answerPermission(optionId) {
    const pending = get().pendingPermission;
    if (!pending) return;
    const queue = get().permissionQueue;
    const allowAlways = /allow[_-]?always/i.test(optionId);

    // "Always" — clear the whole queue with the same choice so parallel tool
    // prompts (common for Cursor web/fetch) don't leave the agent hung.
    if (allowAlways && queue.length) {
      const active = get().activeSession;
      set({
        pendingPermission: null,
        permissionQueue: [],
        activeSession:
          active?.id === pending.sessionId ? { ...active, status: "running" } : active,
        sessions: get().sessions.map((s) =>
          s.id === pending.sessionId ? { ...s, status: "running" } : s,
        ),
      });
      try {
        await api.answerPermission(pending.sessionId, pending.requestId, optionId);
        for (const item of queue) {
          try {
            await api.answerPermission(item.sessionId, item.requestId, optionId);
          } catch {
            // ignore individual queue failures
          }
        }
      } catch (err) {
        set({
          pendingPermission: pending,
          permissionQueue: queue,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    const [next, ...rest] = queue;
    const active = get().activeSession;
    const nextStatus = next ? ("waiting" as const) : ("running" as const);
    set({
      pendingPermission: next ?? null,
      permissionQueue: rest,
      activeSession:
        active?.id === pending.sessionId ? { ...active, status: nextStatus } : active,
      sessions: get().sessions.map((s) =>
        s.id === pending.sessionId ? { ...s, status: nextStatus } : s,
      ),
    });
    try {
      await api.answerPermission(pending.sessionId, pending.requestId, optionId);
    } catch (err) {
      set({
        pendingPermission: pending,
        permissionQueue: next ? [next, ...rest] : rest,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  async answerQuestionFor(sessionId, requestId, result) {
    applyQuestionAnswerLocally(get, set, sessionId, requestId, result);
    try {
      await api.answerQuestion(sessionId, requestId, result);
      const pending = get().pendingQuestion;
      if (pending?.sessionId === sessionId && pending.requestId === requestId) {
        set({ pendingQuestion: null });
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  async answerQuestion(result) {
    const pending = get().pendingQuestion;
    if (!pending) return;
    await get().answerQuestionFor(pending.sessionId, pending.requestId, result);
  },

  toggleFavoriteModel(provider, model) {
    const trimmed = model.trim();
    if (!trimmed) return;
    const current = get().settings;
    const list = current.favoriteModelsByProvider?.[provider] ?? [];
    const next = list.includes(trimmed) ? list.filter((m) => m !== trimmed) : [trimmed, ...list];
    // Optimistic: the picker re-renders instantly; a failed save is rolled back.
    set({
      settings: {
        ...current,
        favoriteModelsByProvider: { ...current.favoriteModelsByProvider, [provider]: next },
      },
    });
    void api
      .updateSettings({
        favoriteModelsByProvider: { ...current.favoriteModelsByProvider, [provider]: next },
      })
      .catch(() => {
        set({ settings: current });
      });
  },

  async saveSettings(patch) {
    const current = get().settings;
    if (typeof patch.chatSplit === "boolean") {
      set({ settings: { ...current, chatSplit: patch.chatSplit } });
      if (patch.chatSplit === false) get().collapseToSinglePane();
    }
    const providerChanged =
      patch.defaultProvider !== undefined && patch.defaultProvider !== current.defaultProvider;
    const nextPatch =
      providerChanged && patch.defaultModel === undefined
        ? { ...patch, defaultModel: "", defaultModelParams: {} }
        : patch;
    const settings = await api.updateSettings(nextPatch);
    let nextSettings =
      typeof nextPatch.chatSplit === "boolean"
        ? { ...settings, chatSplit: nextPatch.chatSplit }
        : settings;
    // Theme/locale are toggled live from the shell; partial saves must not
    // clobber them with stale form values or an older server snapshot.
    if (nextPatch.theme === undefined) {
      nextSettings = { ...nextSettings, theme: current.theme };
    }
    if (nextPatch.locale === undefined) {
      nextSettings = { ...nextSettings, locale: current.locale };
    }
    if (nextPatch.theme) get().applyTheme(nextPatch.theme);
    if (nextPatch.locale) get().applyLocale(nextPatch.locale);
    set({ settings: nextSettings });
    applyAppearance(nextSettings);
    if (
      nextPatch.mcpServers !== undefined ||
      nextPatch.mcpFolderConfigs !== undefined ||
      nextPatch.mcpProjectFiles !== undefined
    ) {
      void get().refreshProjectMcp();
    }
    if (nextPatch.disabledProviders !== undefined || nextPatch.customAgents !== undefined) {
      // A switched-off harness keeps no probe state and leaves the registry
      // list, so nothing (pickers, gate, header) can mention it any more.
      // Custom agents enter/leave the same registry list.
      const disabled = new Set(nextPatch.disabledProviders ?? current.disabledProviders);
      const agentAvailability = { ...get().agentAvailability };
      const agentProbing = { ...get().agentProbing };
      for (const id of disabled) {
        delete agentAvailability[id];
        delete agentProbing[id];
      }
      writeStoredAgentAvailability(agentAvailability);
      set({
        agentAvailability,
        agentProbing,
        agentOfflineWarning: get().agentOfflineWarning.filter((id) => !disabled.has(id)),
      });
      void get().loadAdapters();
    }
    if (nextPatch.chatSplit === false || nextSettings.chatSplit === false) {
      get().collapseToSinglePane();
    }
    const providerToLoad =
      nextPatch.connectedProvider ?? (providerChanged ? settings.defaultProvider : null);
    if (providerToLoad) {
      void get().ensureModels(providerToLoad, {
        force: nextPatch.connectedProvider != null || providerChanged,
      });
      const activeId = get().activeSessionId;
      if (activeId) void get().selectSession(activeId);
    } else if (providerChanged) {
      void get().ensureModels(settings.defaultProvider, { force: true });
      const activeId = get().activeSessionId;
      if (activeId) void get().selectSession(activeId);
    }
  },
}));
