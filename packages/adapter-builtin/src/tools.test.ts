import { describe, expect, it, vi, type Mock } from "vitest";
import type { AgentMode } from "@acpio/shared";
import { createBuiltinTools } from "./tools.js";

/** Tool execution options the SDK passes; only abortSignal is used here. */
const CTX = { abortSignal: new AbortController().signal };

type HostMock = { request: Mock };

function setup(mode: AgentMode, host?: HostMock, ask?: Mock) {
  const h: HostMock = host ?? { request: vi.fn(async () => ({})) };
  const a: Mock = ask ?? vi.fn(async () => undefined);
  return { tools: createBuiltinTools({ host: h, mode, ask: a }), host: h, ask: a };
}

const exec = (tools: Record<string, any>, name: string, input: unknown) =>
  tools[name].execute(input, CTX);

describe("createBuiltinTools", () => {
  it.each([
    ["plan", ["read"]],
    ["ask", ["read"]],
    ["agent", ["read", "write", "edit", "bash"]],
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

  it("edit replaces a single match and writes the result back", async () => {
    const { tools, host } = setup("agent");
    host.request.mockImplementation(async (method: string) =>
      method === "fs/read_text_file" ? { content: "one two three" } : {},
    );
    await expect(
      exec(tools, "edit", { path: "f.txt", old_string: "two", new_string: "2" }),
    ).resolves.toContain("Replaced 1");
    expect(host.request).toHaveBeenCalledWith("fs/write_text_file", {
      path: "f.txt",
      content: "one 2 three",
    });
  });

  it("edit refuses an ambiguous match instead of guessing", async () => {
    const { tools, host } = setup("agent");
    host.request.mockResolvedValue({ content: "x x" });
    await expect(
      exec(tools, "edit", { path: "f.txt", old_string: "x", new_string: "y" }),
    ).rejects.toThrow(/matches 2 times/);
    expect(host.request).toHaveBeenCalledTimes(1); // read only, no write
  });

  it("edit refuses when the anchor is gone", async () => {
    const { tools, host } = setup("agent");
    host.request.mockResolvedValue({ content: "abc" });
    await expect(
      exec(tools, "edit", { path: "f.txt", old_string: "zz", new_string: "y" }),
    ).rejects.toThrow(/not found/);
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
});
