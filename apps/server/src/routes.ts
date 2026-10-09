import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fsp from "node:fs/promises";
import path from "node:path";
import { z, ZodError } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "./db/client.js";
import { messages, messageParts, sessions } from "./db/schema.js";
import { defaultSessionTitle, errorMessage } from "@acpio/i18n";
import { CONSOLE_TERMINAL_LIMITS, CUSTOM_AGENT_MAX, BUILTIN_MAX_OUTPUT_TOKENS_MAX, BUILTIN_TURN_RETRY_ATTEMPTS_MIN, BUILTIN_TURN_RETRY_ATTEMPTS_MAX, BUILTIN_THINKING_LIMIT_MAX, BUILTIN_COMPACTION_THRESHOLD_PERCENT_MIN, BUILTIN_COMPACTION_THRESHOLD_PERCENT_MAX, BUILTIN_KEEP_RECENT_PERCENT_MIN, BUILTIN_KEEP_RECENT_PERCENT_MAX, BUILTIN_MAX_SUMMARY_TOKENS_MAX, BUILTIN_PRUNE_TOOL_RESULTS_KEEP_LAST_MAX, isShellSession, canonicalCwd, normalizeBuiltinSubagents, SHELL_SESSION_PROVIDER, titleFromTaskDescription, titleFromUserText, titleFromSlashCommand } from "@acpio/shared";
import { forgetMcpFolderConfig, getSettings, updateSettings } from "./services/settings.js";
import {
  addTaskAttachments,
  createSession,
  deleteSession,
  getSessionCwd,
  getSessionDetail,
  listBoardSessions,
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
  restartSessionsForBuiltinChange,
  restartSessionMcp,
  resetAllAgentSessions,
  replayPendingInteractive,
  getLiveTurnState,
} from "./acp/sessionManager.js";
import { pickDirectory } from "./services/pickDirectory.js";
import { fetchBuiltinModelCatalog } from "./services/builtinModelCatalog.js";
import { browseDirectory } from "./services/browseDirectory.js";
import {
  MAX_ATTACH_UPLOAD_BYTES,
  stageAcpioUpload,
  stageSessionUpload,
} from "./services/attachmentUpload.js";
import {
  listFolders,
  listFolderTags,
  rememberFolders,
  setFolderTag,
  deleteFolder,
  reorderFolders,
} from "./services/folders.js";
import {
  boardAcceptsCwd,
  createBoard,
  deleteBoard,
  deleteBoardSessions,
  listBoards,
  setBoardFolderAutoRun,
  setBoardFolderTag,
  setBoardFolders,
  updateBoard,
} from "./services/boards.js";
import { getMcpStatus, refreshMcpStatus } from "./services/mcpStatus.js";
import { discoverProjectMcp } from "./services/projectMcp.js";
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
import {
  attachUserConsole,
  reconcileUserConsolesShell,
  releaseUserConsole,
  resetUserConsole,
  resizeUserConsole,
  reviveUserConsole,
  writeUserConsole,
} from "./services/userConsole.js";
import {
  MAX_GIT_PATHS,
  addGitIgnoreEntries,
  applyGitCommitAction,
  checkoutGitBranch,
  checkoutGitRevision,
  commitGit,
  createGitBranchAt,
  createGitTagAt,
  deleteGitBranch,
  deleteGitFiles,
  discardGitChanges,
  getGitBlame,
  getGitCommitDetail,
  getGitDiff,
  getGitFileLines,
  getGitLog,
  getGitShow,
  getGitStatus,
  mergeGitBranch,
  renameGitBranch,
  setGitStage,
  stashGit,
  syncGit,
} from "./services/git.js";
import { buildChatsExport, buildExport, defaultExportDir, saveChatsExportToDisk, saveExportToDisk } from "./services/chatExport.js";
import { isErrorCode, localeFromRequest, resolveLocale, localizeError, serverT } from "./lib/locale.js";
import { adapters } from "./adapters/registry.js";
import type { AgentProvider, AppSettings } from "@acpio/shared";
import {
  isLoopbackClient,
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

const mcpServerSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  enabled: z.boolean(),
  type: z.enum(["local", "remote", "stdio"]),
  command: z.string().max(300).optional(),
  args: z.array(z.string().max(300)).optional(),
  env: z
    .array(
      z.object({
        name: z.string().max(80),
        value: z.string().max(2000),
      }),
    )
    .optional(),
  envConfig: z.string().max(20_000).optional(),
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
});

