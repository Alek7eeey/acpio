import type {
  AppSettings,
  DiagnosticsDumpDto,
  DiagnosticsDumpMeta,
  MessageDto,
  SessionDetailDto,
} from "@acprocess/shared";
import { api } from "./api";
import { useAppStore } from "./store";

const RECENT_ERRORS_KEY = "acprocess.diagnostics.recentErrors";
const MAX_RECENT_ERRORS = 20;
const MAX_MESSAGES = 40;
const MAX_PART_TEXT = 1200;

type RecentError = { at: string; message: string; source?: string };

function readRecentErrors(): RecentError[] {
  try {
    const raw = localStorage.getItem(RECENT_ERRORS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentError[];
    return Array.isArray(parsed) ? parsed.slice(0, MAX_RECENT_ERRORS) : [];
  } catch {
    return [];
  }
}

export function rememberDiagnosticsError(message: string, source = "app") {
  const trimmed = message.trim();
  if (!trimmed) return;
  const next: RecentError[] = [
    { at: new Date().toISOString(), message: trimmed.slice(0, 500), source },
    ...readRecentErrors().filter((e) => e.message !== trimmed),
  ].slice(0, MAX_RECENT_ERRORS);
  try {
    localStorage.setItem(RECENT_ERRORS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

function truncateText(value: unknown, max = MAX_PART_TEXT) {
  const text = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[+${text.length - max}]`;
}

function summarizeMessage(msg: MessageDto) {
  return {
    id: msg.id,
    role: msg.role,
    createdAt: msg.createdAt,
    parts: msg.parts.map((p) => ({
      id: p.id,
      type: p.type,
      order: p.order,
      payload: Object.fromEntries(
        Object.entries(p.payload ?? {}).map(([k, v]) => [
          k,
          typeof v === "string" ? truncateText(v) : v,
        ]),
      ),
    })),
  };
}

function summarizeSession(session: SessionDetailDto | null) {
  if (!session) return null;
  const messages = session.messages.slice(-MAX_MESSAGES).map(summarizeMessage);
  return {
    id: session.id,
    title: session.title,
    provider: session.provider,
    cwd: session.cwd,
    mode: session.mode,
    status: session.status,
    themeId: session.themeId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastMessageAt: session.lastMessageAt,
    messageCount: session.messages.length,
    messagesTruncated: session.messages.length > MAX_MESSAGES,
    messages,
    slashCommands: session.slashCommands ?? [],
  };
}

function redactClientSettings(settings: AppSettings) {
  return {
    ...settings,
    cursorApiKey: settings.cursorApiKey ? "[set]" : "",
    opencodeApiKey: settings.opencodeApiKey ? "[set]" : "",
    anthropicApiKey: settings.anthropicApiKey ? "[set]" : "",
    openaiApiKey: settings.openaiApiKey ? "[set]" : "",
  };
}

export async function resolveDiagnosticsSession(
  sessionId?: string | null,
): Promise<SessionDetailDto | null> {
  if (!sessionId) return null;
  const state = useAppStore.getState();
  if (state.activeSession?.id === sessionId) return state.activeSession;
  try {
    return await api.getSession(sessionId);
  } catch {
    return null;
  }
}

export function buildClientDiagnosticsPayload(opts?: {
  note?: string;
  includeSession?: boolean;
  session?: SessionDetailDto | null;
}) {
  const state = useAppStore.getState();
  const catalog = state.modelsCatalog;
  const session =
    opts?.includeSession === false
      ? null
      : summarizeSession(opts?.session !== undefined ? opts.session : state.activeSession);
  return {
    at: new Date().toISOString(),
    href: typeof window !== "undefined" ? window.location.href : "",
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    language: typeof navigator !== "undefined" ? navigator.language : "",
    online: typeof navigator !== "undefined" ? navigator.onLine : undefined,
    viewport:
      typeof window !== "undefined"
        ? { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio }
        : undefined,
    store: {
      error: state.error,
      connected: state.connected,
      loading: state.loading,
      modelsLoading: state.modelsLoading,
      activeSessionId: state.activeSessionId,
      sessionCount: state.sessions.length,
      themeCount: state.themes.length,
      pendingPermission: Boolean(state.pendingPermission),
      pendingQuestion: Boolean(state.pendingQuestion),
    },
    settings: redactClientSettings(state.settings),
    modelsCatalog: catalog
      ? {
          provider: catalog.provider,
          currentModel: catalog.currentModel,
          modelCount: catalog.models.length,
          modelParams: catalog.modelParams.map((p) => ({
            id: p.id,
            name: p.name,
            currentValue: p.currentValue,
            optionCount: p.options.length,
          })),
          modes: catalog.modes,
          at: catalog.at,
        }
      : null,
    session,
    recentErrors: readRecentErrors(),
    note: opts?.note,
  };
}

export async function submitDiagnosticsDump(opts?: {
  reason?: string;
  note?: string;
  includeSession?: boolean;
  /** Chat to include; omit = active session; null/"" = app state only. */
  sessionId?: string | null;
}): Promise<DiagnosticsDumpMeta> {
  const includeSession = opts?.includeSession !== false && opts?.sessionId !== "";
  const session =
    includeSession === false
      ? null
      : await resolveDiagnosticsSession(
          opts?.sessionId === undefined ? useAppStore.getState().activeSessionId : opts.sessionId,
        );
  const client = buildClientDiagnosticsPayload({
    note: opts?.note,
    includeSession,
    session,
  });
  const res = await api.createDiagnosticsDump({
    reason: opts?.reason ?? "manual",
    note: opts?.note,
    client,
  });
  return res.dump;
}

let lastAutoDumpAt = 0;
let lastAutoDumpMessage = "";

/** Debounced auto-dump on errors so we don't spam the folder. */
export function submitAutoErrorDump(message: string) {
  const now = Date.now();
  if (message === lastAutoDumpMessage && now - lastAutoDumpAt < 60_000) return;
  if (now - lastAutoDumpAt < 15_000) return;
  lastAutoDumpAt = now;
  lastAutoDumpMessage = message;
  void submitDiagnosticsDump({
    reason: "error",
    note: message.slice(0, 500),
  }).catch(() => {
    /* ignore dump failures */
  });
}

export async function listDiagnostics() {
  return api.listDiagnostics();
}

export async function getDiagnosticsDump(id: string): Promise<DiagnosticsDumpDto> {
  return api.getDiagnosticsDump(id);
}

export async function removeDiagnosticsDump(id: string) {
  return api.deleteDiagnosticsDump(id);
}
