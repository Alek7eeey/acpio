import {
  modelDisplayName,
  modelParamFamily,
  modelParamLabel,
  modelParamSectionName,
  providerCommand,
  type AgentMode,
  type AgentProvider,
  type ModelParamDto,
} from "@acprocess/shared";
import { getSettings, updateSettings } from "../services/settings.js";
import {
  appendPart,
  appendTextChunk,
  createMessage,
  getSessionDetail,
  updatePart,
  updateSession,
} from "../services/sessions.js";
import { broadcastToSession } from "../services/wsHub.js";
import {
  AcpClient,
  findModelConfigOption,
  listModelParamOptions,
  peelAnswerFromThought,
  type AcpRequest,
  type ConfigOption,
} from "./AcpClient.js";

function toModelParams(options: ConfigOption[]): ModelParamDto[] {
  const params = listModelParamOptions(options).map((o) => ({
    id: o.id,
    name: modelParamSectionName(o.id, o.name),
    currentValue: o.currentValue,
    options:
      o.options && o.options.length
        ? o.options.map((opt) => ({
            value: opt.value,
            name: modelParamLabel(o.id, opt.value, opt.name),
          }))
        : o.type === "boolean"
          ? [
              { value: "false", name: modelParamLabel(o.id, "false") },
              { value: "true", name: modelParamLabel(o.id, "true") },
            ]
          : [],
  }));

  // Prefer a stable Fast → Усилие → Context order in the picker.
  const rank = (id: string) => {
    const family = modelParamFamily(id);
    if (family === "fast") return 0;
    if (family === "effort") return 1;
    if (family === "context") return 2;
    return 50;
  };
  params.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  return params;
}

function toModelList(options: ConfigOption[]) {
  const modelOpt = findModelConfigOption(options);
  return (modelOpt?.options ?? []).map((o) => ({
    value: o.value,
    name: modelDisplayName(o.value, o.name),
  }));
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  kind: AcpRequest["kind"];
};

class SessionRuntime {
  client: AcpClient | null = null;
  /** Resolves when client.start() has finished (or failed). */
  clientReady: Promise<AcpClient> | null = null;
  /** Provider the live ACP process was started with. */
  provider: AgentProvider | null = null;
  assistantMessageId: string | null = null;
  openTextPartId: string | null = null;
  /** One thought block for the whole turn */
  turnThoughtPartId: string | null = null;
  openThoughtPartId: string | null = null;
  toolPartByCallId = new Map<string, string>();
  pending = new Map<string, PendingRequest>();
  running = false;
  toolsHintSent = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(public readonly sessionId: string) {}

  /** Serialize ACP update handlers to avoid racey part creation per token. */
  enqueue(task: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(task, task);
    return this.chain;
  }
}

const runtimes = new Map<string, SessionRuntime>();

function getRuntime(sessionId: string) {
  let rt = runtimes.get(sessionId);
  if (!rt) {
    rt = new SessionRuntime(sessionId);
    runtimes.set(sessionId, rt);
  }
  return rt;
}

function requestIdFor(sessionId: string, rpcId: string | number) {
  return `${sessionId}:${String(rpcId)}`;
}

