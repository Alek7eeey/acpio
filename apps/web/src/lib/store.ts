import { create } from "zustand";
import type {
  AgentProvider,
  AppLocale,
  AppSettings,
  ChatThemeDto,
  MessageDto,
  MessagePartDto,
  ModelParamDto,
  SessionDetailDto,
  SessionDto,
  SessionUsageDto,
  Theme,
  WsServerEvent,
} from "@acprocess/shared";
import { DEFAULT_SETTINGS, isModelAccessError, usesCloudModelCatalog } from "@acprocess/shared";
import { api } from "./api";
import { applyAppearance } from "./appearance";
import { rememberDiagnosticsError, submitAutoErrorDump } from "./diagnostics";

const MODELS_CACHE_KEY = "acprocess.modelsCatalog.v6";
const MODELS_CACHE_KEY_LEGACY = "acprocess.modelsCatalog.v5";
const USAGE_SUPPORT_KEY = "acprocess.usageSupported.v1";
const ACTIVE_SESSION_KEY = "acprocess.activeSessionId";
/** Soft TTL: serve instantly, refresh quietly in background after this. */
const MODELS_SOFT_TTL_MS = 30 * 60_000;
const MODELS_CLOUD_SOFT_TTL_MS = 30_000;
/** Hard TTL: force a blocking reload only after this. */
const MODELS_HARD_TTL_MS = 7 * 24 * 60_000;
const MODELS_CLOUD_HARD_TTL_MS = 2 * 60_000;

function modelsHardTtl(provider: AgentProvider): number {
  return usesCloudModelCatalog(provider) ? MODELS_CLOUD_HARD_TTL_MS : MODELS_HARD_TTL_MS;
}

function modelsSoftTtl(provider: AgentProvider): number {
  return usesCloudModelCatalog(provider) ? MODELS_CLOUD_SOFT_TTL_MS : MODELS_SOFT_TTL_MS;
}

export type ModelsCatalog = {
  provider: AgentProvider;
  models: Array<{ value: string; name: string }>;
  modelParams: ModelParamDto[];
  /** Session modes (Agent / Plan / Ask) when the agent supports them. */
  modes: Array<{ value: string; name: string }>;
  currentModel?: string;
  at: number;
};

/** Cursor trio must not stick to OMP/OpenCode catalogs after an agent switch. */
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
  // OMP (and similar) only advertise a lone "default" — never a switcher.
  if (provider === "omp" || provider === "pi") return [];
  return list.filter((m) => {
    if (m.value === "agent" || m.value === "plan" || m.value === "ask") return false;
    if (/^(default|normal|standard)$/i.test(m.value)) return false;
    return Boolean(m.value);
  });
}

type ModelsCatalogMap = Partial<Record<AgentProvider, ModelsCatalog>>;

