import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fsp from "node:fs/promises";
import path from "node:path";
import { z, ZodError } from "zod";
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
  forgetSessionSlashCommands,
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
  warmAcp,
  listUnlinkedHarnessSessions,
  importHarnessSession,
  restartSessionsForMcpChange,
  restartSessionMcp,
  resetAllAgentSessions,
} from "./acp/sessionManager.js";
import { pickDirectory } from "./services/pickDirectory.js";
import { browseDirectory } from "./services/browseDirectory.js";
import { listFolders, rememberFolders, deleteFolder } from "./services/folders.js";
import { getMcpStatus, refreshMcpStatus } from "./services/mcpStatus.js";
import { searchMessages } from "./services/search.js";
import { openPath } from "./services/openPath.js";
import {
  defaultDiagnosticsDir,
  deleteDiagnosticsDump,
  listDiagnosticsDumps,
  readDiagnosticsDump,
  writeDiagnosticsDump,
} from "./services/diagnostics.js";
import { addWsClient, subscribeClient, unsubscribeClient } from "./services/wsHub.js";
import { buildExport, defaultExportDir, saveExportToDisk } from "./services/chatExport.js";
import { isErrorCode, localeFromRequest, resolveLocale, localizeError } from "./lib/locale.js";
import { adapters } from "./adapters/registry.js";
import type { AgentProvider, AppSettings } from "@acprocess/shared";
import {
  isLoopbackHost,
  isRemoteAccessPublicPath,
  REMOTE_ACCESS_COOKIE,
  remoteAccessProtected,
  remoteKeysMatch,
} from "./lib/remoteAccess.js";