export async function ensureAcp(
  sessionId: string,
  opts: { provider: AgentProvider; cwd: string; mode: AgentMode },
): Promise<AcpClient> {
  const rt = getRuntime(sessionId);
  // Switching Cursor ↔ OpenCode must replace the live process, not reuse it.
  if (rt.provider && rt.provider !== opts.provider) {
    resetAcpClient(rt);
  }
  if (rt.clientReady) return rt.clientReady;
  if (rt.client) return rt.client;

  const settings = await getSettings();
  const client = new AcpClient(opts.provider, settings, opts.cwd, opts.mode);
  rt.client = client;
  rt.provider = opts.provider;

  client.on("log", (line: string) => {
    console.log(`[acp:${sessionId}]`, line.trim());
  });

  client.on("exit", async () => {
    rt.client = null;
    rt.clientReady = null;
    rt.provider = null;
    rt.running = false;
    rt.toolsHintSent = false;
    await updateSession(sessionId, { status: "closed" });
  });

  client.on("update", (update) => {
    void rt.enqueue(async () => {
      try {
        await handleUpdate(rt, update);
      } catch (err) {
        console.error("update handler error", err);
      }
    });
  });

  // Permissions/questions must NOT hold the update queue while waiting for the user,
  // otherwise streaming/tool updates stall and follow-ups look broken.
  client.on("request", (req: AcpRequest) => {
    void handleIncomingRequest(rt, req).catch((err) => {
      console.error("request handler error", err);
    });
  });

  client.on("extension", (ext: { method: string; params: unknown }) => {
    void rt.enqueue(async () => {
      await handleExtension(rt, ext.method, (ext.params ?? {}) as Record<string, unknown>);
    });
  });

  rt.clientReady = (async () => {
    try {
      await client.start();
      const models = toModelList(client.configOptions);
      const modelParams = toModelParams(client.configOptions);
      const currentModel = findModelConfigOption(client.configOptions)?.currentValue;
      if (models.length || modelParams.length) {
        rememberModels(opts.provider, currentModel, models, modelParams);
      }
      await updateSession(sessionId, {
        acpSessionId: client.sessionId,
        // Don't clobber an in-flight prompt if warm-up finishes during runPrompt.
        ...(rt.running ? {} : { status: "idle" as const }),
      });
      return client;
    } catch (err) {
      rt.client = null;
      rt.clientReady = null;
      throw err;
    }
  })();

  return rt.clientReady;
}

/** Pre-spawn ACP for a session so the first prompt isn't blocked on cold start. */
export function warmAcp(
  sessionId: string,
  opts: { provider: AgentProvider; cwd: string; mode: AgentMode },
) {
  return ensureAcp(sessionId, opts).catch((err) => {
    console.error(`[acp:${sessionId}] warm failed`, err);
  });
}

async function ensureAssistantMessage(rt: SessionRuntime) {
  if (rt.assistantMessageId) return rt.assistantMessageId;
  const msg = await createMessage(rt.sessionId, "assistant");
  rt.assistantMessageId = msg.id;
  rt.openTextPartId = null;
  rt.openThoughtPartId = null;
  rt.turnThoughtPartId = null;
  return msg.id;
}

async function handleUpdate(rt: SessionRuntime, update: import("./AcpClient.js").AcpUpdate) {
  // Metadata-only updates should not create empty assistant bubbles
  if (
    update.kind === "available_commands" ||
    update.kind === "session_info" ||
    update.kind === "other" ||
    update.kind === "user_message_chunk"
  ) {
    return;
  }

  if (update.kind === "agent_message_chunk") {
    if (!update.text) return;
    const messageId = await ensureAssistantMessage(rt);
    // Continue same text part for the turn; tools may split later via clearing openTextPartId
    rt.openTextPartId = await appendTextChunk(
      rt.sessionId,
      messageId,
      "text",
      update.text,
      rt.openTextPartId,
    );
    return;
  }

  if (update.kind === "mixed_chunks") {
    const messageId = await ensureAssistantMessage(rt);
    if (update.thought) {
      const partId = await appendTextChunk(
        rt.sessionId,
        messageId,
        "thought",
        update.thought,
        rt.turnThoughtPartId ?? rt.openThoughtPartId,
      );
      rt.turnThoughtPartId = partId;
      rt.openThoughtPartId = partId;
    }
    if (update.text) {
      rt.openTextPartId = await appendTextChunk(
        rt.sessionId,
        messageId,
        "text",
        update.text,
        rt.openTextPartId,
      );
    }
    return;
  }

  if (update.kind === "agent_thought_chunk") {
    if (!update.text) return;
    const messageId = await ensureAssistantMessage(rt);
    // Always one reasoning block per turn
    const partId = await appendTextChunk(
      rt.sessionId,
      messageId,
      "thought",
      update.text,
      rt.turnThoughtPartId ?? rt.openThoughtPartId,
    );
    rt.turnThoughtPartId = partId;
    rt.openThoughtPartId = partId;
    return;
  }

  if (update.kind === "tool_call") {
    const messageId = await ensureAssistantMessage(rt);
    rt.openTextPartId = null; // next text starts a new segment after tool
    const title = update.title ?? "Tool";
    const kind = String((update.raw.kind as string) ?? "");
    const isSubagent = /task|subagent|explore|browser|generalPurpose/i.test(`${title} ${kind}`);
    const part = await appendPart(rt.sessionId, messageId, isSubagent ? "subagent" : "tool_call", {
      toolCallId: update.toolCallId,
      title,
      description: title,
      subagentType: kind || (isSubagent ? "task" : undefined),
      status: update.status ?? "pending",
      kind,
      raw: update.raw,
    });
    if (update.toolCallId) rt.toolPartByCallId.set(update.toolCallId, part.id);
    return;
  }

  if (update.kind === "tool_call_update") {
    const messageId = await ensureAssistantMessage(rt);
    const partId = rt.toolPartByCallId.get(update.toolCallId);
    const title = (update.raw.title as string) ?? "Tool";
    const status = update.status ?? "in_progress";
    if (!partId) {
      const kind = String((update.raw.kind as string) ?? "");
      const isSubagent = /task|subagent|explore|browser|generalPurpose/i.test(`${title} ${kind}`);
      const part = await appendPart(rt.sessionId, messageId, isSubagent ? "subagent" : "tool_call", {
        toolCallId: update.toolCallId,
        title,
        description: title,
        subagentType: kind || (isSubagent ? "task" : undefined),
        status,
        kind,
        raw: update.raw,
      });
      rt.toolPartByCallId.set(update.toolCallId, part.id);
      return;
    }
    await updatePart(rt.sessionId, partId, {
      toolCallId: update.toolCallId,
      title,
      description: title,
      status,
      raw: update.raw,
    });
    return;
  }

  if (update.kind === "plan") {
    const messageId = await ensureAssistantMessage(rt);
    rt.openTextPartId = null;
    await appendPart(rt.sessionId, messageId, "plan", update.raw);
  }
}

