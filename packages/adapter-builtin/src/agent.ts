import { randomUUID } from "node:crypto";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type {
  AppSettings,
  BuiltinContextMode,
  BuiltinProviderConfig,
  BuiltinReasoningPolicy,
  BuiltinReplyLanguage,
  BuiltinSubagentsSetting,
  InProcessAgentOptions,
  InProcessAgentTransport,
} from "@acpio/shared";
import {
  builtinProviderHeaders,
  DEFAULT_BUILTIN_SUBAGENTS,
  normalizeBuiltinBashTimeoutSec,
  normalizeBuiltinReplyLanguage,
  normalizeBuiltinThinkingLimit,
  parseBuiltinBody,
} from "@acpio/shared";
import { generateText, type ModelMessage, type ToolSet } from "ai";
import {
  builtinModelOptions,
  hasBuiltinEndpoint,
  initialModelId,
  resolveBuiltinModel,
  subagentModelChoice,
  type BuiltinModelSelection,
} from "./config.js";
import { createHostRpc } from "./host.js";
import { providerFetch } from "./keys.js";
import {
  forgetWireLogHeads,
  isContextDriftStop,
  withWireLog,
  wireLogState,
  type ContextDrift,
  type WireLogOptions,
} from "./wireLog.js";
import {
  OffloadStore,
  offloadToolResults,
} from "./offload.js";
import {
  compactHistory,
  digestMessage,
  digestSummaryOf,
  estimateTokens,
  foldInjected,
  hasReasoning,
  MAX_TURN_ATTEMPTS,
  isToolImagesNote,
  maskToolResults,
  pruneMessages,
  promptView,
  repairToolPairs,
  runTurn,
  runTurnWithRetry,
  type CompactionState,
  type ToolImagePart,
  type TurnModel,
  type TurnOutcome,
} from "./loop.js";
import {
  declaredMcpTools,
  McpManager,
  mcpToolSet,
  parseMcpServers,
  snapshotMcpTools,
  type McpToolDecl,
} from "./mcp.js";
import { renderProjectRules, renderRuleNotes, touchedFiles } from "./projectRules.js";
import {
  builtinSlashCommands,
  discoverSettingsSkills,
  expandSkillInvocation,
  matchSkillInvocation,
  renderSkillsSection,
  supersededRules,
  type BuiltinSkill,
} from "./skills.js";
import { existsSync } from "node:fs";
import {
  builtinSessionFile,
  isValidSessionId,
  loadBuiltinSession,
  PROMPT_THINKING_MODES,
  saveBuiltinSession,
  type BuiltinStoredSession,
  type PromptThinkingMode,
} from "./store.js";
import {
  PLAN_DIR,
  PLAN_FILE,
  archivePlan,
  planFilePath,
  planSignature,
  readPlan,
  writePlan,
  type PlanPacing,
  type PlanStage,
  type PlanState,
} from "./planFile.js";
import {
  createBuiltinTools,
  type PlanApproval,
  type PlanEntry,
  type PlanBridge,
} from "./tools.js";
import {
  createSubagentsBridge,
  type SubagentsBridge,
} from "./subagents.js";

const AGENT_INFO = { name: "acpio-builtin", title: "Built-in agent", version: "0.1.0" };

/** The bill a chat carries from session to session — see `sessionUsage`. */
type SpendTotals = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  coldMisses?: number | undefined;
  coldMissTokens?: number | undefined;
};

/** Whatever of a spend the wire carried, as totals; nothing usable reads as absent. */
function spendTotals(raw: unknown): SpendTotals | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const field = (name: keyof SpendTotals): number => {
    const value = (raw as Record<string, unknown>)[name];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  };
  const totals = {
    inputTokens: field("inputTokens"),
    outputTokens: field("outputTokens"),
    cachedInputTokens: field("cachedInputTokens"),
    coldMisses: field("coldMisses"),
    coldMissTokens: field("coldMissTokens"),
  };
  return totals.inputTokens || totals.outputTokens || totals.cachedInputTokens ? totals : undefined;
}

/** The chat's spend, as the harness handed it over on `session/new`|`session/load`. */
function carriedSpend(params: Record<string, unknown>): SpendTotals | undefined {
  const meta = params._meta;
  return meta && typeof meta === "object" ? spendTotals((meta as Record<string, unknown>).spend) : undefined;
}

/**
 * The session's spend rows as an opened session must report them: the file it
 * restored and the totals the harness carried are two memories of one chat, and
 * a row that falls makes the panel hand back money already spent, so the larger
 * of the two wins per row.
 */
function mergedSpend(
  stored: SpendTotals | undefined,
  carried: SpendTotals | undefined,
): { inputTokens: number; outputTokens: number; cachedInputTokens: number; coldMisses: number; coldMissTokens: number } {
  const pick = (key: keyof SpendTotals) => Math.max(stored?.[key] ?? 0, carried?.[key] ?? 0);
  return {
    inputTokens: pick("inputTokens"),
    outputTokens: pick("outputTokens"),
    cachedInputTokens: pick("cachedInputTokens"),
    coldMisses: pick("coldMisses"),
    coldMissTokens: pick("coldMissTokens"),
  };
}
/** First text part of a prompt's content blocks — what `/skill` matching sees. */
/** The session file, or null when the id could not name one. */
function safeSessionFile(stateDir: string, sessionId: string): string | null {
  try {
    return builtinSessionFile(stateDir, sessionId);
  } catch {
    return null;
  }
}

function promptText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  for (const part of parts) {
    if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
      return String((part as { text?: unknown }).text ?? "");
    }
  }
  return "";
}

/**
 * The harness's own id for the user turn a `session/prompt` carries, or "" for a
 * prompt that named none (an internal note, a background job's follow-up). The
 * id is a chat row, so it is used as a key and never trusted beyond its shape.
 */
function turnMessageId(params: Record<string, unknown>): string {
  const meta = params._meta;
  if (!meta || typeof meta !== "object") return "";
  const id = (meta as Record<string, unknown>).messageId;
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : "";
}

/** The point an edit asked to cut this session's history at, or "". */
function rewindPoint(params: Record<string, unknown>): string {
  const meta = params._meta;
  if (!meta || typeof meta !== "object") return "";
  const id = (meta as Record<string, unknown>).rewindTo;
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : "";
}

/**
 * The stored session cut right before `cut`: the messages themselves, every
 * boundary that indexes them (an index past the end would mask or archive the
 * wrong turn) and the turn map, whose later points describe messages that are
 * gone.
 */
function rewindStored(stored: BuiltinStoredSession, cut: number): BuiltinStoredSession {
  const clamp = (value: number | undefined) =>
    value === undefined ? undefined : Math.min(value, cut);
  const compaction = stored.compaction;
  return {
    ...stored,
    messages: stored.messages.slice(0, cut),
    turns: Object.fromEntries(
      Object.entries(stored.turns ?? {}).filter(([, at]) => (at as number) < cut),
    ),
    ...(stored.maskUpTo !== undefined ? { maskUpTo: clamp(stored.maskUpTo) } : {}),
    ...(stored.prunedFrom !== undefined ? { prunedFrom: clamp(stored.prunedFrom) } : {}),
    ...(stored.offloadUpTo !== undefined ? { offloadUpTo: clamp(stored.offloadUpTo) } : {}),
    // A digest covering messages the edit removed would summarise a history that
    // no longer exists: dropping it re-summarises the shorter one instead.
    ...(compaction && compaction.covered <= cut ? { compaction } : { compaction: undefined }),
  };
}

/**
 * The user message: text parts plus image attachments. Harness-side attachments
 * arrive as ACP `image` blocks (base64); `file` is accepted too for the same
 * shape. Non-image files are dropped — they are named in the text hint and the
 * model opens them with the `read` tool.
 */
function userContent(parts: unknown): ModelMessage {
  const content: Array<
    { type: "text"; text: string } | { type: "file"; mediaType: string; data: string }
  > = [];
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const p = part as {
        type?: unknown;
        text?: unknown;
        mediaType?: unknown;
        mimeType?: unknown;
        data?: unknown;
      };
      if (p.type === "text") {
        content.push({ type: "text", text: String(p.text ?? "") });
      } else if (p.type === "image" && p.data) {
        content.push({
          type: "file",
          mediaType: String(p.mimeType ?? p.mediaType ?? "image/png"),
          data: String(p.data),
        });
      } else if (p.type === "file" && p.data && /^image\//.test(String(p.mediaType ?? ""))) {
        content.push({ type: "file", mediaType: String(p.mediaType), data: String(p.data) });
      }
    }
  }
  if (!content.length) content.push({ type: "text", text: "" });
  return { role: "user", content };
}

/**
 * The laws that hold whatever the task is, each under an id so a skill can
 * replace the very one it words itself (frontmatter `supersedes`, see
 * `skills.ts`'s `supersededRules`): a skill that is in effect from the first
 * turn carries its own take on a step, and saying that step twice — once here,
 * once in the skill, at two different strictnesses — is what makes a model spend
 * reasoning on which one wins. An id nothing supersedes is simply kept.
 *
 * `text` is English, `ru` the same rule in Russian: the prompt speaks the UI
 * language (Settings → Appearance), so a reader who reads it sees their own.
 */
const RULES: ReadonlyArray<{ id: string; text: string; ru: string }> = [
  // Merged with `tools`: measured with the prompt's rules removed, the model
  // reads first and keeps its edits in the tools, but reaches for `sed -i` when
  // nothing says not to. Everything else it does unprompted.
  {
    id: "edit",
    text:
      "Read a file before changing it, and change it with `edit`/`write` — never `sed`, `perl` " +
      "or a heredoc through `bash`. One `edit` call per file, however many `edits` it carries; " +
      "a new file the task asks for is written, not surveyed first. Use `read`/`glob`/`grep` " +
      "rather than `cat`/`find`, and one direct command over a helper script.",
    ru:
      "Прочитай файл, прежде чем менять его, и меняй через `edit`/`write` — никогда `sed`, " +
      "`perl` или heredoc через `bash`. Один вызов `edit` на файл, сколько бы `edits` он ни " +
      "нёс; новый файл, который просит задача, сразу пишется, а не изучается предварительно. " +
      "Пользуйся `read`/`glob`/`grep`, а не `cat`/`find`, и одной прямой командой вместо " +
      "вспомогательного скрипта.",
  },
  {
    id: "smallest-change",
    text: "Make the smallest change that fully solves the task.",
    ru: "Делай минимальное изменение, которое полностью решает задачу.",
  },
  // The side panel is the plan's home: the same place other ACP agents put
  // theirs. A model told nothing publishes nothing, and one that restates the
  // list in its answer makes the reader read the same steps twice. The plan is a
  // file (`.acpio/plan.md`) and two stages: `draft` is what the reader is still
  // reading, `applying` is what they approved — and only an approved plan is
  // work the turn owes. It is also gated on a trigger: a plan for every task of
  // more than one step is a plan the reader scrolls past, so the rule names the
  // three cases that call for one and leaves the rest of the work alone.
  {
    id: "plan",
    text:
      "A plan is made in three cases only: the user asks for one, the `plan` skill is invoked " +
      "(`/plan <task>`), or the work is genuinely large — a refactor across subsystems, a " +
      "feature that cannot land in one turn, or steps whose order is still unknown — and you say " +
      "so before starting. Everything else is done straight away with no plan: a bugfix or a " +
      "small feature touching five or ten files is still small work, however many edits it " +
      "takes. With none of the three, do the work and publish no plan. Otherwise the plan goes " +
      "into the file `.acpio/plan.md` before the first step: a title, an `## Overview` of a line " +
      "`## Шаги` (`- [~]` while you work one, `- [x]` when it lands), then the files, the " +
      "reasoning and how it will be checked in the sections after them. Write it with the `plan` " +
      "tool, or with `write`/`edit` and then `plan` with no arguments to republish it; call " +
      "`plan` again as each step starts and lands. In the `draft` stage nothing is implemented " +
      "yet: read, search, form the plan, then call `apply_plan` — it stops the turn and asks the " +
      "reader to approve. Only once the stage is `applying` does the work begin. The reader " +
      "sets the pace: if they want one step at a time, or not to start without them, that " +
      "outranks everything here — do not close the whole list in one turn, and say where you " +
      "stopped. The reader watches the right-hand panel — never repeat the plan in the answer.",
    ru:
      "План составляется только в трёх случаях: пользователь его просит, вызван скилл `plan` " +
      "(`/plan <задача>`), или работа действительно крупная — рефакторинг через несколько " +
      "подсистем, фича, которая не влезает в один ход, либо порядок шагов пока неизвестен — и ты " +
      "говоришь об этом до начала работы. Всё остальное делается сразу и без плана: багфикс или " +
      "мелкая фича на пять-десять файлов — это всё ещё мелкая работа, сколько бы правок она ни " +
      "заняла. Ни одного из трёх нет — делай работу и никакого плана не публикуй. Иначе план идёт " +
      "в файл `.acpio/plan.md` до первого шага: заголовок, `## Overview` в одну-две строки, шаги " +
      "в работе, `- [x]`, когда он закрыт), затем файлы, обоснование и способ проверки в " +
      "разделах после них. Пиши его инструментом `plan` или через `write`/`edit` и потом `plan` " +
      "без аргументов, чтобы опубликовать заново; вызывай `plan` снова, когда шаг начинается и " +
      "когда он закрыт. На стадии `draft` ничего не реализуется: читай, ищи, составь план, затем " +
      "вызови `apply_plan` — он останавливает ход и просит читателя одобрить. Работа начинается " +
      "только когда стадия `applying`. Темп задаёт читатель: если он хочет по одному шагу или не " +
      "хочет начинать без него, это важнее всего здесь — не закрывай весь список за один ход и " +
      "скажи, где остановился. Читатель смотрит на панель справа — никогда не повторяй план в " +
      "ответе.",
  },
  {
    id: "batch",
    text:
      "Batch independent calls in one step (several reads, searches or unrelated commands); " +
      "run a command only after the call it depends on has finished.",
    ru:
      "Объединяй независимые вызовы в один шаг (несколько чтений, поисков или несвязанные " +
      "команды); запускай команду только после того, как завершился вызов, от которого она " +
      "зависит.",
  },
  // The measurement behind the shorter line: with no rules at all the model ran
  // `npm test` and the real script unprompted, so only the norm it broke where
  // it had a rule — fixing the code, not the check — is worth saying.
  {
    id: "verify",
    text:
      "When a check fails, fix the code, never the check — unless the check itself is wrong, " +
      "then fix it and say why in a line. Stop as soon as it passes — no extra listings, " +
      "re-reads or cleanup beyond what the task or a skill asks.",
    ru:
      "Когда проверка падает, исправляй код, а не проверку — если только сама проверка не " +
      "ошибочна, тогда исправь её и одной строкой скажи почему. Останавливайся, как только она " +
      "проходит — никаких дополнительных листингов, повторных чтений и уборки сверх того, что " +
      "просят задача или скилл.",
  },
];

/** Ids of {@link RULES} — the vocabulary a skill's `supersedes` frontmatter names. */
export const RULE_IDS: readonly string[] = RULES.map((rule) => rule.id);

export function systemPrompt(
  locale: string,
  /** Settings → Built-in agent: which language the answer comes in. */
  replyLanguage: BuiltinReplyLanguage,
  cwd: string,
  mcp: { servers: string[] },
  /** Skills the model may call, already rendered into its prompt block. */
  skillsSection: string,
  /** Base rules an active skill words itself: theirs, not ours, in the prompt. */
  supersededRules: ReadonlySet<string>,
  /** Settings → Built-in agent let the tools leave the working directory. */
  outsideCwd: boolean,
  /** Settings → Built-in agent: say that the chat draws markdown pictures. */
  markdownImages: boolean,
  /** Settings → Built-in agent: the `plan` tool is offered, so its rule holds. */
  planTool: boolean,
  /** Settings → Built-in agent: the user's own instructions, appended last. */
  extraInstructions: string,
  /** The harness's own rider (the thinking knob) — not the user's words. */
  thinkingInstructions: string,
  /** The repository's own rules, already rendered (see `projectRules.ts`). */
  projectRules = "",
): string {
  // The prompt speaks the UI language: every fixed line below has its Russian
  // twin, so a reader flipping the language reads rules in their own.
  const t = (en: string, ru: string) => (locale === "ru" ? ru : en);
  // The answer language is the setting's to decide; `auto` hands it back to the
  // interface, which is what every other line here follows anyway.
  const answerIn = replyLanguage === "ru" || replyLanguage === "en" ? replyLanguage : locale;
  return [
    t(
      "You are the built-in coding agent of the Acpio chat harness.",
      "Ты — встроенный кодирующий агент чат-харнесса Acpio.",
    ),
    t(
      `Working directory: ${cwd} (platform: ${process.platform})`,
      `Рабочая папка: ${cwd} (платформа: ${process.platform})`,
    ),
    ...(outsideCwd
      ? [
          t(
            "Paths outside the working directory work too: absolute paths such as a global skill " +
              "folder are readable, and `grep`/`glob` may scope to one. Keep new files inside the " +
              "working directory unless the user points you elsewhere.",
            "Пути вне рабочей папки тоже работают: абсолютные пути, например к глобальной папке " +
              "скиллов, читаются, и `grep`/`glob` можно ограничить ею. Новые файлы держи внутри " +
              "рабочей папки, если пользователь не укажет другое.",
          ),
        ]
      : []),
    t(
      `Reply in ${answerIn === "ru" ? "Russian" : "English"}. Use Markdown; keep answers short and concrete.`,
      `Отвечай по-${answerIn === "ru" ? "русски" : "английски"}. Пиши в Markdown; ответы держи короткими и конкретными.`,
    ),
    // A picture on disk is one line of markdown away from the reader: the chat
    // serves it through the session's own file route. Said as a fact, not as a ban
    // on one sentence: measured on the default model, the markdown is pasted
    // either way and the prohibition only added a clause to argue with — the
    // answer still hedged about the rendering. Hence the switch in
    // Settings → Built-in agent, on by default.
    ...(markdownImages
      ? [
          t(
            "A picture on disk reaches the reader as markdown — `![shot](shot.png)`, a path " +
              "inside the working directory or an absolute one. The chat renders it.",
            "Картинка на диске доходит до читателя строкой markdown — `![shot](shot.png)`, путь " +
              "внутри рабочей папки или абсолютный. Чат её отрисует.",
          ),
        ]
      : []),
    // Numbers are the one thing prose is worst at: both the chat and the plan
    // draw a table and a `chart` block, so the reader compares instead of
    // reading a list of figures.
    t(
      "Numbers the reader has to compare belong in a Markdown table, or in a ```chart block " +
        'carrying JSON — {"type":"bar"|"line"|"pie","title":"…","data":[{"label":"…","value":1}]} — ' +
        "which the chat and the plan draw.",
      "Числа, которые читателю надо сравнить, — таблица Markdown или блок ```chart с JSON " +
        '({"type":"bar"|"line"|"pie","title":"…","data":[{"label":"…","value":1}]}), ' +
        "его рисуют и чат, и план.",
    ),
    "",
    // Four laws that hold whatever the task is: everything narrower belongs to
    // a skill, so a skill can never argue with a rule that already answered its
    // case. A rule an active skill words itself is not repeated here, and the
    // plan rule leaves with the tool it names (Settings → Built-in agent).
    t("Rules:", "Правила:"),
    ...RULES.filter(
      (rule) => !supersededRules.has(rule.id) && (planTool || rule.id !== "plan"),
    ).map((rule) => `- ${t(rule.text, rule.ru)}`),
    // The repository's rules sit right below: more specific than the laws
    // above, less than a skill the user turned on.
    ...(projectRules ? [projectRules] : []),
    // Stable to volatile, top to bottom: the rules and the skills block come
    // first, the MCP list and the user's own instructions after them.
    skillsSection,
    ...(mcp.servers.length
      ? [
          "",
          t(
            `MCP servers connected: ${mcp.servers.join(", ")} — their tools are prefixed \`mcp__\`.`,
            `MCP-серверы подключены: ${mcp.servers.join(", ")} — их инструменты с префиксом \`mcp__\`.`,
          ),
        ]
      : []),
    ...(extraInstructions.trim()
      ? [
          "",
          t(
            "Additional instructions from the user (follow them):",
            "Дополнительные инструкции от пользователя (следуй им):",
          ),
          extraInstructions.trim(),
        ]
      : []),
    // The harness's rider goes in bare: under the header above it would read as
    // the user's own words, and a user who writes instructions of their own
    // would have no way to tell the two apart. It is the block a knob controls,
    // but it is frozen with the head (see `frozenHead.thinking`): "last" is still
    // inside `messages[0]`, so a rider that changed mid-chat rewrote the prefix
    // in front of every message the provider had cached.
    ...(thinkingInstructions.trim() ? ["", thinkingInstructions.trim()] : []),
  ].join("\n");
}