/** Content types for inline image previews of attached files (?inline=1). */
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

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
  defaultModelByProvider: z.record(z.string()).optional(),
  defaultModelParamsByProvider: z.record(z.record(z.string())).optional(),
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
  exportDir: z.string().optional(),
  resumeAgentContext: z.boolean().optional(),
  multitask: z.boolean().optional(),
  sidebarCollapse: z.enum(["full", "rail"]).optional(),
  showBootSplash: z.boolean().optional(),
  fontFamily: z.string().optional(),
  fontSize: z.string().optional(),
  lightScheme: z.string().optional(),
  darkScheme: z.string().optional(),
  lightAccent: z.string().optional(),
  lightBg: z.string().optional(),
  lightSurface: z.string().optional(),
  darkAccent: z.string().optional(),
  darkBg: z.string().optional(),
  darkSurface: z.string().optional(),
  ttsVoiceGender: z.enum(["", "female", "male"]).optional(),
  chatActions: z.array(z.string()).optional(),
  chatMetaChips: z.array(z.string()).optional(),
  thoughtsChipStyle: z.enum(["full", "icon"]).optional(),
  chatComposerButtons: z.array(z.string()).optional(),
  chatTreeElements: z.array(z.string()).optional(),
  chatTreeMenu: z.array(z.string()).optional(),
  chatTreeShowArchive: z.boolean().optional(),
  chatHeaderHeight: z.number().min(40).max(72).optional(),
  chatHeaderIcons: z.array(z.string()).optional(),
  chatEnterToSend: z.boolean().optional(),
  chatShowMessageTime: z.boolean().optional(),
  chatSplit: z.boolean().optional(),
  remoteAccessKey: z.string().max(80).optional(),
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
        insecureTls: z.boolean().optional(),
        remoteConfig: z.string().max(20_000).optional(),
        headers: z
          .array(
            z.object({
              name: z.string().max(80),
              value: z.string().max(500),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

async function sendAgentOffline(req: FastifyRequest, reply: FastifyReply) {
  return reply
    .code(400)
    .send({ error: errorMessage(await resolveLocale(req), "agentOffline") });
}

export async function registerRoutes(app: FastifyInstance) {
  // Validation failures are client errors, not server faults: turn zod
  // .parse() throws into a 400 with the first issue(s) instead of a 500.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      const message = err.issues
        .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
        .join("; ");
      return reply.code(400).send({ error: message || "Invalid request" });
    }
    const statusCode =
      err instanceof Error && "statusCode" in err && typeof err.statusCode === "number"
        ? err.statusCode
        : 500;
    return reply
      .code(statusCode)
      .send({ error: err instanceof Error ? err.message : String(err) });
  });

  app.addHook("onRequest", async (req, reply) => {
    if (isRemoteAccessPublicPath(req.url) || !remoteAccessProtected(req.url)) return;
    const expected = (await getSettings()).remoteAccessKey?.trim() ?? "";
    if (!expected) return;
    if (isLoopbackHost(typeof req.headers.host === "string" ? req.headers.host : undefined)) {
      return;
    }
    const cookie = req.cookies?.[REMOTE_ACCESS_COOKIE];
    const headerRaw = req.headers["x-acp-remote-key"];
    const header = typeof headerRaw === "string" ? headerRaw : "";
    if (remoteKeysMatch(cookie, expected) || remoteKeysMatch(header, expected)) return;
    return reply.code(401).send({ error: "remote_key_required", code: "remote_key_required" });
  });

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/remote-access", async (req) => {
    const expected = (await getSettings()).remoteAccessKey?.trim() ?? "";
    const loopback = isLoopbackHost(typeof req.headers.host === "string" ? req.headers.host : undefined);
    const cookie = req.cookies?.[REMOTE_ACCESS_COOKIE];
    const unlocked = !expected || loopback || remoteKeysMatch(cookie, expected);
    return { required: Boolean(expected) && !loopback, unlocked };
  });

  app.post("/api/remote-access", async (req, reply) => {
    const body = z.object({ key: z.string().max(80) }).parse(req.body ?? {});
    const expected = (await getSettings()).remoteAccessKey?.trim() ?? "";
    if (!expected) {
      return { ok: true, required: false };
    }
    if (!remoteKeysMatch(body.key.trim(), expected)) {
      return reply.code(401).send({ error: "remote_key_required", code: "remote_key_invalid" });
    }
    reply.setCookie(REMOTE_ACCESS_COOKIE, expected, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30,
    });
    return { ok: true, required: true };
  });

  app.get("/api/export/default-dir", async () => ({ path: defaultExportDir() }));

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

  // Registered harness adapters — drives the web's provider list and forms.
  app.get("/api/adapters", async () => {
    return adapters.list().map((a) => ({
      id: a.id,
      label: a.label,
      descriptionKey: a.descriptionKey,
      commandField: a.commandField,
      argsField: a.argsField,
      apiKeyField: a.apiKeyField,
      envApiKeyName: a.envApiKeyName,
      defaultCommand: a.defaultCommand,
      defaultArgs: a.defaultArgs,
      installHint: a.installHint,
      restoreMode: a.restoreMode,
      parameterizedModelPicker: a.parameterizedModelPicker,
      subagentStreaming: a.subagentStreaming,
      cloudCatalog: a.cloudCatalog,
      defaultModes: a.defaultModes,
      subagentToolKinds: [...a.subagentToolKinds],
    }));
  });

  app.post("/api/agent/probe", async (req) => {
    const body = z
      .object({ provider: z.enum(adapters.ids() as [string, ...string[]]).optional() })
      .parse(req.body ?? {});
    return probeAgent(body.provider, { catalogOnly: true });
  });

  app.get("/api/agent/models", async (req) => {
    const q = req.query as { provider?: string; force?: string };
    const provider = adapters.ids().includes(q.provider ?? "") ? q.provider : undefined;
    const force = q.force === "1" || q.force === "true";
    return listModels(provider, { force });
  });

  app.get("/api/agent/status", async () => {
    const settings = await getSettings();
    const availability: Record<string, boolean> = {};
    for (const id of adapters.ids()) {
      availability[id] = getAgentAvailability(id);
    }
    const online = adapters.ids().find((id) => availability[id]);
    const provider = online ?? settings.connectedProvider ?? null;
    return {
      provider,
      available: provider ? Boolean(availability[provider]) : false,
      availability,
    };
  });

  app.get("/api/agent/model-params", async (req, reply) => {
    const q = req.query as { provider?: string; model?: string; sessionId?: string; force?: string };
    const provider = adapters.ids().includes(q.provider ?? "") ? q.provider : undefined;
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
      .object({ provider: z.enum(adapters.ids() as [string, ...string[]]).optional() })
      .parse(req.body ?? {});
    warmModelParamsProbe(body.provider);
    return { ok: true };
  });

  app.post("/api/agent/reset", async () => {
    resetAllAgentSessions();
    return { ok: true };
  });

  app.get("/api/mcp/status", async () => getMcpStatus());

  app.get("/api/search", async (req) => {
    const q = (req.query as { q?: unknown }).q;
    const rawLimit = Number((req.query as { limit?: unknown }).limit ?? 50);
    const needle = typeof q === "string" ? q : "";
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100)
      : 50;
    return searchMessages(needle, limit);
  });

  app.get("/api/settings", async () => getSettings());
  app.put("/api/settings", async (req) => {
    const patch = settingsSchema.parse(req.body);
    const current = await getSettings();
    if (patch.defaultProvider && patch.defaultProvider !== current.defaultProvider) {
      clearModelsCache();
    }
    if (patch.mcpServers) {
      // The agent protocol snapshots MCP servers at session/new — restart live
      // sessions so a disabled/edited server stops being visible in the chat.
      void restartSessionsForMcpChange();
      // Warm the status cache so the indicator reflects the new list quickly.
      void refreshMcpStatus();
    }
    return updateSettings(patch as Partial<AppSettings>);
  });

  app.get("/api/sessions", async () => listSessions());

  // Folders that have ever held chats (empty ones included) — survives
  // deleting the last chat so folders persist across devices.
  app.get("/api/folders", async () => ({ folders: await listFolders() }));

  app.put("/api/folders", async (req) => {
    const body = z.object({ cwds: z.array(z.string().min(1)).max(200) }).parse(req.body);
    await rememberFolders(body.cwds);
    return { ok: true };
  });

  app.delete("/api/folders", async (req) => {
    const query = z.object({ cwd: z.string().min(1) }).parse(req.query);
    const normalized = query.cwd.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    // Tear down live agents of the chats inside before deleting their rows.
    for (const s of await listSessions()) {
      if (s.cwd === normalized) {
        disposeRuntime(s.id);
        forgetSessionSlashCommands(s.id);
      }
    }
    await deleteFolder(query.cwd);
    return { ok: true, folders: await listFolders() };
  });

  app.get("/api/sessions/harness", async (req, reply) => {
    const query = z
      .object({
        provider: z.enum(["cursor", "omp"]),
        cwd: z.string().max(4096).optional(),
      })
      .parse(req.query ?? {});
    return listUnlinkedHarnessSessions(query.provider, query.cwd);
  });

  app.post("/api/sessions/import", async (req, reply) => {
    const body = z
      .object({
        provider: z.enum(["cursor", "omp"]),
        acpSessionId: z.string().min(1).max(200),
        cwd: z.string().max(4096).optional(),
        title: z.string().max(500).optional(),
      })
      .parse(req.body ?? {});
    try {
      return await importHarnessSession(body);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 409) {
        return reply.code(409).send({ error: "alreadyInTree" });
      }
      throw err;
    }
  });

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
        mcpDisabledIds: z.array(z.string().min(1).max(64)).optional(),
      })
      .parse(req.body ?? {});
    const updated = await updateSession(id, body);
    if (!updated) return reply.code(404).send({ error: "Not found" });
    // A chat-level MCP change needs a fresh agent attach, same as a global one.
    if (body.mcpDisabledIds) void restartSessionMcp(id);
    return updated;
  });

  app.post("/api/sessions", async (req, reply) => {
    const body = z
      .object({
        title: z.string().optional(),
        provider: z.enum(["cursor", "omp"]).optional(),
        cwd: z.string().optional(),
        mode: z.enum(["agent", "plan", "ask"]).optional(),
        themeId: z.string().uuid().nullable().optional(),
        model: z.string().max(200).optional(),
      })
      .parse(req.body ?? {});
    const settings = await getSettings();
    const cwd = body.cwd ?? settings.defaultCwd ?? process.cwd();
    const provider = body.provider ?? settings.connectedProvider ?? settings.defaultProvider;
    if (!getAgentAvailability(provider)) {
      return sendAgentOffline(req, reply);
    }
    const session = await createSession({
      title: body.title,
      provider,
      cwd,
      mode: body.mode ?? settings.defaultMode,
      themeId: body.themeId,
      model: body.model,
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
    const detail = await getSessionDetail(id);
    if (!detail) return reply.code(404).send({ error: "Not found" });
    if (getAgentAvailability(detail.provider)) {
      void warmAcp(id, {
        provider: detail.provider,
        cwd: detail.cwd,
        mode: detail.mode,
      });
    }
    return { ...detail, slashCommands: getSessionSlashCommands(id) };
  });

  /** Download the conversation as Markdown or JSON (?format=md|json). */
  app.get("/api/sessions/:id/export", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { format?: string };
    const format = q.format === "json" ? "json" : "md";
    const built = await buildExport(id, format);
    if (!built) return reply.code(404).send({ error: "Not found" });
    reply.header(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(built.fileName)}`,
    );
    return reply
      .type(format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8")
      .header("Cache-Control", "no-store")
      .send(built.content);
  });

  /** Save the export as a file on the server machine (default: <repo>/exports). */
  app.post("/api/sessions/:id/export", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        format: z.enum(["md", "json"]).default("md"),
        dir: z.string().max(4096).optional(),
      })
      .parse(req.body ?? {});
    try {
      const saved = await saveExportToDisk(id, body.format, body.dir);
      return { ok: true, ...saved };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(err instanceof Error && err.message === "Session not found" ? 404 : 500).send({ error: message });
    }
  });

  app.delete("/api/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    disposeRuntime(id);
    forgetSessionSlashCommands(id);
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
    const detail = await getSessionDetail(id);
    if (!detail) return reply.code(404).send({ error: "Not found" });
    if (!getAgentAvailability(detail.provider)) {
      return sendAgentOffline(req, reply);
    }

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
    // \w is ASCII-only — fileIds from real filenames may contain Cyrillic etc.
    if (!/^[\p{L}\p{N}_.\- ]{1,120}$/u.test(fileId)) {
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
    // ?inline=1 lets <img> previews render in the browser: serve known image
    // types with their real content-type and no attachment disposition.
    // Restricted to images only — inlining arbitrary HTML/JS would run in our
    // origin; SVG is safe here because scripts do not execute in <img>.
    const q = req.query as { inline?: string };
    const inline = q.inline === "1";
    const ext = path.extname(fileId).slice(1).toLowerCase();
    const imageMime = IMAGE_MIME[ext];
    if (inline && imageMime) {
      return reply.type(imageMime).send(await fsp.readFile(filePath));
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
    const { id } = req.params as { id: string };
    const body = z
      .object({
        model: z.string().min(1),
        params: z.record(z.string()).optional(),
      })
      .parse(req.body);
    const detail = await getSessionDetail(id);
    if (!detail) return reply.code(404).send({ error: "Not found" });
    if (!getAgentAvailability(detail.provider)) {
      return sendAgentOffline(req, reply);
    }
    return setSessionModel(id, body.model, body.params);
  });

  app.post("/api/sessions/:id/mode", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ mode: z.enum(["agent", "plan", "ask"]) }).parse(req.body);
    const detail = await getSessionDetail(id);
    if (!detail) return reply.code(404).send({ error: "Not found" });
    if (!getAgentAvailability(detail.provider)) {
      return sendAgentOffline(req, reply);
    }
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
