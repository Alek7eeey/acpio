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
  Theme,
  UserDto,
  WsServerEvent,
} from "@acprocess/shared";
import { DEFAULT_SETTINGS } from "@acprocess/shared";
import { api } from "./api";

const MODELS_CACHE_KEY = "acprocess.modelsCatalog.v2";
const MODELS_CACHE_KEY_LEGACY = "acprocess.modelsCatalog.v1";
/** Soft TTL: serve instantly, refresh quietly in background after this. */
const MODELS_SOFT_TTL_MS = 30 * 60_000;
/** Hard TTL: force a blocking reload only after this. */
const MODELS_HARD_TTL_MS = 7 * 24 * 60_000;

export type ModelsCatalog = {
  provider: AgentProvider;
  models: Array<{ value: string; name: string }>;
  modelParams: ModelParamDto[];
  currentModel?: string;
  at: number;
};

type ModelsCatalogMap = Partial<Record<AgentProvider, ModelsCatalog>>;

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
  user: UserDto | null;
  settings: AppSettings;
  sessions: SessionDto[];
  themes: ChatThemeDto[];
  activeSessionId: string | null;
  activeSession: SessionDetailDto | null;
  modelsCatalog: ModelsCatalog | null;
  modelsLoading: boolean;
  sidebarOpen: boolean;
  connected: boolean;
  pendingPermission: PendingPermission | null;
  pendingQuestion: PendingQuestion | null;
  loading: boolean;
  error: string | null;
  setTheme: (theme: Theme) => Promise<void>;
  applyTheme: (theme: Theme) => void;
  setLocale: (locale: AppLocale) => Promise<void>;
  applyLocale: (locale: AppLocale) => void;
  loadBootstrap: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  enterApp: (user: UserDto) => Promise<void>;
  logout: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  updateProfile: (displayName: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
  refreshThemes: () => Promise<void>;
  selectSession: (id: string | null) => Promise<void>;
  createSession: (themeId?: string | null, cwd?: string) => Promise<SessionDto>;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  reorderSessions: (
    items: Array<{ id: string; themeId: string | null; sortOrder: number }>,
  ) => Promise<void>;
  createTheme: (input?: { name?: string }) => Promise<ChatThemeDto>;
  renameTheme: (id: string, name: string) => Promise<void>;
  deleteTheme: (id: string) => Promise<void>;
  sendPrompt: (text: string) => Promise<void>;
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
};

