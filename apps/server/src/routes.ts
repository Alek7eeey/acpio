import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getSettings, updateSettings } from "./services/settings.js";
import {
  createSession,
  deleteSession,
  getSessionDetail,
  listSessions,
  reorderSessions,
  updateSession,
} from "./services/sessions.js";
import {
  createTheme,
  deleteTheme,
  listThemes,
  reorderThemes,
  updateTheme,
} from "./services/themes.js";
import {
  answerPermission,
  answerQuestion,
  cancelPrompt,
  disposeRuntime,
  listModels,
  clearModelsCache,
  probeAgent,
  runPrompt,
  setSessionModel,
  syncSessionAgent,
  warmAcp,
} from "./acp/sessionManager.js";
import {
  aiCommit,
  createPullRequest,
  getGiteaStatus,
  listGiteaJobs,
  resolveConflicts,
} from "./services/gitea.js";
import { pickDirectory } from "./services/pickDirectory.js";
import { addWsClient, subscribeClient, unsubscribeClient } from "./services/wsHub.js";
import {
  AUTH_COOKIE,
  changePassword,
  clearAuthCookie,
  createSession as createAuthSession,
  deleteUser,
  destroySession,
  getRequestUser,
  listAdminUsers,
  loginUser,
  registerUser,
  requireAdmin,
  requireUser,
  setAuthCookie,
  setUserConnectedProvider,
  updateProfile,
} from "./services/auth.js";

const settingsSchema = z.object({
  theme: z.enum(["light", "dark"]).optional(),
  defaultProvider: z.enum(["cursor", "opencode", "omp", "pi"]).optional(),
  defaultMode: z.enum(["agent", "plan", "ask"]).optional(),
  defaultCwd: z.string().optional(),
  defaultModel: z.string().optional(),
  defaultModelParams: z.record(z.string()).optional(),
  cursorCommand: z.string().optional(),
  cursorArgs: z.array(z.string()).optional(),
  opencodeCommand: z.string().optional(),
  opencodeArgs: z.array(z.string()).optional(),
  ompCommand: z.string().optional(),
  ompArgs: z.array(z.string()).optional(),
  piCommand: z.string().optional(),
  piArgs: z.array(z.string()).optional(),
  cursorApiKey: z.string().optional(),
  opencodeApiKey: z.string().optional(),
  anthropicApiKey: z.string().optional(),
  openaiApiKey: z.string().optional(),
  permissionPolicy: z.enum(["prompt", "allowlist", "always"]).optional(),
  permissionAllowlist: z.array(z.string()).optional(),
  giteaBaseUrl: z.string().optional(),
  giteaToken: z.string().optional(),
  giteaOwner: z.string().optional(),
  giteaRepo: z.string().optional(),
});

const authBodySchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(200),
});

function isPublicPath(url: string) {
  const path = url.split("?")[0] ?? url;
  return (
    path === "/api/health" ||
    path === "/api/auth/register" ||
    path === "/api/auth/login" ||
    path === "/api/auth/me"
  );
}

function sendAuthError(reply: FastifyReply, err: unknown) {
  if (err instanceof z.ZodError) {
    return reply.code(400).send({ error: "Укажите логин и пароль" });
  }
  const status =
    typeof err === "object" &&
    err &&
    "statusCode" in err &&
    typeof (err as { statusCode: unknown }).statusCode === "number"
      ? (err as { statusCode: number }).statusCode
      : 400;
  const message = err instanceof Error ? err.message : String(err);
  return reply.code(status).send({ error: message });
}