const settingsSchema = z.object({
  theme: z.enum(["light", "dark"]).optional(),
  locale: z.enum(["ru", "en"]).optional(),
  displayName: z.string().max(80).optional(),
  // Provider ids are validated by the registry merge (unknown → healed), so a
  // patch may add an agent and point at it in the same request.
  connectedProvider: z.string().max(64).nullable().optional(),
  defaultProvider: z.string().max(64).optional(),
  disabledProviders: z.array(z.string().max(64)).optional(),
  customAgents: z.array(z.unknown()).max(CUSTOM_AGENT_MAX * 2).optional(),
  defaultMode: z.enum(["agent", "plan", "ask"]).optional(),
  defaultCwd: z.string().optional(),
  defaultModel: z.string().optional(),
  defaultModelParams: z.record(z.string()).optional(),
  defaultModelByProvider: z.record(z.string()).optional(),
  defaultModelParamsByProvider: z.record(z.record(z.string())).optional(),
  modelParamsByProviderModel: z.record(z.record(z.record(z.string()))).optional(),
  recentModelsByProvider: z.record(z.array(z.string())).optional(),
  favoriteModelsByProvider: z.record(z.array(z.string())).optional(),
  cursorCommand: z.string().optional(),
  cursorArgs: z.array(z.string()).optional(),
  ompCommand: z.string().optional(),
  ompArgs: z.array(z.string()).optional(),
  cursorApiKey: z.string().optional(),
  anthropicApiKey: z.string().optional(),
  openaiApiKey: z.string().optional(),
  builtinProviders: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        name: z.string().max(120).optional(),
        url: z.string().max(500).optional(),
        apiKey: z.string().max(500).optional(),
        enabled: z.boolean().optional(),
        models: z
          .array(
            z.object({
              id: z.string().min(1).max(200),
              label: z.string().max(120).optional(),
              contextWindow: z.number().int().min(1).max(10_000_000).optional(),
              enabled: z.boolean().optional(),
              contextWindowEdited: z.boolean().optional(),
            }),
          )
          .max(1000)
          .optional(),
        headers: z
          .array(
            z.object({
              name: z.string().max(200),
              value: z.string().max(2000),
            }),
          )
          .max(50)
          .optional(),
      }),
    )
    .max(50)
    .optional(),
  builtinMaxOutputTokens: z.number().int().min(0).max(BUILTIN_MAX_OUTPUT_TOKENS_MAX).optional(),
  builtinTurnRetryAttempts: z
    .number()
    .int()
    .min(BUILTIN_TURN_RETRY_ATTEMPTS_MIN)
    .max(BUILTIN_TURN_RETRY_ATTEMPTS_MAX)
    .optional(),
  builtinThinkingLimit: z
    .number()
    .int()
    .min(0)
    .max(BUILTIN_THINKING_LIMIT_MAX)
    .optional(),
  builtinContextMode: z.enum(["off", "prune", "summary"]).optional(),
  builtinCompactionThresholdPercent: z
    .number()
    .int()
    .min(BUILTIN_COMPACTION_THRESHOLD_PERCENT_MIN)
    .max(BUILTIN_COMPACTION_THRESHOLD_PERCENT_MAX)
    .optional(),
  builtinKeepRecentPercent: z
    .number()
    .int()
    .min(BUILTIN_KEEP_RECENT_PERCENT_MIN)
    .max(BUILTIN_KEEP_RECENT_PERCENT_MAX)
    .optional(),
  builtinMaxSummaryTokens: z.number().int().min(0).max(BUILTIN_MAX_SUMMARY_TOKENS_MAX).optional(),
  builtinPruneToolResultsKeepLast: z
    .number()
    .int()
    .min(0)
    .max(BUILTIN_PRUNE_TOOL_RESULTS_KEEP_LAST_MAX)
    .optional(),
  builtinPruneReasoning: z.enum(["keep", "before-last-message", "drop"]).optional(),
  builtinRespectReasoningHistory: z.boolean().optional(),
  builtinOffloadToolResultTokens: z
    .number()
    .int()
    .min(0)
    .max(BUILTIN_MAX_SUMMARY_TOKENS_MAX)
    .optional(),
  permissionPolicy: z.enum(["prompt", "allowlist", "always"]).optional(),
  permissionAllowlist: z.array(z.string()).optional(),
  diagnosticsDir: z.string().optional(),
  diagnosticsDeepLogging: z.boolean().optional(),
  exportDir: z.string().optional(),
  resumeAgentContext: z.boolean().optional(),
  resumeInterruptedTurns: z.boolean().optional(),
  multitask: z.boolean().optional(),
  sidebarCollapse: z.enum(["full", "rail"]).optional(),
  boardAddCardStyle: z.enum(["card", "compact", "hidden"]).optional(),
  boardTaskAgentPicker: z.boolean().optional(),
  boardShowFirstMessage: z.boolean().optional(),
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
  consoleChipStyle: z.enum(["full", "icon"]).optional(),
  terminalShell: z.enum(["cmd", "powershell"]).optional(),
  chatComposerButtons: z.array(z.string()).optional(),
  attachDefaultSource: z.enum(["device", "server"]).optional(),
  chatTreeElements: z.array(z.string()).optional(),
  chatTreeMenu: z.array(z.string()).optional(),
  chatTreeShowArchive: z.boolean().optional(),
  chatTreeRecentLimit: z.number().int().min(0).max(200).optional(),
  chatHeaderHeight: z.number().min(40).max(72).optional(),
  chatHeaderIcons: z.array(z.string()).optional(),
  chatEnterToSend: z.boolean().optional(),
  chatShowMessageTime: z.boolean().optional(),
  chatAgentTurnTimeline: z.boolean().optional(),
  chatGitBranchPosition: z.enum(["below", "above"]).optional(),
  chatChipOptions: z
    .object({
      folder: z
        .object({ compress: z.boolean(), truncate: z.enum(["middle", "end"]) })
        .partial()
        .optional(),
      gitBranch: z.object({ compress: z.boolean() }).partial().optional(),
      gitChanges: z
        .object({
          compress: z.boolean(),
          metrics: z.enum(["none", "lines", "files", "linesAndFiles"]),
        })
        .partial()
        .optional(),
      context: z.object({ format: z.enum(["usage", "percent"]) }).partial().optional(),
    })
    .optional(),
  chatSplit: z.boolean().optional(),
  chatAutoTitle: z.boolean().optional(),
  chatTitleModel: z.string().max(200).optional(),
  chatToolbarStyle: z.enum(["classic", "minimal"]).optional(),
  remoteAccessKey: z.string().max(80).optional(),
  composerDrafts: z.record(z.string().max(20_000)).optional(),
  mcpServers: z.array(mcpServerSchema).max(100).optional(),
  mcpFolderConfigs: z
    .record(
      z.string().max(4096),
      z.object({
        /**
         * Explicit per-server switch for this folder: `true` attaches a server
         * here even when it is off globally, `false` switches it off here.
         * Absent ids inherit the server's own `enabled` flag.
         */
        overrides: z.record(z.string().min(1), z.boolean()),
        servers: z.array(mcpServerSchema).max(100),
      }),
    )
    .optional(),
  mcpProjectFiles: z.array(z.string().min(1).max(512)).max(50).optional(),
  builtinSkillPaths: z.array(z.string().min(1).max(512)).max(50).optional(),
  builtinSubagents: z
    .object({
      enabled: z.boolean().optional(),
      allowAdhoc: z.boolean().optional(),
      model: z.string().max(200).optional(),
      agents: z
        .array(
          z.object({
            id: z.string().min(1).max(64),
            name: z.string().min(1).max(80),
            description: z.string().max(500).optional(),
            systemPrompt: z.string().max(8000).optional(),
            tools: z.array(z.enum(["read", "glob", "grep", "write", "edit", "bash"])).max(6).optional(),
            maxTurns: z.number().int().optional(),
          }),
        )
        .max(20)
        .optional(),
    })
    .optional(),
  builtinAllowOutsideCwd: z.boolean().optional(),
});