async function handleIncomingRequest(rt: SessionRuntime, req: AcpRequest) {
  const settings = await getSettings();
  const reqKey = requestIdFor(rt.sessionId, req.id);

  if (req.kind === "permission") {
    const options =
      ((req.params as { options?: Array<{ optionId: string; kind?: string }> }).options ??
        []) as Array<{ optionId: string; kind?: string }>;

    const pickAllow = () => {
      const byKind =
        options.find((o) => o.kind === "allow_always") ??
        options.find((o) => o.kind === "allow_once" || o.kind === "allow-once") ??
        options.find((o) => /allow[_-]?always/i.test(o.optionId)) ??
        options.find((o) => /allow/i.test(o.optionId));
      return byKind?.optionId ?? options[0]?.optionId ?? "allow_once";
    };

    if (settings.permissionPolicy === "always") {
      rt.client?.respond(req.id, { outcome: { outcome: "selected", optionId: pickAllow() } });
      return;
    }

    const toolName = String(
      (req.params as { toolCall?: { title?: string; kind?: string } }).toolCall?.title ??
        (req.params as { toolCall?: { kind?: string } }).toolCall?.kind ??
        "",
    );
    if (
      settings.permissionPolicy === "allowlist" &&
      settings.permissionAllowlist.some((x) => toolName.toLowerCase().includes(x.toLowerCase()))
    ) {
      rt.client?.respond(req.id, { outcome: { outcome: "selected", optionId: pickAllow() } });
      return;
    }

    await rt.enqueue(async () => {
      const messageId = await ensureAssistantMessage(rt);
      await appendPart(rt.sessionId, messageId, "permission", {
        requestId: reqKey,
        options,
        ...req.params,
      });
    });
    await updateSession(rt.sessionId, { status: "waiting" });
    broadcastToSession(rt.sessionId, {
      type: "permission.request",
      sessionId: rt.sessionId,
      requestId: reqKey,
      payload: { ...req.params, options },
    });

    await new Promise<void>((resolve) => {
      rt.pending.set(reqKey, {
        kind: "permission",
        resolve: () => resolve(),
      });
    });
    return;
  }

  await rt.enqueue(async () => {
    const messageId = await ensureAssistantMessage(rt);
    const kind = req.kind === "ask_question" ? "question" : "plan";
    await appendPart(rt.sessionId, messageId, kind === "question" ? "question" : "plan", {
      requestId: reqKey,
      pending: true,
      ...req.params,
    });
  });
  await updateSession(rt.sessionId, { status: "waiting" });
  broadcastToSession(rt.sessionId, {
    type: "question.request",
    sessionId: rt.sessionId,
    requestId: reqKey,
    kind: req.kind === "ask_question" ? "ask_question" : "create_plan",
    payload: req.params,
  });

  await new Promise<void>((resolve) => {
    rt.pending.set(reqKey, {
      kind: req.kind,
      resolve: () => resolve(),
    });
  });
}