function normalizeCatalog(parsed: Partial<ModelsCatalog> | null | undefined): ModelsCatalog | null {
  if (!parsed?.provider || !Array.isArray(parsed.models)) return null;
  return {
    provider: parsed.provider,
    models: parsed.models,
    modelParams: Array.isArray(parsed.modelParams) ? parsed.modelParams : [],
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
  const [sessions, themes] = await Promise.all([api.listSessions(), api.listThemes()]);
  set({ settings: { ...settings, theme, locale }, sessions, themes });
  // Models only after the user explicitly connected an agent.
  const provider = get().user?.connectedProvider;
  if (provider) {
    void get().ensureModels(provider);
  } else {
    set({ modelsCatalog: null, modelsLoading: false });
  }
  if (sessions[0]) {
    await get().selectSession(sessions[0].id);
  } else {
    set({ activeSessionId: null, activeSession: null });
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  user: null,
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
  sidebarOpen: typeof window !== "undefined" ? window.innerWidth >= 900 : true,
  connected: false,
  pendingPermission: null,
  pendingQuestion: null,
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
    writeStoredModelsCatalog(catalog);
    set({ modelsCatalog: catalog, modelsLoading: false });
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
      Date.now() - existing.at < MODELS_HARD_TTL_MS;
    const missingParams = (existing?.modelParams?.length ?? 0) === 0;

    // Instantly show the last catalog for this agent (Fast/Усилие) when switching.
    if (providerMismatch) {
      set({
        modelsCatalog: existing?.provider === provider ? existing : null,
        modelsLoading: !(existing?.models?.length),
      });
    }

    if (freshEnough && !force && !missingParams) {
      if (active?.provider !== provider) {
        set({ modelsCatalog: existing, modelsLoading: false });
      }
      const softStale = Date.now() - existing.at >= MODELS_SOFT_TTL_MS;
      if (softStale) {
        void api
          .listModels(provider)
          .then((res) => {
            if (!res.ok && !(res.models?.length)) return;
            get().rememberModelsCatalog({
              provider,
              models: res.models ?? [],
              modelParams: res.modelParams ?? [],
              currentModel: res.currentModel,
              at: Date.now(),
            });
          })
          .catch(() => {
            /* keep cache */
          });
      }
      set({ modelsLoading: false });
      return existing;
    }

    // Keep prior catalog for this provider while reloading so Усилие doesn't blink away.
    set({
      modelsCatalog: existing?.provider === provider ? existing : null,
      modelsLoading: !(existing?.models?.length),
    });

    try {
      const res = await api.listModels(provider, { force: force || missingParams || providerMismatch });
      const catalog: ModelsCatalog = {
        provider,
        models: res.models ?? [],
        modelParams: res.modelParams ?? [],
        currentModel: res.currentModel,
        at: Date.now(),
      };
      if (catalog.models.length || catalog.modelParams.length) {
        get().rememberModelsCatalog(catalog);
      } else {
        set({ modelsLoading: false });
      }
      return catalog;
    } catch (err) {
      set({
        modelsLoading: false,
        error: err instanceof Error ? err.message : String(err),
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
      const storedTheme = localStorage.getItem("acprocess.theme") as Theme | null;
      const storedLocale = localStorage.getItem("acprocess.locale") as AppLocale | null;
      if (storedTheme) get().applyTheme(storedTheme);
      if (storedLocale === "en" || storedLocale === "ru") get().applyLocale(storedLocale);
      const { user } = await api.me();
      if (!user) {
        const locale =
          storedLocale === "en" || storedLocale === "ru" ? storedLocale : DEFAULT_SETTINGS.locale;
        set({
          user: null,
          settings: { ...DEFAULT_SETTINGS, locale },
          sessions: [],
          themes: [],
          activeSessionId: null,
          activeSession: null,
        });
        return;
      }
      set({ user });
      await loadAppData(set, get);
    } catch (err) {
      set({
        user: null,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      set({ loading: false });
    }
  },

  async login(username, password) {
    const { user } = await api.login(username.trim(), password);
    await get().enterApp(user);
  },

  async register(username, password) {
    const { user } = await api.register(username.trim(), password);
    await get().enterApp(user);
  },

  async enterApp(user) {
    set({ user, error: null, loading: true });
    try {
      await loadAppData(set, get);
    } finally {
      set({ loading: false });
    }
  },

  async logout() {
    try {
      await api.logout();
    } finally {
      set({
        user: null,
        sessions: [],
        themes: [],
        activeSessionId: null,
        activeSession: null,
        pendingPermission: null,
        pendingQuestion: null,
        connected: false,
      });
    }
  },

  async changePassword(currentPassword, newPassword) {
    await api.changePassword(currentPassword, newPassword);
  },

  async updateProfile(displayName) {
    const { user } = await api.updateProfile(displayName);
    set({ user });
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
      set({ activeSessionId: null, activeSession: null });
      return;
    }
    const detail = await api.getSession(id);
    set({ activeSessionId: id, activeSession: detail });
  },

  async createSession(themeId, cwd) {
    const resolvedThemeId =
      themeId !== undefined ? themeId : get().activeSession?.themeId ?? null;
    const trimmedCwd = cwd?.trim();
    const session = await api.createSession({
      themeId: resolvedThemeId,
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

  async createTheme(input) {
    const theme = await api.createTheme(input ?? {});
    await get().refreshThemes();
    return theme;
  },

  async renameTheme(id, name) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const updated = await api.updateTheme(id, { name: trimmed });
    set({ themes: get().themes.map((t) => (t.id === id ? updated : t)) });
  },

  async deleteTheme(id) {
    await api.deleteTheme(id);
    await Promise.all([get().refreshThemes(), get().refreshSessions()]);
  },

  async sendPrompt(text) {
    const id = get().activeSessionId;
    set({ error: null });

    const markRunning = (sessionId: string) => {
      const active = get().activeSession;
      set({
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
    markRunning(id);
    await api.prompt(id, text);
  },

  async cancelPrompt() {
    const id = get().activeSessionId;
    if (!id) return;
    await api.cancel(id);
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
      set({
        sessions: state.sessions.map((s) => (s.id === event.sessionId ? event.session : s)),
        activeSession:
          state.activeSession?.id === event.sessionId
            ? { ...state.activeSession, ...event.session }
            : state.activeSession,
      });
      return;
    }

    if (event.type === "message.created") {
      if (state.activeSession?.id !== event.sessionId) return;
      set({
        activeSession: {
          ...state.activeSession!,
          messages: upsertMessage(state.activeSession!.messages, event.message),
        },
      });
      return;
    }

    if (event.type === "part.appended" || event.type === "part.updated") {
      if (state.activeSession?.id !== event.sessionId) return;
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
      set({
        pendingPermission: {
          sessionId: event.sessionId,
          requestId: event.requestId,
          payload: event.payload,
        },
      });
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

    if (event.type === "error") {
      set({ error: event.message });
    }
  },

  async answerPermission(optionId) {
    const pending = get().pendingPermission;
    if (!pending) return;
    await api.answerPermission(pending.sessionId, pending.requestId, optionId);
    set({ pendingPermission: null });
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
    if (nextPatch.defaultProvider) {
      // Refresh connectedProvider on the current user for admin / UI badges.
      try {
        const { user } = await api.me();
        if (user) set({ user });
      } catch {
        /* ignore */
      }
      void get().ensureModels(nextPatch.defaultProvider, { force: true });
      const activeId = get().activeSessionId;
      if (activeId) void get().selectSession(activeId);
    } else if (providerChanged) {
      void get().ensureModels(settings.defaultProvider, { force: true });
      const activeId = get().activeSessionId;
      if (activeId) void get().selectSession(activeId);
    }
  },
}));