function readUsageSupportMap(): Partial<Record<AgentProvider, boolean>> {
  try {
    const raw = localStorage.getItem(USAGE_SUPPORT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<Record<AgentProvider, boolean>>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeUsageSupport(provider: AgentProvider, supported: boolean) {
  try {
    const map = readUsageSupportMap();
    map[provider] = supported;
    localStorage.setItem(USAGE_SUPPORT_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

type PendingPermission = {
  sessionId: string;
  requestId: string;
  payload: Record<string, unknown>;
};

type PendingQuestion = {
  sessionId: string;
  requestId: string;
  kind: "ask_question" | "create_plan";
  payload: Record<string, unknown>;
};

type AppState = {
  settings: AppSettings;
  sessions: SessionDto[];
  themes: ChatThemeDto[];
  activeSessionId: string | null;
  activeSession: SessionDetailDto | null;
  modelsCatalog: ModelsCatalog | null;
  modelsLoading: boolean;
  /** Agent reported ACP usage_update at least once (session context / cost). */
  usageSupported: boolean;
  sessionUsage: SessionUsageDto | null;
  sidebarOpen: boolean;
  connected: boolean;
  /** True only when the connected agent was actually verified (probe/prompt OK). */
  agentAvailable: boolean;
  pendingPermission: PendingPermission | null;
  /** Extra permission prompts waiting behind the one shown in the UI. */
  permissionQueue: PendingPermission[];
  pendingQuestion: PendingQuestion | null;
  /** Bumped on each send; cancel stamps cancelledPromptEpoch to ignore late WS parts. */
  promptEpoch: number;
  cancelledPromptEpoch: number;
  /**
   * Requests the user sent while the agent was busy. Items leave the queue the
   * moment they are handed to the server (the server FIFO-runs them), so
   * everything still listed here can still be edited or deleted.
   */
  promptQueue: Array<{ id: string; text: string; editMessageId?: string | null }>;
  /** Prompts handed to the server whose turns have not completed yet. */
  inflight: number;
  loading: boolean;
  error: string | null;
  setTheme: (theme: Theme) => Promise<void>;
  applyTheme: (theme: Theme) => void;
  setLocale: (locale: AppLocale) => Promise<void>;
  applyLocale: (locale: AppLocale) => void;
  loadBootstrap: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  refreshThemes: () => Promise<void>;
  selectSession: (id: string | null) => Promise<void>;
  createSession: (cwd?: string) => Promise<SessionDto>;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  /** Toggle pin/archive flags (optimistic PATCH). */
  setSessionFlags: (
    id: string,
    patch: { pinned?: boolean; archived?: boolean },
  ) => Promise<void>;
  reorderSessions: (
    items: Array<{ id: string; themeId: string | null; sortOrder: number }>,
  ) => Promise<void>;
  sendPrompt: (text: string, opts?: { editMessageId?: string }) => Promise<void>;
  /** Internal: actually hand one prompt to the server (optimistic pair optional). */
  runSendPrompt: (
    text: string,
    opts?: { editMessageId?: string },
    flags?: { optimistic?: boolean },
  ) => Promise<void>;
  removeQueuedPrompt: (id: string) => void;
  updateQueuedPrompt: (id: string, text: string) => void;
  drainPromptQueue: () => Promise<void>;
  /** Optimistic local toggle; the save happens in the background. */
  setMultitask: (value: boolean) => Promise<void>;
  cancelPrompt: () => Promise<void>;
  setSidebarOpen: (open: boolean) => void;
  setConnected: (connected: boolean) => void;
  setAgentAvailable: (available: boolean) => void;
  handleWsEvent: (event: WsServerEvent) => void;
  answerPermission: (optionId: string) => Promise<void>;
  answerQuestion: (result: Record<string, unknown>) => Promise<void>;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
  rememberModelsCatalog: (catalog: ModelsCatalog) => void;
  ensureModels: (
    provider: AgentProvider,
    opts?: { force?: boolean },
  ) => Promise<ModelsCatalog | null>;
  refreshAgentUsage: () => Promise<void>;
};

function normalizeCatalog(parsed: Partial<ModelsCatalog> | null | undefined): ModelsCatalog | null {
  if (!parsed?.provider || !Array.isArray(parsed.models)) return null;
  return {
    provider: parsed.provider,
    models: parsed.models,
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

function readStoredModelsCatalog(provider?: AgentProvider): ModelsCatalog | null {
  const map = readStoredModelsMap();
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
  } catch {
    // ignore quota / private mode
  }
}

function upsertPart(parts: MessagePartDto[], part: MessagePartDto) {
  const idx = parts.findIndex((p) => p.id === part.id);
  if (idx === -1) return [...parts, part].sort((a, b) => a.order - b.order);
  const next = [...parts];
  next[idx] = part;
  return next;
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

/** Server message ids → stable client ids so optimistic bubbles never remount. */
const serverToClientMessageId = new Map<string, string>();
/** One prompt may be active at a time. Map its server messages only to its pair. */
let pendingOptimisticPair: { userId: string; assistantId: string } | null = null;

function resolveClientMessageId(messageId: string) {
  return serverToClientMessageId.get(messageId) ?? messageId;
}

function clearMessageIdAliases() {
  serverToClientMessageId.clear();
  pendingOptimisticPair = null;
}

function upsertMessage(messages: MessageDto[], message: MessageDto) {
  const clientMessageId = resolveClientMessageId(message.id);
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

  const pendingId =
    message.role === "user"
      ? pendingOptimisticPair?.userId
      : message.role === "assistant"
        ? pendingOptimisticPair?.assistantId
        : null;
  if (pendingId && messages.some((item) => item.id === pendingId)) {
    serverToClientMessageId.set(message.id, pendingId);
    const next = messages.slice();
    const index = next.findIndex((item) => item.id === pendingId);
    const previous = next[index]!;
    next[index] = {
      ...message,
      id: pendingId,
      // `message.created` is intentionally empty; never wipe locally received parts.
      parts: message.parts.length ? message.parts : previous.parts,
    };
    if (message.role === "assistant") pendingOptimisticPair = null;
    return next;
  }

  return [...messages, message];
}

/** Keep recently opened chats warm so tree → chat feels instant. */
const sessionDetailCache = new Map<string, SessionDetailDto>();
let selectSessionSeq = 0;

function rememberSessionDetail(detail: SessionDetailDto | null | undefined) {
  if (!detail?.id) return;
  sessionDetailCache.set(detail.id, detail);
  if (sessionDetailCache.size <= 24) return;
  const oldest = sessionDetailCache.keys().next().value;
  if (oldest) sessionDetailCache.delete(oldest);
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

  const state = get();
  const active = state.activeSession;
  if (!active) return;

  let messages = active.messages;
  let touched = false;
  for (const event of batch) {
    if (active.id !== event.sessionId) continue;
    if (state.cancelledPromptEpoch === state.promptEpoch) continue;
    let messageId = resolveClientMessageId(event.messageId);
    if (messageId === event.messageId) {
      const optimisticId = pendingOptimisticPair?.assistantId;
      if (optimisticId && messages.some((message) => message.id === optimisticId)) {
        serverToClientMessageId.set(event.messageId, optimisticId);
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
  if (!touched) return;
  const nextActive = {
    ...active,
    messages,
  };
  rememberSessionDetail(nextActive);
  set({
    activeSession: nextActive,
  });
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
        const active = state.activeSession;
        // Another chat has taken over; don't apply this session's result there.
        if (!active || active.id !== sessionId) {
          return;
        }
        // The persisted detail is the reliable final answer. Render it as
        // normal text; never gate the visible answer on a client animation.
        rememberSessionDetail(detail);
        set({ activeSession: detail });
      })
      .catch(() => {
        // The live WS already rendered what it could; a later selection retries.
      });
  }, 120);
}

async function loadAppData(
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
) {
  const storedTheme = localStorage.getItem("acprocess.theme") as Theme | null;
  const storedLocale = localStorage.getItem("acprocess.locale") as AppLocale | null;
  const settings = { ...DEFAULT_SETTINGS, ...(await api.getSettings()) };
  const theme = storedTheme ?? settings.theme ?? "light";
  const locale =
    storedLocale === "en" || storedLocale === "ru" ? storedLocale : settings.locale ?? "ru";
  get().applyTheme(theme);
  get().applyLocale(locale);
  applyAppearance(settings);
  const sessions = await api.listSessions();
  set({ settings: { ...settings, theme, locale }, sessions, themes: [] });
  const provider = get().settings.connectedProvider;
  if (provider) {
    void get().ensureModels(provider);
    void get().refreshAgentUsage();
    // Verify the agent is really reachable — the header dot must reflect
    // actual availability, not just a saved "connected" flag.
    void api
      .probeAgent(provider)
      .then((result) => get().setAgentAvailable(result.ok))
      .catch(() => get().setAgentAvailable(false));
  } else {
    set({ modelsCatalog: null, modelsLoading: false, usageSupported: false, sessionUsage: null });
  }
  const storedId =
    typeof window !== "undefined" ? localStorage.getItem(ACTIVE_SESSION_KEY) : null;
  const pick =
    storedId && sessions.some((s) => s.id === storedId)
      ? storedId
      : sessions[0]?.id ?? null;
  if (pick) {
    await get().selectSession(pick);
  } else {
    set({ activeSessionId: null, activeSession: null });
  }
}

// Theme-scoped CSS lives under [data-theme=...] — set it synchronously at
// module load so the first paint (and any failed settings fetch) still shows
// the persisted theme instead of falling back to base variables.
if (typeof document !== "undefined") {
  try {
    const storedTheme = localStorage.getItem("acprocess.theme") as Theme | null;
    document.documentElement.setAttribute("data-theme", storedTheme === "dark" ? "dark" : "light");
  } catch {
    /* ignore */
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  sessions: [],
  themes: [],
  activeSessionId: null,
  activeSession: null,
  modelsCatalog: typeof window !== "undefined" ? readStoredModelsCatalog() : null,
  modelsLoading:
    typeof window !== "undefined"
      ? !(readStoredModelsCatalog()?.models?.length)
      : true,
  usageSupported:
    typeof window !== "undefined"
      ? Object.values(readUsageSupportMap()).some(Boolean)
      : false,
  sessionUsage: null,
  sidebarOpen: typeof window !== "undefined" ? window.innerWidth >= 900 : true,
  connected: false,
  agentAvailable: false,
  pendingPermission: null,
  permissionQueue: [],
  pendingQuestion: null,
  promptEpoch: 0,
  cancelledPromptEpoch: -1,
  promptQueue: [],
  inflight: 0,
  loading: true,
  error: null,

  // Apply the persisted theme before the first paint: theme-scoped rules
  // (e.g. the sidebar "New chat" button) must be correct even when the
  // settings fetch fails or races, which would otherwise leave the app on
  // default (light) variables with no data-theme attribute.
  applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("acprocess.theme", theme);
  },

  applyLocale(locale) {
    document.documentElement.lang = locale;
    localStorage.setItem("acprocess.locale", locale);
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

    // Don't keep Cursor Agent/Plan/Ask chips on OMP/OpenCode after a switch.
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
      const res = await api.listModels(provider, {
        force: force || missingParams || missingModes || staleCursorModes || providerMismatch,
      });
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
      await loadAppData(set, get);
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      set({ loading: false });
    }
  },

  async refreshSessions() {
    const sessions = await api.listSessions();
    set({ sessions });
  },

  async refreshThemes() {
    const themes = await api.listThemes();
    set({ themes });
  },

  async selectSession(id) {
    if (!id) {
      localStorage.removeItem(ACTIVE_SESSION_KEY);
      clearMessageIdAliases();
      set({
        activeSessionId: null,
        activeSession: null,
        pendingPermission: null,
        permissionQueue: [],
        pendingQuestion: null,
      });
      return;
    }

    localStorage.setItem(ACTIVE_SESSION_KEY, id);
    const seq = ++selectSessionSeq;
    const cached = sessionDetailCache.get(id);
    const listItem = get().sessions.find((s) => s.id === id);
    const current = get().activeSession;

    // Highlight + show cached/skeleton immediately — don't wait on the network.
    const optimistic: SessionDetailDto | null =
      cached ??
      (current?.id === id
        ? current
        : listItem
          ? { ...listItem, messages: [], slashCommands: [] }
          : null);

    if (current?.id !== id) clearMessageIdAliases();

    set({
      activeSessionId: id,
      activeSession: optimistic,
      pendingPermission: null,
      permissionQueue: [],
      pendingQuestion: null,
    });

    try {
      const detail = await api.getSession(id);
      rememberSessionDetail(detail);
      if (seq !== selectSessionSeq || get().activeSessionId !== id) return;
      // Don't clobber an in-flight optimistic turn with a stale GET snapshot.
      if (get().activeSession?.status === "running") return;
      set({ activeSession: detail });
    } catch (err) {
      if (seq !== selectSessionSeq || get().activeSessionId !== id) return;
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  async createSession(cwd) {
    const trimmedCwd = cwd?.trim();
    const session = await api.createSession({
      themeId: null,
      ...(trimmedCwd ? { cwd: trimmedCwd } : {}),
    } as Partial<SessionDto>);
    await get().refreshSessions();
    await get().selectSession(session.id);
    return session;
  },

  async deleteSession(id) {
    await api.deleteSession(id);
    const { activeSessionId } = get();
    await get().refreshSessions();
    if (activeSessionId === id) {
      const next = get().sessions[0];
      await get().selectSession(next?.id ?? null);
    }
  },

  async renameSession(id, title) {
    const trimmed = title.trim();
    if (!trimmed) return;
    const updated = await api.updateSession(id, { title: trimmed });
    set({
      sessions: get().sessions.map((s) => (s.id === id ? updated : s)),
      activeSession:
        get().activeSession?.id === id
          ? { ...get().activeSession!, ...updated }
          : get().activeSession,
    });
  },

  async setSessionFlags(id, patch) {
    // Optimistic flip, then reconcile with the server's canonical row.
    const apply = (s: SessionDto) => (s.id === id ? { ...s, ...patch } : s);
    set({
      sessions: get().sessions.map(apply),
      activeSession:
        get().activeSession?.id === id
          ? { ...get().activeSession!, ...patch }
          : get().activeSession,
    });
    try {
      const updated = await api.updateSession(id, patch);
      set({
        sessions: get().sessions.map((s) => (s.id === id ? updated : s)),
        activeSession:
          get().activeSession?.id === id
            ? { ...get().activeSession!, ...updated }
            : get().activeSession,
      });
    } catch {
      // keep the optimistic value
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
    const limit = get().settings.multitask ? 2 : 1;
    const busy =
      get().inflight >= limit ||
      get().promptQueue.length > 0 ||
      get().activeSession?.status === "running" ||
      get().activeSession?.status === "waiting";
    if (busy) {
      set({
        promptQueue: [
          ...get().promptQueue,
          {
            id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            text,
            editMessageId: opts?.editMessageId ?? null,
          },
        ],
      });
      // Small delay so the queue bar renders before drain picks up the item.
      await new Promise((r) => setTimeout(r, 80));
      void get().drainPromptQueue();
      return;
    }
    // Reserve a slot so a second send while this turn is running actually
    // queues instead of being drained instantly (inflight only drops on idle).
    set({ inflight: get().inflight + 1 });
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
    if (get().inflight >= limit) return;
    // Serial mode: never start the next turn while the agent is still working
    // (inflight can read 0 after a page reload mid-turn).
    const status = get().activeSession?.status;
    if (limit === 1 && (status === "running" || status === "waiting")) return;
    const q = get().promptQueue;
    if (!q.length) return;
    const [item, ...rest] = q;
    set({ promptQueue: rest, inflight: get().inflight + 1 });
    try {
      await get().runSendPrompt(
        item.text,
        item.editMessageId ? { editMessageId: item.editMessageId } : undefined,
        {
          // The first slot reuses the optimistic pair; extra multitask slots
          // stream their real messages in over WS instead.
          optimistic: get().inflight <= 1,
        },
      );
    } catch {
      set({ inflight: Math.max(0, get().inflight - 1) });
    }
    // Fill the second multitask slot; serial mode is already at the limit.
    void get().drainPromptQueue();
  },

  async runSendPrompt(text, opts, { optimistic = true } = {}) {
    const id = get().activeSessionId;
    set({ error: null });

    const buildOptimisticPair = (sessionId: string, baseMessages: MessageDto[]) => {
      const epoch = get().promptEpoch + 1;
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
      const active = get().activeSession;
      set({
        modelsLoading: false,
        promptEpoch: epoch,
        sessions: get().sessions.map((s) =>
          s.id === sessionId ? { ...s, status: "running" as const } : s,
        ),
        activeSession:
          active?.id === sessionId
            ? {
                ...active,
                status: "running",
                ...(messages ? { messages } : {}),
              }
            : active,
      });
    };

    if (!id) {
      const session = await get().createSession();
      const active = get().activeSession;
      const pair = buildOptimisticPair(session.id, active?.id === session.id ? active.messages : []);
      pendingOptimisticPair = { userId: pair.userId, assistantId: pair.assistantId };
      commitRunning(session.id, pair.messages, pair.epoch);
      await api.prompt(session.id, text);
      return;
    }

    if (opts?.editMessageId && get().activeSession?.id === id) {
      const msgs = get().activeSession!.messages;
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
        pendingOptimisticPair = { userId, assistantId };
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

    const active = get().activeSession;
    if (active?.id === id && optimistic) {
      const pair = buildOptimisticPair(id, active.messages);
      pendingOptimisticPair = { userId: pair.userId, assistantId: pair.assistantId };
      commitRunning(id, pair.messages, pair.epoch);
    } else {
      commitRunning(id, null, get().promptEpoch + 1);
    }
    await api.prompt(id, text, opts?.editMessageId ? { editMessageId: opts.editMessageId } : undefined);
  },

  async cancelPrompt() {
    const id = get().activeSessionId;
    if (!id) return;
    const state = get();
    set({
      cancelledPromptEpoch: state.promptEpoch,
      promptQueue: [],
      inflight: 0,
      pendingPermission:
        state.pendingPermission?.sessionId === id ? null : state.pendingPermission,
      permissionQueue: state.permissionQueue.filter((p) => p.sessionId !== id),
      pendingQuestion: state.pendingQuestion?.sessionId === id ? null : state.pendingQuestion,
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, status: "idle" as const } : s)),
      activeSession:
        state.activeSession?.id === id
          ? { ...state.activeSession, status: "idle" as const }
          : state.activeSession,
    });
    try {
      await api.cancel(id);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  setSidebarOpen(open) {
    set({ sidebarOpen: open });
  },

  setConnected(connected) {
    set({ connected });
  },

  setAgentAvailable(available) {
    set({ agentAvailable: available });
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
            s.id === event.sessionId ? { ...event.session, status: "running" } : s,
          ),
          activeSession: {
            ...state.activeSession,
            ...event.session,
            status: "running",
            messages: state.activeSession.messages,
          },
        });
        return;
      }
      // After Stop, don't let a late "running"/"waiting" event revive the stream UI.
      const cancelled =
        state.activeSession?.id === event.sessionId &&
        state.cancelledPromptEpoch === state.promptEpoch;
      const session =
        cancelled && (event.session.status === "running" || event.session.status === "waiting")
          ? { ...event.session, status: "idle" as const }
          : event.session;
      set({
        ...(session.status === "running" || session.status === "waiting"
          ? { modelsLoading: false }
          : {}),
        ...(session.mode && session.mode !== state.settings.defaultMode
          ? { settings: { ...state.settings, defaultMode: session.mode } }
          : {}),
        sessions: state.sessions.map((s) =>
          s.id === event.sessionId
            ? {
                ...session,
                lastMessageAt: session.lastMessageAt ?? s.lastMessageAt ?? s.createdAt,
              }
            : s,
        ),
        activeSession:
          state.activeSession?.id === event.sessionId
            ? {
                ...state.activeSession,
                ...session,
                lastMessageAt:
                  session.lastMessageAt ??
                  state.activeSession.lastMessageAt ??
                  state.activeSession.createdAt,
                messages: state.activeSession.messages,
              }
            : state.activeSession,
      });
      // A few ACP adapters finish their RPC before the final WS part has
      // crossed the proxy. Reconcile only after idle so that answer cannot
      // remain hidden until the user reloads the chat.
      if (
        session.status === "idle" &&
        state.activeSession?.id === event.sessionId &&
        !cancelled
      ) {
        reconcileFinishedTurn(event.sessionId, get, set);
        // All in-flight turns are done — free the queue slots and send more.
        if (get().inflight > 0) set({ inflight: 0 });
        void get().drainPromptQueue();
      }
      return;
    }

    if (event.type === "message.created") {
      const nextSessions = state.sessions.map((s) =>
        s.id === event.sessionId
          ? {
              ...s,
              lastMessageAt: event.message.createdAt,
              updatedAt: event.message.createdAt,
            }
          : s,
      );
      if (state.activeSession?.id !== event.sessionId) {
        set({ sessions: nextSessions });
        return;
      }
      const nextActive = {
        ...state.activeSession!,
        lastMessageAt: event.message.createdAt,
        updatedAt: event.message.createdAt,
        messages: upsertMessage(state.activeSession!.messages, event.message),
      };
      rememberSessionDetail(nextActive);
      set({
        sessions: nextSessions,
        activeSession: nextActive,
      });
      return;
    }

    if (event.type === "messages.truncated" || event.type === "messages.replaced") {
      if (state.activeSession?.id !== event.sessionId) return;
      const replacedActive = {
        ...state.activeSession!,
        messages: event.messages,
      };
      rememberSessionDetail(replacedActive);
      set({
        activeSession: replacedActive,
      });
      return;
    }

    if (event.type === "part.appended" || event.type === "part.updated") {
      if (state.activeSession?.id !== event.sessionId) return;
      // User hit Stop — ignore late tokens still arriving over WS.
      if (state.cancelledPromptEpoch === state.promptEpoch) return;
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
      if (state.activeSession?.id !== event.sessionId) return;
      set({
        activeSession: {
          ...state.activeSession!,
          slashCommands: event.commands,
        },
      });
      return;
    }

    if (event.type === "usage.updated") {
      const provider =
        event.usage.provider ??
        state.settings.connectedProvider ??
        state.activeSession?.provider;
      if (provider) writeUsageSupport(provider, true);
      set({
        usageSupported: true,
        sessionUsage: event.usage,
      });
      return;
    }

    if (event.type === "agent.availability") {
      if (event.provider === state.settings.connectedProvider) {
        set({ agentAvailable: event.available });
      }
      return;
    }

    if (event.type === "error") {
      set({ error: event.message });
      rememberDiagnosticsError(event.message, "ws");
      void submitAutoErrorDump(event.message);
      const provider = get().settings.connectedProvider ?? get().settings.defaultProvider;
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

  async answerQuestion(result) {
    const pending = get().pendingQuestion;
    if (!pending) return;
    await api.answerQuestion(pending.sessionId, pending.requestId, result);
    set({ pendingQuestion: null });
  },

  async saveSettings(patch) {
    const current = get().settings;
    const providerChanged =
      patch.defaultProvider !== undefined && patch.defaultProvider !== current.defaultProvider;
    const nextPatch =
      providerChanged && patch.defaultModel === undefined
        ? { ...patch, defaultModel: "", defaultModelParams: {} }
        : patch;
    const settings = await api.updateSettings(nextPatch);
    if (nextPatch.theme) get().applyTheme(nextPatch.theme);
    if (nextPatch.locale) get().applyLocale(nextPatch.locale);
    set({ settings });
    applyAppearance(settings);
    const providerToLoad =
      nextPatch.connectedProvider ?? (providerChanged ? settings.defaultProvider : null);
    if (providerToLoad) {
      void get().ensureModels(providerToLoad, {
        force: nextPatch.connectedProvider != null || providerChanged,
      });
      void get().refreshAgentUsage();
      const activeId = get().activeSessionId;
      if (activeId) void get().selectSession(activeId);
    } else if (providerChanged) {
      void get().ensureModels(settings.defaultProvider, { force: true });
      void get().refreshAgentUsage();
      const activeId = get().activeSessionId;
      if (activeId) void get().selectSession(activeId);
    }
  },

  async refreshAgentUsage() {
    const provider = get().settings.connectedProvider ?? undefined;
    const sessionId = get().activeSessionId ?? undefined;
    const cached = provider ? readUsageSupportMap()[provider] === true : false;
    try {
      const res = await api.getAgentUsage({ provider, sessionId: sessionId ?? undefined });
      if (res.supported && res.usage) {
        if (provider) writeUsageSupport(provider, true);
        set({ usageSupported: true, sessionUsage: res.usage });
        return;
      }
      set({
        usageSupported: cached,
        sessionUsage: null,
      });
    } catch {
      set({ usageSupported: cached });
    }
  },
}));