async function handleExtension(
  rt: SessionRuntime,
  method: string,
  params: Record<string, unknown>,
) {
  const messageId = await ensureAssistantMessage(rt);
  if (method === "cursor/update_todos") {
    await appendPart(rt.sessionId, messageId, "todo", params);
    return;
  }
  if (method === "cursor/task") {
    await appendPart(rt.sessionId, messageId, "subagent", params);
    return;
  }
  if (method === "cursor/generate_image") {
    await appendPart(rt.sessionId, messageId, "status", {
      kind: "image",
      ...params,
    });
  }
}

export async function runPrompt(
  sessionId: string,
  text: string,
  opts: { provider: AgentProvider; cwd: string; mode: AgentMode; titleHint?: string },
) {
  const rt = getRuntime(sessionId);
  if (rt.running) {
    // Auto-recover stuck runtimes older than nothing tracked — force unlock via cancel path
    throw new Error("Сессия уже выполняет запрос. Нажмите «Стоп» и попробуйте снова.");
  }

  // Kick off ACP as early as possible (spawn overlaps with persisting the user message).
  const acpReady = ensureAcp(sessionId, opts);

  const userMsg = await createMessage(sessionId, "user");
  await appendPart(sessionId, userMsg.id, "text", { text });

  if (opts.titleHint) {
    await updateSession(sessionId, {
      title: opts.titleHint.slice(0, 80),
    });
  }

  rt.running = true;
  rt.assistantMessageId = null;
  rt.openTextPartId = null;
  rt.openThoughtPartId = null;
  rt.turnThoughtPartId = null;
  rt.toolPartByCallId.clear();
  await updateSession(sessionId, { status: "running" });
  // Assistant bubble is created only when the first real update arrives,
  // so the UI doesn't show an empty "Агент" gap before tokens stream.

  try {
    const client = await acpReady;
    // UI shows the raw user text; agent gets a tools reminder so it doesn't refuse web lookups.
    let promptText = text;
    if (!rt.toolsHintSent) {
      rt.toolsHintSent = true;
      promptText =
        `${text}\n\n` +
        `[Системно: в этой среде у тебя есть инструменты web/fetch, terminal и fs. ` +
        `Для актуальных данных (погода, сайты, новости) сразу вызывай инструменты — ` +
        `не отвечай, что «нет доступа к интернету/погоде».]`;
    }
    const result = await client.prompt(promptText);
    // Let in-flight update handlers settle; keep short to avoid a long "blank" wait.
    await rt.enqueue(async () => undefined);
    await new Promise((r) => setTimeout(r, 400));
    await rt.enqueue(async () => undefined);

    const detail = await import("../services/sessions.js").then((m) => m.getSessionDetail(sessionId));
    const lastAssistant = detail?.messages.filter((m) => m.role === "assistant").at(-1);
    const hasContent = lastAssistant?.parts.some((p) =>
      ["text", "thought", "tool_call", "error"].includes(p.type),
    );

    // If the model put the answer into the thought channel, peel it into a text part.
    if (lastAssistant) {
      const thoughtPart = lastAssistant.parts.find((p) => p.type === "thought");
      const hasText = lastAssistant.parts.some(
        (p) => p.type === "text" && String(p.payload.text ?? "").trim(),
      );
      if (thoughtPart && !hasText) {
        const rawThought = String(thoughtPart.payload.text ?? "");
        const peeled = peelAnswerFromThought(rawThought);
        if (peeled.answer) {
          await updatePart(sessionId, thoughtPart.id, { text: peeled.thought });
          rt.openTextPartId = await appendTextChunk(
            sessionId,
            lastAssistant.id,
            "text",
            peeled.answer,
            null,
          );
        }
      }
    }

    if (!hasContent) {
      const model =
        client.configOptions.find((o) => o.id === "model")?.currentValue ?? "(неизвестно)";
      const hint =
        `Агент завершил ход без текста (stopReason=${result.stopReason ?? "unknown"}). ` +
        `Модель: ${model}. В Настройках выбери модель с API (не local-ollama, если Ollama не запущена) и сохрани ключ.`;
      const assistantId = await ensureAssistantMessage(rt);
      await appendPart(sessionId, assistantId, "error", { message: hint });
    }

    await updateSession(sessionId, { status: "idle" });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      const assistantId = await ensureAssistantMessage(rt);
      await appendPart(sessionId, assistantId, "error", { message });
    } catch {
      // ignore secondary failures
    }
    await updateSession(sessionId, { status: "error" });
    broadcastToSession(sessionId, { type: "error", sessionId, message });
    // Broken ACP process → recreate next time
    if (/exited|spawn|ENOENT|таймаут|timeout/i.test(message)) {
      rt.client?.dispose();
      rt.client = null;
      rt.clientReady = null;
    }
    throw err;
  } finally {
    rt.running = false;
  }
}

