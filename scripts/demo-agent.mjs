/**
 * Scripted ACP agent for the documentation media: the chats in `docs/screens`
 * and the demo clip are photographed from a database seeded by `demo-data.mjs`,
 * never from a real one. This agent answers the prompts that script sends — it
 * is the only thing that decides what a screenshot says.
 *
 *   node scripts/demo-agent.mjs        (the server spawns it as "cursor")
 *
 * Every prompt is looked up by its exact text in `SCRIPT`; an unknown prompt
 * still gets a turn, so a typo in the seeder shows up as a plain answer instead
 * of a failed run. The turns talk about this repository, so the file paths in
 * the tool rows are the ones a reader can open.
 */
import readline from "node:readline";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The `/` menu a harness fills: without this the composer shows a spinner
 * instead of a list, and the slash screenshot has nothing to photograph.
 */
const COMMANDS = [
  { name: "review", description: "Review the working tree and report the risky bits" },
  { name: "test", description: "Run the suite that covers the file in question" },
  { name: "plan", description: "Lay the change out as steps before writing code" },
  { name: "changelog", description: "Draft the changelog line for this change" },
  { name: "explain", description: "Walk through the code the last turn touched" },
];

/** The picker a real Cursor CLI fills: one model, chosen, no extra knobs. */
const MODEL_OPTIONS = [
  {
    id: "model",
    name: "Model",
    type: "select",
    currentValue: "sonnet-4.5",
    options: [
      { value: "sonnet-4.5", name: "Sonnet 4.5" },
      { value: "composer-1", name: "Composer 1" },
    ],
  },
];

/**
 * Turns keyed by prompt text. Each entry is a list of steps the agent streams:
 * `thought` and `text` are chunks, `tool` opens a call and `done` closes it.
 */
