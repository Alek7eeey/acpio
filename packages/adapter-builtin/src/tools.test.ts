import { spawnSync } from "node:child_process";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { AgentMode } from "@acpio/shared";
import { createBuiltinTools, shellCommand, windowRead } from "./tools.js";

/** Tool execution options the SDK passes; only abortSignal is used here. */
const CTX = { abortSignal: new AbortController().signal };

type HostMock = { request: Mock };

function setup(mode: AgentMode, host?: HostMock, ask?: Mock) {
  const h: HostMock = host ?? { request: vi.fn(async () => ({})) };
  const a: Mock = ask ?? vi.fn(async () => undefined);
  return {
    tools: createBuiltinTools({ host: h, mode, ask: a, sessionId: "S1" }),
    host: h,
    ask: a,
  };
}

const exec = (tools: Record<string, any>, name: string, input: unknown) =>
  tools[name].execute(input, CTX);

describe("createBuiltinTools", () => {
  it.each([
    ["plan", ["read", "glob", "grep", "ask"]],
    ["ask", ["read", "glob", "grep", "ask"]],
    ["agent", ["read", "glob", "grep", "write", "edit", "bash", "ask"]],
  ] as const)("mode %s exposes exactly %j", (mode, expected) => {
    expect(Object.keys(setup(mode).tools)).toEqual([...expected]);
  });

  it("read passes the window through to the host", async () => {
    const { tools, host } = setup("agent");
    host.request.mockResolvedValue({ content: "line" });
    await expect(exec(tools, "read", { path: "f.txt", line: 2, limit: 3 })).resolves.toBe("line");
    expect(host.request).toHaveBeenCalledWith("fs/read_text_file", {
      path: "f.txt",
      line: 2,
      limit: 3,
    });
  });

  it("read without a window asks for the whole file", async () => {
    const { tools, host } = setup("agent");
    host.request.mockResolvedValue({ content: "all of it" });
    await expect(exec(tools, "read", { path: "f.txt" })).resolves.toBe("all of it");
    expect(host.request).toHaveBeenCalledWith("fs/read_text_file", { path: "f.txt" });
  });

  it("write asks permission before the file is touched", async () => {
    const { tools, host, ask } = setup("agent");
    await exec(tools, "write", { path: "f.txt", content: "new" });
    expect(ask).toHaveBeenCalledWith({
      title: "write f.txt",
      kind: "edit",
      input: { path: "f.txt" },
    });
    expect(host.request).toHaveBeenCalledWith("fs/write_text_file", {
      path: "f.txt",
      content: "new",
    });
    expect(ask.mock.invocationCallOrder[0]).toBeLessThan(host.request.mock.invocationCallOrder[0]!);
  });

  it("declined permission never reaches the file", async () => {
    const ask: Mock = vi.fn(async () => {
      throw new Error("Операция отклонена: write f.txt");
    });
    const { tools, host } = setup("agent", undefined, ask);
    await expect(exec(tools, "write", { path: "f.txt", content: "new" })).rejects.toThrow(
      /отклонена/,
    );
    expect(host.request).not.toHaveBeenCalled();
  });

  it("glob lists what the host matched, with each file's size", async () => {
    const { tools, host } = setup("agent");
    host.request.mockResolvedValue({
      files: [
        { path: "a.ts", bytes: 2048 },
        { path: "b.ts", bytes: 512 },
      ],
      truncated: false,
    });
    await expect(exec(tools, "glob", { pattern: "**/*.ts" })).resolves.toBe(
      "  2.0 KB  a.ts\n   512 B  b.ts",
    );
    expect(host.request).toHaveBeenCalledWith("fs/glob", { pattern: "**/*.ts" });
  });

  it("glob survives a host that reports no size at all", async () => {
    const { tools, host } = setup("agent");
    host.request.mockResolvedValue({ files: [{ path: "a.ts" }], truncated: false });
    await expect(exec(tools, "glob", { pattern: "**/*.ts" })).resolves.toBe("       ?  a.ts");
  });

  it("glob says so when nothing matched", async () => {
    const { tools } = setup("agent");
    await expect(exec(tools, "glob", { pattern: "*.rs" })).resolves.toContain("No files match");
  });

  it("grep heads each file once and lists its hits underneath", async () => {
    const { tools, host } = setup("agent");
    host.request.mockResolvedValue({
      hits: [
        { path: "a.ts", line: 3, text: "calcTotal()" },
        { path: "a.ts", line: 9, text: "calcTotal()" },
        { path: "b.ts", line: 1, text: "calcTotal()" },
      ],
      files: [
        { path: "a.ts", bytes: 2048, lines: 120 },
        { path: "b.ts", bytes: 512, lines: 8 },
      ],
      truncated: false,
    });
    await expect(exec(tools, "grep", { pattern: "calcTotal", ignore_case: true })).resolves.toBe(
      "a.ts (2.0 KB, 120 lines)\n  3: calcTotal()\n  9: calcTotal()\n" +
        "b.ts (512 B, 8 lines)\n  1: calcTotal()",
    );
    expect(host.request).toHaveBeenCalledWith("fs/search", {
      pattern: "calcTotal",
      ignore_case: true,
    });
  });

  it("grep marks a truncated result", async () => {
    const { tools, host } = setup("agent");
    host.request.mockResolvedValue({
      hits: [{ path: "a.ts", line: 1, text: "x" }],
      files: [{ path: "a.ts", bytes: 512, lines: 8 }],
      truncated: true,
    });
    await expect(exec(tools, "grep", { pattern: "x" })).resolves.toContain("more matches than shown");
  });

  it("edit applies every entry against the original text", async () => {
    const { tools, host } = setup("agent");
    host.request.mockImplementation(async (method: string) =>
      method === "fs/read_text_file" ? { content: "one two three" } : {},
    );
    await expect(
      exec(tools, "edit", {
        path: "f.txt",
        edits: [
          { old_string: "one", new_string: "1" },
          { old_string: "three", new_string: "3" },
        ],
      }),
    ).resolves.toContain("Replaced 2");
    expect(host.request).toHaveBeenCalledWith("fs/write_text_file", {
      path: "f.txt",
      content: "1 two 3",
    });
  });

  it("edit replace_all rewrites every occurrence", async () => {
    const { tools, host } = setup("agent");
    host.request.mockImplementation(async (method: string) =>
      method === "fs/read_text_file" ? { content: "x x" } : {},
    );
    await expect(
      exec(tools, "edit", { path: "f.txt", edits: [{ old_string: "x", new_string: "y", replace_all: true }] }),
    ).resolves.toContain("Replaced 2");
    expect(host.request).toHaveBeenCalledWith("fs/write_text_file", {
      path: "f.txt",
      content: "y y",
    });
  });

  it("edit refuses an ambiguous match instead of guessing", async () => {
    const { tools, host } = setup("agent");
    host.request.mockResolvedValue({ content: "x x" });
    await expect(
      exec(tools, "edit", { path: "f.txt", edits: [{ old_string: "x", new_string: "y" }] }),
    ).rejects.toThrow(/matches 2 times/);
    expect(host.request).toHaveBeenCalledTimes(1); // read only, no write
  });

  it("edit refuses when the anchor is gone", async () => {
    const { tools, host } = setup("agent");
    host.request.mockResolvedValue({ content: "abc" });
    await expect(
      exec(tools, "edit", { path: "f.txt", edits: [{ old_string: "zz", new_string: "y" }] }),
    ).rejects.toThrow(/not found/);
    expect(host.request).toHaveBeenCalledTimes(1);
  });

  it("edit refuses overlapping entries before writing", async () => {
    const { tools, host } = setup("agent");
    host.request.mockResolvedValue({ content: "abcdef" });
    await expect(
      exec(tools, "edit", {
        path: "f.txt",
        edits: [
          { old_string: "abcd", new_string: "X" },
          { old_string: "cdef", new_string: "Y" },
        ],
      }),
    ).rejects.toThrow(/overlap/);
    expect(host.request).toHaveBeenCalledTimes(1);
  });

  it("bash runs the command through the host terminal", async () => {
    const { tools, host, ask } = setup("agent");
    host.request.mockImplementation(async (method: string) => {
      if (method === "terminal/create") return { terminalId: "T1" };
      if (method === "terminal/wait_for_exit") return { exitCode: 0, signal: null };
      if (method === "terminal/output") return { output: "hello\n", truncated: false };
      return {};
    });
    const out = await exec(tools, "bash", { command: "echo hello" });
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ kind: "execute" }));
    expect(out).toContain("exit code: 0");
    expect(out).toContain("hello");
    expect(host.request.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      "terminal/create",
      "terminal/wait_for_exit",
      "terminal/output",
      "terminal/release",
    ]);
  });

  it("declined bash never spawns a terminal", async () => {
    const ask: Mock = vi.fn(async () => {
      throw new Error("Операция отклонена: bash");
    });
    const { tools, host } = setup("agent", undefined, ask);
    await expect(exec(tools, "bash", { command: "echo hi" })).rejects.toThrow(/отклонена/);
    expect(host.request).not.toHaveBeenCalled();
  });

  it("ask shows the question card the CLI agents use", async () => {
    const { tools, host } = setup("agent");
    host.request.mockResolvedValue({ action: "accept", content: { target: "src/api" } });
    await exec(tools, "ask", { questions: [{ id: "target", question: "Where to put it?" }] });
    expect(host.request).toHaveBeenCalledWith("elicitation/create", {
      sessionId: "S1",
      mode: "form",
      message: "Where to put it?",
      requestedSchema: {
        type: "object",
        properties: { target: { type: "string", title: "Where to put it?" } },
        required: ["target"],
      },
    });
  });

  it("ask maps options, multi-select and the Other field into the form", async () => {
    const { tools, host } = setup("agent");
    host.request.mockResolvedValue({ action: "accept", content: {} });
    await exec(tools, "ask", {
      questions: [
        {
          id: "scope",
          question: "How far?",
          description: "Pick one.",
          options: [
            { id: "types", label: "Types only", description: "No runtime change" },
            { id: "all", label: "Everything" },
          ],
        },
        {
          id: "files",
          question: "Which files?",
          multiple: true,
          options: [{ id: "a.ts", label: "a.ts" }],
        },
      ],
    });
    const [, params] = host.request.mock.calls.at(-1) as [string, { requestedSchema: unknown }];
    expect(params.requestedSchema).toEqual({
      type: "object",
      properties: {
        scope: {
          type: "string",
          title: "How far?",
          description: "Pick one.",
          oneOf: [
            { const: "types", title: "Types only", description: "No runtime change" },
            { const: "all", title: "Everything" },
          ],
        },
        scope__other: { type: "string", title: "Other" },
        files: {
          type: "array",
          title: "Which files?",
          items: { anyOf: [{ const: "a.ts", title: "a.ts" }] },
        },
        files__other: { type: "string", title: "Other" },
      },
      required: ["scope", "files"],
    });
  });

  it("ask drops the Other field only when the model opts out", async () => {
    const { tools, host } = setup("agent");
    host.request.mockResolvedValue({ action: "accept", content: {} });
    await exec(tools, "ask", {
      questions: [
        {
          id: "scope",
          question: "How far?",
          allow_free_text: false,
          options: [{ id: "all", label: "Everything" }],
        },
        {
          id: "files",
          question: "Which files?",
          multiple: true,
          allow_free_text: false,
          options: [{ id: "a.ts", label: "a.ts" }],
        },
      ],
    });
    const [, params] = host.request.mock.calls.at(-1) as [string, { requestedSchema: any }];
    expect(Object.keys(params.requestedSchema.properties)).toEqual(["scope", "files"]);
  });

  it("ask hands the model one line per answer, without repeating the question", async () => {
    const { tools, host } = setup("agent");
    host.request.mockResolvedValue({
      action: "accept",
      content: {
        scope: "types",
        scope__other: "types + docs",
        files: ["a.ts", "b.ts"],
      },
    });
    const out = await exec(tools, "ask", {
      questions: [
        { id: "scope", question: "How far?", allow_free_text: true },
        { id: "files", question: "Which files?" },
      ],
    });
    expect(out).toBe(
      "The user answered:\n- scope: \"types\" — their own words: \"types + docs\"\n- files: \"a.ts\", \"b.ts\"",
    );
  });

  it("ask marks a question the user left empty", async () => {
    const { tools, host } = setup("agent");
    host.request.mockResolvedValue({ action: "accept", content: { target: "" } });
    await expect(
      exec(tools, "ask", { questions: [{ id: "target", question: "Where?" }] }),
    ).resolves.toBe("The user answered:\n- target: (no answer)");
  });

  it("a declined question continues the turn instead of failing it", async () => {
    const { tools, host } = setup("agent");
    host.request.mockResolvedValue({ action: "decline" });
    await expect(
      exec(tools, "ask", { questions: [{ id: "target", question: "Where?" }] }),
    ).resolves.toContain("declined to answer");
  });

  it("a skipped question continues the turn instead of failing it", async () => {
    const { tools, host } = setup("agent");
    host.request.mockResolvedValue({ action: "cancel" });
    await expect(
      exec(tools, "ask", { questions: [{ id: "target", question: "Where?" }] }),
    ).resolves.toContain("left unanswered");
  });

  // The hand-written schema validates nothing, so the guard has to: a malformed
  // call must come back as something the model can correct in its next step.
  it.each([
    [{}, /non-empty `questions`/],
    [{ questions: [] }, /non-empty `questions`/],
    [{ questions: "Where?" }, /non-empty `questions`/],
    [{ questions: [{ id: "target" }] }, /needs an `id` and a `question`/],
    [{ questions: [{ id: "t", question: "Where?", options: "src/api" }] }, /`options` must be an array/],
    [{ questions: [{ id: "t", question: "Where?", options: [{ label: "src/api" }] }] }, /needs an `id`/],
  ])("ask answers a malformed call with a sentence: %j", async (input, expected) => {
    const { tools, host } = setup("agent");
    await expect(exec(tools, "ask", input)).rejects.toThrow(expected);
    // Nothing reached the user: a broken call must not open a card.
    expect(host.request).not.toHaveBeenCalled();
  });

  it("ask reads a bare option as its own label and an empty list as free text", async () => {
    const { tools, host } = setup("agent");
    host.request.mockResolvedValue({ action: "accept", content: {} });
    await exec(tools, "ask", {
      questions: [
        { id: "target", question: "Where?", options: [{ id: "src/api" }] },
        { id: "note", question: "Anything else?", options: [] },
      ],
    });
    const [, params] = host.request.mock.calls.at(-1) as [string, { requestedSchema: any }];
    expect(params.requestedSchema.properties.target).toEqual({
      type: "string",
      title: "Where?",
      oneOf: [{ const: "src/api", title: "src/api" }],
    });
    expect(params.requestedSchema.properties.note).toEqual({ type: "string", title: "Anything else?" });
  });
});

