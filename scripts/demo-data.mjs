/**
 * Seeds the demo database the documentation media are photographed from.
 *
 *   node scripts/demo-data.mjs --locale en [--port 18772]
 *
 * It never touches a real database: `tmp/demo-<locale>` is wiped and the server
 * is started on that fresh file, so every chat in a screenshot was written by
 * `demo-agent.mjs` from the script below. The server is left running (its pid
 * goes into `server.pid`) because the capture scripts photograph it next.
 *
 * The chats live in this repository, so the paths in the screenshots are real
 * folders on the machine that took them.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const LOCALE = arg("locale", "en");
const PORT = Number(arg("port", "18772"));
const DIR = path.join(ROOT, "tmp", `demo-${LOCALE}`);
const API = `http://127.0.0.1:${PORT}`;
const WEB = path.join(ROOT, "apps/web");
const SERVER = path.join(ROOT, "apps/server");

/** The whole demo world, written out per language instead of translated on the fly. */
const WORLD = {
  en: {
    chats: [
      {
        title: "Settings page stays light",
        prompts: ["The settings page stays light in the dark theme. Where do its colours come from?"],
      },
      {
        title: "Board lanes explained",
        prompts: ["How does a board card decide which lane it sits in?"],
      },
      {
        title: "E2E run dies on a slow turn",
        prompts: [
          "A slow turn kills the whole e2e run. Where is the timeout set?",
          "Which files did the timeout change touch?",
        ],
      },
      {
        title: "Version row for the board lanes change",
        prompts: ["Draft the VERSIONS.md row for the board lanes change."],
      },
    ],
    board: {
      name: "Orbit",
      folders: [
        { cwd: WEB, tag: "web" },
        { cwd: SERVER, tag: "api" },
      ],
      tasks: [
        {
          cwd: WEB,
          title: "Export a chat as markdown",
          description: "The export API already returns the transcript; the tree needs the button that saves it.",
          lane: "todo",
        },
        {
          cwd: SERVER,
          title: "Keep board folders in creation order",
          description: "The rail sorts by name. The reader added them in an order they meant — keep it.",
          lane: "todo",
        },
        {
          cwd: WEB,
          title: "Cache the folder list in the tree",
          description: "Every render asks the server for folders again. Keep the last answer and refresh it on open.",
          lane: "progress",
        },
        {
          cwd: SERVER,
          title: "Decide the retry budget for the e2e run",
          description: "One retry or none? A flaky socket on CI is worth absorbing; a real failure is not.",
          lane: "wait",
          run: "Should the e2e run retry a failed turn?",
        },
        {
          cwd: WEB,
          title: "Wire the theme switch into the toolbar",
          description: "The switch lives in settings only; the toolbar is where it is looked for.",
          lane: "done",
        },
        {
          cwd: WEB,
          title: "Fix the double scroll in the chat",
          description: "The feed scrolls inside a page that scrolls too — one of them has to go.",
          lane: "done",
        },
      ],
    },
  },
  ru: {
    chats: [
      {
        title: "Настройки не темнеют",
        prompts: ["Страница настроек остаётся светлой в тёмной теме. Откуда она берёт цвета?"],
      },
      {
        title: "Колонки доски",
        prompts: ["Как карточка доски выбирает, в какой она колонке?"],
      },
      {
        title: "Медленный ход валит e2e",
        prompts: [
          "Один медленный ход валит весь e2e-прогон. Где задан таймаут?",
          "Какие файлы задел таймаут?",
        ],
      },
      {
        title: "Строка в VERSIONS.md про колонки",
        prompts: ["Собери строку в VERSIONS.md про колонки доски."],
      },
    ],
    board: {
      name: "Орбита",
      folders: [
        { cwd: WEB, tag: "web" },
        { cwd: SERVER, tag: "api" },
      ],
      tasks: [
        {
          cwd: WEB,
          title: "Экспорт чата в markdown",
          description: "Export API уже отдаёт переписку — в дереве не хватает кнопки, которая её сохранит.",
          lane: "todo",
        },
        {
          cwd: SERVER,
          title: "Папки доски — в порядке создания",
          description: "Рельса сортирует по имени, а читатель добавлял папки в том порядке, который имел в виду.",
          lane: "todo",
        },
        {
          cwd: WEB,
          title: "Кешировать список папок в дереве",
          description: "Каждый рендер снова спрашивает папки у сервера. Держать последний ответ и обновлять при открытии.",
          lane: "progress",
        },
        {
          cwd: SERVER,
          title: "Решить бюджет повторов e2e-прогона",
          description: "Один повтор или ни одного? Флейк на CI стоит простить, настоящую поломку — нет.",
          lane: "wait",
          run: "Нужен ли повтор упавшего хода в e2e-прогоне?",
        },
        {
          cwd: WEB,
          title: "Вынести переключатель темы в тулбар",
          description: "Переключатель живёт только в настройках, а ищут его в тулбаре.",
          lane: "done",
        },
        {
          cwd: WEB,
          title: "Убрать двойной скролл в чате",
          description: "Лента скроллится внутри страницы, которая тоже скроллится — один из них лишний.",
          lane: "done",
        },
      ],
    },
  },
};