const SCRIPT = {
  en: {
    "The settings page stays light in the dark theme. Where do its colours come from?": [
      ["thought", "The page ships its own stylesheet and the tokens live in global.css. Compare the two."],
      ["tool", { id: "t1", title: "read SettingsPage.module.css", kind: "read", path: "apps/web/src/pages/SettingsPage.module.css" }],
      ["done", "t1"],
      ["thought", "There it is: three rules that never ask for the token."],
      ["tool", { id: "t2", title: "grep --panel", kind: "search", path: "apps/web/src/styles/global.css" }],
      ["done", "t2"],
      [
        "text",
        "Found it — the page carries its own colours instead of reading the theme's:\n\n" +
          "- `apps/web/src/styles/global.css` defines `--panel`, `--panel-2` and `--border` on `:root` and again under `[data-theme='dark']`;\n" +
          "- `SettingsPage.module.css` hard-codes `background: #fff` in three rules, so the panel never sees the variable;\n" +
          "- the leaf panes already read `var(--panel-2)`, which is why only the right-hand side looked wrong.\n\n" +
          "Replace those three literals with `var(--panel)` and the page follows the theme like the rest of the shell.",
      ],
    ],
    "How does a board card decide which lane it sits in?": [
      ["thought", "The lane is derived on the board page, not stored on the card. Grep the helper."],
      ["tool", { id: "t1", title: "grep laneOf", kind: "search", path: "apps/web/src/pages/BoardPage.tsx" }],
      ["done", "t1"],
      [
        "text",
        "The lane is derived from the session, never stored. The checks run in this order:\n\n" +
          "1. **Done** — `doneAt` is set, and Mark done wins over a live turn.\n" +
          "2. **In Progress** — the session is `running`: a turn is streaming right now.\n" +
          "3. **Wait** — the turn ended (`idle` with `startedAt`), failed, or is parked on a question.\n" +
          "4. **Todo** — created and never run.\n\n" +
          "A card dragged by hand keeps its lane (`boardColumnId`) until a claimed turn takes it back.",
      ],
    ],
    "A slow turn kills the whole e2e run. Where is the timeout set?": [
      ["thought", "Playwright puts the ceiling in its own config; the app's idle guard is a different thing."],
      ["tool", { id: "t1", title: "read playwright.config.ts", kind: "read", path: "e2e/playwright.config.ts" }],
      ["done", "t1"],
      ["thought", "30 s per spec and no retries — one slow boot takes the whole run with it."],
      ["tool", { id: "t2", title: "edit playwright.config.ts", kind: "edit", path: "e2e/playwright.config.ts" }],
      ["done", "t2"],
      [
        "text",
        "`e2e/playwright.config.ts` now waits for a turn instead of a fixed 30 s:\n\n" +
          "- `timeout: 90_000` for the spec, since a run boots the built server and two phone layouts;\n" +
          "- `expect.timeout` stays at 10 s — a selector that never appears should still fail quickly;\n" +
          "- `retries: process.env.CI ? 1 : 0`: CI absorbs one flake, a local run keeps failing loudly.\n\n" +
          "`npm run test:e2e:desktop` passes: 10 tests, ~40 s.",
      ],
    ],
    "Which files did the timeout change touch?": [
      ["thought", "The turn touched one config file; nothing else reads the ceiling."],
      ["text", "One file: `e2e/playwright.config.ts` — the spec timeout, the expect timeout and the retry switch."],
    ],
    "Draft the VERSIONS.md row for the board lanes change.": [
      ["thought", "VERSIONS.md lists published releases only, so the row belongs to the next tag."],
      ["tool", { id: "t1", title: "read VERSIONS.md", kind: "read", path: "VERSIONS.md" }],
      ["done", "t1"],
      [
        "text",
        "The table takes one row per release, so this goes under the next tag:\n\n" +
          "```\n| 0.1.49 | — |\n```\n\n" +
          "**Boards** — a card keeps the lane you drag it to, and a finished turn no longer pulls it back to Wait.",
      ],
    ],
    "Should the e2e run retry a failed turn?": [
      ["thought", "A retry hides a real failure as well as a flake, so it belongs to CI only."],
      [
        "text",
        "One retry, CI only. A flaky socket on a runner is worth absorbing; the same retry locally hides a test that fails for a reason the reader could have fixed.",
      ],
    ],
  },
  ru: {
    "Страница настроек остаётся светлой в тёмной теме. Откуда она берёт цвета?": [
      ["thought", "У страницы свой стиль, а токены живут в global.css. Сравню оба."],
      ["tool", { id: "t1", title: "read SettingsPage.module.css", kind: "read", path: "apps/web/src/pages/SettingsPage.module.css" }],
      ["done", "t1"],
      ["thought", "Вот оно: три правила, которые даже не спрашивают токен."],
      ["tool", { id: "t2", title: "grep --panel", kind: "search", path: "apps/web/src/styles/global.css" }],
      ["done", "t2"],
      [
        "text",
        "Нашёл — страница носит свои цвета вместо цветов темы:\n\n" +
          "- `apps/web/src/styles/global.css` объявляет `--panel`, `--panel-2` и `--border` на `:root` и повторно под `[data-theme='dark']`;\n" +
          "- `SettingsPage.module.css` в трёх правилах жёстко пишет `background: #fff`, поэтому панель не видит переменную;\n" +
          "- панели справа уже читают `var(--panel-2)` — потому и выглядела чужой только правая часть.\n\n" +
          "Замените эти три литерала на `var(--panel)` — и страница начнёт следовать теме, как вся остальная оболочка.",
      ],
    ],
    "Как карточка доски выбирает, в какой она колонке?": [
      ["thought", "Колонка выводится на странице доски, а не хранится в карточке. Поищу функцию."],
      ["tool", { id: "t1", title: "grep laneOf", kind: "search", path: "apps/web/src/pages/BoardPage.tsx" }],
      ["done", "t1"],
      [
        "text",
        "Колонка выводится из сессии и никогда не хранится. Проверки идут по порядку:\n\n" +
          "1. **Done** — выставлен `doneAt`: «Готово» сильнее живого хода.\n" +
          "2. **In Progress** — сессия `running`, то есть ход стримится прямо сейчас.\n" +
          "3. **Wait** — ход закончился (`idle` с `startedAt`), упал или ждёт ответа на вопрос.\n" +
          "4. **Todo** — задача создана и ни разу не запускалась.\n\n" +
          "Карточку, перетащенную руками, держит её колонка (`boardColumnId`), пока её не заберёт запущенный ход.",
      ],
    ],
    "Один медленный ход валит весь e2e-прогон. Где задан таймаут?": [
      ["thought", "Потолок ставит конфиг Playwright, а собственный idle-guard приложения — это другое."],
      ["tool", { id: "t1", title: "read playwright.config.ts", kind: "read", path: "e2e/playwright.config.ts" }],
      ["done", "t1"],
      ["thought", "30 с на спек и ни одного повтора — один медленный старт уносит весь прогон."],
      ["tool", { id: "t2", title: "edit playwright.config.ts", kind: "edit", path: "e2e/playwright.config.ts" }],
      ["done", "t2"],
      [
        "text",
        "Теперь `e2e/playwright.config.ts` ждёт ход, а не фиксированные 30 с:\n\n" +
          "- `timeout: 90_000` на спек: прогон поднимает собранный сервер и два телефонных лэйаута;\n" +
          "- `expect.timeout` остался 10 с — селектор, который так и не появился, должен падать быстро;\n" +
          "- `retries: process.env.CI ? 1 : 0`: CI прощает один флейк, локальный прогон продолжает краснеть.\n\n" +
          "`npm run test:e2e:desktop` проходит: 10 тестов, ~40 с.",
      ],
    ],
    "Какие файлы задел таймаут?": [
      ["thought", "Ход тронул один конфиг; потолок больше никто не читает."],
      ["text", "Один файл: `e2e/playwright.config.ts` — таймаут спека, таймаут ожиданий и переключатель повторов."],
    ],
    "Собери строку в VERSIONS.md про колонки доски.": [
      ["thought", "VERSIONS.md перечисляет только выпущенные релизы, значит строка — для следующего тега."],
      ["tool", { id: "t1", title: "read VERSIONS.md", kind: "read", path: "VERSIONS.md" }],
      ["done", "t1"],
      [
        "text",
        "Таблица ведёт по строке на релиз, поэтому это уйдёт под следующий тег:\n\n" +
          "```\n| 0.1.49 | — |\n```\n\n" +
          "**Доски** — карточка остаётся в той колонке, куда её перетащили, и законченный ход больше не уводит её в «Ожидание».",
      ],
    ],
    "Нужен ли повтор упавшего хода в e2e-прогоне?": [
      ["thought", "Повтор прячет и флейк, и настоящую поломку — значит, ему место только в CI."],
      [
        "text",
        "Один повтор, только в CI. Флейк на раннере стоит простить, а локально тот же повтор скроет тест, который падает по причине, которую читатель мог бы починить.",
      ],
    ],
  },
};

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function notify(method, params) {
  write({ jsonrpc: "2.0", method, params });
}