export async function cancelPrompt(sessionId: string) {
  const rt = runtimes.get(sessionId);
  if (rt) {
    rt.running = false;
    for (const [reqKey, p] of rt.pending) {
      if (p.kind === "permission") {
        const rpcId = reqKey.slice(sessionId.length + 1);
        const numericId = Number(rpcId);
        const id = Number.isFinite(numericId) && String(numericId) === rpcId ? numericId : rpcId;
        rt.client?.respond(id, { outcome: { outcome: "cancelled" } });
      }
      p.resolve(undefined);
    }
    rt.pending.clear();
    try {
      await rt.client?.cancel();
    } catch {
      // ignore
    }
  }
  await updateSession(sessionId, { status: "idle" });
}

export async function probeAgent(provider?: AgentProvider) {
  const settings = await getSettings();
  const selected = provider ?? settings.defaultProvider;
  const client = new AcpClient(
    selected,
    settings,
    settings.defaultCwd || process.cwd(),
    settings.defaultMode,
  );
  const logs: string[] = [];
  client.on("log", (line: string) => logs.push(line));
  try {
    await client.start(30000);
    const models = toModelList(client.configOptions);
    const modelParams = toModelParams(client.configOptions);
    const sessionId = client.sessionId ?? undefined;
    const currentModel = findModelConfigOption(client.configOptions)?.currentValue;
    if (models.length || modelParams.length) {
      rememberModels(selected, currentModel, models, modelParams);
    }
    client.dispose();
    const paramSummary = modelParams
      .map((p) => `${p.name}: ${modelParamLabel(p.id, p.currentValue ?? "", undefined)}`)
      .filter((s) => !s.endsWith(": "))
      .join(", ");
    return {
      ok: true,
      provider: selected,
      command: providerCommand(settings, selected),
      message: currentModel
        ? `ACP OK. Model: ${modelDisplayName(currentModel)}${paramSummary ? ` · ${paramSummary}` : ""}`
        : `ACP OK — session ${sessionId}`,
      details: logs.join("\n").slice(-1500),
      sessionId,
      currentModel,
      models,
      modelParams,
    };
  } catch (err) {
    client.dispose();
    return {
      ok: false,
      provider: selected,
      command: providerCommand(settings, selected),
      message: err instanceof Error ? err.message : String(err),
      details: `${logs.join("\n")}\n${client.lastStderr}`.slice(-2000),
    };
  }
}

function resetAcpClient(rt: SessionRuntime) {
  rt.clientReady = null;
  try {
    rt.client?.dispose();
  } catch {
    // ignore
  }
  rt.client = null;
  rt.provider = null;
  rt.toolsHintSent = false;
}

/** Align chat row + ACP with the currently connected agent in settings. */
export async function syncSessionAgent(sessionId: string) {
  const detail = await getSessionDetail(sessionId);
  if (!detail) return null;
  const settings = await getSettings();
  const provider = settings.defaultProvider;
  if (detail.provider === provider) return detail;

  const rt = runtimes.get(sessionId);
  if (rt) resetAcpClient(rt);
  const updated = await updateSession(sessionId, { provider });
  return updated
    ? { ...detail, ...updated, messages: detail.messages }
    : { ...detail, provider };
}