/**
 * What a read-only turn says about itself, in the turn's own message — the
 * tail, where a new line costs only itself. The declarations stay whole and the
 * writing tools refuse (see `BuiltinToolOptions.readOnly`), so this note is the
 * only place the model learns the turn's limit.
 */
function readOnlyTurnNote(locale: string): string {
  return locale === "ru"
    ? "\n\n(Этот ход только читает: `write`, `edit`, `plan`, `apply_plan` и `task` откажут. " +
        "Ответ в чате — это весь результат: ни один файл не создаётся, рабочее дерево не меняется, " +
        "а команда — для чтения, теста или истории, не для того, чтобы что-то записать.)"
    : "\n\n(This turn only reads: `write`, `edit`, `plan`, `apply_plan` and `task` refuse. The " +
        "answer in the chat is the whole result — no file is created, the working tree is not " +
        "changed, and a command is for reading, a test run or the history, not for writing down.)";
}

/**
 * What the model reads when it stops with plan steps still open: the steps
 * themselves, so the reminder cannot be waved off as a general "carry on", and
 * the two honest ways out — do the step, or say why it is not being done.
 */
function planFinishNudge(locale: string, steps: PlanEntry[]): string {
  const list = steps.map((step) => `- ${step.content} (${step.status})`).join("\n");
  return locale === "ru"
    ? `План не закрыт: в панели справа эти шаги ещё не выполнены.\n${list}\n` +
        "Продолжай и закрой их: сделай работу, затем вызови `plan` с выполненными шагами " +
        "в `completed`. Если шаг сделать нельзя — скажи почему в ответе и убери его из плана. " +
        "Не заканчивай ход с половиной списка."
    : `The plan is not finished: the side panel still lists these steps as open.\n${list}\n` +
        "Keep going and close them: do the work, then call `plan` with the steps you finished " +
        "marked `completed`. If a step cannot be done, say why in the answer and drop it from " +
        "the plan. Do not end the turn with the list half done.";
}

/**
 * What the model reads when its turn ends with a plan written and the reader
 * never asked: `apply_plan` is the card above the input, and a plan announced in
 * the answer without it leaves a promise with nothing to click.
 */
function planApprovalNudge(locale: string, path: string): string {
  return locale === "ru"
    ? `План записан в ${path}, но одобрения никто не просил: карточки над вводом нет, и ` +
        "читателю нечего ответить. Вызови `apply_plan` сейчас и дождись его ответа — до " +
        "одобрения ничего не делай."
    : `The plan is written to ${path}, but nobody was asked to approve it: no card sits ` +
        "above the input and the reader has nothing to answer. Call `apply_plan` now and " +
        "wait for their answer — implement nothing until it comes.";
}

/**
 * A relay in front of a thinking model demands its own reasoning back: an
 * assistant message without a `reasoning_content` string makes the whole
 * request fail with `400 … The reasoning_content in the thinking mode must be
 * passed back to the API`. It checks every assistant message of the history it
 * produced — an acting step that thought nothing as much as an answer that did
 * — and which upstream instance handles the next request decides whether the
 * turn survives. An empty echo satisfies the check (measured against the
 * endpoint), so the gap is filled rather than left to chance.
 *
 * `thinking` says the conversation is in thinking mode even when this body
 * carries no reasoning: a view whose reasoning was pruned (the
 * `builtinPruneReasoning` policies, a digest standing in for the covered
 * prefix) is sendable only if the echo is decided by the history, not by the
 * bytes of one request. `false` leaves a body that never thought exactly as it
 * was built, so no endpoint is handed a field it did not ask for.
 *
 * That history is the caller's answer, not this body's: a body carrying one
 * reasoned step and one bare one would otherwise grow the field on the bare
 * step a request *after* that step had already crossed the wire. The provider
 * matches its cache from the first message, so a message edited behind the
 * reader's back ends the cached prefix there and the whole tail is billed
 * again — for a field the endpoint never missed.
 */
export function fillReasoningEcho(messages: unknown, thinking = false): unknown {
  if (!Array.isArray(messages)) return messages;
  if (!thinking) return messages;
  let changed = false;
  const filled = messages.map((message) => {
    const row = message as { role?: unknown; reasoning_content?: unknown } | undefined;
    if (row?.role !== "assistant") return message;
    if (typeof row.reasoning_content === "string") return message;
    changed = true;
    return { ...row, reasoning_content: "" };
  });
  return changed ? filled : messages;
}

/**
 * Endpoint client for one provider: its URL, its keys and headers, plus any extra
 * request body the provider configures (Settings → Built-in agent). The extra
 * object merges over the built body, so a provider-specific knob the
 * OpenAI-compatible schema has no field for — MiMo's `thinking`, an
 * `reasoning_effort` — reaches the endpoint. `{{sessionId}}` in a header value
 * resolves to the asking session.
 */
function builtinEndpoint(
  provider: BuiltinProviderConfig,
  sessionId: string,
  extraBody?: Record<string, unknown>,
  /**
   * Whether the conversation reasons, asked at every request — the caller pins
   * the answer for as long as a message of it may still be on the wire (see
   * `fillReasoningEcho`).
   */
  thinking: () => boolean = () => false,
  /** Whether the head is compared, and who hears about it — see `withWireLog`. */
  hooks?: WireLogOptions,
  /**
   * The chain of requests this endpoint belongs to, when it is not the chat's
   * own — a subagent's run, whose prompt is not the chat's head. See
   * `WireLogTarget.lane`.
   */
  lane?: string,
) {
  // Provider body first, the per-turn override on top: the turn's pick (the
  // `thinking` the user chose in the ⋯ menu) is the more specific intent.
  const extra = { ...(parseBuiltinBody(provider.body) ?? {}), ...(extraBody ?? {}) };
  return createOpenAICompatible({
    name: `builtin:${provider.id}`,
    baseURL: provider.url,
    // No `apiKey` here: the provider may carry several (Settings → Built-in
    // agent → Providers), so `providerFetch` puts one on every request and, on a
    // key that cannot pay, sends the same request again on the next one. The
    // session id is handed over so the pool keeps one key per chat: the provider
    // caches a prompt per key, and a key that moves mid-conversation pays for the
    // whole prefix again.
    // The keys of a pool rotate and the provider caches a prefix per key, so a
    // bill nobody can explain needs the request itself on disk: `ACPIO_WIRE_LOG=1`
    // records every one of them, with the hashes that name a moving head. The
    // log sits *under* the pool — `providerFetch` is what puts the key on the
    // request, and a fingerprint taken above it would be empty for every chat
    // that draws from a pool, which is exactly the chats a rotation costs.
    fetch: providerFetch(
      provider,
      withWireLog({ sessionId, providerId: provider.id, ...(lane ? { lane } : {}) }, fetch, hooks),
      undefined,
      sessionId,
    ),
    // Most OpenAI-compatible servers only report usage when asked to.
    includeUsage: true,
    headers: builtinProviderHeaders(provider.headers, sessionId),
    // Always on: the reasoning echo is not a provider knob but a rule the
    // endpoint enforces on the history the agent hands back.
    transformRequestBody: (args: Record<string, any>) => {
      const body = Object.keys(extra).length > 0 ? { ...args, ...extra } : args;
      const messages = fillReasoningEcho(body.messages, thinking());
      return messages === body.messages ? body : { ...body, messages };
    },
  });
}

/**
 * The prompt-side knob (⋯ menu → "Prompt"), in chip order (most thinking
 * first). It shapes the prompt only: "High" asks for the thinking that decides
 * the design, "Low"/"Extra low" cap the private-reasoning budget, "Default"
 * leaves the prompt alone. What the endpoint actually spends is the other,
 * independent knob — `reasoning_effort` (see `effort`). The list itself lives in
 * `store.ts`, with the frozen head this mode is part of.
 */
const THINKING_MODES = PROMPT_THINKING_MODES;

type ThinkingMode = PromptThinkingMode;

/**
 * Body field that switches an endpoint's thinking pass off. Endpoints with a
 * thinking knob (MiMo's `thinking`, the common relay switches) honour it; the
 * rest ignore an unknown field.
 */
const THINKING_DISABLED_BODY = { thinking: { type: "disabled" } };

/**
 * The chain a subagent's requests are filed under — see `WireLogTarget.lane`.
 * One lane for every child: a child's own head moving between runs is not the
 * chat's business, and nothing here draws the card (children pass no `onDrift`).
 */
const SUBAGENT_LANE = "subagent";

/**
 * The chain the summariser's own asks are filed under — see `WireLogTarget.lane`.
 *
 * A digest ask re-sends a *shortened* head on purpose: the covered prefix plus
 * one instruction message. Compared with the turn's requests it reads as a head
 * that moved — chat 62eba797 drew "совпало 245 из 416" over a request the
 * provider answered from its cache in full (162 688 of 162 857 tokens), and the
 * card it drew stopped nobody from paying anything. Its own lane keeps that
 * comparison inside the pass, where a moved head is the pass's own business.
 */
const COMPACTION_LANE = "compaction";

/** `effort` values that mean "no thinking pass", as opposed to a level. */
const EFFORT_OFF = new Set(["off", "none", "disabled"]);

/** Chip label of one registry effort value: `xhigh` → `XHigh`, `max` → `Max`. */
function effortLabel(value: string): string {
  const known: Record<string, string> = {
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "XHigh",
    max: "Max",
  };
  return known[value.toLowerCase()] ?? value.charAt(0).toUpperCase() + value.slice(1);
}

/** A value the picker sent, kept only when this model can mean it. */
function normalizeEffortValue(value: string, declared: string[]): string {
  const level = value.trim().toLowerCase();
  if (!level || level === "default") return "default";
  if (EFFORT_OFF.has(level)) return declared.includes("none") ? "none" : "off";
  return declared.includes(level) ? level : "default";
}

/** `/thinking [on|off]` — bare means "toggle". */
const THINKING_COMMAND_RE = /^\/thinking(?:\s+(\S+))?\s*$/i;

/** `/thinking-limit [on|off|<chars>]` — bare reports the current state. */
const THINKING_LIMIT_COMMAND_RE = /^\/thinking-limit(?:\s+(\S+))?\s*$/i;

/** The fuse's default line: one step's thinking past this is cut. */
const THINKING_LIMIT_DEFAULT_CHARS = 3_000;

/**
 * How many times a turn is sent back to finish a plan it wrote itself. The
 * panel is a promise to the reader: a turn that published steps and stopped
 * with them open is work abandoned mid-way, so the model is told to close them
 * — twice, not forever, because a model that will not finish has to be let go
 * with its answer rather than spun in place.
 */
const PLAN_FINISH_NUDGES = 2;

/**
 * How many times a turn is sent back to ask for the approval it forgot. Two, on
 * the same reasoning as the finish nudges: a reminder reaches a model that lost
 * the call, and a model that will not ask has to be let go with its answer
 * rather than spun in place.
 */
const PLAN_APPROVAL_NUDGES = 2;

/**
 * What "High" appends: the opposite failure to Extra low's — a model that
 * settles for the first idea that compiles and meets the hard case after
 * shipping it. It asks for the thinking Extra low leaves out (the decision, the
 * fork, the case that parts working from broken) and keeps Extra low's ban on
 * rumination, so depth is spent on the problem, never on narration. With the
 * fuse armed (3000 chars by default) that pre-action thinking is what gets cut:
 * High pays off with `/thinking-limit off` or a raised cap.
 */
const THINKING_HIGH_INSTRUCTION =
  "Hard rule: before your first action, think the problem through — name the " +
  "goal, the constraint that decides the design, and the case that will part a " +
  "working change from a broken one. Two designs that both fit: pick one and say " +
  "why in a sentence; never leave a real fork unexamined. Depth is the hard case " +
  "covered, not length: no recaps of what you just read, no options you will not " +
  "try, no \"now let me\" narration. A second paragraph about what is already on " +
  "screen is a failure, not diligence.";

/**
 * What "Low" appends to the system prompt: a budget rule, which is the only
 * lever that survived measurement. It has to be stated as a hard failure — a
 * preference gets reasoned around by a model that enjoys reasoning.
 */
const THINKING_LOW_INSTRUCTION =
  "Hard rule: your private reasoning budget is 150 words. Think once, decide, " +
  "then answer. No enumeration of options, no re-derivation of obvious facts, " +
  "no restating the task, no planning commentary. Exceeding the budget is a " +
  "failure; write the answer immediately once you have decided.";

/**
 * What "Extra low" appends: the 150-word rule still left room for the failure
 * the harness actually saw — long rumination inside one step (a single
 * reasoning block grew past 17k chars while the model explored a repo). This
 * one caps the per-step chain of thought, prices thinking in the user's own
 * money, and names the rumination shapes (recaps, plans, option lists,
 * "now let me" narration) as bugs rather than diligence.
 */
const THINKING_EXTRA_LOW_INSTRUCTION =
  "Hard rule: private reasoning is capped at 3 sentences per step and ~60 " +
  "words total. Observe, decide in one sentence, act. Thinking longer is a " +
  "billing failure, not diligence: no recaps of what you just read, no plans " +
  "before acting, no lists of options you will not try, no \"now let me\" " +
  "narration, no re-deriving facts already on screen. If a thought reaches a " +
  "second paragraph, stop mid-sentence and emit the tool call or the answer.";

/** The per-mode system-prompt rider; "default" leaves the prompt alone. */
/** What the "thinking" knob appends to the user instructions (the prompt lab reads it). */
export const THINKING_INSTRUCTIONS: Record<ThinkingMode, string> = {
  high: THINKING_HIGH_INSTRUCTION,
  default: "",
  low: THINKING_LOW_INSTRUCTION,
  "extra-low": THINKING_EXTRA_LOW_INSTRUCTION,
};

/**
 * ACP endpoint that runs inside the server process: the same JSON-RPC frames a
 * spawned CLI would put on stdio, with no external binary to install.
 *
 * One transport serves one session. Conversations live in `stateDir` so
 * `session/load` can restore them after a restart; the harness keeps its own
 * copy and never replays, hence `suppressReplayOnLoad`.
 */
/**
 * The instruction the summariser reads after the turns it folds. It travels as
 * the LAST message, after the very turns the pass folds: the request is then a
 * prefix of the one this turn already sent — same system prompt, same digest,
 * same head, same bytes — and the provider serves that prefix from its prompt
 * cache. Only these few hundred tokens are new. A transcript of its own
 * (flattened by `renderTranscript`) shares nothing with the previous request and
 * pays full price for the head: tens of thousands of tokens on the pass that
 * matters.
 */
function digestInstruction(previousSummary: string | undefined, focus: string | undefined): string {
  return (
    (previousSummary
      ? "Не отвечай на переписку выше и не продолжай её. Ты обновляешь конспект диалога программиста с " +
        "агентом: первое сообщение переписки — прошлый конспект, дальше — новые ходы. Сохрани ВСЁ из " +
        "прошлого конспекта, добавь новые решения и прогресс, перенеси завершённое из «в работе» в " +
        "«сделано». Формат: Задача, Ограничения, Сделано, В работе, Заблокировано, Решения, Следующие " +
        "шаги, Важное. Сохраняй точные пути файлов, имена функций и тексты ошибок. Ответь только " +
        "конспектом, без вступлений."
      : "Не отвечай на переписку выше и не продолжай её. Сожми эту переписку в конспект для памяти " +
        "агента: сохрани исходную задачу и её ограничения, принятые решения, изменённые файлы с сутью " +
        "правок, выполненные команды и их результат, нерешённые проблемы. Формат: Задача, Ограничения, " +
        "Сделано, В работе, Заблокировано, Решения, Следующие шаги, Важное. Ответь только конспектом, " +
        "без вступлений. Инструменты не вызывай.") + (focus ? `\n\nДополнительный фокус: ${focus}` : "")
  );
}

