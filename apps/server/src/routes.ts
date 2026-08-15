import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "./db/client.js";
import { messages, messageParts } from "./db/schema.js";
import { defaultSessionTitle, errorMessage } from "@acprocess/i18n";
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
  getSessionSlashCommands,
  listModels,
  clearModelsCache,
  probeAgent,
  resolveModelParams,
  warmModelParamsProbe,
  runPrompt,
  setSessionModel,
  setSessionMode,
  getAgentAvailability,
  syncSessionAgent,
  warmAcp,
} from "./acp/sessionManager.js";
import { pickDirectory } from "./services/pickDirectory.js";
import { browseDirectory } from "./services/browseDirectory.js";
import { openPath } from "./services/openPath.js";
import { piperSpeakMixed, piperStatus, resolvePiperVoice } from "./services/piper.js";
import {
  defaultDiagnosticsDir,
  deleteDiagnosticsDump,
  listDiagnosticsDumps,
  readDiagnosticsDump,
  writeDiagnosticsDump,
} from "./services/diagnostics.js";
import { addWsClient, subscribeClient, unsubscribeClient } from "./services/wsHub.js";
import { isErrorCode, localeFromRequest, resolveLocale, localizeError } from "./lib/locale.js";
import type { AgentProvider } from "@acprocess/shared";

const settingsSchema = z.object({
  theme: z.enum(["light", "dark"]).optional(),
  locale: z.enum(["ru", "en"]).optional(),
  displayName: z.string().max(80).optional(),
  connectedProvider: z.enum(["cursor", "omp"]).nullable().optional(),
  defaultProvider: z.enum(["cursor", "omp"]).optional(),
  defaultMode: z.enum(["agent", "plan", "ask"]).optional(),
  defaultCwd: z.string().optional(),
  defaultModel: z.string().optional(),
  defaultModelParams: z.record(z.string()).optional(),
  cursorCommand: z.string().optional(),
  cursorArgs: z.array(z.string()).optional(),
  ompCommand: z.string().optional(),
  ompArgs: z.array(z.string()).optional(),
  cursorApiKey: z.string().optional(),
  anthropicApiKey: z.string().optional(),
  openaiApiKey: z.string().optional(),
  permissionPolicy: z.enum(["prompt", "allowlist", "always"]).optional(),
  permissionAllowlist: z.array(z.string()).optional(),
  diagnosticsDir: z.string().optional(),
  multitask: z.boolean().optional(),
  sidebarCollapse: z.enum(["full", "rail"]).optional(),
  showBootSplash: z.boolean().optional(),
  fontFamily: z.string().optional(),
  fontSize: z.string().optional(),
  lightScheme: z.string().optional(),
  darkScheme: z.string().optional(),
  ttsVoiceGender: z.enum(["", "female", "male"]).optional(),
  mcpServers: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        name: z.string().min(1).max(80),
        enabled: z.boolean(),
        type: z.enum(["local", "remote"]),
        command: z.string().max(300).optional(),
        args: z.array(z.string().max(300)).optional(),
        url: z.string().max(500).optional(),
        token: z.string().max(500).optional(),
      }),
    )
    .optional(),
});

async function agentConnected(): Promise<AgentProvider | null> {
  const settings = await getSettings();
  return settings.connectedProvider;
}