const world = WORLD[LOCALE];
if (!world) throw new Error(`unknown locale ${LOCALE}`);

async function api(pathname, init) {
  const res = await fetch(`${API}${pathname}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${pathname} → ${res.status} ${body}`);
  return body ? JSON.parse(body) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      await api("/api/settings");
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error("server never answered");
}

/** One prompt round trip: send it, then wait until the turn is over. */
async function runPrompt(sessionId, text) {
  const before = (await api(`/api/sessions/${sessionId}`)).messages.length;
  await api(`/api/sessions/${sessionId}/prompt`, { method: "POST", body: JSON.stringify({ text }) });
  for (let i = 0; i < 150; i++) {
    await sleep(300);
    const detail = await api(`/api/sessions/${sessionId}`);
    if (detail.status === "error") throw new Error(`turn failed: ${text}`);
    if (detail.messages.length > before && detail.status === "idle") return detail;
  }
  throw new Error(`turn never finished: ${text}`);
}

async function main() {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });

  const log = fs.openSync(path.join(DIR, "server.log"), "w");
  const server = spawn(process.execPath, [path.join(ROOT, "apps/server/dist/index.js")], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_PATH: path.join(DIR, "acpio.db"), ACPIO_PORT: String(PORT), HOST: "127.0.0.1" },
    stdio: ["ignore", log, log],
    detached: true,
  });
  server.unref();
  fs.writeFileSync(path.join(DIR, "server.pid"), String(server.pid));
  await waitForServer();

  await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify({
      locale: LOCALE,
      theme: "dark",
      showBootSplash: false,
      disabledProviders: ["omp", "opencode"],
      defaultProvider: "cursor",
      cursorCommand: process.execPath,
      cursorArgs: [path.join(ROOT, "scripts", "demo-agent.mjs")],
    }),
  });
  await api("/api/agent/probe", { method: "POST", body: JSON.stringify({ provider: "cursor" }) });

  const chats = [];
  for (const chat of world.chats) {
    const session = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "cursor", title: chat.title, cwd: ROOT }),
    });
    for (const prompt of chat.prompts) await runPrompt(session.id, prompt);
    chats.push({ id: session.id, title: chat.title });
    console.log(`  chat ✓ ${chat.title}`);
  }

  const board = await api("/api/boards", { method: "POST", body: JSON.stringify({ name: world.board.name }) });
  await api(`/api/boards/${board.id}/folders`, {
    method: "PUT",
    body: JSON.stringify({ cwds: world.board.folders.map((f) => f.cwd) }),
  });
  for (const folder of world.board.folders) {
    await api(`/api/boards/${board.id}/folders/tag`, {
      method: "PUT",
      body: JSON.stringify({ cwd: folder.cwd, tag: folder.tag }),
    });
  }

  const tasks = [];
  for (const task of world.board.tasks) {
    const session = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        provider: "cursor",
        boardId: board.id,
        cwd: task.cwd,
        title: task.title,
        taskDescription: task.description,
      }),
    });
    if (task.run) await runPrompt(session.id, task.run);
    if (task.lane === "progress") {
      await api(`/api/sessions/${session.id}`, {
        method: "PATCH",
        body: JSON.stringify({ boardColumnId: "progress" }),
      });
    }
    if (task.lane === "done") {
      await api(`/api/sessions/${session.id}`, {
        method: "PATCH",
        body: JSON.stringify({ doneAt: new Date().toISOString() }),
      });
    }
    tasks.push({ id: session.id, title: task.title, lane: task.lane });
    console.log(`  card ✓ ${task.lane} — ${task.title}`);
  }

  const summary = { locale: LOCALE, port: PORT, dir: DIR, chats, board: { id: board.id, name: world.board.name, tasks } };
  fs.writeFileSync(path.join(DIR, "demo.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