/** Registered provider id (built-ins + custom agents). Sessions may only
 *  reference an agent that exists in the registry right now. */
const registeredProviderSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((id) => adapters.ids().includes(id), { message: "unknownAgent" });

async function sendAgentOffline(req: FastifyRequest, reply: FastifyReply) {
  return reply
    .code(400)
    .send({ error: errorMessage(await resolveLocale(req), "agentOffline") });
}

/** A repeated header arrives as an array — take the first value. */
function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

/** File names ride percent-encoded (they may be Cyrillic: «Снимок экрана.png»). */
function decodeHeaderFileName(value: string | string[] | undefined): string {
  const raw = headerValue(value);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function registerRoutes(app: FastifyInstance) {
  // Attachment uploads post raw bytes (see /attachments/upload), so the body
  // arrives as a Buffer rather than JSON; the limit matches the service's cap.
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: MAX_ATTACH_UPLOAD_BYTES },
    (_req, body, done) => done(null, body),
  );

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
    if (isLoopbackClient(req)) {
      return;
    }
    const cookie = req.cookies?.[REMOTE_ACCESS_COOKIE];
    const headerRaw = req.headers["x-acp-remote-key"];
    const header = typeof headerRaw === "string" ? headerRaw : "";
    if (remoteKeysMatch(cookie, expected) || remoteKeysMatch(header, expected)) return;
    return reply.code(401).send({ error: "remote_key_required", code: "remote_key_required" });
  });

  app.get("/api/health", async () => ({ ok: true, platform: process.platform }));

  app.get("/api/remote-access", async (req) => {
    const expected = (await getSettings()).remoteAccessKey?.trim() ?? "";
    const loopback = isLoopbackClient(req);
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
      return await browseDirectory(rawPath, { includeFiles: q.files === "1" });
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
      return await browseDirectory(body.path, { includeFiles: body.files === true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/api/fs/open", async (req, reply) => {
    const body = z.object({ path: z.string().min(1).max(4096) }).parse(req.body ?? {});
    const result = await openPath(body.path);
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
  // Disabled harnesses are still listed (Settings → Connect manages them) but
  // flagged so the web hides them everywhere else.
  app.get("/api/adapters", async () => {
    const settings = await getSettings();
    const disabled = new Set(settings.disabledProviders ?? []);
    return adapters.list().map((a) => ({
      id: a.id,
      label: a.label,
      enabled: !disabled.has(a.id),
      descriptionKey: a.descriptionKey,
      description: a.description,
      custom: a.custom === true,
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
      midTurnSteering: a.midTurnSteering === true,
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

  /**
   * Models one provider's endpoint advertises (`GET /models`). The body
   * carries the form's URL/key so the list can be fetched before Save; with
   * nothing in the body the first configured provider is the fallback.
   */
  app.post("/api/agent/builtin/models", async (req) => {
    const body = z
      .object({
        url: z.string().max(500).optional(),
        apiKey: z.string().max(500).optional(),
        headers: z
          .array(
            z.object({
              name: z.string().max(200),
              value: z.string().max(2000),
            }),
          )
          .max(50)
          .optional(),
      })
      .parse(req.body ?? {});
    const settings = await getSettings();
    const fallback = settings.builtinProviders[0];
    const url = body.url !== undefined ? body.url : (fallback?.url ?? "");
    const apiKey = body.apiKey !== undefined ? body.apiKey : (fallback?.apiKey ?? "");
    const headers = body.headers !== undefined ? body.headers : fallback?.headers;
    const result = await fetchBuiltinModelCatalog(url, apiKey, { headers });
    if (result.ok) return result;
    const t = serverT(await resolveLocale(req));
    return {
      ok: false,
      models: [],
      error: t(`builtinCatalog.${result.code}`, {
        detail: result.detail ?? "",
        status: result.detail ?? "",
      }),
    };
  });

  app.get("/api/agent/status", async () => {
    const settings = await getSettings();
    const disabled = new Set(settings.disabledProviders);
    const ids = adapters.ids().filter((id) => !disabled.has(id));
    const availability: Record<string, boolean> = {};
    for (const id of ids) {
      availability[id] = getAgentAvailability(id);
    }
    const online = ids.find((id) => availability[id]);
    const provider =
      online ??
      (settings.connectedProvider && ids.includes(settings.connectedProvider)
        ? settings.connectedProvider
        : null);
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

  // Servers found in each folder's own MCP files, keyed by canonical cwd. The
  // web reads this to show what a folder brings in and to size the MCP chip.
  app.get("/api/mcp/project", async (req) => {
    const query = z.object({ cwd: z.string().max(4096).optional() }).parse(req.query ?? {});
    const settings = await getSettings();
    const folders = new Set(await listFolders());
    if (query.cwd?.trim()) folders.add(query.cwd);
    const entries = await Promise.all(
      [...folders].map(
        async (folder) =>
          [
            canonicalCwd(folder),
            await discoverProjectMcp(folder, settings.mcpProjectFiles),
          ] as const,
      ),
    );
    return { folders: Object.fromEntries(entries.filter(([key]) => key)) };
  });

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
    const next = await updateSettings(patch as Partial<AppSettings>);
    if (patch.mcpServers || patch.mcpFolderConfigs || patch.mcpProjectFiles) {
      // The agent protocol snapshots MCP servers at session/new — restart live
      // sessions so a disabled/edited server stops being visible in the chat.
      // Fires only AFTER the write: the sweep re-reads settings, and the driver
      // runs that read synchronously, so firing before the write made the sweep
      // always see the pre-edit list and skip every restart.
      void restartSessionsForMcpChange();
      // Warm the status cache so the indicator reflects the new list quickly.
      void refreshMcpStatus();
    }
    if (
      patch.builtinProviders !== undefined &&
      JSON.stringify(patch.builtinProviders) !== JSON.stringify(current.builtinProviders)
    ) {
      // The transport reads providers per turn, but a live chat may be pinned
      // to a model the edit removed — restart live built-in chats so the new
      // endpoints/model list apply immediately.
      void restartSessionsForBuiltinChange();
    }
    if (
      patch.builtinSkillPaths !== undefined &&
      JSON.stringify(patch.builtinSkillPaths) !== JSON.stringify(current.builtinSkillPaths)
    ) {
      // Skills are discovered from the settings snapshot the transport holds,
      // so a path edit needs the same restart as an endpoint edit.
      void restartSessionsForBuiltinChange();
    }
    if (
      patch.builtinSubagents !== undefined &&
      JSON.stringify(normalizeBuiltinSubagents(patch.builtinSubagents)) !==
        JSON.stringify(current.builtinSubagents)
    ) {
      // The subagent roster and the feature flag are read from the settings
      // snapshot the transport holds — restart live built-in chats so an
      // edited roster (or a toggled feature) applies on the next turn.
      // Both sides are compared normalized so client key order cannot force
      // a spurious restart.
      void restartSessionsForBuiltinChange();
    }
    if (patch.terminalShell && patch.terminalShell !== current.terminalShell) {
      void reconcileUserConsolesShell();
    }
    return next;
  });

  app.get("/api/sessions", async (req) => {
    const query = z.object({ boardId: z.string().max(64).optional() }).parse(req.query ?? {});
    if (query.boardId) return listBoardSessions(query.boardId);
    return listSessions();
  });

  // Folders that have ever held chats (empty ones included) — survives
  // deleting the last chat so folders persist across devices. `tags` holds
  // each folder's optional one-line note, keyed by canonical cwd.
  app.get("/api/folders", async () => ({
    folders: await listFolders(),
    tags: await listFolderTags(),
  }));

  app.put("/api/folders", async (req) => {
    const body = z.object({ cwds: z.array(z.string().min(1)).max(200) }).parse(req.body);
    await rememberFolders(body.cwds);
    return { ok: true };
  });

  // Set (or clear with an empty string) a folder's one-line tag.
  app.put("/api/folders/tag", async (req) => {
    const body = z
      .object({ cwd: z.string().min(1).max(4096), tag: z.string().max(80) })
      .parse(req.body);
    const tags = await setFolderTag(body.cwd, body.tag);
    return { ok: true, tags };
  });

  app.put("/api/folders/reorder", async (req) => {
    const body = z
      .object({
        items: z.array(
          z.object({
            cwd: z.string(),
            sortOrder: z.number().int(),
          }),
        ),
      })
      .parse(req.body);
    const folders = await reorderFolders(body.items);
    return { ok: true, folders };
  });

  app.delete("/api/folders", async (req) => {
    const query = z.object({ cwd: z.string().min(1) }).parse(req.query);
    const normalized = canonicalCwd(query.cwd);
    // Tear down live agents of the chats inside before deleting their rows.
    for (const s of await listSessions()) {
      if (s.cwd === normalized) {
        disposeRuntime(s.id);
        forgetSessionSlashCommands(s.id);
      }
    }
    await deleteFolder(query.cwd);
    await forgetMcpFolderConfig(normalized);
    return { ok: true, folders: await listFolders() };
  });

  // Kanban boards — isolated workspaces: own folders, own tasks.
  app.get("/api/boards", async () => listBoards());
  app.post("/api/boards", async (req) => {
    const body = z.object({ name: z.string().min(1).max(80) }).parse(req.body ?? {});
    return createBoard(body.name);
  });
  app.patch("/api/boards/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        name: z.string().min(1).max(80).optional(),
        sortOrder: z.number().int().optional(),
      })
      .parse(req.body ?? {});
    const updated = await updateBoard(id, body);
    if (!updated) return reply.code(404).send({ error: "Not found" });
    return updated;
  });
  app.put("/api/boards/:id/folders", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({ cwds: z.array(z.string().min(1).max(4096)).max(200) })
      .parse(req.body ?? {});
    const folders = await setBoardFolders(id, body.cwds);
    if (folders === null) return reply.code(404).send({ error: "Not found" });
    return { ok: true, folders };
  });
  // Set (or clear with an empty string) a board folder's one-line tag.
  app.put("/api/boards/:id/folders/tag", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({ cwd: z.string().min(1).max(4096), tag: z.string().max(80) })
      .parse(req.body ?? {});
    const folderTags = await setBoardFolderTag(id, body.cwd, body.tag);
    if (folderTags === null) return reply.code(404).send({ error: "Not found" });
    return { ok: true, folderTags };
  });
  // Switch a board folder's task queue on or off (tasks run one after another).
  app.put("/api/boards/:id/folders/auto-run", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({ cwd: z.string().min(1).max(4096), autoRun: z.boolean() })
      .parse(req.body ?? {});
    const folderAutoRun = await setBoardFolderAutoRun(id, body.cwd, body.autoRun);
    if (folderAutoRun === null) return reply.code(404).send({ error: "Not found" });
    return { ok: true, folderAutoRun };
  });
  app.delete("/api/boards/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    // Tear down live agents of the board's tasks before deleting their rows.
    const tasks = await listBoardSessions(id);
    for (const s of tasks) {
      disposeRuntime(s.id);
      forgetSessionSlashCommands(s.id);
    }
    if (tasks.length > 0) await deleteBoardSessions(id);
    const ok = await deleteBoard(id);
    if (!ok) return reply.code(404).send({ error: "Not found" });
    return { ok: true, boards: await listBoards() };
  });

  app.get("/api/sessions/harness", async (req, reply) => {
    const query = z
      .object({
        provider: registeredProviderSchema,
        cwd: z.string().max(4096).optional(),
      })
      .parse(req.query ?? {});
    return listUnlinkedHarnessSessions(query.provider, query.cwd);
  });

  app.post("/api/sessions/import", async (req, reply) => {
    const body = z
      .object({
        provider: registeredProviderSchema,
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
        taskDescription: z.string().max(20000).nullable().optional(),
        doneAt: z.string().datetime().nullable().optional(),
        /** Pre-start only: a task picks its agent before the first turn. */
        provider: registeredProviderSchema.optional(),
      })
      .parse(req.body ?? {});
    if (body.provider) {
      const rows = await db
        .select({ acpSessionId: sessions.acpSessionId })
        .from(sessions)
        .where(eq(sessions.id, id))
        .limit(1);
      if (!rows[0]) return reply.code(404).send({ error: "Not found" });
      if (rows[0].acpSessionId) return reply.code(400).send({ error: "alreadyStarted" });
    }
    const { doneAt, provider, ...rest } = body;
    const updated = await updateSession(id, {
      ...rest,
      ...(provider ? { provider } : {}),
      ...(doneAt !== undefined ? { doneAt: doneAt === null ? null : new Date(doneAt) } : {}),
    });
    if (!updated) return reply.code(404).send({ error: "Not found" });
    // A chat-level MCP change needs a fresh agent attach, same as a global one.
    if (body.mcpDisabledIds) void restartSessionMcp(id);
    return updated;
  });

  app.post("/api/sessions", async (req, reply) => {
    const body = z
      .object({
        /** Optimistic UI creates the row client-side first, then posts it here. */
        id: z.string().uuid().optional(),
        title: z.string().optional(),
        provider: z.string().min(1).max(64).optional(),
        cwd: z.string().optional(),
        mode: z.enum(["agent", "plan", "ask"]).optional(),
        themeId: z.string().uuid().nullable().optional(),
        model: z.string().max(200).optional(),
        /** Board task: partition id + description; created without a live turn. */
        boardId: z.string().uuid().optional(),
        taskDescription: z.string().max(20000).optional(),
      })
      .parse(req.body ?? {});
    const settings = await getSettings();
    const cwd = body.cwd ?? settings.defaultCwd ?? process.cwd();
    const provider = body.provider ?? settings.connectedProvider ?? settings.defaultProvider;
    if (!isShellSession(provider) && !adapters.get(provider)) {
      return reply.code(400).send({ error: "unknownAgent" });
    }
    if (body.boardId) {
      if (isShellSession(provider)) {
        return reply.code(400).send({ error: "boardTaskNeedsAgent" });
      }
      if (!(await boardAcceptsCwd(body.boardId, cwd))) {
        return reply.code(400).send({ error: "unknownBoardFolder" });
      }
    } else if (
      !isShellSession(provider) &&
      (settings.disabledProviders.includes(provider) || !getAgentAvailability(provider))
    ) {
      return sendAgentOffline(req, reply);
    }
    const session = await createSession({
      id: body.id,
      title: body.title,
      provider,
      cwd,
      mode: body.mode ?? settings.defaultMode,
      themeId: body.themeId,
      model: body.model,
      boardId: body.boardId ?? null,
      taskDescription: body.taskDescription ?? null,
    });
    // Board tasks must not boot an agent: the start action may pick another one.
    if (!body.boardId && !isShellSession(session.provider)) {
      void warmAcp(session.id, {
        provider: session.provider,
        cwd: session.cwd,
        mode: session.mode,
      });
    }
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
    if (!isShellSession(detail.provider) && getAgentAvailability(detail.provider)) {
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

  /**
   * Download every chat of one provider (?provider=builtin, the default) as a
   * single JSON bundle — the artifact users attach when reporting on an agent.
   */
  app.get("/api/export/chats", async (req, reply) => {
    const q = req.query as { provider?: string };
    const provider = (q.provider ?? "builtin").trim() || "builtin";
    const built = await buildChatsExport(provider);
    reply.header(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(built.fileName)}`,
    );
    return reply
      .type("application/json; charset=utf-8")
      .header("Cache-Control", "no-store")
      .send(built.content);
  });

  /** Save the bundle on the server machine (same dir as single-chat exports). */
  app.post("/api/export/chats", async (req, reply) => {
    const body = z
      .object({
        provider: z.string().max(64).default("builtin"),
        dir: z.string().max(4096).optional(),
      })
      .parse(req.body ?? {});
    try {
      const saved = await saveChatsExportToDisk(body.provider, body.dir);
      return { ok: true, ...saved };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: message });
    }
  });

  app.delete("/api/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    disposeRuntime(id);
    forgetSessionSlashCommands(id);
    releaseUserConsole(id);
    const ok = await deleteSession(id);
    if (!ok) return reply.code(404).send({ error: "Not found" });
    return { ok: true };
  });

  app.post("/api/sessions/:id/console/attach", async (req, reply) => {
    const { id } = req.params as { id: string };
    const detail = await getSessionDetail(id);
    if (!detail) return reply.code(404).send({ error: "Not found" });
    const body = z
      .object({
        cols: z
          .number()
          .int()
          .min(CONSOLE_TERMINAL_LIMITS.cols.min)
          .max(CONSOLE_TERMINAL_LIMITS.cols.max)
          .optional(),
        rows: z
          .number()
          .int()
          .min(CONSOLE_TERMINAL_LIMITS.rows.min)
          .max(CONSOLE_TERMINAL_LIMITS.rows.max)
          .optional(),
      })
      .parse(req.body ?? {});
    await attachUserConsole(id, detail.cwd, undefined, body);
    return { ok: true };
  });

  app.post("/api/sessions/:id/console/detach", async (req, reply) => {
    const { id } = req.params as { id: string };
    const detail = await getSessionDetail(id);
    if (!detail) return reply.code(404).send({ error: "Not found" });
    releaseUserConsole(id);
    return { ok: true };
  });

  app.get("/api/sessions/:id/git/status", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = z.object({ summary: z.enum(["0", "1"]).optional() }).parse(req.query ?? {});
    const cwd = await getSessionCwd(id);
    if (cwd === null) return reply.code(404).send({ error: "Not found" });
    return getGitStatus(cwd, { summary: q.summary === "1" });
  });

  app.get("/api/sessions/:id/git/diff", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = z.object({ path: z.string().max(4096).optional() }).parse(req.query ?? {});
    const cwd = await getSessionCwd(id);
    if (cwd === null) return reply.code(404).send({ error: "Not found" });
    return { diff: await getGitDiff(cwd, q.path) };
  });

  app.get("/api/sessions/:id/git/log", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).optional(),
        skip: z.coerce.number().int().min(0).max(100000).optional(),
        /** Repeated: the history filter may keep several branches at once. */
        branch: z.union([z.string().max(200), z.array(z.string().max(200))]).optional(),
      })
      .parse(req.query ?? {});
    const cwd = await getSessionCwd(id);
    if (cwd === null) return reply.code(404).send({ error: "Not found" });
    const branches = q.branch === undefined ? [] : Array.isArray(q.branch) ? q.branch : [q.branch];
    return getGitLog(cwd, { limit: q.limit, skip: q.skip, branches });
  });

  app.get("/api/sessions/:id/git/show", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = z
      .object({
        rev: z.string().min(4).max(64),
        path: z.string().min(1).max(4096).optional(),
      })
      .parse(req.query ?? {});
    const cwd = await getSessionCwd(id);
    if (cwd === null) return reply.code(404).send({ error: "Not found" });
    return { diff: await getGitShow(cwd, q.rev, q.path) };
  });

  app.get("/api/sessions/:id/git/commit", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = z.object({ rev: z.string().min(4).max(64) }).parse(req.query ?? {});
    const cwd = await getSessionCwd(id);
    if (cwd === null) return reply.code(404).send({ error: "Not found" });
    const commit = await getGitCommitDetail(cwd, q.rev);
    if (!commit) return reply.code(404).send({ error: "Commit not found" });
    return { detail: commit };
  });

  app.post("/api/sessions/:id/git/checkout", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .union([
        z.object({
          branch: z.string().min(1).max(255),
          create: z.boolean().optional(),
          /** Where a new branch starts; the current HEAD when it is absent. */
          start: z.string().min(1).max(64).optional(),
        }),
        z.object({ rev: z.string().min(7).max(64) }),
      ])
      .parse(req.body);
    const cwd = await getSessionCwd(id);
    if (cwd === null) return reply.code(404).send({ error: "Not found" });
    const result =
      "rev" in body
        ? await checkoutGitRevision(cwd, body.rev)
        : await checkoutGitBranch(cwd, body.branch, { create: body.create, startPoint: body.start });
    if (!result.ok) return reply.code(400).send({ error: result.error ?? "Checkout failed" });
    return { ok: true, status: await getGitStatus(cwd) };
  });

  app.post("/api/sessions/:id/git/stage", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        paths: z.array(z.string().min(1).max(4096)).min(1).max(MAX_GIT_PATHS),
        staged: z.boolean(),
      })
      .parse(req.body);
    const cwd = await getSessionCwd(id);
    if (cwd === null) return reply.code(404).send({ error: "Not found" });
    const result = await setGitStage(cwd, body.paths, body.staged);
    if (!result.ok) return reply.code(400).send({ error: result.error ?? "Stage failed" });
    return { ok: true, status: await getGitStatus(cwd) };
  });

  app.post("/api/sessions/:id/git/commit", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ message: z.string().min(1).max(5000) }).parse(req.body);
    const cwd = await getSessionCwd(id);
    if (cwd === null) return reply.code(404).send({ error: "Not found" });
    const result = await commitGit(cwd, body.message);
    if (!result.ok) {
      req.log.warn({ sessionId: id, cwd: cwd, error: result.error }, "git commit failed");
      return reply.code(400).send({ error: result.error ?? "Commit failed" });
    }
    return { ok: true, status: await getGitStatus(cwd) };
  });

  app.post("/api/sessions/:id/git/sync", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ action: z.enum(["fetch", "pull", "push"]) }).parse(req.body);
    const cwd = await getSessionCwd(id);
    if (cwd === null) return reply.code(404).send({ error: "Not found" });
    const result = await syncGit(cwd, body.action);
    if (!result.ok && !result.conflict) {
      req.log.warn(
        { sessionId: id, cwd: cwd, action: body.action, error: result.error },
        "git sync failed",
      );
      return reply.code(400).send({ error: result.error ?? "Sync failed" });
    }
    return {
      ok: result.ok,
      conflict: result.conflict ?? false,
      output: result.output ?? "",
      status: await getGitStatus(cwd),
    };
  });

  app.post("/api/sessions/:id/git/merge", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        from: z.string().min(1).max(255),
        /** Branch that receives the merge; the checked-out one when absent. */
        into: z.string().min(1).max(255).optional(),
      })
      .parse(req.body);
    const cwd = await getSessionCwd(id);
    if (cwd === null) return reply.code(404).send({ error: "Not found" });
    const result = await mergeGitBranch(cwd, body.from, { into: body.into });
    // A merge stopped by conflicts is the question the reader answers next, not
    // a failed request — same shape as a pull that stops on a conflict.
    if (!result.ok && !result.conflict) {
      req.log.warn(
        { sessionId: id, cwd: cwd, from: body.from, into: body.into, error: result.error },
        "git merge failed",
      );
      return reply.code(400).send({ error: result.error ?? "Merge failed" });
    }
    return {
      ok: result.ok,
      conflict: result.conflict ?? false,
      output: result.output ?? "",
      status: await getGitStatus(cwd),
    };
  });

  app.post("/api/sessions/:id/git/stash", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        action: z.enum(["push", "pop"]),
        message: z.string().max(500).optional(),
      })
      .parse(req.body);
    const cwd = await getSessionCwd(id);
    if (cwd === null) return reply.code(404).send({ error: "Not found" });
    const result = await stashGit(cwd, body.action, body.message);
    if (!result.ok) return reply.code(400).send({ error: result.error ?? "Stash failed" });
    return { ok: true, output: result.output ?? "", status: await getGitStatus(cwd) };
  });

  app.post("/api/sessions/:id/git/commit-action", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        action: z.enum(["revert", "cherry-pick"]),
        rev: z.string().min(7).max(64),
      })
      .parse(req.body);
    const cwd = await getSessionCwd(id);
    if (cwd === null) return reply.code(404).send({ error: "Not found" });
    const result = await applyGitCommitAction(cwd, body.action, body.rev);
    if (!result.ok) return reply.code(400).send({ error: result.error ?? "Git action failed" });
    return { ok: true, output: result.output ?? "", status: await getGitStatus(cwd) };
  });

  app.post("/api/sessions/:id/git/create-branch", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        rev: z.string().min(7).max(64),
        branch: z.string().min(1).max(255),
      })
      .parse(req.body);
    const cwd = await getSessionCwd(id);
    if (cwd === null) return reply.code(404).send({ error: "Not found" });
    const result = await createGitBranchAt(cwd, body.branch, body.rev);
    if (!result.ok) return reply.code(400).send({ error: result.error ?? "Create branch failed" });
    return { ok: true, status: await getGitStatus(cwd) };
  });

  app.post("/api/sessions/:id/git/create-tag", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        rev: z.string().min(7).max(64),
        tag: z.string().min(1).max(255),
      })
      .parse(req.body);
    const cwd = await getSessionCwd(id);
    if (cwd === null) return reply.code(404).send({ error: "Not found" });
    const result = await createGitTagAt(cwd, body.tag, body.rev);
    if (!result.ok) return reply.code(400).send({ error: result.error ?? "Create tag failed" });
    return { ok: true, status: await getGitStatus(cwd) };
  });

  app.post("/api/sessions/:id/git/delete-branch", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        branch: z.string().min(1).max(255),
        /** Repeat call after the reader confirms losing an unmerged branch. */
        force: z.boolean().optional(),
      })
      .parse(req.body);
    const cwd = await getSessionCwd(id);
    if (cwd === null) return reply.code(404).send({ error: "Not found" });
    const result = await deleteGitBranch(cwd, body.branch, { force: body.force });
    // A branch git refuses to drop because nothing else has its commits is the
    // question the reader answers next, not a failed request — same shape as a
    // pull that stops on a conflict: 200 with the outcome and the fresh status.
    if (!result.ok && !result.unmerged) {
      req.log.warn(
        { sessionId: id, cwd: cwd, branch: body.branch, error: result.error },
        "git branch delete failed",
      );
      return reply.code(400).send({ error: result.error ?? "Delete branch failed" });
    }
    return {
      ok: result.ok,
      unmerged: result.unmerged ?? false,
      status: await getGitStatus(cwd),
    };
  });

  app.post("/api/sessions/:id/git/rename-branch", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        branch: z.string().min(1).max(255),
        next: z.string().min(1).max(255),
      })
      .parse(req.body);
    const cwd = await getSessionCwd(id);
    if (cwd === null) return reply.code(404).send({ error: "Not found" });
    const result = await renameGitBranch(cwd, body.branch, body.next);
    if (!result.ok) {
      req.log.warn(
        { sessionId: id, cwd: cwd, branch: body.branch, next: body.next, error: result.error },
        "git branch rename failed",
      );
      return reply.code(400).send({ error: result.error ?? "Rename branch failed" });
    }
    return { ok: true, status: await getGitStatus(cwd) };
  });

  app.post("/api/sessions/:id/git/discard", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        paths: z.array(z.string().min(1).max(4096)).min(1).max(MAX_GIT_PATHS),
      })
      .parse(req.body);
    const cwd = await getSessionCwd(id);
    if (cwd === null) return reply.code(404).send({ error: "Not found" });
    const result = await discardGitChanges(cwd, body.paths);
    if (!result.ok) return reply.code(400).send({ error: result.error ?? "Discard failed" });
    return { ok: true, status: await getGitStatus(cwd) };
  });

  app.post("/api/sessions/:id/git/delete", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        paths: z.array(z.string().min(1).max(4096)).min(1).max(MAX_GIT_PATHS),
      })
      .parse(req.body);
    const cwd = await getSessionCwd(id);
    if (cwd === null) return reply.code(404).send({ error: "Not found" });
    const result = await deleteGitFiles(cwd, body.paths);
    if (!result.ok) return reply.code(400).send({ error: result.error ?? "Delete failed" });
    return { ok: true, status: await getGitStatus(cwd) };
  });

  app.post("/api/sessions/:id/git/ignore", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        paths: z.array(z.string().min(1).max(4096)).min(1).max(MAX_GIT_PATHS),
      })
      .parse(req.body);
    const cwd = await getSessionCwd(id);
    if (cwd === null) return reply.code(404).send({ error: "Not found" });
    const result = await addGitIgnoreEntries(cwd, body.paths);
    if (!result.ok) return reply.code(400).send({ error: result.error ?? "Add to .gitignore failed" });
    return { ok: true, added: result.added, status: await getGitStatus(cwd) };
  });

  app.get("/api/sessions/:id/git/lines", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = z
      .object({
        path: z.string().min(1).max(4096),
        start: z.coerce.number().int().min(1),
        end: z.coerce.number().int().min(1),
        side: z.enum(["old", "new"]),
        mode: z.enum(["working", "commit"]),
        rev: z.string().min(4).max(64).optional(),
      })
      .parse(req.query ?? {});
    const cwd = await getSessionCwd(id);
    if (cwd === null) return reply.code(404).send({ error: "Not found" });
    if (q.mode === "commit" && !q.rev) return reply.code(400).send({ error: "rev required" });
    const result = await getGitFileLines(
      cwd,
      q.path,
      q.start,
      q.end,
      q.side,
      q.mode === "commit" ? { mode: "commit", rev: q.rev! } : { mode: "working" },
    );
    if (!result) return reply.code(404).send({ error: "Lines not available" });
    return result;
  });

  app.get("/api/sessions/:id/git/blame", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = z.object({ path: z.string().min(1).max(4096) }).parse(req.query ?? {});
    const cwd = await getSessionCwd(id);
    if (cwd === null) return reply.code(404).send({ error: "Not found" });
    const blame = await getGitBlame(cwd, q.path);
    if (!blame) return reply.code(404).send({ error: "Blame not available" });
    return { blame };
  });

  /** Stage a pasted/uploaded file; returns a path attachment. A board task's
   *  files land in acpio's own data folder — the task is worked in the user's
   *  project, and their repository must not collect the task's attachments. */
  app.post("/api/sessions/:id/attachments/upload", async (req, reply) => {
    const { id } = req.params as { id: string };
    const detail = await getSessionDetail(id);
    if (!detail) return reply.code(404).send({ error: "Not found" });
    // The client posts the clipboard blob itself; name/mime ride in headers so
    // no base64 (and no giant JSON body) is involved.
    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      return reply.code(400).send({ error: "Empty upload" });
    }
    if (bytes.length > MAX_ATTACH_UPLOAD_BYTES) {
      return reply.code(413).send({ error: "File too large" });
    }
    const name = decodeHeaderFileName(req.headers["x-file-name"]).trim();
    if (!name) return reply.code(400).send({ error: "Missing file name" });
    const mime = headerValue(req.headers["x-file-mime"]).trim();
    try {
      const saved = detail.boardId
        ? await stageAcpioUpload(id, { name, mime, bytes })
        : await stageSessionUpload(id, detail.cwd, { name, mime, bytes });
      // A board task keeps the file on itself: its first turn carries what
      // the task was created with, however long the card waits in Todo.
      if (detail.boardId && !detail.startedAt) {
        await addTaskAttachments(id, [{ name: saved.name, path: saved.path }]);
      }
      return { name: saved.name, path: saved.path, size: saved.size };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "File too large") {
        return reply.code(413).send({ error: message });
      }
      return reply.code(400).send({ error: message || "Upload failed" });
    }
  });

  app.post("/api/sessions/:id/prompt", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        text: z.string().min(1),
        editMessageId: z.string().uuid().optional(),
        // How to reach an agent that is already working. `queue` (the default,
        // and what an older client always meant) waits for the whole turn;
        // `steer` stops it now; `afterStep` folds the text into it.
        delivery: z.enum(["queue", "steer", "afterStep"]).optional(),
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
    const settings = await getSettings();
    // A harness the user switched off must not be driven through an old chat
    // either - regardless of what the stale client believes about availability.
    if (settings.disabledProviders.includes(detail.provider)) {
      return sendAgentOffline(req, reply);
    }
    if (!getAgentAvailability(detail.provider)) {
      return sendAgentOffline(req, reply);
    }

    const defaultTitle = defaultSessionTitle(settings.locale);
    // A title the system derived itself — the placeholder, the board
    // description's first line, or this very message — may be rewritten by a
    // model. A name the user chose may not.
    const titleIsDefault =
      detail.title === defaultTitle || detail.title === "Новый чат" || detail.title === "New chat";
    const descTitle = detail.taskDescription
      ? titleFromTaskDescription(detail.taskDescription)
      : "";
    const titleIsAuto =
      titleIsDefault || (descTitle !== "" && detail.title === descTitle);
    // `/commit-en` alone is a command, not words: the sanitizer eats the
    // command and leaves nothing to title from. The command's own description —
    // a skill's — says what the chat is about, so it titles it instead; the
    // list is whatever this chat's composer already offered.
    const messageTitle =
      titleFromUserText(body.text) ||
      titleFromSlashCommand(body.text, getSessionSlashCommands(id));
    // `detail` predates this prompt's own message: an empty list means this is
    // the first message of the chat, the only place a title may be refined.
    const firstMessage = detail.messages.length === 0;
    const aiTitle =
      settings.chatAutoTitle && titleIsAuto && firstMessage
        ? titleIsDefault
          ? messageTitle || undefined
          : body.text
        : undefined;
    // Pictures the task was created with ride along with its first turn: the
    // form that uploaded them is long gone by the time the card starts. Once
    // the task has started, they belong to that first message and are never
    // attached again — the chat's own attachment flow takes over from there.
    const taskAttachments = detail.startedAt ? [] : (detail.taskAttachments ?? []);
    const alreadySent = new Set((body.attachments ?? []).map((a) => a.path));
    const attachments = [
      ...(body.attachments ?? []),
      ...taskAttachments.filter((a) => !alreadySent.has(a.path)),
    ];
    void runPrompt(id, body.text, {
      provider: detail.provider,
      cwd: detail.cwd,
      mode: detail.mode,
      editMessageId: body.editMessageId,
      delivery: body.delivery,
      attachments: attachments.length ? attachments : undefined,
      titleHint: titleIsDefault ? body.text : undefined,
      aiTitle,
    }).catch((err) => {
      console.error("prompt failed", err);
    });

    return { ok: true, status: "running" };
  });

  /** Whether the server process still has a live turn for this chat. The DB row can
   *  lag behind it, so a client that reloaded asks here instead of trusting status. */
  app.get("/api/sessions/:id/turn", async (req) => {
    const { id } = req.params as { id: string };
    return getLiveTurnState(id) ?? { running: false, waiting: false };
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
    await answerQuestion(id, requestId, body.result);
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
          data?: string;
          cols?: number;
          rows?: number;
        };
        if (msg.type === "ping") {
          socket.send(JSON.stringify({ type: "pong" }));
          return;
        }
        if (msg.type === "subscribe" && msg.sessionId) {
          subscribeClient(client, msg.sessionId);
          // The subscriber may have missed live prompts while its socket was
          // down — re-emit whatever is still waiting on the user. Turn status is
          // reconciled over REST (`GET /api/sessions/:id/turn`), not by broadcasting.
          replayPendingInteractive(msg.sessionId);
          return;
        }
        if (msg.type === "unsubscribe" && msg.sessionId) {
          unsubscribeClient(client, msg.sessionId);
          return;
        }
        if (msg.type === "process.input" && msg.sessionId && typeof msg.data === "string") {
          const sessionId = msg.sessionId;
          if (!writeUserConsole(sessionId, msg.data)) {
            // The panel is attached to a shell that is no longer here (the server
            // restarted, the shell exited, the profile changed). Keystrokes must
            // not vanish into a terminal that looks alive: start one and let the
            // client reset its screen.
            void getSessionDetail(sessionId).then((detail) => {
              if (!detail) return;
              void reviveUserConsole(sessionId, detail.cwd);
            });
          }
          return;
        }
        if (
          msg.type === "process.resize" &&
          msg.sessionId &&
          typeof msg.cols === "number" &&
          typeof msg.rows === "number"
        ) {
          resizeUserConsole(msg.sessionId, msg.cols, msg.rows);
          return;
        }
        if (msg.type === "process.clear" && msg.sessionId) {
          const sessionId = msg.sessionId;
          void getSessionDetail(sessionId).then((detail) => {
            if (!detail) return;
            void resetUserConsole(sessionId, detail.cwd);
          });
          return;
        }
      } catch {
        // ignore
      }
    });
  });
}