export async function registerRoutes(app: FastifyInstance) {
  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/tts/ping", async () => {
    const name = (v: { file: string; id: string } | null) =>
      v ? v.file.replace(/\.onnx$/, "") : null;
    return {
      ...piperStatus(),
      voicesByGender: {
        female: {
          ru: name(resolvePiperVoice("ru", "female")),
          en: name(resolvePiperVoice("en", "female")),
        },
        male: {
          ru: name(resolvePiperVoice("ru", "male")),
          en: name(resolvePiperVoice("en", "male")),
        },
      },
    };
  });

  app.get("/api/tts/speak", async (req, reply) => {
    const q = req.query as { text?: string; gender?: string };
    const text = typeof q.text === "string" ? q.text.trim() : "";
    if (!text) {
      return reply.code(400).send({ error: "text required" });
    }
    const gender =
      q.gender === "male" || q.gender === "female" ? q.gender : "";
    const ruVoice = resolvePiperVoice("ru", gender);
    const enVoice = resolvePiperVoice("en", gender);
    if (!ruVoice && !enVoice) {
      return reply.code(501).send({ error: "Piper not available", status: piperStatus() });
    }
    try {
      const wav = await piperSpeakMixed(text, ruVoice, enVoice);
      return reply.type("audio/wav").header("Cache-Control", "no-store").send(wav);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: message });
    }
  });

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

  app.get("/api/fs/browse", async (req, reply) => {
    const q = req.query as { path?: string; files?: string };
    const rawPath = typeof q.path === "string" ? q.path : undefined;
    try {
      return browseDirectory(rawPath, { includeFiles: q.files === "1" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/api/fs/browse", async (req, reply) => {
    const body = z
      .object({ path: z.string().optional(), files: z.boolean().optional() })
      .parse(req.body ?? {});
    try {
      return browseDirectory(body.path, { includeFiles: body.files === true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/api/fs/open", async (req, reply) => {
    const body = z.object({ path: z.string().min(1).max(4096) }).parse(req.body ?? {});
    const result = openPath(body.path);
    if (!result.ok) {
      return reply.code(400).send({ error: result.error });
    }
    return result;
  });

  app.post("/api/fs/mkdir", async (req, reply) => {
    const body = z.object({ path: z.string().min(1).max(4096) }).parse(req.body ?? {});
    try {
      await fsp.mkdir(body.path, { recursive: true });
      return { ok: true, path: body.path };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/api/agent/probe", async (req) => {
    const body = z
      .object({ provider: z.enum(["cursor", "omp"]).optional() })
      .parse(req.body ?? {});
    return probeAgent(body.provider);
  });

  app.get("/api/agent/models", async (req) => {
    const q = req.query as { provider?: string; force?: string };
    const provider =
      q.provider === "cursor" || q.provider === "omp" ? q.provider : undefined;
    const force = q.force === "1" || q.force === "true";
    return listModels(provider, { force });
  });

  app.get("/api/agent/status", async () => {
    const settings = await getSettings();
    return {
      provider: settings.connectedProvider,
      available: settings.connectedProvider
        ? getAgentAvailability(settings.connectedProvider)
        : false,
    };
  });

  app.get("/api/agent/model-params", async (req, reply) => {
    const q = req.query as { provider?: string; model?: string; sessionId?: string; force?: string };
    const provider =
      q.provider === "cursor" || q.provider === "omp" ? q.provider : undefined;
    const model = typeof q.model === "string" ? q.model.trim() : "";
    if (!provider || !model) {
      return reply.code(400).send({ error: "provider and model required" });
    }
    const force = q.force === "1" || q.force === "true";
    const sessionId = typeof q.sessionId === "string" && q.sessionId ? q.sessionId : undefined;
    return resolveModelParams(provider, model, { sessionId, force });
  });

  app.post("/api/agent/warm-params", async (req) => {
    const body = z
      .object({ provider: z.enum(["cursor", "omp"]).optional() })
      .parse(req.body ?? {});
    warmModelParamsProbe(body.provider);
    return { ok: true };
  });

  app.get("/api/settings", async () => getSettings());
  app.put("/api/settings", async (req) => {
    const patch = settingsSchema.parse(req.body);
    const current = await getSettings();
    if (patch.defaultProvider && patch.defaultProvider !== current.defaultProvider) {
      clearModelsCache();
    }
    return updateSettings(patch);
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
        pinned: z.boolean().optional(),
        archived: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    const updated = await updateSession(id, body);
    if (!updated) return reply.code(404).send({ error: "Not found" });
    return updated;
  });

  app.post("/api/sessions", async (req, reply) => {
    const connected = await agentConnected();
    if (!connected) {
      return reply
        .code(400)
        .send({ error: errorMessage(await resolveLocale(req), "agentNotConnected") });
    }
    const body = z
      .object({
        title: z.string().optional(),
        provider: z.enum(["cursor", "omp"]).optional(),
        cwd: z.string().optional(),
        mode: z.enum(["agent", "plan", "ask"]).optional(),
        themeId: z.string().uuid().nullable().optional(),
      })
      .parse(req.body ?? {});
    const settings = await getSettings();
    const cwd = body.cwd ?? settings.defaultCwd ?? process.cwd();
    const provider = body.provider ?? connected;
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
    const { id } = req.params as { id: string };
    const connected = await agentConnected();
    const detail = await syncSessionAgent(id, connected);
    if (!detail) return reply.code(404).send({ error: "Not found" });
    if (connected) {
      void warmAcp(id, {
        provider: detail.provider,
        cwd: detail.cwd,
        mode: detail.mode,
      });
    }
    return { ...detail, slashCommands: getSessionSlashCommands(id) };
  });

  app.delete("/api/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    disposeRuntime(id);
    const ok = await deleteSession(id);
    if (!ok) return reply.code(404).send({ error: "Not found" });
    return { ok: true };
  });

  app.post("/api/sessions/:id/prompt", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        text: z.string().min(1),
        editMessageId: z.string().uuid().optional(),
        attachments: z
          .array(
            z.object({
              name: z.string().min(1).max(255),
              path: z.string().min(1).max(4096),
            }),
          )
          .max(8)
          .optional(),
      })
      .parse(req.body);
    const connected = await agentConnected();
    if (!connected) {
      return reply
        .code(400)
        .send({ error: errorMessage(await resolveLocale(req), "agentNotConnected") });
    }
    const detail = await syncSessionAgent(id, connected);
    if (!detail) return reply.code(404).send({ error: "Not found" });

    const settings = await getSettings();
    const defaultTitle = defaultSessionTitle(settings.locale);
    void runPrompt(id, body.text, {
      provider: detail.provider,
      cwd: detail.cwd,
      mode: detail.mode,
      editMessageId: body.editMessageId,
      attachments: body.attachments,
      titleHint:
        detail.title === defaultTitle || detail.title === "Новый чат" || detail.title === "New chat"
          ? body.text
          : undefined,
    }).catch((err) => {
      console.error("prompt failed", err);
    });

    return { ok: true, status: "running" };
  });

  app.get("/api/sessions/:id/attachments/:fileId", async (req, reply) => {
    const { id, fileId } = req.params as { id: string; fileId: string };
    if (!/^[\w.\- ]{1,120}$/.test(fileId)) {
      return reply.code(400).send({ error: "Invalid file id" });
    }
    const detail = await getSessionDetail(id);
    if (!detail) return reply.code(404).send({ error: "Not found" });
    const cwdRoot = path.resolve(detail.cwd);

    // Attachments are read in place: the file part stores the absolute path.
    let filePath: string | null = null;
    try {
      const rows = await db
        .select({ payload: messageParts.payload })
        .from(messageParts)
        .innerJoin(messages, eq(messageParts.messageId, messages.id))
        .where(and(eq(messages.sessionId, id), eq(messageParts.type, "file")));
      const part = rows.find(
        (r) => (r.payload as { fileId?: string } | null)?.fileId === fileId,
      );
      const p = part?.payload as { path?: unknown } | null;
      if (typeof p?.path === "string" && p.path.trim()) {
        filePath = path.resolve(p.path);
      }
    } catch {
      // DB read failure — fall through to a 404
    }
    // Files were attached by the user; serve only absolute paths on this machine.
    if (!filePath || !path.isAbsolute(filePath)) {
      return reply.code(404).send({ error: "Not found" });
    }
    try {
      await fsp.access(filePath);
    } catch {
      return reply.code(404).send({ error: "Not found" });
    }
    reply.header(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(fileId)}`,
    );
    return reply.type("application/octet-stream").send(await fsp.readFile(filePath));
  });

  app.post("/api/sessions/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    await cancelPrompt(id);
    return { ok: true };
  });

  app.post("/api/sessions/:id/model", async (req, reply) => {
    const connected = await agentConnected();
    if (!connected) {
      return reply
        .code(400)
        .send({ error: errorMessage(await resolveLocale(req), "agentNotConnected") });
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
    await syncSessionAgent(id, connected);
    return setSessionModel(id, body.model, body.params);
  });

  app.post("/api/sessions/:id/mode", async (req, reply) => {
    const connected = await agentConnected();
    if (!connected) {
      return reply
        .code(400)
        .send({ error: errorMessage(await resolveLocale(req), "agentNotConnected") });
    }
    const { id } = req.params as { id: string };
    const body = z.object({ mode: z.enum(["agent", "plan", "ask"]) }).parse(req.body);
    const detail = await getSessionDetail(id);
    if (!detail) return reply.code(404).send({ error: "Not found" });
    await syncSessionAgent(id, connected);
    return setSessionMode(id, body.mode);
  });

  app.post("/api/sessions/:id/permissions/:requestId", async (req) => {
    const { id, requestId: rawRequestId } = req.params as { id: string; requestId: string };
    const body = z
      .object({
        optionId: z.string().min(1),
        requestId: z.string().min(1).optional(),
      })
      .parse(req.body);
    const requestId = body.requestId ?? decodeURIComponent(rawRequestId);
    answerPermission(id, requestId, body.optionId);
    return { ok: true };
  });

  app.post("/api/sessions/:id/answers/:requestId", async (req) => {
    const { id, requestId: rawRequestId } = req.params as { id: string; requestId: string };
    const body = z
      .object({
        result: z.record(z.unknown()),
        requestId: z.string().min(1).optional(),
      })
      .parse(req.body);
    const requestId = body.requestId ?? decodeURIComponent(rawRequestId);
    answerQuestion(id, requestId, body.result);
    return { ok: true };
  });

  app.get("/api/diagnostics", async () => listDiagnosticsDumps());
  app.get("/api/diagnostics/default-dir", async () => ({
    path: defaultDiagnosticsDir(),
  }));
  app.post("/api/diagnostics/dump", async (req) => {
    const body = z
      .object({
        reason: z.string().max(80).optional(),
        note: z.string().max(2000).optional(),
        client: z.record(z.unknown()).optional(),
      })
      .parse(req.body ?? {});
    const meta = await writeDiagnosticsDump({
      reason: body.reason,
      note: body.note,
      client: body.client as Record<string, unknown> | undefined,
    });
    return { ok: true, dump: meta };
  });
  app.get("/api/diagnostics/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const dump = await readDiagnosticsDump(id);
    if (!dump) return reply.code(404).send({ error: "Not found" });
    return dump;
  });
  app.delete("/api/diagnostics/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await deleteDiagnosticsDump(id);
    if (!ok) return reply.code(404).send({ error: "Not found" });
    return { ok: true };
  });

  app.get("/ws", { websocket: true }, async (socket) => {
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