describe("read windowing", () => {
  it("returns small files untouched", () => {
    const content = "a\r\nb\r\nc";
    expect(windowRead(content, "f.mjs", 1)).toBe(content);
  });

  it("caps a long file at 2000 lines and names the line to continue from", () => {
    const content = Array.from({ length: 5_000 }, (_, i) => `line ${i + 1}`).join("\n");
    const out = windowRead(content, "big.mjs", 1);
    expect(out).toContain("truncated at 2000 lines");
    expect(out).toContain("big.mjs has 5000 lines");
    expect(out).toContain("line: 2001");
    expect(out.split("\n").length).toBeLessThan(2_100);
  });

  it("continues from the requested window, not from the top", () => {
    const content = Array.from({ length: 5_000 }, (_, i) => `line ${i + 1}`).join("\n");
    const out = windowRead(content, "big.mjs", 2_001);
    expect(out).toContain("line: 4001");
  });

  it("counts the continuation in the caller's line numbering", () => {
    // 3000 CRLF lines: the kept text must stay byte-faithful (no LF rewriting).
    const content = Array.from({ length: 3_000 }, () => "x").join("\r\n");
    const out = windowRead(content, "crlf.txt", 1);
    expect(out.slice(0, 4)).toBe("x\r\nx");
    expect(out).toContain("line: 2001");
  });

  it("also caps a windowed read that is still too large", () => {
    const content = Array.from({ length: 3_000 }, (_, i) => `line ${i + 1}`).join("\n");
    const out = windowRead(content, "big.mjs", 1_001);
    expect(out).toContain("truncated at 2000 lines");
    expect(out).toContain("line: 3001");
  });
});

