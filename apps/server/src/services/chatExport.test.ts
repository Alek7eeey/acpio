import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AppSettings, MessageDto, MessagePartDto, SessionDetailDto } from "@acprocess/shared";
import type { ExportFormat } from "./chatExport.js";
import {
  defaultExportDir,
  exportFileName,
  fenceFor,
  renderJson,
  renderMarkdown,
  resolveExportDir,
  safeFileBase,
} from "./chatExport.js";

// ---------- fixtures (SessionDetailDto-shaped) ----------

let partSeq = 0;

function makePart(
  type: MessagePartDto["type"],
  payload: Record<string, unknown> = {},
  extra: Partial<MessagePartDto> = {},
): MessagePartDto {
  partSeq += 1;
  return {
    id: `p${partSeq}`,
    messageId: "m1",
    type,
    order: 0,
    payload,
    createdAt: "2026-08-16T10:00:00.000Z",
    ...extra,
  };
}

function makeMessage(
  role: MessageDto["role"],
  parts: MessagePartDto[],
  createdAt = "2026-08-16T10:00:00.000Z",
): MessageDto {
  return { id: `m-${role}`, sessionId: "s1", role, createdAt, parts };
}

function makeDetail(overrides: Partial<SessionDetailDto> = {}): SessionDetailDto {
  return {
    id: "s1",
    title: "Тестовый чат",
    provider: "cursor",
    cwd: "C:\\work",
    mode: "agent",
    status: "idle",
    acpSessionId: null,
    themeId: null,
    sortOrder: 0,
    pinned: false,
    archived: false,
    createdAt: "2026-08-16T08:00:00.000Z",
    updatedAt: "2026-08-16T10:00:00.000Z",
    lastMessageAt: "2026-08-16T10:00:00.000Z",
    messages: [],
    ...overrides,
  };
}

// ---------- safeFileBase ----------

describe("safeFileBase", () => {
  it.each([
    ["Привет мир", "Привет мир"], // Cyrillic preserved verbatim
    ["Hello   World", "Hello World"], // runs of spaces collapse
    ["a\tb\nc", "abc"], // tabs/newlines are control chars, removed
    ["a\u00a0\u00a0b", "a b"], // non-breaking space run collapses
    ["C:\\temp\\file.txt", "C temp file.txt"], // backslash + colon replaced
    ['a:b*c?"d<e>f|g', "a b c d e f g"], // every reserved char -> space
    ["name. ", "name"], // trailing dot + space stripped
    ["name..", "name"], // trailing dots stripped
    ["   x   ", "x"], // outer whitespace trimmed
    ["a\u0000b\u0001c", "abc"], // control chars removed
    ["x".repeat(100), "x".repeat(80)], // capped at 80 chars
    ["", "chat"], // empty -> chat
    ["   ", "chat"], // whitespace-only -> chat
  ])("sanitizes %j into %j", (input, expected) => {
    expect(safeFileBase(input)).toBe(expected);
  });
});

// ---------- fenceFor ----------

describe("fenceFor", () => {
  it.each([
    ["", "```"],
    ["plain text", "```"],
    ["a`b", "```"], // run of 1 -> max(2, 3)
    ["a``b", "```"], // run of 2 -> max(3, 3)
    ["a```b", "````"], // run of 3 -> 4
    ["a`````b", "``````"], // run of 5 -> 6
    ["`a``b```", "````"], // longest run wins
  ])("fence for %j is %j", (text, expected) => {
    expect(fenceFor(text)).toBe(expected);
  });
});

// ---------- exportFileName ----------