/**
 * The turn's own declarations, with nothing to execute: the wire bytes are what
 * the provider renders ahead of the messages, and they must match the turn's
 * exactly for its cached prefix to cover this request. A model that answers with
 * a tool call anyway finds no executor here, so it cannot run anything — the
 * caller sees empty prose and asks again.
 */
function declareOnly(tools: ToolSet | undefined): ToolSet | undefined {
  if (!tools) return undefined;
  const out: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    const { execute: _execute, ...declaration } = tool as { execute?: unknown };
    out[name] = declaration as ToolSet[string];
  }
  return out;
}

export class BuiltinAgent implements InProcessAgentTransport {
  private out: ((line: string) => void) | null = null;
  private closed: ((info?: { message?: string }) => void) | null = null;
  private stopping = false;
  private readonly rpc = createHostRpc((frame) => this.send(frame));
  private readonly opts: InProcessAgentOptions;

  private sessionId = "";
  private cwd: string;
  private modelId: string;
  /** Per-model reasoning mode picked in the composer (see `configOptions`). */
  private thinking: ThinkingMode = "default";
  /** `/thinking off`: requests carry a body that switches the thinking pass off. */
  private thinkingOff = false;
  /**
   * Wire reasoning effort of this chat: a level the model declares, `off` (no
   * thinking pass at all) or `default` (the field is left out). Independent of
   * the prompt-side mode in `thinking` — neither knob writes the other.
   */
  private effort = "default";
  /**
   * `/thinking-limit`: chars of one step's private reasoning before the fuse
   * cuts the model call mid-think and the turn carries on with a reminder.
   * The effective threshold: the chat's {@link thinkingLimitOverride} if it
   * has one, else the global `builtinThinkingLimit` setting — recomputed by
   * {@link applyThinkingLimit} wherever live settings are read.
   * 0 = off. Session-level and wire-free — the prompt-shaped sibling of
   * `thinkingOff`, which kills the thinking pass itself.
   */
  private thinkingLimit = 0;
  /**
   * What `/thinking-limit` decided for this chat: a number (0 = off here even
   * when the global setting arms the fuse), or `undefined` to follow the
   * global setting. Persisted, so a restart keeps the choice.
   */
  private thinkingLimitOverride: number | undefined;
  private messages: ModelMessage[] = [];
  /** Digest of the covered prefix — see {@link CompactionState}. */
  private compaction: CompactionState | undefined;
  /** Stored-message boundary the mask covers; advanced only when a pass runs. */
  private maskUpTo = 0;
  /**
   * Where each of the harness's user turns begins in `messages`, keyed by the id
   * that turn has in the chat. The id is the only name both sides share, and an
   * edit names the turn it rewrites with it: without this map the agent can cut
   * its history nowhere, so the harness has to throw the whole session away.
   */
  private turnIndex: Record<string, number> = {};
  /**
   * Stored-message boundary whose archive decision is taken, pinned for the same
   * reason as `maskUpTo`: a tool answer below it has already gone out with the
   * shape it has. Deciding it again was how a lowered threshold rewrote a
   * message in the middle of a prompt — chat c88a1a10 kept 41 of 78 messages
   * and the provider charged the rest from the 42nd on.
   */
  private offloadUpTo = 0;
  /**
   * Stored index the prune mode view starts at. Sticky: recomputing the cut on
   * every turn would rewrite the head of every later request while a provider
   * charges the whole view again for it.
   */
  private prunedFrom = 0;
  /**
   * The turn already told the reader its context moved in the middle. Reset at
   * the start of a turn: one warning per turn, or a long tool run would repeat
   * the same one at every step.
   */
  private driftWarned = false;
  /**
   * A compaction pass rewrote this prompt on purpose, so the break that follows
   * it is not the reader's to decide: the digest moves every byte behind it by
   * design, and stopping the turn there only means stopping (chat 62eba797
   * parked a turn at "1 из 183" for exactly that). The row the pass already
   * reported is the whole story; the next break that is nobody's plan warns
   * again. Set by `emitCompaction`, cleared by the request it explains.
   */
  private passRewroteView = false;
  /**
   * This turn's view carries one message per stored message, so an index a pass
   * computed on the view is also an index into `this.messages` — the one thing
   * that lets a digest written between steps outlive the turn (see
   * `compactView`). False when the view is a pruned fallback or already starts
   * with a digest.
   */
  private viewIndexed = false;
  /**
   * The reader answered the drift card with “stop”: the turn ends there, and the
   * request it was asked about is never sent. Reset at the start of a turn.
   */
  private driftStopped = false;
  /**
   * The skills half of the system prompt, fixed on the session's first turn: an
   * inlined skill body and the rules it replaces must sit still while the
   * prefix is warm. A mode flipped in Settings mid-chat therefore arrives with
   * the next session, not with the next turn — the alternative rewrites the
   * prompt at the head of every later request and pays a cold prefix for it.
   * A `/name` invocation never changes it either: the body rides in the user
   * message (see `expandSkillInvocation`).
   */
  private frozenSkills: { section: string; supersedes: Set<string> } | null = null;
  /**
   * The project-rules block of the system prompt, fixed with the first turn like
   * `frozenSkills`, and for the same reason: the provider's cache answers the
   * prefix, so a rule inlined into `messages[0]` between two requests bills the
   * whole history again. A rule the settings add mid-chat arrives with the next
   * session; one whose `globs` start to match arrives in the tail (see
   * `deliveredRules`).
   */
  private frozenRules: string | null = null;
  /**
   * Rule paths already appended to the tail: a note lands once, so the request
   * that carries it is the only one that pays for it.
   */
  private deliveredRules: string[] = [];
  /**
   * The settings every other part of the head is written from, fixed with the
   * session's first turn like `frozenSkills`. Each of them lands in the system
   * prompt or in the tool declarations, both of which ride ahead of the
   * messages: reading them live meant a switch flipped in Settings rewrote the
   * head of the next request and billed the whole history again — chat
   * b0c36ffa paid 50 768 tokens for a head that moved. A knob turned there
   * arrives with the next session, deliberately; live is only what a single
   * request decides by itself (the wire effort, the fences, the reasoning echo —
   * see `echoThinking`).
   */
  private frozenHead: {
    locale: string;
    replyLanguage: BuiltinReplyLanguage;
    /**
     * The ⋯ menu's prompt mode. Its rider is the last block of the system prompt —
     * last, but still inside `messages[0]`, so a switch flipped mid-chat rewrote
     * the head and billed every message behind it again.
     */
    thinking: ThinkingMode;
    /** `plan` tool offered, so its rule holds and the tool is declared. */
    planTool: boolean;
    outsideCwd: boolean;
    markdownImages: boolean;
    extraInstructions: string;
    /** MCP servers the head names — and the only ones whose tools it offers. */
    servers: string[];
    /**
     * The tiers `promptHistory` renders the view with. Not the head, but they
     * rewrite messages the head stands in front of: a mask policy flipped
     * mid-chat puts already-sent results back on the wire in another shape and
     * the cache breaks at the first one.
     */
    contextMode: BuiltinContextMode;
    pruneReasoning: BuiltinReasoningPolicy;
    respectReasoningHistory: boolean;
    /**
     * Subagents as the first turn read them. The `task` declaration names this
     * roster, so an agent added or edited mid-chat moves the head just like a
     * switch would.
     */
    subagents: BuiltinSubagentsSetting;
  } | null = null;
  /**
   * The MCP declarations this chat's first turn sent, in the order it sent them
   * — the other half of the head, and the one the servers write.
   *
   * `frozenHead.servers` only names the servers. Listed live, their tools moved
   * for any of the reasons a chat cannot control — another answer order before
   * that was fixed, a tool a newer server version added, a server that timed out
   * on this boot — and since the declarations ride ahead of every message, each
   * move billed the whole history again (chat 26c9d529: 0 of 391 659 input
   * tokens from cache on the first request after a restart, its neighbours
   * reading 99 %). A chat keeps the declarations it started with; see
   * `declaredMcpTools` for what a tool the servers dropped answers.
   */
  private frozenTools: McpToolDecl[] | null = null;
  /**
   * The plan as this session last read it out of `.acpio/plan.md` — title,
   * overview, the Markdown, the steps and the stage. The file is the source of
   * truth (the tools write it, the reader may edit it by hand, the watcher
   * follows it); this copy is what the nudge and the panel are drawn from.
   */
  private planState: PlanState | undefined;
  /**
   * Signature of the plan as last published, so the poll below can tell a hand
   * edit from its own write, and how many `plan` calls have landed. A turn that
   * wrote a plan into an approved one owes its steps (see the nudge in
   * `prompt`); the count is how that turn is told apart from one where the plan
   * was already there — an unrelated question must not be pulled back into old
   * work.
   */
  private planPublished = "";
  private planEpoch = 0;
  /**
   * How many times this session asked the reader to approve a plan. A turn that
   * ends without the count moving forgot the call, not got a refusal — the
   * refusal is an answer and must not be asked again (see `prompt`).
   */
  private planApprovals = 0;
  /** Polls `.acpio/plan.md` while the session is open — see `watchPlan`. */
  private planWatch: NodeJS.Timeout | undefined;
  /** Archive of bulky tool results for this session, when offloading is on. */
  private offload: OffloadStore | undefined;
  private abort: AbortController | null = null;
  /**
   * The turn this session is running, if any — resolved when it has settled.
   * A prompt that arrives in the meantime stops it and waits here, because two
   * turns over one history is what rewrote the head mid-chat (see `prompt`).
   */
  private turnInFlight: Promise<void> | null = null;
  /** Set for the duration of one prompt: the subagent bridge, if enabled. */
  private activeSubagents: SubagentsBridge | null = null;
  /**
   * Model spend of this session to date, as the rows of the context panel count
   * it: every billing figure this agent puts on a `usage_update` is one of
   * these totals, never the scope of the report that happens to carry it (one
   * call, one turn, one compaction pass, one child). The harness stores the
   * latest update as-is — it never adds them up — so a snapshot scoped to
   * whatever just happened is what made the panel's in/out rows jump backwards
   * mid-run; a session-scoped snapshot can only grow, and each report only ever
   * adds what it is the first to report.
   */
  private sessionUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    /**
     * Requests whose head went out unchanged and whose prefix the provider still
     * billed in full. Nothing in this code can make them cheaper — the gateway
     * in front of the provider routes to whichever upstream answers, and the
     * prompt cache lives on that upstream, not on our side (chat b4e9586d paid
     * 72 260 tokens at 0 % ninety-seven seconds after the same bytes were served
     * from cache). The panel needs them apart from a moved head, or every one of
     * them reads as our defect.
     */
    coldMisses: 0,
    coldMissTokens: 0,
  };
  /**
   * Verdict of the last request the wire saw, from `onHead` (see `wireLog`).
   * Consumed by the next usage report: the call it belongs to is the one whose
   * usage arrives right after it, and a flag that outlived two requests would
   * charge a cold start to the turn that came later.
   */
  private headIntact: boolean | null = null;
  /**
   * Subagent spend already folded into `sessionUsage`. The bridge's own counter
   * is a running total for the prompt, so only its growth is new money — the
   * rest was billed by an earlier update of the same prompt.
   */
  private bridgeReported = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  /**
   * Model spend of this prompt's compaction passes that no usage report has
   * carried to the panel yet. The harness overwrites — never accumulates — usage
   * per update, so a summariser call left out of the turn's report is left out
   * of the session's totals for good: the first squeeze in a measured run was
   * 11 353 in / 560 out the panel and the bench rows never saw. Its money goes
   * into `sessionUsage` where the call is made; this stays the flag that decides
   * whether `/compact` has a bill worth reporting at all.
   */
  private pendingUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  /**
   * Last context size the provider itself measured. A `/compact` pass has no
   * turn to report into, and the squeezed size is only measurable on the next
   * call — so its usage update keeps the chip on the size that was measured.
   */
  private lastMeasuredUsed = 0;
  /**
   * What the provider counted for the view the last request carried — the
   * number the compaction trigger is judged by. `estimateTokens` is only a
   * floor: it reads JSON chars / 4 and ran 20% low on a Russian, tool-heavy
   * history (chat 9590a5eb: billed 258 133 against an estimate of 200 135), so
   * a line set at 20% fired at 26% of the window. Zeroed when a pass rewrites
   * the view: no request carried those bytes, and the count they were billed
   * at may not fire the next pass.
   */
  private lastBilledView = 0;
  /**
   * The input half of that count, which is what the compaction row reports as
   * "before": the row says how much prompt went out, and the output of the
   * answer was never part of it.
   */
  private lastBilledInput = 0;
  /**
   * The pass whose row is still waiting for the provider's count of the view it
   * left behind (`tokensAfter`), keyed by the `passId` it went out with. Only
   * the next request can price that view, so the row shows `*` until it lands.
   */
  private compactionAwaiting: number | undefined;
  /** Passes this session ran, as the row's own name — survives nothing but the process. */
  private compactionPass = 0;
  /**
   * Mid-turn messages the host asked for (`session/steer`): each one resolves
   * when the model loop really folds it into a prompt, or with `false` when the
   * turn it was aimed at ended first — the host then queues it as usual.
   */
  private steers: Array<{ text: string; resolve: (delivered: boolean) => void }> = [];
  /** Rebuilt per session: `session/new` carries that session's `mcpServers`. */
  private mcp = new McpManager([], (toolCall) => this.askPermission(toolCall));

  constructor(opts: InProcessAgentOptions) {
    this.opts = opts;
    this.cwd = opts.cwd;
    this.modelId = initialModelId(opts.settings);
  }

  // ── InProcessAgentTransport ───────────────────────────────────────────────

  write(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    if (this.rpc.receive(msg)) return;
    void this.handle(msg).catch((err) => this.replyError(msg, err));
  }

  onLine(cb: (line: string) => void): void {
    this.out = cb;
  }

  onClose(cb: (info?: { message?: string }) => void): void {
    this.closed = cb;
  }

  close(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.unwatchPlan();
    this.abort?.abort();
    this.mcp.close();
    this.rpc.failAll(new Error("встроенный агент остановлен"));
    this.closed?.();
  }

  // ── JSON-RPC ──────────────────────────────────────────────────────────────

  /** No sink is a hard error: a request that can never be answered must reject. */
  private send(frame: Record<string, unknown>): void {
    if (this.stopping || !this.out) throw new Error("встроенный агент не подключён");
    this.out(JSON.stringify(frame));
  }

  private replyError(msg: Record<string, unknown>, err: unknown): void {
    if (this.stopping || !this.out || msg.id === undefined) return;
    const message = err instanceof Error ? err.message : String(err);
    this.out(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message } }));
  }

  private async handle(msg: Record<string, unknown>): Promise<void> {
    const method = msg.method;
    if (typeof method !== "string") return;
    if (msg.id === undefined) {
      if (method === "session/cancel") this.abort?.abort();
      return;
    }
    try {
      const result = await this.dispatch(method, (msg.params ?? {}) as Record<string, unknown>);
      this.send({ jsonrpc: "2.0", id: msg.id, result: result ?? {} });
    } catch (err) {
      this.replyError(msg, err);
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          agentInfo: AGENT_INFO,
        };
      case "session/new":
        return this.openSession(
          randomUUID(),
          String(params.cwd ?? this.opts.cwd),
          false,
          params.mcpServers,
          carriedSpend(params),
        );
      case "session/load": {
        const requested = String(params.sessionId ?? "");
        // The id becomes a file name and rides along in every update — reject
        // anything that is not a plain token instead of accepting it silently.
        if (requested && !isValidSessionId(requested)) {
          throw new Error(`Некорректный id сессии: ${requested}`);
        }
        return this.openSession(
          requested || randomUUID(),
          String(params.cwd ?? this.opts.cwd),
          true,
          params.mcpServers,
          carriedSpend(params),
          // An edit names the turn it rewrites; the history is cut there instead
          // of being thrown away with the session (see `openSession`).
          rewindPoint(params),
        );
      }
      case "session/prompt":
        return this.prompt(params);
      case "session/steer":
        return this.steer(params);
      case "session/cancel":
        this.abort?.abort();
        return {};
      // One mode: the harness may still announce a mode, and the only answer is
      // the one it already runs in.
      case "session/set_mode":
        return {};
      case "session/set_config_option": {
        const configId = String(params.configId ?? "");
        const value = String(params.value ?? "").trim();
        if (configId === "model" && value) {
          const picked = resolveBuiltinModel(this.opts.settings, value);
          if (!picked) {
            throw new Error(
              `Модель "${value}" не найдена в настройках встроенного агента — Настройки → Встроенный агент.`,
            );
          }
          this.modelId = picked.value;
          // The new model states its own levels: a level it does not declare
          // would go out as a request field the endpoint cannot mean.
          if (!EFFORT_OFF.has(this.effort) && !this.selectionEfforts().includes(this.effort)) {
            this.effort = "default";
          }
        } else if (configId === "prompt_style" || configId === "thinking") {
          // `thinking` is the id this param had before the two knobs split: a
          // client built earlier still speaks it, and both mean the same mode.
          if ((THINKING_MODES as readonly string[]).includes(value)) {
            this.thinking = value as ThinkingMode;
          }
        } else if (configId === "effort") {
          this.effort = normalizeEffortValue(value, this.selectionEfforts());
          // One knob for the reader: `/thinking off` and `effort=off` are the
          // same wire state, so neither may leave the other saying otherwise.
          this.thinkingOff = EFFORT_OFF.has(this.effort);
          this.persist();
        }
        return { configOptions: this.configOptions() };
      }
      default:
        throw Object.assign(new Error(`Unsupported method: ${method}`), { code: -32601 });
    }
  }

  // ── Session state ─────────────────────────────────────────────────────────

  private async openSession(
    sessionId: string,
    cwd: string,
    restore = false,
    mcpServers?: unknown,
    /** The chat's spend to date, as the harness remembers it (see `sessionUsage`). */
    carried?: SpendTotals | undefined,
    /**
     * The chat row an edit rewrites. A restore cuts the stored history right
     * before that turn instead of loading all of it: the agent's own transcript
     * still holds the answer being replaced, and the harness's DB has already
     * dropped it — resuming in full would hand the model an answer the reader
     * cannot see, while a fresh session would hand it no history at all (chat
     * 655f80a6 asked `/grill-me` after an edit and got "назовите предмет").
     */
    rewindTo = "",
  ) {
    const loaded = restore ? loadBuiltinSession(this.opts.stateDir, sessionId) : undefined;
    const cut = rewindTo ? loaded?.turns?.[rewindTo] : undefined;
    // An unknown point is not a guess: a file older than this feature has no
    // map, and loading it whole is exactly what the edit set out to undo — so
    // the session opens empty, as it did before the rewind existed, and the
    // diagnostic below says why.
    const stored = !rewindTo
      ? loaded
      : cut === undefined
        ? (loaded ? { ...loaded, messages: [], turns: {} } : undefined)
        : rewindStored(loaded!, cut);
    this.mcp.close();
    this.mcp = new McpManager(
      parseMcpServers(mcpServers),
      (toolCall) => this.askPermission(toolCall),
      this.opts.onDiagnostic,
      cwd || this.opts.cwd,
    );
    this.sessionId = sessionId;
    this.cwd = cwd || this.opts.cwd;
    // The plan belongs to the chat that opens it: a restored session picks its
    // own file back up, and a new one starts from a stage the file decides.
    this.planState = undefined;
    this.planWatch = undefined;
    this.watchPlan();
    // A conversation saved before providers existed carries a bare model id —
    // normalize it so the picker reports the value it actually runs.
    const storedModel = stored?.modelId?.trim();
    if (storedModel) {
      this.modelId = resolveBuiltinModel(this.opts.settings, storedModel)?.value ?? storedModel;
    }
    const beforeRepair = stored?.messages;
    this.messages = repairToolPairs(beforeRepair ?? []);
    // The requests this session already sent described a longer history: leaving
    // their head in place makes the first request after the cut report a moved
    // head, which is a card on a drift the reader asked for (see
    // `forgetWireLogHeads`).
    if (cut !== undefined) forgetWireLogHeads(sessionId);
    // A rewind point indexes the stored array: a repair that dropped messages
    // moved every point behind it, and a moved point cuts at the wrong turn.
    this.turnIndex =
      beforeRepair && beforeRepair.length === this.messages.length ? { ...(stored?.turns ?? {}) } : {};
    // A restore that came back empty is indistinguishable from a brand-new chat
    // in every artifact the host has — the wire log shows a short request, the
    // chat shows its own transcript. Chat 8294560b resumed by `load` and sent
    // "system + one note" while the stored history was intact on disk, and the
    // second, empty agent then lived beside the first one. Say what the boot
    // found: the file it read, whether it was there, and how much history it gave.
    if (restore) {
      const file = safeSessionFile(this.opts.stateDir, sessionId);
      this.opts.onDiagnostic?.({
        kind: "session-load",
        data: {
          agentSessionId: sessionId,
          file,
          filePresent: file ? existsSync(file) : null,
          stored: stored?.messages.length ?? 0,
          messages: this.messages.length,
          repaired: (stored?.messages.length ?? 0) - this.messages.length,
          modelId: stored?.modelId ?? null,
          ...(rewindTo ? { rewind: { requested: rewindTo, cut: cut ?? null } } : {}),
        },
      });
    }
    this.compaction = stored?.compaction;
    // A fresh conversation has no measured window and no unreported pass.
    this.pendingUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    this.lastMeasuredUsed = 0;
    // The spend rows count from where this conversation left off: a restored
    // session keeps the totals it had, or the panel would open the next turn by
    // handing back everything the session had already spent. A *new* session is
    // not a new chat, though (an edit or a regenerate boots one), so the totals
    // the harness carries in count too — and rows only ever grow: whichever of
    // the two remembers more is the bill.
    this.sessionUsage = mergedSpend(stored?.usage, carried);
    this.bridgeReported = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    this.thinkingOff = stored?.thinkingOff === true;
    this.effort = stored?.effort ?? "default";
    // The override may be absent (follow the global setting), 0 (off here) or
    // a cap; the effective fuse is resolved from it right away so a report
    // right after boot is not off-by-the-settings-snapshot.
    this.thinkingLimitOverride = stored?.thinkingLimit;
    this.applyThinkingLimit(normalizeBuiltinThinkingLimit(this.opts.settings.builtinThinkingLimit));
    // Both boundaries outlive the process: a restart that forgot them would
    // send the noted results back verbatim and recompute the cut for nothing.
    this.maskUpTo = stored?.maskUpTo ?? 0;
    this.prunedFrom = stored?.prunedFrom ?? 0;
    // A stored history has been on the wire in full: sealing all of it is what
    // keeps the archive from re-cutting a prompt the provider has already
    // cached. The count in the file is no help there — it can only be behind
    // what was sent, because a batch of tool answers is persisted with the seal
    // of the request that came before it, and a crash keeps that pair. Chat
    // c4e7abfc came back at 55 messages with 2, archived a `gitea_get_pull`
    // answer it had sent in full (7 990 tokens) and matched 3 of 73 messages,
    // billing 54 055 tokens again.
    this.offloadUpTo = stored ? this.messages.length : 0;
    // A transport rebuilt mid-chat resumes on the prompt bytes the first turn
    // fixed, instead of inlining (or dropping) a skill body it read again.
    this.frozenSkills = stored?.promptSkills
      ? {
          section: stored.promptSkills.section,
          supersedes: new Set(stored.promptSkills.supersedes),
        }
      : null;
    // Same reason as the skills block: a transport built again mid-chat resumes
    // on the prompt bytes the first turn fixed, and on the notes already sent.
    this.frozenRules = stored?.promptRules ? stored.promptRules.section : null;
    this.deliveredRules = [...(stored?.promptRules?.delivered ?? [])];
    // …and the settings the head is written from, for the very same reason: a
    // transport built again mid-chat (a restart, a settings save) must resume on
    // the bytes the provider has cached, not on the settings as they are now.
    this.frozenHead = stored?.promptHead ? { ...stored.promptHead } : null;
    // …and the declarations themselves, for the same reason: the servers may
    // answer differently on this boot, and the provider's cache holds the ones
    // the chat already sent.
    this.frozenTools = stored?.promptTools ? [...stored.promptTools] : null;
    // …and whether the history that head wrote went out with the reasoning echo:
    // the field is added to every assistant message that has none, so a
    // transport built again mid-chat may not take that decision again either.
    this.echoThinking = stored?.echoReasoning;
    this.offload = OffloadStore.forSession(this.opts.stateDir, sessionId);
    // Announce discovered skills before the boot reply: the harness merges them
    // into the composer's slash menu, exactly like a CLI agent's own list. The
    // board's new-task form reads the same builder, so it offers what a chat
    // composer would before the session that would announce it exists.
    const skills = await discoverSettingsSkills(this.opts.settings, this.cwd);
    this.emitUpdate({
      sessionUpdate: "available_commands_update",
      commands: builtinSlashCommands(this.opts.settings, skills),
    });
    return { sessionId, configOptions: this.configOptions() };
  }

  /** Effort levels the selected model declares (Settings → Models → refresh). */
  private selectionEfforts(): string[] {
    return resolveBuiltinModel(this.opts.settings, this.modelId)?.efforts ?? [];
  }

  private configOptions() {
    const declared = this.selectionEfforts();
    // "off" is always offered: it is the only way to stop the endpoint's
    // thinking pass from the picker, whatever the model declares.
    const offValue = declared.includes("none") ? "none" : "off";
    const effortOptions = [
      { value: "default", name: "Default" },
      ...declared
        .filter((v) => !EFFORT_OFF.has(v))
        .map((v) => ({ value: v, name: effortLabel(v) })),
      { value: offValue, name: offValue === "none" ? "None (off)" : "Off" },
    ];
    return [
      {
        id: "model",
        category: "model",
        name: "Model",
        type: "select",
        currentValue: this.modelId,
        options: builtinModelOptions(this.opts.settings).map((o) => ({
          value: o.value,
          name: o.name,
          // Shown as its own right-hand column in pickers (OMP/Cursor show it too).
          provider: o.provider.name,
        })),
      },
      {
        id: "prompt_style",
        category: "model_config",
        name: "Prompt",
        type: "select",
        currentValue: this.thinking,
        options: [
          { value: "high", name: "High" },
          { value: "default", name: "Default" },
          { value: "low", name: "Low" },
          { value: "extra-low", name: "Extra low" },
        ],
      },
      {
        // What the endpoint spends on thinking — the model's own levels plus
        // "off". A model that declares none still gets "off".
        id: "effort",
        category: "model_config",
        name: "Effort API",
        type: "select",
        currentValue: effortOptions.some((o) => o.value === this.effort)
          ? this.effort
          : "default",
        options: effortOptions,
      },
    ];
  }

  private persist(): void {
    if (!this.sessionId) return;
    saveBuiltinSession(this.opts.stateDir, this.sessionId, {
      version: 1,
      cwd: this.cwd,
      modelId: this.modelId,
      messages: this.messages,
      ...(this.thinkingOff ? { thinkingOff: true } : {}),
      ...(this.effort !== "default" ? { effort: this.effort } : {}),
      ...(this.thinkingLimitOverride !== undefined ? { thinkingLimit: this.thinkingLimitOverride } : {}),
      ...(this.compaction ? { compaction: this.compaction } : {}),
      ...(this.maskUpTo > 0 ? { maskUpTo: this.maskUpTo } : {}),
      ...(Object.keys(this.turnIndex).length ? { turns: this.turnIndex } : {}),
      ...(this.offloadUpTo > 0 ? { offloadUpTo: this.offloadUpTo } : {}),
      ...(this.prunedFrom > 0 ? { prunedFrom: this.prunedFrom } : {}),
      ...(this.frozenSkills
        ? {
            promptSkills: {
              section: this.frozenSkills.section,
              supersedes: [...this.frozenSkills.supersedes],
            },
          }
        : {}),
      ...(this.frozenRules !== null || this.deliveredRules.length
        ? { promptRules: { section: this.frozenRules ?? "", delivered: [...this.deliveredRules] } }
        : {}),
      ...(this.frozenHead ? { promptHead: { ...this.frozenHead, servers: [...this.frozenHead.servers] } } : {}),
      ...(this.frozenTools ? { promptTools: this.frozenTools } : {}),
      // The echo decision rides with the same bytes: a restart that retook it
      // would add the field to messages the provider has already cached.
      ...(this.echoThinking !== undefined ? { echoReasoning: this.echoThinking } : {}),
      // The spend rows ride along: a restart must resume the session's totals,
      // not restart them from zero and make the panel's first update after the
      // reboot hand back what the session had already spent.
      ...(this.sessionUsage.inputTokens ||
      this.sessionUsage.outputTokens ||
      this.sessionUsage.cachedInputTokens ||
      this.sessionUsage.coldMisses
        ? { usage: { ...this.sessionUsage } }
        : {}),
    });
  }

  /**
   * Settings as of right now. The server hands a live getter alongside the boot
   * snapshot, so a knob turned in Settings reaches this chat on its next turn
   * instead of waiting for a new one.
   */
  private async settings(): Promise<AppSettings> {
    if (!this.opts.settingsProvider) return this.opts.settings;
    try {
      return await this.opts.settingsProvider();
    } catch {
      return this.opts.settings;
    }
  }

  /**
   * The fuse as it stands now: this chat's override, else the global
   * `builtinThinkingLimit`. Called wherever live settings are read — the
   * turn, the subagents' bridge and the report all read `thinkingLimit`.
   */
  private applyThinkingLimit(global: number): void {
    this.thinkingLimit = this.thinkingLimitOverride ?? normalizeBuiltinThinkingLimit(global);
  }

  /**
   * Seal the archive boundary at the end of a turn.
   *
   * Everything a turn appended has crossed the wire by the time the turn is
   * over, and a prompt is not ours to rewrite after that (see
   * `offloadToolResults`). The boundary may not wait for the next
   * `promptHistory`: that call reads it *before* its pass runs, so a turn's own
   * tool results stood undecided for a whole turn, and the next turn archived
   * them in the middle of a prompt the provider had already cached — chat
   * 304f9398 matched 3 of 87 messages and paid 62 718 tokens again for a
   * `gitea_get_pull` answer it had sent in full, chat c051bfac did the same at
   * message 3 of 27 (cached 0 of 43 360).
   */
  private sealOffloadBoundary(): void {
    if (!this.offload || this.offloadUpTo === this.messages.length) return;
    this.offloadUpTo = this.messages.length;
    this.persist();
  }

  /**
   * Everything the panel learns about the plan, on one `session/update: plan`
   * frame: the steps, the document and the stage (see `PlanUpdate`).
   */
  private planFrame(state: PlanState): Record<string, unknown> {
    return {
      sessionUpdate: "plan",
      ...(state.name ? { name: state.name } : {}),
      ...(state.problem ? { problem: state.problem } : {}),
      ...(state.overview ? { overview: state.overview } : {}),
      ...(state.plan ? { plan: state.plan } : {}),
      entries: state.entries,
      stage: state.stage,
      pacing: state.pacing,
      path: this.planDisplayPath(),
    };
  }

  /** The plan file of this session — one per chat, inside the working folder. */
  private planFile(): string {
    return planFilePath(this.cwd);
  }

  /** What the panel shows instead of an absolute path. */
  private planDisplayPath(): string {
    return `${PLAN_DIR}/${PLAN_FILE}`;
  }

  /**
   * A folder holds many chats and one plan file: the file itself says whose plan
   * it is, and another chat's plan is not this chat's to read, follow or
   * publish. An ownerless file — written by hand, or by a version before the
   * owner was recorded — is nobody's yet: the first write takes it (see
   * `savePlan`), the watcher never adopts it on its own.
   */
  private ownPlan(state: PlanState | undefined): PlanState | undefined {
    if (!state) return undefined;
    if (state.chat && state.chat !== this.sessionId) return undefined;
    return state;
  }

  private planLocale(): "ru" | "en" {
    return this.opts.settings.locale === "ru" ? "ru" : "en";
  }

  /** Publish a state the file already holds: file first, panel second. */
  private publishPlan(state: PlanState): void {
    this.planState = state;
    this.planPublished = planSignature(state);
    this.planEpoch += 1;
    this.emitUpdate(this.planFrame(state));
  }

  /** Write the file and put the very same state on the wire. */
  private savePlan(state: PlanState): void {
    const file = this.planFile();
    // Another chat's plan is not overwritten in place: it goes to `.acpio/plans/`
    // where the plan it replaced already goes, and this chat's own plan starts.
    const onDisk = readPlan(file);
    if (onDisk && onDisk.chat && onDisk.chat !== this.sessionId) archivePlan(file);
    const own: PlanState = { ...state, chat: this.sessionId };
    writePlan(file, own, this.planLocale());
    this.publishPlan(own);
  }

  /**
   * `apply_plan`'s gate: the approval card. The harness draws it from the plan
   * itself (`requestKinds` maps this method to `create_plan`), so the reader
   * approves the very document the panel shows. A turn cut short while it waits
   * reads as a dismissal — silence is neither consent nor a refusal.
   */
  private async approvePlan(state: PlanState): Promise<PlanApproval> {
    const plan = this.planFrame(state);
    delete plan.sessionUpdate;
    this.planApprovals += 1;
    try {
      const res = await this.rpc.request<{ outcome?: { outcome?: string; reason?: string } }>(
        "builtin/plan_approval",
        plan,
      );
      if (res?.outcome?.outcome === "accepted") return { accepted: true };
      // The card puts the reader's own words into `reason` when they type them:
      // that is the answer `apply_plan` hands back so the same turn can rework
      // the plan. `cancelled` is ACP's "the request was dismissed", and the X
      // sends exactly it: no words, no verdict — reporting that as a refusal put
      // words in the reader's mouth.
      const feedback = typeof res?.outcome?.reason === "string" ? res.outcome.reason.trim() : "";
      if (!feedback && res?.outcome?.outcome !== "rejected") {
        return { accepted: false, dismissed: true };
      }
      return { accepted: false, ...(feedback ? { feedback } : {}) };
    } catch {
      // A turn stopped while the card waited dismissed it too.
      return { accepted: false, dismissed: true };
    }
  }

  /** The plan file as the tools see it — see `PlanBridge`. */
  private planBridge(): PlanBridge {
    const file = this.planFile();
    return {
      file,
      path: this.planDisplayPath(),
      // The file first: it is the truth, and the memory copy only stands in
      // when the reader deleted it mid-task. Another chat's file is not read at
      // all — its steps are not this chat's work.
      read: () => this.ownPlan(readPlan(file)) ?? this.planState,
      write: (state) => this.savePlan(state),
      approve: (state) => this.approvePlan(state),
    };
  }

  /** Steps the plan still owes: not `completed` — what the turn is nudged for. */
  private openPlanSteps(): PlanEntry[] {
    return (this.planState?.entries ?? []).filter((entry) => entry.status !== "completed");
  }

  /**
   * Follow the plan file: an edit made by hand — the reader in their editor, or
   * the model with plain `write`/`edit` — reaches the panel without waiting for
   * the next tool call. Polled rather than watched: `fs.watch` on Windows fires
   * twice per write and misses renames, and one parse a second is nothing. The
   * timer is unref'd, so it never keeps a process alive on its own.
   */
  private watchPlan(): void {
    this.unwatchPlan();
    const file = this.planFile();
    // Adopted only when the file says this very chat owns it: opening a chat in
    // a folder where another chat left its plan is not that chat's news.
    const opening = readPlan(file);
    if (opening?.chat === this.sessionId) {
      this.planState = opening;
      this.planPublished = planSignature(opening);
    } else {
      this.planState = this.ownPlan(this.planState);
      this.planPublished = planSignature(this.planState);
    }
    const timer = setInterval(() => {
      if (this.stopping) return;
      const state = readPlan(file);
      if (!state || state.chat !== this.sessionId) return;
      const signature = planSignature(state);
      if (signature === this.planPublished) return;
      // A hand edit is not this turn's plan: the epoch stays, so a reader
      // touching the file never turns into a nudge.
      this.planPublished = signature;
      this.planState = state;
      this.emitUpdate(this.planFrame(state));
    }, 1_000);
    timer.unref?.();
    this.planWatch = timer;
  }

  private unwatchPlan(): void {
    if (this.planWatch) clearInterval(this.planWatch);
    this.planWatch = undefined;
  }

  private emitUpdate(update: Record<string, unknown>): void {
    if (this.stopping || !this.out) return;
    this.decorateUpdate(update);
    this.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: this.sessionId, update } });
  }

  /**
   * Single funnel for every ACP update. Subagent additions ride here so the
   * loop itself stays untouched: the `task` call gets a headline ("task:
   * explore: …") for its card, the harness gets the child's report on the
   * tool's terminal update, and the child's spend joins the session's totals
   * (the harness overwrites — never accumulates — usage per update).
   */
  private decorateUpdate(update: Record<string, unknown>): void {
    if (update.sessionUpdate === "usage_update") {
      const used = Number(update.used ?? 0) || 0;
      if (used > 0) {
        this.lastMeasuredUsed = used;
        // A report that names no fresh input is this agent repeating the chip's
        // last figure (the `/compact` path), not the provider counting again.
        if (Number(update.inputTokens ?? 0) > 0) {
          this.lastBilledView = used;
          this.lastBilledInput = Number(update.inputTokens) || 0;
          // The first request after a pass is the only thing that can price the
          // view it left; its row is still holding a `*` for that number.
          this.fillCompaction(this.lastBilledInput);
        }
      }
      // The billing fields ride an increment: what THIS report adds — the call
      // a step just measured, the part of a turn's bill its steps did not
      // already report, a compaction pass. Fold it in and put the session's
      // totals on the wire: the harness keeps the latest update verbatim, so a
      // snapshot scoped to whatever happened last is what made the panel's
      // in/out rows jump backwards mid-run — a session-scoped one only grows.
      const usage = this.sessionUsage;
      const addedIn = Number(update.inputTokens ?? 0) || 0;
      const addedCached = Number(update.cachedInputTokens ?? 0) || 0;
      usage.inputTokens += addedIn;
      usage.outputTokens += Number(update.outputTokens ?? 0) || 0;
      usage.cachedInputTokens += addedCached;
      // The verdict of the request this report prices, once: an unchanged head
      // that the provider still billed in full is a cache miss nobody here can
      // fix, and the panel counts it separately from the ones a moved head cost.
      if (this.headIntact === true && addedIn > 0 && addedCached === 0) {
        usage.coldMisses += 1;
        usage.coldMissTokens += addedIn;
      }
      this.headIntact = null;
      const bridge = this.activeSubagents;
      if (bridge) {
        const keys = ["inputTokens", "outputTokens", "cachedInputTokens"] as const;
        for (const key of keys) {
          const seen = Number(bridge.usage[key] ?? 0) || 0;
          const newMoney = Math.max(0, seen - this.bridgeReported[key]);
          this.bridgeReported[key] += newMoney;
          usage[key] += newMoney;
        }
      }
      update.inputTokens = usage.inputTokens;
      update.outputTokens = usage.outputTokens;
      update.cachedInputTokens = usage.cachedInputTokens;
      update.coldMisses = usage.coldMisses;
      update.coldMissTokens = usage.coldMissTokens;
      return;
    }
    const bridge = this.activeSubagents;
    if (!bridge) return;
    if (update.sessionUpdate === "tool_call" && update.toolName === "task") {
      const input = (update.rawInput ?? {}) as {
        agent?: unknown;
        system_prompt?: unknown;
        prompt?: unknown;
      };
      const label =
        typeof input.agent === "string" && input.agent.trim()
          ? input.agent.trim()
          : typeof input.system_prompt === "string" && input.system_prompt.trim()
            ? "ad-hoc"
            : "task";
      const brief = String(input.prompt ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
      update.title = `task: ${label}${brief ? `: ${brief}` : ""}`;
      return;
    }
    if (update.sessionUpdate === "tool_call_update" && update.status === "completed") {
      const report = bridge.results.get(String(update.toolCallId ?? ""));
      if (report !== undefined) {
        update.result = report;
        bridge.results.delete(String(update.toolCallId ?? ""));
      }
    }
  }

  /** Delegates the call to the harness so `permissionPolicy` applies to us. */
  private async askPermission(toolCall: {
    title: string;
    kind: string;
    input: Record<string, unknown>;
  }): Promise<void> {
    const res = await this.rpc.request<{ outcome?: { outcome?: string; optionId?: string } }>(
      "session/request_permission",
      {
        sessionId: this.sessionId,
        toolCall: { title: toolCall.title, kind: toolCall.kind, input: toolCall.input },
        options: [
          { optionId: "allow_once", kind: "allow_once", name: "Разрешить один раз" },
          { optionId: "reject_once", kind: "reject_once", name: "Запретить" },
        ],
      },
    );
    const outcome = res?.outcome;
    if (outcome?.outcome !== "selected" || !/^allow/i.test(outcome.optionId ?? "")) {
      throw new Error(`Операция отклонена: ${toolCall.title}`);
    }
  }

  // ── Context window ────────────────────────────────────────────────────────

  /**
   * Body fields for the wire effort knob. `off` kills the thinking pass — for
   * an endpoint that names levels (DeepSeek and friends) `reasoning_effort:
   * "none"` does it, for the rest the common `thinking` switch; a declared
   * level goes out as `reasoning_effort`; `default` sends nothing at all.
   */
  private reasoningBody(
    selection: BuiltinModelSelection,
  ): Record<string, unknown> | undefined {
    const level = this.effort.trim().toLowerCase();
    const declared = selection.efforts;
    if (this.thinkingOff || EFFORT_OFF.has(level)) {
      return declared.length
        ? { reasoning_effort: "none", ...THINKING_DISABLED_BODY }
        : THINKING_DISABLED_BODY;
    }
    if (!level || level === "default") return undefined;
    return { reasoning_effort: level };
  }

  /**
   * Endpoint client for one selection. Rebuilt per call so `{{sessionId}}`
   * resolves to the session that is asking.
   *
   * No cache markers go into the request: the `/chat/completions` endpoints this
   * agent talks to cache a matching prefix on their own (OpenAI, DeepSeek,
   * Gemini and most relays). What they need from us is the other half — a prefix
   * that does not change for no reason, which the pinned mask, the stable
   * offload ids and the carried-over digest provide.
   */
  private endpointFor(selection: BuiltinModelSelection) {
    return builtinEndpoint(
      selection.provider,
      this.sessionId,
      this.reasoningBody(selection),
      // The stored transcript, not the view: a pruned view is still a thinking
      // conversation, and the echo must survive the pruning.
      () => this.echoReasoning(),
      {
        onDrift: (drift) => this.warnDrift(drift),
        // The head verdict rides every request, whatever the Diagnostics switch
        // says: it is what splits the bill in the tokens panel into "wrong head"
        // and "cold provider cache", and the switch only decides whether the
        // warning card is drawn.
        onAnswer: (status) => {
          this.answerStatus = status;
        },
        onHead: (head) => {
          this.headIntact = head.intact;
          // A request whose head went out unchanged is no longer the pass's
          // rewritten view: a flag left over from a `/compact` must not swallow
          // the first break that comes after it.
          if (head.intact) this.passRewroteView = false;
        },
        // Settings → Diagnostics: off means the head is not even hashed. Read
        // per request, so the switch reaches the very next call.
        watch: () => this.watching === true,
      },
    );
  }

  /**
   * The endpoint the summariser's asks go through: the chat's own bytes (body
   * overrides, reasoning echo — a digest ask is a prefix of the turn's request
   * exactly because nothing else differs), on a lane of its own, which is what
   * keeps its deliberately shortened head off the chat's drift comparison.
   */
  private digestEndpoint(selection: BuiltinModelSelection) {
    return builtinEndpoint(
      selection.provider,
      this.sessionId,
      this.reasoningBody(selection),
      () => this.echoReasoning(),
      // No `onDrift`: a head that moved inside the pass is the pass's own
      // doing, and nothing here draws a card (the same rule children follow).
      // The status is the chat's own: the pass sends the chat's bytes, so an
      // accepted answer vouches for the prefix a failed turn would otherwise
      // rewrite.
      {
        watch: () => this.watching === true,
        onAnswer: (status) => {
          this.answerStatus = status;
        },
      },
      COMPACTION_LANE,
    );
  }

  /**
   * Settings → Diagnostics → context drift, as of the last turn this chat ran.
   * `undefined` before the first turn: the endpoint outlives turns, and a switch
   * turned off right now must not leave the comparison running for a session
   * that starts on it.
   */
  private watching: boolean | undefined;

  /**
   * Whether this turn's requests carry the reasoning echo, once decided.
   * `undefined` asks the transcript again — see `echoReasoning`.
   */
  private echoThinking: boolean | undefined;

  /**
   * Status of the last answer the turn's endpoint gave, `undefined` before the
   * first one — the half of the echo rule that is not the transcript's: a
   * refused or unreachable call cached nothing, so the rerun may decide again,
   * while an accepted one was read and cached whatever its stream did next.
   */
  private answerStatus: number | undefined;

  /**
   * Does the conversation think, as far as this turn's requests are concerned?
   *
   * Asked once, at the session's first request, and held from then on — across
   * turns, and across a restart (the answer is stored with the session): the
   * transcript grows its own reasoning while a chat runs, and a decision
   * retaken would add `reasoning_content` to an assistant message that already
   * went out without it. The provider's cache stops at the first message that
   * changed, so that field cost the whole tail of every later request in the
   * turn (chat 7a6c147b: cached 9 600 of 11 430 where the step before it read
   * 9 088 of 9 698) — and a turn boundary is not free either: chat b5852ea0
   * was answered from cache for 2 of its 67 messages, because a steer started a
   * turn that retook the decision.
   *
   * A refused attempt is the other half of the rule: a 400 turned no prefix into
   * a cached one, so the question may be asked again and the rerun can satisfy
   * an endpoint that demands the echo (`400 … The reasoning_content in the
   * thinking mode must be passed back to the API`) at the cost of one break
   * the reader would have paid anyway. The same holds only for a refusal — an
   * answer the endpoint accepted does not give the decision back (see `turn`).
   */
  private echoReasoning(): boolean {
    if (this.echoThinking === undefined) this.echoThinking = hasReasoning(this.messages);
    return this.echoThinking;
  }

  /**
   * The chat says out loud that its context moved in the middle. The provider
   * matches a cached prompt from the first message, so a head that shifted
   * below it is billed in full from that point — the reader has to learn it
   * from the transcript, not from the invoice.
   *
   * With Settings → Diagnostics → context drift on, the warning is also the card
   * that decides this request: nothing is sent until the reader answers, and
   * “stop” ends the turn here. `false` is that answer.
   *
   * One warning per turn: a break found at the first step is the same break at
   * every step after it, and a chat that kept repeating it would bury itself.
   */
  private async warnDrift(drift: ContextDrift): Promise<boolean> {
    // The pass that just ran is the cause of this break (see `passRewroteView`):
    // nothing is sent until the reader answers, so the only answers are "pay it"
    // and "end the turn" — a question with no choice behind it.
    if (this.passRewroteView) {
      this.passRewroteView = false;
      return true;
    }
    if (this.driftWarned) return true;
    this.driftWarned = true;
    this.emitUpdate({
      sessionUpdate: "context_drift",
      ...drift,
      // Whether a support archive of this chat can be built right now: bodies
      // are only on disk in `full` mode, and the button follows that.
      logMode: wireLogState(),
    });
    return this.confirmDrift(drift);
  }

  /**
   * Park the request on the reader: continue as planned, or stop the turn. This
   * is not the model asking anything — it is the loop holding its own next
   * request — so the answer is drawn on the drift row itself (its own request
   * kind, `context_drift`), never as a question bubble with a model preamble.
   * The row is still durable: the answer survives a reconnect like any other.
   */
  private async confirmDrift(drift: ContextDrift): Promise<boolean> {
    const ru = this.opts.settings.locale === "ru";
    // Which head moved is the whole answer: the system prompt, the tool list, or
    // a message in the middle. Without it the card read "0 of 279" and left the
    // reader to guess (chat a26a4eca).
    const what = drift.systemChanged
      ? ru
        ? "Системный промпт (правила, скиллы, настройки) изменился целиком."
        : "The system prompt itself changed — rules, skills or the settings it is written from."
      : drift.toolsChanged
        ? ru
          ? "Набор инструментов изменился."
          : "The tool list changed."
        : "";
    const prompt = (
      ru
        ? `Начало запроса изменилось: совпало ${drift.prefixSame} из ${drift.prevMessages} ` +
          `сообщений, сейчас ${drift.messages}. ${what}${what ? " " : ""}Запрос ещё не отправлен. ` +
          "Кэш провайдера отвечает только на неизменное начало — всё после сдвига оплачивается полностью."
        : `The request's head moved: ${drift.prefixSame} of ${drift.prevMessages} messages still ` +
          `match, ${drift.messages} now. ${what}${what ? " " : ""}The request has not been sent yet. ` +
          "The provider's cache only answers an unchanged head — everything past the shift is billed in full."
    );
    let picked = "";
    try {
      const res = await this.rpc.request<{
        outcome?: { answers?: Array<{ selectedOptionIds?: string[] }> };
      }>("builtin/context_drift", {
        title: ru ? "Контекст изменился в середине хода" : "The context changed mid-turn",
        // The row these answers belong to is already in the transcript; the
        // counts ride along so a host that lost it can still draw one.
        messages: drift.messages,
        prevMessages: drift.prevMessages,
        prefixSame: drift.prefixSame,
        // The file this miss was written to, for a host that has to draw the
        // card from scratch: the name is what turns a warning into a record.
        ...(drift.driftFile ? { driftFile: drift.driftFile } : {}),
        questions: [
          {
            id: "drift",
            prompt,
            options: [
              { id: "continue", label: ru ? "Продолжить" : "Continue" },
              { id: "stop", label: ru ? "Остановить ход" : "Stop the turn" },
            ],
          },
        ],
      });
      picked = res?.outcome?.answers?.[0]?.selectedOptionIds?.[0] ?? "";
    } catch {
      // No card to show (host restarted, turn cut): the warning stands on its
      // own and the request goes out — silence is not a stop.
      return true;
    }
    // A turn cancelled while the card waited: there is nothing left to send.
    if (this.abort?.signal.aborted) return false;
    if (picked !== "stop") return true;
    this.driftStopped = true;
    this.emitUpdate({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: ru
          ? "Ход остановлен: контекст запроса изменился."
          : "The turn was stopped: the request's context had changed.",
      },
    });
    this.abort?.abort();
    return false;
  }

  /**
   * Manual `/compact [focus]`: the pass the threshold would run, with the line
   * lowered so it fires now, and an optional focus line the digest must carry.
   */
  private async compactNow(
    selection: BuiltinModelSelection,
    focus: string,
  ): Promise<{ stopReason: string }> {
    // The pass rewrites the prefix (the covered messages become one digest), so
    // its own requests have already lost the cache: the echo may be decided
    // again here, where nothing of the old bytes survives anyway.
    this.echoThinking = undefined;
    const live = await this.settings();
    const digestModel = this.digestEndpoint(selection).chatModel(selection.modelId);
    const abort = new AbortController();
    this.abort = abort;
    try {
      const before = this.compaction?.covered ?? 0;
      // This prompt's own accumulator: its pass bill has nowhere else to go —
      // there is no turn after it to carry the report.
      this.pendingUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
      // The pass rides on the head the chat sends, rebuilt from what the session
      // froze (see `freezeHead`): after a restart nothing of the last turn is in
      // memory, and a digest request without the head shares no prefix with the
      // turn's — billed in full, on the one pass that matters.
      await this.freezeHead(live);
      const { system, tools } = await this.renderHead({
        // A pass cannot call a tool (`declareOnly` strips every executor), so no
        // picture ever needs a place in the turn.
        onImages: () => {},
        bashTimeoutMs: normalizeBuiltinBashTimeoutSec(live.builtinBashTimeoutSec) * 1000,
      });
      await this.promptHistory({
        contextWindow: selection.contextWindow,
        model: digestModel,
        digestModel,
        abortSignal: abort.signal,
        system,
        tools,
        force: focus,
        manual: true,
      });
      const after = this.compaction?.covered ?? 0;
      // A pass that folded something reports itself through the compaction row
      // (see `emitCompaction`); only "nothing to squeeze" still needs words.
      if (after <= before) {
        const ru = this.opts.settings.locale === "ru";
        this.emitUpdate({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: ru
              ? "Сжимать нечего: история и так ниже линии."
              : "Nothing to compact: the history is already below the line.",
          },
        });
      }
      // The pass's bill is in the session's totals already (see `ask`), but
      // totals only reach the panel through an update: the compaction row
      // prices only the digest's output, so without this one the pass would
      // stay unread until the next turn. A provider that reported no usage for
      // it leaves the panel on the previous figures, as before.
      const pending = this.pendingUsage;
      if (pending.inputTokens || pending.outputTokens || pending.cachedInputTokens) {
        this.emitUpdate({
          sessionUpdate: "usage_update",
          size: selection.contextWindow,
          // The squeezed size is an estimate until the next call measures it:
          // the chip keeps the last number the provider itself put on this
          // window, and the next turn replaces it with the real one.
          used:
            this.lastMeasuredUsed > 0
              ? this.lastMeasuredUsed
              : pending.inputTokens + pending.outputTokens,
        });
        this.pendingUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
      }
      return { stopReason: "end_turn" };
    } finally {
      this.abort = null;
    }
  }

  /**
   * `/thinking off|on` (bare = toggle): the wire switch that stops the endpoint
   * from running its thinking pass at all — the thing that actually costs those
   * reasoning tokens. Separate from the prompt-side Default/Low the ⋯ menu
   * picks: that one only asks the model to be brief, it cannot stop it.
   */
  private setWireThinking(arg: string): { stopReason: string } {
    const ru = this.opts.settings.locale === "ru";
    const word = arg.trim().toLowerCase();
    const on = word === "on" || word === "true" || word === "1" || word === "вкл";
    const off = word === "off" || word === "false" || word === "0" || word === "выкл";
    if (word && !on && !off) {
      this.emitUpdate({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: ru
            ? "Не понял аргумент. `/thinking off` выключает проход размышлений, `/thinking on` включает, `/thinking` без аргумента переключает."
            : "Did not understand the argument. `/thinking off` disables the thinking pass, `/thinking on` enables it, bare `/thinking` toggles.",
        },
      });
      return { stopReason: "end_turn" };
    }
    this.thinkingOff = word ? off : !this.thinkingOff;
    // Keep the picker's own knob in step: it shows the same wire state.
    if (this.thinkingOff) this.effort = this.selectionEfforts().includes("none") ? "none" : "off";
    else if (EFFORT_OFF.has(this.effort)) this.effort = "default";
    this.persist();
    this.emitUpdate({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: this.thinkingOff
          ? ru
            ? 'Thinking выключен: запросы уходят с `thinking: {"type": "disabled"}`. Включить — `/thinking on`.'
            : 'Thinking is off: requests go out with `thinking: {"type": "disabled"}`. Turn it back on with `/thinking on`.'
          : ru
            ? "Thinking включён: эндпоинт снова решает сам, думать ли. Выключить — `/thinking off`."
            : "Thinking is on: the endpoint decides again whether to think. Turn it off with `/thinking off`.",
      },
    });
    return { stopReason: "end_turn" };
  }

  /**
   * `/thinking-limit [on|off|<chars>]` (bare = report): the mid-think fuse.
   * Past the threshold a model call is cut while it is still only thinking,
   * the reasoning it produced is folded into the history, and the turn
   * continues with a reminder to act. Sets this chat's override — `off` pins
   * it off even when the global setting arms the fuse, `on` hands control
   * back to the global setting (or the 3000-char default when that is off).
   */
  private async setThinkingLimit(arg: string): Promise<{ stopReason: string }> {
    const ru = this.opts.settings.locale === "ru";
    const global = normalizeBuiltinThinkingLimit((await this.settings()).builtinThinkingLimit);
    const word = arg.trim().toLowerCase();
    const on = word === "on" || word === "true" || word === "1" || word === "вкл";
    const off = word === "off" || word === "false" || word === "0" || word === "выкл";
    const report = () => {
      // The base line states the effective fuse; only the provenance varies.
      const source =
        this.thinkingLimit > 0 && this.thinkingLimitOverride === undefined
          ? ru
            ? " Порог взят из глобальной настройки."
            : " The cap comes from the global setting."
          : this.thinkingLimit === 0 && this.thinkingLimitOverride === 0 && global > 0
            ? ru
              ? ` В этом чате он выключен вручную, хотя глобальная настройка: ${global} символов.`
              : ` Off in this chat by choice, while the global setting is ${global} chars.`
            : "";
      this.emitUpdate({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text:
            (this.thinkingLimit > 0
              ? ru
                ? `Предохранитель включён: размышления шага длиннее ${this.thinkingLimit} символов обрываются с напоминанием действовать. Выключить — \`/thinking-limit off\`, новый порог — \`/thinking-limit <символы>\`.`
                : `Fuse is on: a step's reasoning past ${this.thinkingLimit} chars is cut and the model is reminded to act. Turn off with \`/thinking-limit off\`, set a new cap with \`/thinking-limit <chars>\`.`
              : ru
                ? `Предохранитель выключен: размышления ничем не ограничены. Включить — \`/thinking-limit on\` (${
                    global > 0 ? "глобальная настройка" : "3000 символов"
                  }), свой порог — \`/thinking-limit <символы>\`.`
                : `Fuse is off: reasoning is unlimited. Turn it on with \`/thinking-limit on\` (${
                    global > 0 ? "follows the global setting" : "3000 chars"
                  }) or set your own with \`/thinking-limit <chars>\`.`) +
            source,
        },
      });
      return { stopReason: "end_turn" };
    };
    if (!word) return report();
    if (word && !on && !off && !/^\d+$/.test(word)) {
      this.emitUpdate({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: ru
            ? "Не понял аргумент. `/thinking-limit on` включает (3000 символов), `/thinking-limit off` выключает, `/thinking-limit 1500` ставит свой порог."
            : "Did not understand the argument. `/thinking-limit on` enables the fuse (3000 chars), `/thinking-limit off` disables it, `/thinking-limit 1500` sets your own cap.",
        },
      });
      return { stopReason: "end_turn" };
    }
    this.thinkingLimitOverride = off
      ? 0
      : on
        ? global > 0
          ? undefined
          : THINKING_LIMIT_DEFAULT_CHARS
        : Number(word);
    this.applyThinkingLimit(global);
    this.persist();
    return report();
  }

  /**
   * The prompt view of the stored history — the only thing these settings
   * shape. Tiers in the order of what they cost: archive a bulky result so it
   * can be read back, mask the results of tools that can simply be called again
   * (no model call at all), then, per `builtinContextMode`, digest the oldest
   * turns with one model call or drop them outright. `this.messages` keeps the
   * whole transcript either way, so a pass never destroys what the chat shows.
   */
  private async promptHistory(opts: {
    contextWindow: number;
    /** The summariser's model: the turn's own bytes, on the pass's own lane. */
    model: TurnModel;
    /** The same model again, named for what it is here — the digest's asks. */
    digestModel: TurnModel;
    abortSignal: AbortSignal;
    /** The system prompt this turn sends; empty for a session opened on `/compact`. */
    system: string;
    /** The declarations this turn sends — part of the prefix the provider caches. */
    tools?: ToolSet;
    /** Manual `/compact` — run a pass whatever the window says. */
    force?: string;
    /** Manual `/compact` — the row says a human asked for this pass. */
    manual?: boolean;
  }): Promise<ModelMessage[]> {
    const settings = await this.settings();
    // The tiers and the mask policy rewrite messages rather than the head, and
    // the provider's cache breaks at the first message whose bytes changed: they
    // read what the session's first turn froze, exactly like the head (see
    // `frozenHead`). Only the thresholds stay live — they decide when a pass runs,
    // and a pass rewrites the prompt on purpose and reports itself.
    const frozen = this.frozenHead;
    const contextMode = frozen?.contextMode ?? settings.builtinContextMode;
    const pruneReasoning = frozen?.pruneReasoning ?? settings.builtinPruneReasoning;
    const respectReasoningHistory =
      frozen?.respectReasoningHistory ?? settings.builtinRespectReasoningHistory;
    const keepLastConfigured = settings.builtinPruneToolResultsKeepLast;
    // Tier 0: bulky results move to the session archive under a stable id and
    // reach the model as a citation it can read back — reversible, unlike a
    // mask. Only the tail is decided: what already went out keeps the shape it
    // had, whatever the threshold says now.
    const offloaded = this.offload
      ? offloadToolResults(
          this.messages,
          this.offload,
          settings.builtinOffloadToolResultTokens,
          this.offloadUpTo,
        )
      : this.messages;
    // The tail just decided — archived or kept verbatim — is what goes on the
    // wire next, so the boundary moves with it. Advanced even with the switch
    // off: “kept verbatim” is a decision too, and a threshold set later may not
    // revise it.
    if (this.offload && this.offloadUpTo !== this.messages.length) {
      this.offloadUpTo = this.messages.length;
      this.persist();
    }
    // Tier 1: mask what can simply be called again. The boundary is pinned
    // between passes — advancing it every turn would rewrite the prefix and
    // throw away the provider's prompt cache for every later message.
    const keepLast = Math.max(0, offloaded.length - this.maskUpTo);
    // A thinking model reads its observation history, and hard masking costs it
    // ~10% of its solve rate (arXiv 2508.21433): leave it alone when reasoning
    // is present, unless the setting says otherwise.
    const skipMask =
      keepLastConfigured > 0 && respectReasoningHistory && hasReasoning(offloaded);
    const view = skipMask
      ? offloaded
      : maskToolResults(offloaded, keepLast, pruneReasoning);
    const thresholdPercent = opts.force !== undefined ? 1 : settings.builtinCompactionThresholdPercent;
    if (contextMode === "off" && opts.force === undefined) return view;
    if (contextMode === "prune" && opts.force === undefined) {
      const line = opts.contextWindow * (settings.builtinCompactionThresholdPercent / 100);
      // Both boundaries are sticky and move together: the cut only when the kept
      // view outgrows the line again, the notes with it. Advancing them every
      // turn rewrote the head of every later request, and the provider charged
      // the whole view again for a turn that added a sentence.
      if (opts.contextWindow > 0 && estimateTokens(view.slice(this.prunedFrom)) > line) {
        const kept = pruneMessages(view, opts.contextWindow, settings.builtinCompactionThresholdPercent);
        this.advanceMaskBoundary(keepLastConfigured);
        this.prunedFrom = Math.max(this.prunedFrom, this.messages.length - kept.length);
        this.persist();
      }
      // The notes this turn's boundary stands for, cut at the stored index —
      // and cut again after them, unlike the pass path, which keeps the digest
      // in front of the tail.
      const noted = skipMask
        ? this.messages
        : maskToolResults(this.messages, this.messages.length - this.maskUpTo, pruneReasoning);
      return noted.slice(this.prunedFrom);
    }
    const maxSummaryTokens = settings.builtinMaxSummaryTokens;
    // Output tokens the summariser wrote for THIS pass — every ask it makes,
    // retries included. The bill rides the compaction row: a digest the reader
    // can see but cannot price is half a bill.
    let summaryOutputTokens = 0;
    const ask = async (delta: ModelMessage[], previousSummary?: string, focus?: string) => {
      const answered = await this.askDigest(delta, {
        model: opts.digestModel,
        system: opts.system,
        tools: opts.tools,
        abortSignal: opts.abortSignal,
        maxSummaryTokens,
        previousSummary,
        focus,
      });
      summaryOutputTokens += answered.outputTokens;
      return answered.text;
    };
    const before = this.compaction?.covered ?? 0;
    // The "before" the row reports is the view this pass started from — digest
    // plus tail — not the stored transcript: the covered prefix has been out
    // of every request since the pass that wrote the digest.
    const tokensBefore = Math.max(
      estimateTokens(promptView(view, this.compaction)),
      // What the provider counted for the last request over this view: the same
      // bytes, priced by the tokenizer that bills them.
      this.lastBilledInput,
    );
    const result = await compactHistory({
      messages: view,
      contextWindow: opts.contextWindow,
      thresholdPercent,
      // A forced pass fires at 1% so it fires at all; what it produces still has
      // to sit under the line the setting names, or it is a retelling.
      fitPercent: settings.builtinCompactionThresholdPercent,
      keepRecentPercent: settings.builtinKeepRecentPercent,
      state: this.compaction,
      measuredTokens: this.lastBilledView,
      summarize: (dropped) => ask(dropped, undefined, opts.force),
      update: (delta, previous) => ask(delta, previous, opts.force),
    });
    if (result.state && result.state.covered !== before) {
      // An ordinary pass, not a fault: the row it reports says the same thing.
      console.log(
        `[builtin] compacted messages ${before}..${result.state.covered} into a digest ` +
          `(${skipMask ? "masking skipped: reasoning history" : ""})`,
      );
      this.compaction = result.state;
      this.advanceMaskBoundary(keepLastConfigured);
      this.lastBilledView = 0;
      // The view it priced is gone; the pass's own request is the next count.
      this.lastBilledInput = 0;
      this.persist();
      this.emitCompaction({
        manual: opts.manual === true,
        coveredBefore: before,
        coveredAfter: result.state.covered,
        tokensBefore,
        summary: result.state.summary,
        summaryOutputTokens,
      });
      // Tier 1 applies to the view this pass is about to send: the notes moved
      // with the digest, so this turn carries them from the start. Leaving them
      // to the next turn rewrites the tail once more — the same bytes charged a
      // second time, and the cached prefix broken for nothing.
      if (!skipMask) {
        const tail = this.messages.slice(result.state.covered);
        const prefix = result.messages.length - tail.length;
        // A pruned fallback is not the stored tail verbatim — leave it alone.
        if (prefix >= 0) {
          const keepFromEnd = Math.max(0, this.messages.length - this.maskUpTo);
          return [
            ...result.messages.slice(0, prefix),
            ...maskToolResults(tail, keepFromEnd, pruneReasoning),
          ];
        }
      }
    }
    return result.messages;
  }

  /**
   * One digest ask: the turns to fold, the previous digest when there is one,
   * and the instruction — over the very declarations and system prompt the turn
   * sends, with none of them able to execute. Its bill goes straight into the
   * session's totals: no turn's usage report would ever contain it.
   */
  private async askDigest(
    delta: ModelMessage[],
    opts: {
      model: TurnModel;
      system?: string | undefined;
      tools?: ToolSet | undefined;
      abortSignal: AbortSignal;
      maxSummaryTokens: number;
      previousSummary?: string | undefined;
      focus?: string | undefined;
    },
  ): Promise<{ text: string; outputTokens: number }> {
    const head: ModelMessage[] = [
      ...(opts.previousSummary ? [digestMessage(opts.previousSummary)] : []),
      ...delta,
    ];
    const tools = declareOnly(opts.tools);
    let outputTokens = 0;
    const instruction = digestInstruction(opts.previousSummary, opts.focus);
    // `tool_choice` stays at the provider default (`auto`): naming `none` makes
    // it drop the declarations from the prompt altogether, and the request then
    // shares nothing with the turn's (8188 vs 9690 tokens, 0% cached against 99%).
    const call = async (last: string): Promise<string> => {
      const { text, usage } = await generateText({
        model: opts.model,
        ...(opts.system ? { system: opts.system } : {}),
        messages: [...head, { role: "user", content: last }],
        ...(tools ? { tools } : {}),
        abortSignal: opts.abortSignal,
        maxRetries: 1,
        // 0 = the setting says "no ceiling": the provider default applies.
        ...(opts.maxSummaryTokens > 0 ? { maxOutputTokens: opts.maxSummaryTokens } : {}),
      });
      // This call is part of the prompt's bill, but no turn's usage report would
      // ever contain it: it goes straight into the session's totals, and the
      // next `usage_update` reports them (see `decorateUpdate`). `pendingUsage`
      // keeps its own copy — `/compact` reads it to decide whether the pass cost
      // anything worth reporting.
      const inTokens = Number(usage?.inputTokens ?? 0) || 0;
      const outTokens = Number(usage?.outputTokens ?? 0) || 0;
      const cachedTokens = Number(usage?.inputTokenDetails?.cacheReadTokens ?? 0) || 0;
      this.pendingUsage.inputTokens += inTokens;
      this.pendingUsage.outputTokens += outTokens;
      this.pendingUsage.cachedInputTokens += cachedTokens;
      this.sessionUsage.inputTokens += inTokens;
      this.sessionUsage.outputTokens += outTokens;
      this.sessionUsage.cachedInputTokens += cachedTokens;
      outputTokens += outTokens;
      return text;
    };
    const first = await call(instruction);
    if (first.trim()) return { text: first, outputTokens };
    // Nothing but a tool call came back: ask again on the same prefix (still
    // cached) with the line that leaves no room for one.
    return {
      text: await call(`${instruction}\n\nИнструменты не вызывай — ответь только текстом конспекта.`),
      outputTokens,
    };
  }

  /**
   * A full compaction between the steps of one turn — the pass a turn boundary
   * runs, digest and all, over the view the next step is about to send.
   *
   * A turn is one `promptHistory` call, so a turn's own growth was the one place
   * the threshold never looked.
   *
   * The digest this pass writes outlives the turn when the view it folded is one
   * message per stored message (`viewIndexed`), which is every view built by
   * `promptHistory` outside the pruned fallback and without a picture note: the
   * cut is then an index into `this.messages` as well, so the next turn's pass
   * can start from it instead of folding the same prefix again. It used to be
   * this turn's alone, and the second pass paid for the tail a second time at
   * full price — chat 62eba797 read 99 471 and then 106 173 tokens with `cached`
   * 0 while the bytes under the new digest were the ones it had just sent.
   */
  private async compactView(
    view: ModelMessage[],
    opts: {
      model: TurnModel;
      /** The summariser's model — the same one, on the compaction lane. */
      digestModel: TurnModel;
      system?: string | undefined;
      tools?: ToolSet | undefined;
      abortSignal: AbortSignal;
      contextWindow: number;
      settings: AppSettings;
      state?: CompactionState | undefined;
      /**
       * Stored-message index the digest at the head of a folded `view` stands
       * for. Absent when the view is one message per stored message.
       */
      foldedBase?: number | undefined;
      /** The provider's count of the request this view is measured against. */
      measuredTokens?: number | undefined;
    },
  ): Promise<{ messages: ModelMessage[]; state?: CompactionState }> {
    const settings = opts.settings;
    let summaryOutputTokens = 0;
    const ask = async (delta: ModelMessage[], previousSummary?: string) => {
      const answered = await this.askDigest(delta, {
        model: opts.digestModel,
        system: opts.system,
        tools: opts.tools,
        abortSignal: opts.abortSignal,
        maxSummaryTokens: settings.builtinMaxSummaryTokens,
        previousSummary,
      });
      summaryOutputTokens += answered.outputTokens;
      return answered.text;
    };
    // The provider's own count of the request this view is measured against
    // outvotes the estimate — that is the number the reader's bill carries.
    const tokensBefore = Math.max(
      estimateTokens(promptView(view, opts.state)),
      opts.measuredTokens ?? 0,
    );
    const result = await compactHistory({
      messages: view,
      contextWindow: opts.contextWindow,
      thresholdPercent: settings.builtinCompactionThresholdPercent,
      fitPercent: settings.builtinCompactionThresholdPercent,
      keepRecentPercent: settings.builtinKeepRecentPercent,
      ...(opts.state ? { state: opts.state } : {}),
      measuredTokens: opts.measuredTokens,
      summarize: (dropped) => ask(dropped, undefined),
      update: (delta, previous) => ask(delta, previous),
    });
    // A pass that folded nothing (the view did not fit under the line, so the
    // fallback pruned instead) is not a squeeze: a row for it would claim a
    // digest nobody wrote and a cut nobody made.
    if (result.state && result.state.covered > (opts.state?.covered ?? 0)) {
      // The cut counts view messages, and the view is the stored transcript plus
      // the turn's own steps — one entry each, unless a picture note was wedged
      // between them. A view that starts with a digest is one entry for its head
      // and many for the prefix that head stands for, so the cut is moved back
      // into stored indices through `foldedBase`. Either way the state this turn
      // really sent is what the next turn has to start from: dropping it made a
      // folded turn look unfolded to the turn-boundary pass, which then folded
      // the same bytes again and rewrote the digest — one full-price prefix per
      // turn (chat 9590a5eb: 10 passes, 7 of them from a `covered` of 0).
      // A view that is not one entry per stored message — the pruned fallback —
      // can carry picture notes the transcript never saw (see
      // `attachToolImages`): the cut counts them, the transcript does not, and a
      // note standing in front of the cut would name a stored message the pass
      // never covered. An aligned view carries no such note: `storeStep` writes
      // every picture note into the transcript as it lands, so subtracting it
      // there moved the digest's boundary a note early (chat e460dc05: three
      // notes inside the folded prefix, `covered` 136 instead of 139). Nothing
      // showed in that turn — the pass hands the loop its own cut view — and the
      // next turn rebuilt from the stored index, re-sent three digested messages
      // under the digest and lost the whole prefix: prefixSame 2 of 314, 148 893
      // tokens with `cached` 0.
      const aligned = opts.foldedBase !== undefined || this.viewIndexed;
      const notesBefore = aligned
        ? 0
        : view.slice(0, result.state.covered).filter(isToolImagesNote).length;
      const stored =
        opts.foldedBase !== undefined
          ? opts.foldedBase + result.state.covered - 1
          : result.state.covered - notesBefore;
      const before = opts.foldedBase ?? opts.state?.covered ?? 0;
      // Same reason as the turn-boundary pass: the count that fired this one
      // priced a view that no longer exists.
      this.lastBilledView = 0;
      this.lastBilledInput = 0;
      this.emitCompaction({
        manual: false,
        coveredBefore: before,
        coveredAfter: stored,
        tokensBefore,
        summary: result.state.summary,
        summaryOutputTokens,
      });
      const mappable = opts.foldedBase !== undefined || this.viewIndexed;
      if (mappable) {
        this.compaction = { summary: result.state.summary, covered: stored };
        this.advanceMaskBoundary(settings.builtinPruneToolResultsKeepLast);
        this.persist();
      }
    }
    return result;
  }

  /**
   * The pass, reported to the chat: a squeeze that happens silently is a bill
   * the reader cannot explain. Costs, sizes and the digest itself ride on the
   * update so the row can stand on its own, outside the turn's work.
   */
  private emitCompaction(info: {
    manual: boolean;
    coveredBefore: number;
    coveredAfter: number;
    /** The provider's count of the last request over this view, or the estimate when there is none. */
    tokensBefore: number;
    summary: string;
    /** Output tokens spent writing the digest; absent when the provider reports none. */
    summaryOutputTokens: number;
  }): void {
    // The next request carries the rewritten view: its break is this pass's
    // doing, not something the reader can decide (see `passRewroteView`).
    this.passRewroteView = true;
    const passId = (this.compactionPass += 1);
    // "After" is not measurable yet, and the estimate is exactly the number that
    // lied before (chat 9590a5eb: 200 135 estimated where the provider billed
    // 258 133). The row goes out with a `*` and `fillCompaction` puts the real
    // count on it as soon as the next request is billed.
    this.compactionAwaiting = passId;
    this.emitUpdate({
      sessionUpdate: "compaction",
      passId,
      manual: info.manual,
      coveredBefore: info.coveredBefore,
      coveredAfter: info.coveredAfter,
      tokensBefore: info.tokensBefore,
      tokensAfterPending: true,
      summary: info.summary,
      // 0 means "the provider did not say", not "free": the row omits it and
      // the chat shows an unknown instead of a confident zero.
      ...(info.summaryOutputTokens > 0 ? { summaryOutputTokens: info.summaryOutputTokens } : {}),
    });
  }

  /**
   * The provider counted the request a pass left behind: that count is the
   * row's "after". One fill per pass — the flag is cleared on the first report
   * with a fresh input count, so a later step of the same turn cannot overwrite
   * the number that belongs to the row.
   */
  private fillCompaction(tokens: number): void {
    const passId = this.compactionAwaiting;
    if (passId === undefined || !(tokens > 0)) return;
    this.compactionAwaiting = undefined;
    this.emitUpdate({
      sessionUpdate: "compaction_update",
      passId,
      tokensAfter: tokens,
    });
  }

  /**
   * Move the mask boundary to `messages.length - keepLast`. It only ever moves
   * forward and only when a pass already rewrote the prompt, so masking never
   * costs a cache hit on its own.
   */
  private advanceMaskBoundary(keepLastConfigured: number): void {
    if (!(keepLastConfigured > 0)) return;
    this.maskUpTo = Math.max(this.maskUpTo, Math.max(0, this.messages.length - keepLastConfigured));
  }

  /**
   * Fix the parts of the prompt that ride ahead of the messages, once per
   * session: the skills block, the repository's rules and the settings the
   * system prompt and the tool declarations are written from (see `frozenHead`).
   *
   * `prompt` and a `/compact` pass both call it, so a pass that has no turn
   * behind it — a chat restored from disk — sends the same head instead of none.
   * A setting that shapes any of it therefore lands with the next session, not
   * with the next turn: rewriting the head mid-chat bills the whole history
   * again (chat b0c36ffa paid 50 768 tokens for exactly that).
   */
  private async freezeHead(live: AppSettings, knownSkills?: BuiltinSkill[]): Promise<void> {
    // The skills block is the one part of the prompt that depends on skill
    // settings, and those are read live on every turn. The locale rides in it
    // too, so a chat keeps the language it started in — as it keeps the list.
    if (!this.frozenSkills) {
      const skills = knownSkills ?? (await discoverSettingsSkills(this.opts.settings, this.cwd));
      this.frozenSkills = {
        section: await renderSkillsSection(skills, live.builtinSkillModes, live.locale),
        supersedes: supersededRules(skills, live.builtinSkillModes),
      };
      this.persist();
    }
    // A rule that inlines itself between two requests moves the head of the
    // prompt, and the provider's cache only answers an unchanged head.
    if (this.frozenRules === null) {
      this.frozenRules = await renderProjectRules(this.cwd, live.builtinProjectRules);
      this.persist();
    }
    // The rest of the head: the system prompt and the tool declarations both sit
    // in front of the messages, so a knob turned in Settings must not reach them
    // mid-chat. The view tiers join them for the same money: they rewrite
    // messages rather than the head, and the cache breaks at the first one.
    if (!this.frozenHead) {
      const { tools: mcpEntries } = await this.mcp.ensure();
      this.frozenHead = {
        locale: live.locale,
        replyLanguage: normalizeBuiltinReplyLanguage(live.builtinReplyLanguage),
        thinking: this.thinking,
        planTool: live.builtinPlanTool !== false,
        outsideCwd: live.builtinAllowOutsideCwd === true,
        markdownImages: live.builtinMarkdownImages === true,
        extraInstructions: live.builtinExtraInstructions ?? "",
        servers: [...new Set(mcpEntries.map((entry) => entry.server))].sort(),
        contextMode: live.builtinContextMode,
        pruneReasoning: live.builtinPruneReasoning,
        respectReasoningHistory: live.builtinRespectReasoningHistory !== false,
        subagents: live.builtinSubagents ?? DEFAULT_BUILTIN_SUBAGENTS,
      };
      this.persist();
    }
    // The declarations are the half of the head the *servers* write, and they
    // are as much a part of it as the system prompt: listed live on every
    // transport, they moved whenever a server answered in another order, gained
    // a tool or missed its timeout, and the whole history was billed for it.
    // What the first turn declared stays declared. A chat stored before this
    // existed freezes on this turn, which sends those very declarations — so
    // the change costs no request anything.
    if (this.frozenTools === null) {
      const servers = new Set(this.frozenHead?.servers ?? []);
      const { tools: mcpEntries } = await this.mcp.ensure();
      this.frozenTools = snapshotMcpTools(mcpEntries.filter((entry) => servers.has(entry.server)));
      this.persist();
    }
  }

  /**
   * The head of every request this session sends: the system prompt and the tool
   * declarations, both written from what {@link freezeHead} fixed. Rebuilt
   * rather than remembered so the digest pass (and a `/compact` that follows a
   * restart) sends the same bytes the turn does — the declarations ride ahead of
   * the messages, and a summariser that omits them stops being a prefix of the
   * turn's (measured: 0% of the head from the provider's cache without them,
   * 98% with them).
   */
  private async renderHead(opts: {
    onImages: (toolCallId: string, images: ToolImagePart[]) => void;
    /** `bash`'s kill time when a call names none — live, and never in the schema. */
    bashTimeoutMs: number;
    /**
     * The turn only reads: a `read-only` skill was invoked (`/ask`). It does
     * **not** reach the head — neither the system prompt nor the declarations.
     * A head that moved for one turn is a head the provider's cache has never
     * seen, and a chat that alternates `/ask` with work pays for its whole
     * history on every switch (chat 13923ef4: 891 messages re-billed twice in
     * one hour). The writing tools refuse instead, and the turn's own message
     * says so (see `readOnlyTurnNote`).
     */
    readOnly?: boolean;
  }): Promise<{ system: string; tools: ToolSet }> {
    const head = this.frozenHead;
    if (!head) throw new Error("prompt head не заморожен");
    // The plan rides with the head: a plan is a file, so leaving it out of one
    // turn's declarations would move them, and the ask skill's refusal inside
    // `plan` is what keeps that turn from writing one.
    const planTool = head.planTool;
    const ask = (toolCall: { title: string; kind: string; input: Record<string, unknown> }) =>
      this.askPermission(toolCall);
    // The tools follow the head: a server connected mid-chat (or a switch
    // flipped) must not add one here — its tools arrive with the next session —
    // and the ones it declared are the declarations this chat froze, not what
    // the servers answer on this boot (see `frozenTools`).
    const { tools: mcpEntries } = await this.mcp.ensure();
    const offered = mcpEntries.filter((entry) => head.servers.includes(entry.server));
    const declared = this.frozenTools ? declaredMcpTools(this.frozenTools, offered) : offered;
    const system = systemPrompt(
      head.locale,
      head.replyLanguage,
      this.cwd,
      { servers: head.servers },
      this.frozenSkills?.section ?? "",
      this.frozenSkills?.supersedes ?? new Set<string>(),
      head.outsideCwd,
      head.markdownImages,
      // Its rule leaves the prompt with the tool, or the model would be told to
      // call a `plan` it does not have.
      planTool,
      head.extraInstructions,
      THINKING_INSTRUCTIONS[head.thinking],
      this.frozenRules ?? "",
    );
    const tools = {
      ...createBuiltinTools({
        host: this.rpc,
        sessionId: this.sessionId,
        ask,
        outsideCwd: head.outsideCwd,
        bashTimeoutMs: opts.bashTimeoutMs,
        // Declared on a read-only turn too — the declarations are the head — and
        // the `task` tool itself refuses the spawn (see `TaskToolHost.readOnly`).
        subagents: head.subagents.enabled
          ? { settings: head.subagents, bridge: () => this.activeSubagents }
          : undefined,
        plan: planTool ? this.planBridge() : undefined,
        readOnly: opts.readOnly === true,
        // Same channel as the MCP tools: `read` on a picture hands the bytes to
        // the turn, which puts them right after that call's result.
        onImages: opts.onImages,
      }),
      ...mcpToolSet(declared, { ask, onImages: opts.onImages }),
    };
    return { system, tools };
  }

  // ── The turn ──────────────────────────────────────────────────────────────

  /**
   * One turn at a time per session.
   *
   * The host cannot know when a stopped turn is really over: `session/cancel`
   * is a notification, and ACP answers nothing on "the turn has ended", so the
   * next `session/prompt` lands while the cancelled one is still waiting for its
   * tool. Two loops then share one history — the stopped turn appends its step
   * after the new user message, and each request rewrites the head the other
   * one just sent. Chat 8294560b lived that way for 90 minutes: two message
   * chains under one session id, one provider cache between them, and 24 %, 19 %
   * and 0 % of the prompt read from cache on the requests that crossed. Stopping
   * the live turn and letting it settle here is the whole fix; the step that was
   * still open lands before this prompt is recorded, never after.
   */
  private async prompt(params: Record<string, unknown>): Promise<{ stopReason: string }> {
    if (this.turnInFlight) {
      this.abort?.abort();
      await this.turnInFlight.catch(() => undefined);
    }
    const run = this.runPrompt(params);
    this.turnInFlight = run.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await run;
    } finally {
      this.turnInFlight = null;
    }
  }

  private async runPrompt(params: Record<string, unknown>): Promise<{ stopReason: string }> {
    if (!this.sessionId) throw new Error("session/new не был вызван");
    // Fail before the message is recorded: a retry after fixing Settings must
    // not stack duplicate user turns in the stored history.
    if (!hasBuiltinEndpoint(this.opts.settings)) {
      throw new Error("Не задан адрес встроенного агента — Настройки → Встроенный агент.");
    }
    if (!this.modelId) {
      throw new Error("Не выбрана модель встроенного агента — Настройки → Встроенный агент.");
    }
    const selection = resolveBuiltinModel(this.opts.settings, this.modelId);
    if (!selection) {
      throw new Error(
        `Модель "${this.modelId}" не найдена в настройках встроенного агента — Настройки → Встроенный агент.`,
      );
    }
    // `/compact [focus]` shapes the prompt view instead of asking the model
    // anything — it must not be recorded as a user turn.
    const manual = /^\/compact(?:\s+([\s\S]*))?$/.exec(promptText(params.prompt).trim());
    if (manual) return this.compactNow(selection, (manual[1] ?? "").trim());
    // `/thinking [on|off]` flips the wire switch: also a command, never a turn.
    const thinkingArg = THINKING_COMMAND_RE.exec(promptText(params.prompt).trim());
    if (thinkingArg) return this.setWireThinking(thinkingArg[1] ?? "");
    // `/thinking-limit [on|off|<chars>]` arms or disarms the mid-think fuse.
    const limitArg = THINKING_LIMIT_COMMAND_RE.exec(promptText(params.prompt).trim());
    if (limitArg) return this.setThinkingLimit(limitArg[1] ?? "");
    const skills = await discoverSettingsSkills(this.opts.settings, this.cwd);
    // An explicit `/name` message is rewritten into the skill's body plus the
    // request before it is recorded, so the stored history carries what the
    // model actually saw and a re-run expands identically.
    const promptParts = params.prompt;
    // A skill that only reads makes its turn read-only: `/ask` is a question,
    // and a question does not leave files behind. The name is matched before
    // the body is inlined, because the expansion is what the model sees and
    // this is what the harness does about it.
    const readOnly =
      matchSkillInvocation(
        promptText(promptParts),
        skills,
        this.opts.settings.builtinSkillModes,
      )?.skill.readOnly === true;
    const expanded = await expandSkillInvocation(
      promptText(promptParts),
      skills,
      this.opts.settings.builtinSkillModes,
      this.opts.settings.locale,
    );
    // A read-only turn says so here, in the tail, and nowhere else: the head is
    // the bytes the provider caches, and a mode that rewrote it billed the whole
    // history again on every `/ask` and again on the way back (see `renderHead`).
    const asked = readOnly
      ? `${expanded}${readOnlyTurnNote(this.frozenHead?.locale ?? this.opts.settings.locale)}`
      : expanded;
    // Recorded before the push, so the point names this turn's own first
    // message — the index an edit rewinds to (see `openSession`).
    const turnId = turnMessageId(params);
    if (turnId) this.turnIndex[turnId] = this.messages.length;
    this.messages.push(userContent(asked ? [{ type: "text", text: asked }] : promptParts));
    this.persist();
    // A steer aimed at an earlier turn must not ride into this one.
    this.settleSteers(false);

    const live = await this.settings();
    // Settings → Diagnostics: whether a request's head is compared at all. Read
    // here, per turn, so the switch reaches a chat that is already running.
    this.watching = live.diagnosticsContextDrift === true;
    // The fuse follows this chat's override, else the global setting — a knob
    // turned in Settings reaches this turn instead of a new session.
    this.applyThinkingLimit(normalizeBuiltinThinkingLimit(live.builtinThinkingLimit));
    // Settings → Built-in agent: every switch below is read once per session
    // (see `freezeHead`), so a toggle here arrives with the next chat.
    const { contextWindow } = selection;
    const abort = new AbortController();
    this.abort = abort;
    const { warnings } = await this.mcp.ensure();
    for (const warning of warnings) console.warn(`[builtin] MCP ${warning}`);
    await this.freezeHead(live, skills);
    const head = this.frozenHead;
    if (!head) throw new Error("prompt head не заморожен");
    // A rule whose `globs` match a file this conversation has already opened
    // belongs in front of the model — but behind everything already sent, so
    // the cached prefix still answers and only the note is charged. It lands
    // in front of the reader's own turn, never inside it.
    const ruleNotes = await renderRuleNotes(
      this.cwd,
      live.builtinProjectRules,
      touchedFiles(this.messages, this.cwd),
      new Set(this.deliveredRules),
    );
    if (ruleNotes.text) {
      this.deliveredRules.push(...ruleNotes.paths);
      this.messages.splice(
        Math.max(0, this.messages.length - 1),
        0,
        userContent([{ type: "text", text: ruleNotes.text }]),
      );
      this.persist();
    }
    const ask = (toolCall: {
      title: string;
      kind: string;
      input: Record<string, unknown>;
    }) => this.askPermission(toolCall);
    try {
      const endpoint = this.endpointFor(selection);
      // The summariser's endpoint: the same bytes on its own lane, so its
      // deliberately shortened head never reads as the chat's head moving.
      const digestModel = this.digestEndpoint(selection).chatModel(selection.modelId);
      // One bridge per prompt: slots and the usage accumulator must span the
      // turn and its wrap-up continuation.
      // Children run on their own model when one is configured — a fresh
      // endpoint for that provider — and on the session's model otherwise.
      const subagentsEnabled = head.subagents.enabled;
      const childChoice = subagentsEnabled
        ? subagentModelChoice(this.opts.settings, selection)
        : null;
      if (childChoice?.fellBack) {
        console.warn(
          `[builtin] subagent model "${head.subagents.model}" is not configured — children run on the session model`,
        );
      }
      // A child's requests are a prompt of their own (see `WireLogTarget.lane`),
      // so they get a lane: unlaned, they took the chat's head for their own and
      // the chat's next request drew a card over a prefix the provider had
      // cached. The endpoint mirrors the chat's whenever the child runs on the
      // same model, so the bytes stay the ones its own cache knows; the lane is
      // all that differs, and children never draw the card themselves.
      const childHooks = { watch: () => this.watching === true };
      const sameModel = !childChoice || childChoice.selection.value === selection.value;
      const childModel =
        !childChoice
          ? endpoint.chatModel(selection.modelId)
          : builtinEndpoint(
              childChoice.selection.provider,
              this.sessionId,
              sameModel
                ? this.reasoningBody(selection)
                : this.thinkingOff
                  ? THINKING_DISABLED_BODY
                  : undefined,
              sameModel ? () => this.echoReasoning() : undefined,
              childHooks,
              SUBAGENT_LANE,
            ).chatModel(childChoice.selection.modelId);
      const subagents = subagentsEnabled
        ? createSubagentsBridge({
            ask,
            model: childModel,
            extraSystem: THINKING_INSTRUCTIONS[head.thinking],
            // Children ruminate at the same prices: the parent's fuse binds them.
            reasoningLimitChars: this.thinkingLimit,
            contextWindow: childChoice?.selection.contextWindow ?? contextWindow,
            cwd: this.cwd,
            signal: abort.signal,
            // The roster the `task` declaration names, frozen with the head: a
            // child can never be addressed by a name the prompt does not list.
            settings: head.subagents,
            emit: (update: Record<string, unknown>) => this.emitUpdate(update),
            buildChildTools: (childAsk) =>
              createBuiltinTools({
                host: this.rpc,
                sessionId: this.sessionId,
                ask: childAsk,
                bashTimeoutMs: normalizeBuiltinBashTimeoutSec(live.builtinBashTimeoutSec) * 1000,
              }),
          })
        : null;
      this.activeSubagents = subagents;
      // One usage accumulator per prompt, cleared where the bridge is built:
      // the compaction pass below and every turn of this prompt (retries and
      // continuations included) report into it, and a retry that runs another
      // pass keeps both passes' bills.
      this.pendingUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
      // The new bridge's counter starts at zero, so the totals it feeds have
      // nothing counted yet.
      this.bridgeReported = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
      // Tool pictures are collected out of band, per call: the tool result stays
      // text (the wire takes nothing else there) and `runTurn` inserts each
      // picture as a user message right after its own result.
      const toolImages = new Map<string, ToolImagePart[]>();
      // The head is rebuilt from what `freezeHead` fixed rather than remembered
      // here, so every request of this chat — the summariser's, a `/compact`
      // after a restart — sends the very same bytes the provider has cached.
      const { system, tools } = await this.renderHead({
        onImages: (toolCallId, images) => toolImages.set(toolCallId, images),
        // Read live and kept out of the declarations: a raised limit reaches the
        // very next call without moving the head (see the `bash` schema).
        bashTimeoutMs: normalizeBuiltinBashTimeoutSec(live.builtinBashTimeoutSec) * 1000,
        // A read-only turn (`/ask`) refuses the tools that write and says so in
        // its own message; the head stays the one the cache already has.
        readOnly,
      });
      // A fresh turn: the warning about a moving head is its to earn again.
      this.driftWarned = false;
      // The reasoning echo is not retaken at a turn boundary: the field rides
      // every assistant message that has none, so a decision made again there
      // rewrites messages the provider has already cached — a steer ends one
      // turn and starts another, and that is how chat b5852ea0 lost the prefix
      // of 66 messages to one field on message 2. A failed attempt is the one
      // place it may be decided again (see the retry below): nothing cached it.
      this.driftStopped = false;
      // A turn is one `promptHistory` call, so a turn's own growth is the one
      // place the threshold never looked: chat c24d5224 rode its line for twenty
      // minutes. This hands the loop the same pass a turn boundary runs — digest
      // and all — at the step where the view crosses the line.
      //
      // One pass per turn. The pass hands the loop a rewritten chain — the digest
      // plus the verbatim tail, not one entry per stored message — and a second
      // pass over that chain would have to count its cut against the digest, not
      // against the transcript. One per turn is also all the bill justifies.
      let passedInTurn = false;
      const compactBetweenSteps = async (view: ModelMessage[], billed: number) => {
        if (live.builtinContextMode !== "summary" || passedInTurn) return undefined;
        const line = contextWindow * (live.builtinCompactionThresholdPercent / 100);
        if (!(line > 0) || !(billed > line)) return undefined;
        // The view this step sends is the turn's own: a boundary pass that folded
        // the transcript put its digest at the head, and the covered count then
        // means view messages (the digest is one of them), not stored ones. Hand
        // the pass a `covered` of 0 here and it declares the prefix unfolded,
        // asks the summariser to re-read the digest it already wrote, and falls
        // back to a bare prune that sends the whole tail at full price — chat
        // 0be3205c lost its head this way on the third step of every long turn.
        const headSummary = digestSummaryOf(view[0]);
        const folded = headSummary !== undefined;
        const state = folded
          ? ({ summary: headSummary, covered: 1 } as CompactionState)
          : // An unfolded view is one entry per stored message, which is the only
            // shape `covered` may be counted against. A pruned view is neither,
            // so the pass starts from nothing and rewrites what it must.
            this.viewIndexed
            ? this.compaction
            : undefined;
        const foldedBase = folded && headSummary === this.compaction?.summary ? this.compaction?.covered : undefined;
        const passed = await this.compactView(view, {
          model: endpoint.chatModel(selection.modelId),
          digestModel,
          system,
          tools,
          abortSignal: abort.signal,
          contextWindow,
          settings: live,
          state,
          ...(foldedBase !== undefined ? { foldedBase } : {}),
          measuredTokens: billed,
        });
        // One pass per turn, whether or not it squeezed: a second attempt over a
        // chain the first one rewrote would have to count its cut against the
        // digest instead of the transcript, and the bill has no room for it.
        passedInTurn = true;
        return passed.messages;
      };
      const turnOnce = async () => {
        const history = await this.promptHistory({
          contextWindow,
          // The turn asks nothing of the summariser: a pass inside a turn asks
          // on `digestModel` (see `promptHistory`).
          model: endpoint.chatModel(selection.modelId),
          digestModel,
          abortSignal: abort.signal,
          system,
          tools,
        });
        // One view message per stored message: an index a pass computes here is
        // also an index into `this.messages`, which is what lets its digest
        // outlive the turn (see `compactView`). A folded or pruned view is not
        // that, and the next turn's pass stays the one that writes the digest.
        this.viewIndexed = history.length === this.messages.length;
        return runTurn({
          model: endpoint.chatModel(selection.modelId),
          system,
          messages: history,
          tools,
          abortSignal: abort.signal,
          contextWindow,
          maxOutputTokens: live.builtinMaxOutputTokens,
          // The `/thinking-limit` fuse: past this many chars of one step's
          // private reasoning the call is cut and the turn carries on below.
          reasoningLimitChars: this.thinkingLimit,
          emit: (update) => this.emitUpdate(update),
          // `afterStep`: the host's mid-turn messages join the next model call
          // instead of waiting for this turn to end.
          takeSteer: () => this.takeSteers(),
          compactBetweenSteps,
          toolImages,
          // A step that already ran is part of the history from that moment on.
          // The turn's own fold (`keepResponse`) only lands if the turn ends, and
          // the interesting deaths are the ones where it does not: the process
          // restarts under a chat parked on a question, and the resumed session
          // starts from a transcript that never learned what the turn did — its
          // files, its background job, its tool results. The next request then
          // rebuilds a shorter head than the provider has cached (chat 0be3205c:
          // 479 messages after 484).
          storeStep: (messages) => {
            this.messages = [...this.messages, ...messages];
            this.persist();
          },
        });
      };
      // One attempt. A failed one may decide the echo again on the rerun — but
      // only when the answer was refused: a 400 turned no prefix into a cached
      // one, while an accepted answer did, whatever became of its stream (chat
      // 74e07024 answered a step `200` with an empty body, the rerun took the
      // echo again and gave six assistant messages a `reasoning_content: ""`
      // they had already gone out without — the provider's cache ended at the
      // first of them and the head matched 53 of 135).
      const turn = async () => {
        this.answerStatus = undefined;
        try {
          return await turnOnce();
        } catch (err) {
          if (!(this.answerStatus && this.answerStatus < 400)) this.echoThinking = undefined;
          throw err;
        }
      };
      // The folded messages sit where the model read them — mid-step, not at
      // the tail — so the stored history stays a truthful transcript. A failed
      // attempt is folded the same way: the retry then continues from what the
      // dead call had already produced instead of repeating that work.
      const keepResponse = (partial: TurnOutcome) => {
        // What `storeStep` already took is in `this.messages` — fold only the
        // rest, or the turn would store its own first steps twice.
        const folded = foldInjected(partial.response, partial.injected);
        this.messages = [...this.messages, ...folded.slice(partial.stored ?? 0)];
        this.persist();
      };
      // A stream that dies mid-flight throws before any response message
      // exists, so the stored history is still exact and the same turn can
      // simply run again; one that dies after producing messages comes back as
      // an outcome carrying `failure`, and is folded before the retry.
      // A step the model cut short — stopped on reasoning alone, or capped
      // mid-answer — is not an answer. The turn runs on from what it produced,
      // and this line is what tells it to pick up there instead of reading its
      // own cut-off output as the end.
      const carryOn =
        live.locale === "ru"
          ? "Предыдущий ход оборвался, не дойдя до ответа. Продолжи с того места, " +
            "где остановился, — не начинай заново."
          : "The previous turn was cut off before you wrote an answer. Continue from " +
            "where you stopped — do not start over.";
      // A reasoning cut gets the reminder, not the generic nudge: the step's
      // thinking is already in the history (folded by `keepPartial`), so the
      // model resumes from its own conclusions with a push to act on them.
      const afterReasoningCut =
        live.locale === "ru"
          ? `Размышления на шаге превысили лимит в ${this.thinkingLimit} символов и были обрезаны — ` +
            "их начало сохранено выше. Не продолжай рассуждать: действуй прямо сейчас по тому, " +
            "что уже понял, — вызови инструмент или дай ответ."
          : `The step's reasoning exceeded the ${this.thinkingLimit}-char limit and was cut — ` +
            "its beginning is kept above. Do not keep thinking: act right now on what you " +
            "already know — call a tool or give the answer.";
      const retryOpts = {
        signal: abort.signal,
        attempts: live.builtinTurnRetryAttempts ?? MAX_TURN_ATTEMPTS,
        note: (message: string) =>
          this.emitUpdate({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: message },
          }),
        // The outcome `runTurnWithRetry` gives back on exhaustion has already
        // been through `keepPartial` — folding it again would put a duplicate
        // of the last message into the history.
        keepPartial: (partial: TurnOutcome) => {
          folded = partial;
          keepResponse(partial);
        },
        continueAfter: (cut: TurnOutcome) => {
          const nudge = cut.reasoningLimitHit ? afterReasoningCut : carryOn;
          this.messages = [...this.messages, userContent([{ type: "text", text: nudge }])];
          this.persist();
        },
      };
      let folded: TurnOutcome | null = null;
      // The plan as it stands before this turn: a plan written later is this
      // turn's own promise, an older one is not (see the nudge below).
      const planEpochAtStart = this.planEpoch;
      const planApprovalsAtStart = this.planApprovals;
      let outcome = await runTurnWithRetry(turn, retryOpts);
      if (outcome.reasoningLimitHit && !abort.signal.aborted) {
        // The fuse spent its continuations and the turn is still silent: on
        // this cap the model cannot finish a single step without being cut.
        // One last call with the fuse off — its thinking is already in the
        // history with the reminder, and an answer must reach the user.
        this.messages = [...this.messages, userContent([{ type: "text", text: afterReasoningCut }])];
        this.persist();
        const cap = this.thinkingLimit;
        this.thinkingLimit = 0;
        try {
          folded = null;
          outcome = await runTurnWithRetry(turn, retryOpts);
        } finally {
          this.thinkingLimit = cap;
        }
      }
      // The turn that wrote a plan owes the reader a button. `apply_plan` is the
      // card above the input, and a turn that ends without it leaves a promise
      // nobody can answer (seen: a one-line "the card above the input approves
      // it" over a plan no card had ever asked about). A refusal moved the count
      // too — the reader answered, so there is nothing forgotten to remind of.
      for (let asked = 1; !abort.signal.aborted && asked <= PLAN_APPROVAL_NUDGES; asked += 1) {
        if (outcome.failure || outcome.reasoningLimitHit) break;
        if (outcome.stopReason !== "end_turn" && outcome.stopReason !== "max_tokens") break;
        if (this.planEpoch === planEpochAtStart) break;
        if (this.planApprovals !== planApprovalsAtStart) break;
        const plan = this.planState;
        // Only a plan that could actually be approved: no steps or no problem
        // and `apply_plan` would refuse the call it is being sent back for.
        if (!plan || plan.stage !== "draft") break;
        if (!plan.entries.length || !(plan.problem ?? "").trim()) break;
        if (folded !== outcome) {
          keepResponse(outcome);
          folded = outcome;
        }
        this.messages = [
          ...this.messages,
          userContent([
            { type: "text", text: planApprovalNudge(live.locale, this.planDisplayPath()) },
          ]),
        ];
        this.persist();
        retryOpts.note("План записан, но не одобрен: прошу модель поднять карточку одобрения.");
        outcome = await runTurnWithRetry(turn, retryOpts);
      }
      // The turn that wrote a plan owes its steps: the panel is what the reader
      // watches, and a turn ending with half of it open is work abandoned
      // mid-way. Asked twice at most — the nudge names the two honest ways out
      // (do the step, or say why not), so a plan that cannot be finished ends
      // with an answer rather than a spin.
      for (let asked = 1; !abort.signal.aborted && asked <= PLAN_FINISH_NUDGES; asked += 1) {
        if (outcome.failure || outcome.reasoningLimitHit) break;
        if (outcome.stopReason !== "end_turn" && outcome.stopReason !== "max_tokens") break;
        if (this.planEpoch === planEpochAtStart) break;
        // Only an approved plan is a promise this turn owes. A plan still in
        // `draft` is what the reader is reading — pushing the model to close it
        // is exactly the case the user asked us not to push. `step` pacing is
        // the same request in the reader's own words: one step, then it is
        // their floor again, so nothing pushes the model there either.
        if (this.planState?.stage !== "applying") break;
        if (this.planState.pacing === "step") break;
        const open = this.openPlanSteps();
        if (!open.length) break;
        // What this turn produced has to be in the history the rerun reads.
        if (folded !== outcome) {
          keepResponse(outcome);
          folded = outcome;
        }
        this.messages = [
          ...this.messages,
          userContent([{ type: "text", text: planFinishNudge(live.locale, open) }]),
        ];
        this.persist();
        retryOpts.note(
          `План не закрыт: прошу модель доработать оставшиеся шаги ` +
            `(${asked} из ${PLAN_FINISH_NUDGES}).`,
        );
        // The plan file is the record of that work: the model closes steps
        // with `plan`, and the reader sees them land in the panel.
        outcome = await runTurnWithRetry(turn, retryOpts);
      }
      if (folded !== outcome) keepResponse(outcome);
      if (outcome.failure) throw outcome.failure;
      // The reader stopped the turn: it ends where they stopped it, and the
      // steps already answered above stay in the history — a transcript that
      // forgets them drops them from the next request's head, and the chat
      // pays for its own history again (chat 8294560b: "совпало 3 из 6").
      if (outcome.cancelled) return { stopReason: "cancelled" };
      // The reader stopped the turn at the drift card: the request never left,
      // so the turn is over where they stopped it.
      if (this.driftStopped) return { stopReason: "cancelled" };
      return { stopReason: outcome.stopReason };
    } catch (err) {
      // The reader stopped the turn at the drift card: the request never left,
      // and the turn ends as a cancellation — not as a harness failure.
      if (isContextDriftStop(err)) return { stopReason: "cancelled" };
      throw err;
    } finally {
      this.abort = null;
      this.activeSubagents = null;
      // The turn's own messages are on the wire: what the archive may still
      // touch from here on is the next turn's tail (see `sealOffloadBoundary`).
      this.sealOffloadBoundary();
      // Whatever a steer was still waiting on belongs to a turn that is over.
      this.settleSteers(false);
    }
  }

  /**
   * `session/steer`: fold text into the turn that is running right now. No live
   * turn means nothing to fold into — the host queues the message instead.
   */
  private steer(params: Record<string, unknown>): Promise<{ delivered: boolean }> {
    const text = typeof params.text === "string" ? params.text : promptText(params.prompt);
    if (!this.abort || !text.trim()) return Promise.resolve({ delivered: false });
    return new Promise((resolve) => {
      this.steers.push({ text, resolve: (delivered) => resolve({ delivered }) });
    });
  }

  /** Drain the pending mid-turn messages for the next model call. */
  private takeSteers(): Array<{ message: ModelMessage; ack: () => void }> {
    return this.steers.splice(0).map((entry) => ({
      message: userContent([{ type: "text", text: entry.text }]),
      // The message is part of a prompt only once the loop says so.
      ack: () => entry.resolve(true),
    }));
  }

  /** Answer everyone still waiting on a steer the turn never got to. */
  private settleSteers(delivered: boolean) {
    for (const entry of this.steers.splice(0)) entry.resolve(delivered);
  }
}

export function createBuiltinTransport(opts: InProcessAgentOptions): InProcessAgentTransport {
  return new BuiltinAgent(opts);
}