let nextSession = 1;

/**
 * Streams one scripted turn. The delays are not decoration: the app's own chat
 * feed merges chunks into one message by arrival, and instant text would read
 * as a single block with no timing on its timer.
 */
async function runTurn(sessionId, steps) {
  for (const [kind, value] of steps) {
    await sleep(220);
    if (kind === "thought") {
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          messageId: "thought-1",
          content: { type: "text", text: value },
        },
      });
      continue;
    }
    if (kind === "tool") {
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: `${sessionId}-${value.id}`,
          title: value.title,
          toolName: value.title,
          kind: value.kind,
          status: "in_progress",
          rawInput: { path: value.path },
          locations: [{ path: value.path }],
        },
      });
      continue;
    }
    if (kind === "done") {
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: `${sessionId}-${value}`,
          status: "completed",
        },
      });
      continue;
    }
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "text-1",
        content: { type: "text", text: value },
      },
    });
  }
}

/**
 * The prompt's own language picks the script, so a chat never mixes them.
 *
 * Matching is by containment, not equality: a session's first turn reaches the
 * agent with the harness's own context blocks appended, and the reader's text
 * is one of several blocks — the script key has to be found inside it.
 */
function scriptFor(text) {
  const probe = text.replace(/\s+/g, " ");
  const pick = (map) =>
    Object.entries(map)
      .sort((a, b) => b[0].length - a[0].length)
      .find(([prompt]) => probe.includes(prompt.replace(/\s+/g, " ")));
  return pick(SCRIPT.ru) ?? pick(SCRIPT.en) ?? null;
}

function announceCommands(sessionId) {
  notify("session/update", {
    sessionId,
    update: { sessionUpdate: "available_commands_update", availableCommands: COMMANDS },
  });
}

async function handle(method, params) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true } },
        serverInfo: { name: "acpio-demo", version: "1.0.0" },
      };
    case "authenticate":
      return {};
    case "session/new": {
      const sessionId = `demo-${nextSession++}`;
      announceCommands(sessionId);
      return {
        sessionId,
        configOptions: structuredClone(MODEL_OPTIONS),
        modes: { availableModes: [] },
      };
    }
    case "session/load":
    case "session/resume":
      announceCommands(String(params.sessionId ?? ""));
      return { configOptions: structuredClone(MODEL_OPTIONS) };
    case "session/prompt": {
      const text = String(params.prompt?.map((p) => p?.text ?? "").join("") ?? "");
      const script = scriptFor(text);
      if (script) {
        await runTurn(params.sessionId, script[1]);
      } else {
        notify("session/update", {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "text-1",
            content: { type: "text", text: "No script for this prompt." },
          },
        });
      }
      return { stopReason: "end_turn" };
    }
    case "session/cancel":
    case "session/set_config_option":
    case "session/set_mode":
    case "session/close":
      return {};
    default:
      return {};
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === undefined) return;
  try {
    const result = await handle(msg.method, msg.params ?? {});
    if (msg.id !== undefined) write({ jsonrpc: "2.0", id: msg.id, result });
  } catch (err) {
    if (msg.id !== undefined) {
      write({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(err?.message ?? err) } });
    }
  }
});