export async function setSessionModel(
  sessionId: string,
  model: string,
  params?: Record<string, string>,
) {
  const patch: { defaultModel: string; defaultModelParams?: Record<string, string> } = {
    defaultModel: model,
  };
  if (params) patch.defaultModelParams = params;
  await updateSettings(patch);

  const detail = await syncSessionAgent(sessionId);
  const rt = runtimes.get(sessionId);
  // Mid-session set_config_option often leaves OpenCode/Cursor in a broken state
  // ("Model is unavailable"). Restart ACP so the new model applies like a new chat.
  if (rt) resetAcpClient(rt);

  if (!detail) {
    return { ok: true, model, appliedLive: false };
  }

  try {
    const client = await ensureAcp(sessionId, {
      provider: detail.provider,
      cwd: detail.cwd,
      mode: detail.mode,
    });
    const models = toModelList(client.configOptions);
    const modelParams = toModelParams(client.configOptions);
    const currentModel =
      findModelConfigOption(client.configOptions)?.currentValue ?? model;
    rememberModels(detail.provider, currentModel, models, modelParams);
    return {
      ok: true,
      model,
      appliedLive: true,
      restarted: true,
      currentModel,
      models,
      modelParams,
    };
  } catch (err) {
    console.error(`[acp:${sessionId}] setSessionModel restart failed`, err);
    return {
      ok: true,
      model,
      appliedLive: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

let modelsCache: {
  provider: AgentProvider;
  currentModel?: string;
  models: Array<{ value: string; name: string }>;
  modelParams: ModelParamDto[];
  at: number;
} | null = null;

export function rememberModels(
  provider: AgentProvider,
  currentModel: string | undefined,
  models: Array<{ value: string; name: string }>,
  modelParams: ModelParamDto[] = [],
) {
  modelsCache = { provider, currentModel, models, modelParams, at: Date.now() };
}

export function clearModelsCache(provider?: AgentProvider) {
  if (!provider || modelsCache?.provider === provider) {
    modelsCache = null;
  }
}

export async function listModels(
  provider?: AgentProvider,
  opts?: { force?: boolean },
) {
  const settings = await getSettings();
  const selected = provider ?? settings.defaultProvider;
  const force = opts?.force === true;
  if (
    !force &&
    modelsCache &&
    modelsCache.provider === selected &&
    Date.now() - modelsCache.at < 24 * 60_000 &&
    // Empty params may be a cold partial — don't stick for the full TTL.
    (modelsCache.modelParams.length > 0 || Date.now() - modelsCache.at < 20_000)
  ) {
    return {
      ok: true,
      provider: selected,
      currentModel: settings.defaultModel || modelsCache.currentModel,
      models: modelsCache.models,
      modelParams: modelsCache.modelParams,
      cached: true,
    };
  }
  const probed = await probeAgent(selected);
  if (probed.ok && (probed.models?.length || probed.modelParams?.length)) {
    rememberModels(selected, probed.currentModel, probed.models ?? [], probed.modelParams ?? []);
  }
  return {
    ok: probed.ok,
    provider: selected,
    currentModel: settings.defaultModel || probed.currentModel,
    models: probed.models ?? [],
    modelParams: probed.modelParams ?? [],
    message: probed.message,
    cached: false,
  };
}

export function answerPermission(sessionId: string, requestId: string, optionId: string) {
  const rt = runtimes.get(sessionId);
  if (!rt) throw new Error("Runtime not found");
  const pending = rt.pending.get(requestId);
  if (!pending) throw new Error("Permission request not found");

  const rpcId = requestId.slice(sessionId.length + 1);
  const numericId = Number(rpcId);
  const id = Number.isFinite(numericId) && String(numericId) === rpcId ? numericId : rpcId;

  rt.client?.respond(id, {
    outcome: { outcome: "selected", optionId },
  });
  pending.resolve(optionId);
  rt.pending.delete(requestId);
  void updateSession(sessionId, { status: "running" });
}

export function answerQuestion(
  sessionId: string,
  requestId: string,
  result: Record<string, unknown>,
) {
  const rt = runtimes.get(sessionId);
  if (!rt) throw new Error("Runtime not found");
  const pending = rt.pending.get(requestId);
  if (!pending) throw new Error("Question request not found");

  const rpcId = requestId.slice(sessionId.length + 1);
  const numericId = Number(rpcId);
  const id = Number.isFinite(numericId) && String(numericId) === rpcId ? numericId : rpcId;

  rt.client?.respond(id, result);
  pending.resolve(result);
  rt.pending.delete(requestId);
  void updateSession(sessionId, { status: "running" });
}

export function disposeRuntime(sessionId: string) {
  const rt = runtimes.get(sessionId);
  if (rt) {
    rt.clientReady = null;
    rt.client?.dispose();
  }
  runtimes.delete(sessionId);
}