export async function registerRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (req, reply) => {
    const path = req.url.split("?")[0] ?? req.url;
    if (!path.startsWith("/api/") || isPublicPath(path)) return;
    const user = await requireUser(req, reply);
    if (!user) return;
  });

  app.get("/api/health", async () => ({ ok: true }));

  app.post("/api/fs/pick-directory", async (req, reply) => {
    const body = z
      .object({ initialPath: z.string().max(500).optional() })
      .parse(req.body ?? {});
    try {
      const path = await pickDirectory(body.initialPath);
      return { path };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: message });
    }
  });

  app.get("/api/auth/me", async (req) => {
    const user = await getRequestUser(req);
    return { user };
  });

  app.post("/api/auth/register", async (req, reply) => {
    try {
      const body = authBodySchema.parse(req.body);
      const user = await registerUser(body.username, body.password);
      const session = await createAuthSession(user.id);
      setAuthCookie(reply, session.token, session.expiresAt);
      return { user };
    } catch (err) {
      return sendAuthError(reply, err);
    }
  });

  app.post("/api/auth/login", async (req, reply) => {
    try {
      const body = authBodySchema.parse(req.body);
      const user = await loginUser(body.username, body.password);
      const session = await createAuthSession(user.id);
      setAuthCookie(reply, session.token, session.expiresAt);
      return { user };
    } catch (err) {
      return sendAuthError(reply, err);
    }
  });

  app.post("/api/auth/logout", async (req, reply) => {
    await destroySession(req.cookies?.[AUTH_COOKIE]);
    clearAuthCookie(reply);
    return { ok: true };
  });

  app.post("/api/auth/password", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    try {
      const body = z
        .object({
          currentPassword: z.string().min(1).max(200),
          newPassword: z.string().min(1).max(200),
        })
        .parse(req.body);
      await changePassword(user.id, body.currentPassword, body.newPassword);
      return { ok: true };
    } catch (err) {
      return sendAuthError(reply, err);
    }
  });

  app.patch("/api/auth/profile", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    try {
      const body = z.object({ displayName: z.string().min(1).max(80) }).parse(req.body);
      const updated = await updateProfile(user.id, body.displayName);
      return { user: updated };
    } catch (err) {
      return sendAuthError(reply, err);
    }
  });

  app.post("/api/agent/probe", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const body = z
      .object({ provider: z.enum(["cursor", "opencode", "omp", "pi"]).optional() })
      .parse(req.body ?? {});
    // Probe does NOT mark the agent as connected — user must click Connect.
    return probeAgent(body.provider);
  });

  app.get("/api/agent/models", async (req) => {
    const q = req.query as { provider?: string; force?: string };
    const provider =
      q.provider === "cursor" ||
      q.provider === "opencode" ||
      q.provider === "omp" ||
      q.provider === "pi"
        ? q.provider
        : undefined;
    const force = q.force === "1" || q.force === "true";
    return listModels(provider, { force });
  });

  app.get("/api/settings", async () => getSettings());
  app.put("/api/settings", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const patch = settingsSchema.parse(req.body);
    const current = await getSettings();
    if (patch.defaultProvider && patch.defaultProvider !== current.defaultProvider) {
      clearModelsCache();
    }
    const updated = await updateSettings(patch);
    // Only an explicit Connect (defaultProvider in patch) binds the agent to this user.
    if (patch.defaultProvider) {
      await setUserConnectedProvider(user.id, patch.defaultProvider);
    }
    return updated;
  });

  app.get("/api/admin/users", async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    return listAdminUsers();
  });

  app.delete("/api/admin/users/:id", async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const { id } = req.params as { id: string };
    try {
      return await deleteUser(id, admin.id);
    } catch (err) {
      return sendAuthError(reply, err);
    }
  });

  app.get("/api/sessions", async () => listSessions());

  app.put("/api/sessions/reorder", async (req) => {
    const body = z
      .object({
        items: z.array(
          z.object({
            id: z.string().uuid(),
            themeId: z.string().uuid().nullable(),
            sortOrder: z.number().int(),
          }),
        ),
      })
      .parse(req.body);
    const before = await listSessions();
    const beforeById = new Map(before.map((s) => [s.id, s]));
    const sessions = await reorderSessions(body.items);
    for (const s of sessions) {
      const prev = beforeById.get(s.id);
      if (prev && prev.cwd !== s.cwd) disposeRuntime(s.id);
    }
    return sessions;
  });

  app.patch("/api/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        title: z.string().min(1).max(120).optional(),
        themeId: z.string().uuid().nullable().optional(),
        sortOrder: z.number().int().optional(),
      })
      .parse(req.body ?? {});
    const updated = await updateSession(id, body);
    if (!updated) return reply.code(404).send({ error: "Not found" });
    return updated;
  });

  app.post("/api/sessions", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!user.connectedProvider) {
      return reply
        .code(400)
        .send({ error: "Сначала подключите агента в Настройках" });
    }
    const body = z
      .object({
        title: z.string().optional(),
        provider: z.enum(["cursor", "opencode", "omp", "pi"]).optional(),
        cwd: z.string().optional(),
        mode: z.enum(["agent", "plan", "ask"]).optional(),
        themeId: z.string().uuid().nullable().optional(),
      })
      .parse(req.body ?? {});
    const settings = await getSettings();
    const cwd = body.cwd ?? settings.defaultCwd ?? process.cwd();
    const provider = body.provider ?? user.connectedProvider;
    const session = await createSession({
      title: body.title,
      provider,
      cwd,
      mode: body.mode ?? settings.defaultMode,
      themeId: body.themeId,
    });
    void warmAcp(session.id, {
      provider: session.provider,
      cwd: session.cwd,
      mode: session.mode,
    });
    return session;
  });

  app.get("/api/themes", async () => listThemes());
  app.post("/api/themes", async (req) => {
    const body = z
      .object({
        name: z.string().max(80).optional(),
      })
      .parse(req.body ?? {});
    return createTheme(body);
  });
  app.patch("/api/themes/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        name: z.string().min(1).max(80).optional(),
        sortOrder: z.number().int().optional(),
      })
      .parse(req.body ?? {});
    const updated = await updateTheme(id, body);
    if (!updated) return reply.code(404).send({ error: "Not found" });
    return updated;
  });
  app.delete("/api/themes/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await deleteTheme(id);
    if (!ok) return reply.code(404).send({ error: "Not found" });
    return { ok: true };
  });
  app.put("/api/themes/reorder", async (req) => {
    const body = z.object({ ids: z.array(z.string().uuid()) }).parse(req.body);
    return reorderThemes(body.ids);
  });

  app.get("/api/sessions/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const detail = await syncSessionAgent(id, user.connectedProvider);
    if (!detail) return reply.code(404).send({ error: "Not found" });
    if (user.connectedProvider) {
      void warmAcp(id, {
        provider: detail.provider,
        cwd: detail.cwd,
        mode: detail.mode,
      });
    }
    return detail;
  });

  app.delete("/api/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    disposeRuntime(id);
    const ok = await deleteSession(id);
    if (!ok) return reply.code(404).send({ error: "Not found" });
    return { ok: true };
  });

  app.post("/api/sessions/:id/prompt", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = z.object({ text: z.string().min(1) }).parse(req.body);
    if (!user.connectedProvider) {
      return reply
        .code(400)
        .send({ error: "Сначала подключите агента в Настройках" });
    }
    const detail = await syncSessionAgent(id, user.connectedProvider);
    if (!detail) return reply.code(404).send({ error: "Not found" });

    void runPrompt(id, body.text, {
      provider: detail.provider,
      cwd: detail.cwd,
      mode: detail.mode,
      titleHint: detail.title === "Новый чат" ? body.text : undefined,
    }).catch((err) => {
      console.error("prompt failed", err);
    });

    return { ok: true, status: "running" };
  });

  app.post("/api/sessions/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    await cancelPrompt(id);
    return { ok: true };
  });

  app.post("/api/sessions/:id/model", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!user.connectedProvider) {
      return reply
        .code(400)
        .send({ error: "Сначала подключите агента в Настройках" });
    }
    const { id } = req.params as { id: string };
    const body = z
      .object({
        model: z.string().min(1),
        params: z.record(z.string()).optional(),
      })
      .parse(req.body);
    const detail = await getSessionDetail(id);
    if (!detail) return reply.code(404).send({ error: "Not found" });
    await syncSessionAgent(id, user.connectedProvider);
    return setSessionModel(id, body.model, body.params);
  });

  app.post("/api/sessions/:id/permissions/:requestId", async (req) => {
    const { id, requestId } = req.params as { id: string; requestId: string };
    const body = z
      .object({
        optionId: z.string().min(1),
      })
      .parse(req.body);
    answerPermission(id, requestId, body.optionId as "allow-once" | "allow-always" | "reject-once");
    return { ok: true };
  });

  app.post("/api/sessions/:id/answers/:requestId", async (req) => {
    const { id, requestId } = req.params as { id: string; requestId: string };
    const body = z.object({ result: z.record(z.unknown()) }).parse(req.body);
    answerQuestion(id, requestId, body.result);
    return { ok: true };
  });

  app.get("/api/gitea/status", async () => getGiteaStatus());
  app.get("/api/gitea/jobs", async () => listGiteaJobs());

  app.post("/api/gitea/commit", async (req) => {
    const body = z.object({ message: z.string().optional() }).parse(req.body ?? {});
    return aiCommit(body.message);
  });

  app.post("/api/gitea/pr", async (req) => {
    const body = z
      .object({
        title: z.string().optional(),
        body: z.string().optional(),
        head: z.string().optional(),
        base: z.string().optional(),
      })
      .parse(req.body ?? {});
    return createPullRequest(body);
  });

  app.post("/api/gitea/conflicts", async () => resolveConflicts());

  app.get("/ws", { websocket: true }, async (socket, req) => {
    const user = await getRequestUser(req as FastifyRequest);
    if (!user) {
      socket.close(4401, "Unauthorized");
      return;
    }

    const client = addWsClient(socket);
    socket.send(JSON.stringify({ type: "pong" }));

    socket.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as {
          type?: string;
          sessionId?: string;
        };
        if (msg.type === "ping") {
          socket.send(JSON.stringify({ type: "pong" }));
          return;
        }
        if (msg.type === "subscribe" && msg.sessionId) {
          subscribeClient(client, msg.sessionId);
          return;
        }
        if (msg.type === "unsubscribe" && msg.sessionId) {
          unsubscribeClient(client, msg.sessionId);
        }
      } catch {
        // ignore
      }
    });
  });
}