describe("exportFileName", () => {
  it.each([
    ["My Chat", "2026-08-16T12:00:00.000Z", "md", "My Chat-2026-08-16.md"],
    ["My Chat", "2026-08-16T12:00:00.000Z", "json", "My Chat-2026-08-16.json"],
    ["Q: Help?", "2026-08-16T12:00:00.000Z", "md", "Q Help-2026-08-16.md"],
    ["Тест", "2026-08-16T23:59:59.999Z", "md", "Тест-2026-08-16.md"],
  ] as Array<[string, string, ExportFormat, string]>)(
    "title %j, stamp %j, format %s -> %j",
    (title, lastMessageAt, format, expected) => {
      expect(exportFileName(makeDetail({ title, lastMessageAt }), format)).toBe(expected);
    },
  );

  it("falls back to createdAt when lastMessageAt is missing", () => {
    const detail = makeDetail({ title: "T", lastMessageAt: "", createdAt: "2026-08-16T08:00:00.000Z" });
    expect(exportFileName(detail, "md")).toBe("T-2026-08-16.md");
  });

  it("produces an empty date stamp when no dates exist", () => {
    const detail = makeDetail({ title: "T", lastMessageAt: "", createdAt: "" });
    expect(exportFileName(detail, "md")).toBe("T-.md");
  });
});

// ---------- defaultExportDir / resolveExportDir ----------

describe("defaultExportDir", () => {
  it("points at the exports folder under the repo root", () => {
    const dir = defaultExportDir();
    expect(path.isAbsolute(dir)).toBe(true);
    expect(path.basename(dir)).toBe("exports");
  });
});

describe("resolveExportDir", () => {
  it("uses an explicit settings override", async () => {
    const dir = await resolveExportDir({ exportDir: "custom/export" } as AppSettings);
    expect(dir).toBe(path.resolve("custom/export"));
  });

  it("trims whitespace around the override", async () => {
    const dir = await resolveExportDir({ exportDir: "  ./exp  " } as AppSettings);
    expect(dir).toBe(path.resolve("./exp"));
  });

  it.each([[""], ["   "]])("empty exportDir %j falls back to the default", async (exportDir) => {
    const dir = await resolveExportDir({ exportDir } as AppSettings);
    expect(dir).toBe(defaultExportDir());
  });
});

// ---------- renderMarkdown ----------

