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
  pendingPermission: PendingPermission | null;
  /** Extra permission prompts waiting behind the one shown in the UI. */
  permissionQueue: PendingPermission[];
  pendingQuestion: PendingQuestion | null;
  /** Bumped on each send; cancel stamps cancelledPromptEpoch to ignore late WS parts. */
  promptEpoch: number;
  cancelledPromptEpoch: number;
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
  reorderSessions: (
    items: Array<{ id: string; themeId: string | null; sortOrder: number }>,
  ) => Promise<void>;
  sendPrompt: (text: string, opts?: { editMessageId?: string }) => Promise<void>;
  cancelPrompt: () => Promise<void>;
  setSidebarOpen: (open: boolean) => void;
  setConnected: (connected: boolean) => void;
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

function upsertMessage(messages: MessageDto[], message: MessageDto) {
  const idx = messages.findIndex((m) => m.id === message.id);
  if (idx === -1) return [...messages, message];
  const next = [...messages];
  next[idx] = message;
  return next;
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
  const sessions = await api.listSessions();
  set({ settings: { ...settings, theme, locale }, sessions, themes: [] });
  const provider = get().settings.connectedProvider;
  if (provider) {
    void get().ensureModels(provider);
    void get().refreshAgentUsage();
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
  pendingPermission: null,
  permissionQueue: [],
  pendingQuestion: null,
  promptEpoch: 0,
  cancelledPromptEpoch: -1,
  loading: true,
  error: null,

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

    // Instantly show the last catalog for this agent (Fast/Усилие) when switching.
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
    // Keep prior catalog for this provider while reloading so Усилие doesn't blink away.
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
      set({ activeSessionId: null, activeSession: null });
      return;
    }
    localStorage.setItem(ACTIVE_SESSION_KEY, id);
    const detail = await api.getSession(id);
    set({
      activeSessionId: id,
      activeSession: detail,
      pendingPermission: null,
      permissionQueue: [],
      pendingQuestion: null,
    });
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

  async reorderSessions(items) {
    const sessions = await api.reorderSessions(items);
    const active = get().activeSession;
    const nextActive = active ? sessions.find((s) => s.id === active.id) : null;
    set({
      sessions,
      activeSession: active && nextActive ? { ...active, ...nextActive } : active,
    });
  },

  async sendPrompt(text, opts) {
    const id = get().activeSessionId;
    set({ error: null });

    const markRunning = (sessionId: string) => {
      const active = get().activeSession;
      set({
        modelsLoading: false,
        promptEpoch: get().promptEpoch + 1,
        sessions: get().sessions.map((s) =>
          s.id === sessionId ? { ...s, status: "running" as const } : s,
        ),
        activeSession:
          active?.id === sessionId ? { ...active, status: "running" } : active,
      });
    };

    if (!id) {
      const session = await get().createSession();
      markRunning(session.id);
      await api.prompt(session.id, text);
      return;
    }

    if (opts?.editMessageId && get().activeSession?.id === id) {
      const msgs = get().activeSession!.messages;
      const idx = msgs.findIndex((m) => m.id === opts.editMessageId);
      if (idx >= 0) {
        const trimmed = text.trim();
        const slashMatch = trimmed.match(/^\/([\w-]+)/);
        const nextMessages = msgs.slice(0, idx + 1).map((m, i) => {
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
        set({
          activeSession: { ...get().activeSession!, messages: nextMessages, status: "running" },
        });
      }
    }

    markRunning(id);
    await api.prompt(id, text, opts?.editMessageId ? { editMessageId: opts.editMessageId } : undefined);
  },

  async cancelPrompt() {
    const id = get().activeSessionId;
    if (!id) return;
    const state = get();
    set({
      cancelledPromptEpoch: state.promptEpoch,
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

  handleWsEvent(event) {
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
      set({
        sessions: nextSessions,
        activeSession: {
          ...state.activeSession!,
          lastMessageAt: event.message.createdAt,
          updatedAt: event.message.createdAt,
          messages: upsertMessage(state.activeSession!.messages, event.message),
        },
      });
      return;
    }

    if (event.type === "messages.truncated") {
      if (state.activeSession?.id !== event.sessionId) return;
      set({
        activeSession: {
          ...state.activeSession!,
          messages: event.messages,
        },
      });
      return;
    }

    if (event.type === "part.appended" || event.type === "part.updated") {
      if (state.activeSession?.id !== event.sessionId) return;
      // User hit Stop — ignore late tokens still arriving over WS.
      if (state.cancelledPromptEpoch === state.promptEpoch) return;
      const messages = state.activeSession!.messages.map((m) => {
        if (m.id !== event.messageId) return m;
        return { ...m, parts: upsertPart(m.parts, event.part) };
      });
      if (!messages.some((m) => m.id === event.messageId)) {
        messages.push({
          id: event.messageId,
          sessionId: event.sessionId,
          role: "assistant",
          createdAt: new Date().toISOString(),
          parts: [event.part],
        });
      }
      set({
        activeSession: {
          ...state.activeSession!,
          messages,
        },
      });
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
