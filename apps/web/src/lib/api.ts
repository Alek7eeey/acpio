import type {
  AgentProbeResult,
  AgentProvider,
  AppSettings,
  ChatThemeDto,
  GiteaJobDto,
  GiteaStatusDto,
  ModelParamDto,
  SessionDetailDto,
  SessionDto,
} from "@acprocess/shared";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const hasBody = init?.body !== undefined && init?.body !== null;
  if (hasBody && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(path, { ...init, headers, credentials: "include" });
  if (!res.ok) {
    const text = await res.text();
    let message = text || res.statusText;
    try {
      const json = JSON.parse(text) as { error?: string };
      if (json.error) message = json.error;
    } catch {
      // keep raw text
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  getSettings: () => request<AppSettings>("/api/settings"),
  updateSettings: (patch: Partial<AppSettings>) =>
    request<AppSettings>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  probeAgent: (provider?: AgentProvider) =>
    request<AgentProbeResult>("/api/agent/probe", {
      method: "POST",
      body: JSON.stringify({ provider }),
    }),
  listModels: (provider?: AgentProvider, opts?: { force?: boolean }) => {
    const q = new URLSearchParams();
    if (provider) q.set("provider", provider);
    if (opts?.force) q.set("force", "1");
    const qs = q.toString();
    return request<{
      ok: boolean;
      provider: AgentProvider;
      currentModel?: string;
      models: Array<{ value: string; name: string }>;
      modelParams?: ModelParamDto[];
      cached?: boolean;
      message?: string;
    }>(`/api/agent/models${qs ? `?${qs}` : ""}`);
  },
  getModelParams: (
    provider: AgentProvider,
    model: string,
    opts?: { sessionId?: string; force?: boolean },
  ) => {
    const q = new URLSearchParams({ provider, model });
    if (opts?.sessionId) q.set("sessionId", opts.sessionId);
    if (opts?.force) q.set("force", "1");
    return request<{
      ok: boolean;
      modelParams: ModelParamDto[];
      cached?: boolean;
      live?: boolean;
      message?: string;
    }>(`/api/agent/model-params?${q}`);
  },
  warmModelParams: (provider?: AgentProvider) =>
    request<{ ok: boolean }>("/api/agent/warm-params", {
      method: "POST",
      body: JSON.stringify({ provider }),
    }),
  setSessionModel: (id: string, model: string, params?: Record<string, string>) =>
    request<{
      ok: boolean;
      model: string;
      appliedLive: boolean;
      currentModel?: string;
      models?: Array<{ value: string; name: string }>;
      modelParams?: ModelParamDto[];
    }>(`/api/sessions/${id}/model`, {
      method: "POST",
      body: JSON.stringify({ model, params }),
    }),
  pickDirectory: (initialPath?: string) =>
    request<{ path: string | null }>("/api/fs/pick-directory", {
      method: "POST",
      body: JSON.stringify({ initialPath: initialPath || undefined }),
    }),
  browseDirectory: (path?: string) =>
    request<{
      path: string;
      parent: string | null;
      kind?: "drives" | "directory";
      entries: Array<{ name: string; path: string }>;
    }>("/api/fs/browse", {
      method: "POST",
      body: JSON.stringify({ path: path || undefined }),
    }),
  listSessions: () => request<SessionDto[]>("/api/sessions"),
  createSession: (body?: Partial<SessionDto>) =>
    request<SessionDto>("/api/sessions", {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),
  updateSession: (
    id: string,
    patch: { title?: string; themeId?: string | null; sortOrder?: number },
  ) =>
    request<SessionDto>(`/api/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  reorderSessions: (
    items: Array<{ id: string; themeId: string | null; sortOrder: number }>,
  ) =>
    request<SessionDto[]>("/api/sessions/reorder", {
      method: "PUT",
      body: JSON.stringify({ items }),
    }),
  getSession: (id: string) => request<SessionDetailDto>(`/api/sessions/${id}`),
  deleteSession: (id: string) =>
    request<{ ok: boolean }>(`/api/sessions/${id}`, { method: "DELETE" }),
  listThemes: () => request<ChatThemeDto[]>("/api/themes"),
  createTheme: (input?: { name?: string }) =>
    request<ChatThemeDto>("/api/themes", {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    }),
  updateTheme: (id: string, patch: { name?: string; sortOrder?: number }) =>
    request<ChatThemeDto>(`/api/themes/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteTheme: (id: string) =>
    request<{ ok: boolean }>(`/api/themes/${id}`, { method: "DELETE" }),
  reorderThemes: (ids: string[]) =>
    request<ChatThemeDto[]>("/api/themes/reorder", {
      method: "PUT",
      body: JSON.stringify({ ids }),
    }),
  prompt: (id: string, text: string) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  cancel: (id: string) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/cancel`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  answerPermission: (
    id: string,
    requestId: string,
    optionId: "allow-once" | "allow-always" | "reject-once" | string,
  ) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/permissions/${encodeURIComponent(requestId)}`, {
      method: "POST",
      body: JSON.stringify({ optionId }),
    }),
  answerQuestion: (id: string, requestId: string, result: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/answers/${encodeURIComponent(requestId)}`, {
      method: "POST",
      body: JSON.stringify({ result }),
    }),
  giteaStatus: () => request<GiteaStatusDto>("/api/gitea/status"),
  giteaJobs: () => request<GiteaJobDto[]>("/api/gitea/jobs"),
  giteaCommit: (message?: string) =>
    request<GiteaJobDto>("/api/gitea/commit", {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  giteaPr: (body?: { title?: string; body?: string; base?: string }) =>
    request<GiteaJobDto>("/api/gitea/pr", {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),
  giteaConflicts: () =>
    request<GiteaJobDto>("/api/gitea/conflicts", {
      method: "POST",
      body: JSON.stringify({}),
    }),
};