describe("renderMarkdown", () => {
  it("renders the title header and all meta lines", () => {
    const md = renderMarkdown(
      makeDetail({ title: "Мой чат", provider: "cursor", mode: "agent", cwd: "C:\\work\\proj", messages: [] }),
      "ru",
    );
    const lines = md.split("\n");
    expect(lines[0]).toBe("# Мой чат");
    expect(lines[2]).toBe("> Экспорт чата: cursor · Агент");
    expect(lines[4]).toBe("> Рабочая папка: `C:\\work\\proj`");
    expect(lines[6]).toMatch(/^> Сообщений: 0 · Экспортировано: /);
    expect(md).toContain("---");
  });

  it.each([
    ["agent", "Агент"],
    ["plan", "План"],
    ["ask", "Спросить"],
    ["custom", "custom"], // unknown modes pass through raw
  ])("renders mode %s as %s", (mode, label) => {
    const md = renderMarkdown(makeDetail({ mode: mode as SessionDetailDto["mode"], messages: [] }), "ru");
    expect(md).toContain(`> Экспорт чата: cursor · ${label}`);
  });

  it("omits the folder line when cwd is empty", () => {
    const md = renderMarkdown(makeDetail({ cwd: "   ", messages: [] }), "ru");
    expect(md).not.toContain("Рабочая папка");
  });

  it("renders (пусто) for an empty session and no message headings", () => {
    const md = renderMarkdown(makeDetail({ messages: [] }), "ru");
    expect(md).toContain("(пусто)");
    expect(md).not.toMatch(/^## /m);
  });

  it.each([
    ["user", "Пользователь"],
    ["assistant", "Ассистент"],
    ["system", "Система"],
  ])("renders the %s role heading with a date", (role, label) => {
    const md = renderMarkdown(
      makeDetail({ messages: [makeMessage(role as MessageDto["role"], [makePart("text", { text: "hi" })])] }),
      "ru",
    );
    expect(md).toMatch(new RegExp(`## ${label} · `));
  });

  it("puts a formatted date after the role label in the heading", () => {
    const md = renderMarkdown(
      makeDetail({ messages: [makeMessage("user", [makePart("text", { text: "x" })])] }),
      "ru",
    );
    const heading = md.split("\n").find((l) => l.startsWith("## ")) ?? "";
    expect(heading).toMatch(/^## Пользователь · .*\d/);
  });

  it("passes multi-line text through verbatim", () => {
    const md = renderMarkdown(
      makeDetail({
        messages: [makeMessage("user", [makePart("text", { text: "Первая строка\n\nВторая строка  " })])],
      }),
      "ru",
    );
    expect(md).toContain("Первая строка\n\nВторая строка");
  });

  it("skips whitespace-only text parts", () => {
    const md = renderMarkdown(
      makeDetail({
        messages: [makeMessage("user", [makePart("text", { text: "   " }), makePart("text", { text: " \n\t " })])],
      }),
      "ru",
    );
    const lines = md.split("\n");
    const headingIdx = lines.findIndex((l) => l.startsWith("## "));
    expect(lines.slice(headingIdx + 1).filter((l) => l.trim() !== "")).toEqual([]);
  });

  it("renders a thought as Размышление with blockquote lines", () => {
    const md = renderMarkdown(
      makeDetail({
        messages: [makeMessage("assistant", [makePart("thought", { text: "Подумаю\nещё раз" })])],
      }),
      "ru",
    );
    expect(md).toContain("**Размышление**\n\n> Подумаю\n> ещё раз");
  });

  it("skips empty thoughts", () => {
    const md = renderMarkdown(
      makeDetail({ messages: [makeMessage("assistant", [makePart("thought", { text: "   " })])] }),
      "ru",
    );
    expect(md).not.toContain("Размышление");
  });

  it("renders a tool_call with its title and a fenced text output", () => {
    const md = renderMarkdown(
      makeDetail({
        messages: [
          makeMessage("assistant", [makePart("tool_call", { title: "search_files", raw: { content: "found 3 matches" } })]),
        ],
      }),
      "ru",
    );
    expect(md).toContain("**Инструмент: search_files**");
    expect(md).toContain("```text\nfound 3 matches\n```");
  });

  it("renders a tool_call without output and without a fence", () => {
    const md = renderMarkdown(
      makeDetail({ messages: [makeMessage("assistant", [makePart("tool_call", { title: "x", raw: {} })])] }),
      "ru",
    );
    expect(md).toContain("**Инструмент: x**");
    expect(md).not.toContain("```");
  });

  it.each([
    [{ title: "T", description: "D" }, "T"],
    [{ description: "D" }, "D"],
    [{}, "Инструмент"],
  ])("tool title for payload %j is %s", (payload, title) => {
    const md = renderMarkdown(
      makeDetail({ messages: [makeMessage("assistant", [makePart("tool_call", payload)])] }),
      "ru",
    );
    expect(md).toContain(`**Инструмент: ${title}**`);
  });

  it("extracts tool output from raw.content blocks", () => {
    const md = renderMarkdown(
      makeDetail({
        messages: [
          makeMessage("assistant", [
            makePart("tool_call", { raw: { content: [{ content: { text: "one" } }, { text: "two" }] } }),
          ]),
        ],
      }),
      "ru",
    );
    expect(md).toContain("```text\nonetwo\n```");
  });

  it("keeps fences safe when tool output contains backticks", () => {
    const output = "```js\nconst x = 1;\n```";
    const md = renderMarkdown(
      makeDetail({
        messages: [makeMessage("assistant", [makePart("tool_call", { title: "run", raw: { content: output } })])],
      }),
      "ru",
    );
    expect(md).toContain("````text\n" + output + "\n````");
  });

  it("grows the fence for longer backtick runs in tool output", () => {
    const output = "``````"; // run of 6
    const md = renderMarkdown(
      makeDetail({
        messages: [makeMessage("assistant", [makePart("tool_call", { title: "run", raw: { content: output } })])],
      }),
      "ru",
    );
    expect(md).toContain("```````text\n" + output + "\n```````");
  });

  it("truncates tool output over 20000 chars with the marker", () => {
    const long = "a".repeat(20001);
    const md = renderMarkdown(
      makeDetail({
        messages: [makeMessage("assistant", [makePart("tool_call", { title: "run", raw: { content: long } })])],
      }),
      "ru",
    );
    expect(md).toContain("a".repeat(20000) + "\n… вывод обрезан");
    expect(md).not.toContain("a".repeat(20001));
  });

  it("keeps tool output intact at exactly 20000 chars", () => {
    const exact = "b".repeat(20000);
    const md = renderMarkdown(
      makeDetail({
        messages: [makeMessage("assistant", [makePart("tool_call", { title: "run", raw: { content: exact } })])],
      }),
      "ru",
    );
    expect(md).toContain("b".repeat(20000));
    expect(md).not.toContain("обрезан");
  });

  it("renders a file part with name and path", () => {
    const md = renderMarkdown(
      makeDetail({
        messages: [
          makeMessage("assistant", [makePart("file", { name: "report.pdf", path: "C:\\out\\report.pdf" })]),
        ],
      }),
      "ru",
    );
    expect(md).toContain("**Файл:** report.pdf (`C:\\out\\report.pdf`)");
  });

  it("renders a file part without a path", () => {
    const md = renderMarkdown(
      makeDetail({ messages: [makeMessage("assistant", [makePart("file", { name: "report.pdf" })])] }),
      "ru",
    );
    expect(md).toContain("**Файл:** report.pdf");
  });

  it("renders an error part, flattening newlines", () => {
    const md = renderMarkdown(
      makeDetail({
        messages: [makeMessage("assistant", [makePart("error", { message: "Что-то\nсломалось" })])],
      }),
      "ru",
    );
    expect(md).toContain("_Ошибка: Что-то сломалось_");
  });

  it("skips empty error parts", () => {
    const md = renderMarkdown(
      makeDetail({ messages: [makeMessage("assistant", [makePart("error", { message: "  " })])] }),
      "ru",
    );
    expect(md).not.toContain("Ошибка");
  });

  it("renders a status part", () => {
    const md = renderMarkdown(
      makeDetail({ messages: [makeMessage("assistant", [makePart("status", { text: "работаю" })])] }),
      "ru",
    );
    expect(md).toContain("_Статус: работаю_");
  });

  it("renders a named plan with its body", () => {
    const md = renderMarkdown(
      makeDetail({
        messages: [makeMessage("assistant", [makePart("plan", { name: "Шаг 1", plan: "Сделать X" })])],
      }),
      "ru",
    );
    expect(md).toContain("**План: Шаг 1**\n\nСделать X");
  });

  it("renders a bare plan heading when unnamed", () => {
    const md = renderMarkdown(
      makeDetail({ messages: [makeMessage("assistant", [makePart("plan", { plan: "тело" })])] }),
      "ru",
    );
    expect(md).toContain("**План**\n\nтело");
  });

  it("skips empty plan parts", () => {
    const md = renderMarkdown(
      makeDetail({ messages: [makeMessage("assistant", [makePart("plan", { name: " ", plan: " " })])] }),
      "ru",
    );
    expect(md).not.toContain("План");
  });

  it("renders todo checkboxes honouring done and completed status", () => {
    const md = renderMarkdown(
      makeDetail({
        messages: [
          makeMessage("assistant", [
            makePart("todo", {
              items: [
                { text: "сделано", done: true },
                { text: "не сделано", done: false },
                { text: "по статусу", status: "completed" },
                { text: "в работе", status: "running" },
              ],
            }),
          ]),
        ],
      }),
      "ru",
    );
    expect(md).toContain("**Задачи**");
    expect(md).toContain("- [x] сделано");
    expect(md).toContain("- [ ] не сделано");
    expect(md).toContain("- [x] по статусу");
    expect(md).toContain("- [ ] в работе");
  });

  it("skips todo parts without items", () => {
    const md = renderMarkdown(
      makeDetail({ messages: [makeMessage("assistant", [makePart("todo", { items: [] })])] }),
      "ru",
    );
    expect(md).not.toContain("Задачи");
  });

  it.each([
    ["question", "Вопрос", "text"],
    ["question", "Вопрос", "message"],
    ["question", "Вопрос", "question"],
    ["permission", "Разрешение", "prompt"],
  ])("renders %s via the %s payload field", (type, label, field) => {
    const md = renderMarkdown(
      makeDetail({
        messages: [
          makeMessage("assistant", [makePart(type as MessagePartDto["type"], { [field]: "спросить\nчто-то" })]),
        ],
      }),
      "ru",
    );
    expect(md).toContain(`**${label}:** спросить что-то`);
  });

  it("skips empty question parts", () => {
    const md = renderMarkdown(
      makeDetail({ messages: [makeMessage("assistant", [makePart("question", { text: " " })])] }),
      "ru",
    );
    expect(md).not.toContain("Вопрос:");
  });

  it("renders a subagent with title and body from payload.result", () => {
    const md = renderMarkdown(
      makeDetail({
        messages: [
          makeMessage("assistant", [makePart("subagent", { description: "Мой агент", result: "итог работы" })]),
        ],
      }),
      "ru",
    );
    expect(md).toContain("**Субагент: Мой агент**\n\nитог работы");
  });

  it("renders a bare subagent heading without title or body", () => {
    const md = renderMarkdown(
      makeDetail({ messages: [makeMessage("assistant", [makePart("subagent", {})])] }),
      "ru",
    );
    expect(md).toContain("**Субагент**");
  });

  it("filters generic subagent titles and falls back to raw.name", () => {
    const md = renderMarkdown(
      makeDetail({
        messages: [makeMessage("assistant", [makePart("subagent", { title: "task", raw: { name: "worker" } })])],
      }),
      "ru",
    );
    expect(md).toContain("**Субагент: worker**");
  });

  it("drops the title when only generic names are present", () => {
    const md = renderMarkdown(
      makeDetail({
        messages: [makeMessage("assistant", [makePart("subagent", { description: "агент", title: "tool" })])],
      }),
      "ru",
    );
    expect(md).toContain("**Субагент**");
  });

  it.each([
    ['{"result":"json text"}', "json text"],
    ['["a","b"]', "a\n\nb"],
    [{ text: "obj text" }, "obj text"],
    [{ output: "obj output" }, "obj output"],
    [{ result: "obj result" }, "obj result"],
    [{ content: "deep" }, "deep"],
  ] as Array<[unknown, string]>)("extracts subagent body from %j", (result, expected) => {
    const md = renderMarkdown(
      makeDetail({ messages: [makeMessage("assistant", [makePart("subagent", { result })])] }),
      "ru",
    );
    expect(md).toContain("**Субагент**\n\n" + expected);
  });

  it("truncates long subagent bodies with the marker", () => {
    const long = "z".repeat(20001);
    const md = renderMarkdown(
      makeDetail({ messages: [makeMessage("assistant", [makePart("subagent", { result: long })])] }),
      "ru",
    );
    expect(md).toContain("z".repeat(20000) + "\n… вывод обрезан");
  });

  it("renders unknown part types via generic text extraction", () => {
    const part = { ...makePart("text", { message: "generic" }), type: "mystery" } as MessagePartDto;
    const md = renderMarkdown(
      makeDetail({ messages: [makeMessage("user", [part])] }),
      "ru",
    );
    expect(md).toContain("generic");
  });

  it("separates messages with a single blank line and ends with a newline", () => {
    const md = renderMarkdown(
      makeDetail({
        messages: [
          makeMessage("user", [makePart("text", { text: "первое" })], "2026-08-16T09:00:00.000Z"),
          makeMessage("assistant", [makePart("text", { text: "второе" })], "2026-08-16T10:00:00.000Z"),
        ],
      }),
      "ru",
    );
    const lines = md.split("\n");
    const first = lines.indexOf("первое");
    expect(lines[first + 1]).toBe("");
    expect(lines[first + 2]).toMatch(/^## Ассистент · /);
    expect(lines.at(-2)).toBe("второе");
    expect(md.endsWith("\n")).toBe(true);
  });
});

// ---------- renderJson ----------

describe("renderJson", () => {
  it("dumps format, version, exportedAt and the session meta", () => {
    const detail = makeDetail({
      id: "s-42",
      title: "Тест",
      provider: "omp",
      mode: "plan",
      cwd: "C:\\proj",
      createdAt: "2026-08-16T08:00:00.000Z",
      updatedAt: "2026-08-16T09:00:00.000Z",
      lastMessageAt: "2026-08-16T10:00:00.000Z",
    });
    const parsed = JSON.parse(renderJson(detail)) as {
      format: string;
      version: number;
      exportedAt: string;
      session: Record<string, unknown>;
      messages: unknown[];
    };
    expect(parsed.format).toBe("acprocess-chat");
    expect(parsed.version).toBe(1);
    expect(typeof parsed.exportedAt).toBe("string");
    expect(Number.isNaN(Date.parse(parsed.exportedAt))).toBe(false);
    expect(parsed.session).toEqual({
      id: "s-42",
      title: "Тест",
      provider: "omp",
      mode: "plan",
      cwd: "C:\\proj",
      createdAt: "2026-08-16T08:00:00.000Z",
      updatedAt: "2026-08-16T09:00:00.000Z",
      lastMessageAt: "2026-08-16T10:00:00.000Z",
    });
    expect(parsed.messages).toEqual([]);
  });

  it("keeps messages in order with role and createdAt", () => {
    const detail = makeDetail({
      messages: [
        makeMessage("user", [makePart("text", { text: "привет" })], "2026-08-16T09:00:00.000Z"),
        makeMessage("assistant", [makePart("tool_call", { title: "run" })], "2026-08-16T09:01:00.000Z"),
      ],
    });
    const parsed = JSON.parse(renderJson(detail)) as {
      messages: Array<{ role: string; createdAt: string; parts: unknown[] }>;
    };
    expect(parsed.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(parsed.messages.map((m) => m.createdAt)).toEqual([
      "2026-08-16T09:00:00.000Z",
      "2026-08-16T09:01:00.000Z",
    ]);
  });

  it("keeps part type/order/createdAt/payload fidelity", () => {
    const detail = makeDetail({
      messages: [
        makeMessage("user", [
          makePart("text", { text: "привет" }, { id: "p1", order: 0, createdAt: "2026-08-16T09:00:00.000Z" }),
          makePart("thought", { text: "думаю" }, { id: "p2", order: 1, createdAt: "2026-08-16T09:00:01.000Z" }),
        ]),
        makeMessage(
          "assistant",
          [makePart("tool_call", { title: "run", raw: { content: "ok" } }, { id: "p3", order: 2 })],
          "2026-08-16T09:01:00.000Z",
        ),
      ],
    });
    const parsed = JSON.parse(renderJson(detail)) as {
      messages: Array<{
        parts: Array<{ type: string; order: number; createdAt: string; payload: Record<string, unknown> }>;
      }>;
    };
    expect(parsed.messages[0].parts).toEqual([
      { type: "text", order: 0, createdAt: "2026-08-16T09:00:00.000Z", payload: { text: "привет" } },
      { type: "thought", order: 1, createdAt: "2026-08-16T09:00:01.000Z", payload: { text: "думаю" } },
    ]);
    expect(parsed.messages[1].parts[0]).toEqual({
      type: "tool_call",
      order: 2,
      createdAt: "2026-08-16T10:00:00.000Z",
      payload: { title: "run", raw: { content: "ok" } },
    });
  });

  it("pretty-prints JSON and ends with a newline", () => {
    const out = renderJson(makeDetail());
    expect(out.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(out)).not.toThrow();
    expect(out).toContain("\n  \"session\": {");
  });
});