describe("bash shell selection", () => {
  // The regression this guards: running these commands through cmd.exe on
  // Windows mangles nested quotes into "Unterminated string constant", which
  // costs the agent whole steps (it writes a script file and retries instead).
  const QUOTED = "node -e \"console.log('a b'.split(' ').join('-'))\"";

  it("parses POSIX quoting wherever a POSIX shell exists", () => {
    const { command, args } = shellCommand(QUOTED);
    if (process.platform === "win32" && command === "cmd.exe") {
      // No Git Bash / sh on this machine: cmd.exe is the documented fallback.
      return;
    }
    const res = spawnSync(command, args, { encoding: "utf8" });
    const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    expect(output).not.toMatch(/Unterminated string|Invalid or unexpected token/i);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("a-b");
  });
});

describe("createBuiltinTools with subagents", () => {
  const host = { request: vi.fn(async () => ({})) };
  const ask = vi.fn(async () => undefined);
  const bridge = {
    mode: "agent",
    ask,
    model: {},
    contextWindow: 1_000,
    cwd: "/w",
    signal: new AbortController().signal,
    settings: { enabled: true, allowAdhoc: true, agents: [] },
    emit: vi.fn(),
    buildChildTools: vi.fn(() => ({ read: { description: "read" } })),
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 },
    results: new Map(),
    slots: { acquire: async () => () => {} },
  } as unknown as Parameters<typeof createBuiltinTools>[0]["subagents"];

  it("adds the `task` tool only when the bridge is present, in both modes", () => {
    expect(Object.keys(createBuiltinTools({ host, mode: "agent", ask }))).not.toContain("task");
    expect(Object.keys(createBuiltinTools({ host, mode: "plan", ask, subagents: bridge }))).toEqual([
      "read",
      "glob",
      "grep",
      "ask",
      "task",
    ]);
    expect(Object.keys(createBuiltinTools({ host, mode: "agent", ask, subagents: bridge }))).toEqual([
      "read",
      "glob",
      "grep",
      "write",
      "edit",
      "bash",
      "ask",
      "task",
    ]);
  });

  it("describes the roster and the ad-hoc rules for the model", () => {
    const tools = createBuiltinTools({ host, mode: "agent", ask, subagents: bridge });
    const description = String((tools.task as { description: string }).description);
    expect(description).toContain("explore —");
    expect(description).toContain("ad-hoc");
    expect(description).toContain("cannot spawn");
  });
});
