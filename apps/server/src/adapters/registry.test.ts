import { describe, it, expect, afterEach } from "vitest";
import { DEFAULT_SETTINGS, type AppSettings } from "@acpio/shared";
import {
  adapterArgs,
  adapterCommand,
  adapters,
  getAdapter,
  setCustomAdapters,
} from "./registry.js";
import { cursorAdapter } from "@acpio/adapter-cursor";
import { ompAdapter } from "@acpio/adapter-omp";

describe("adapter registry", () => {
  it("registers the three built-in harnesses", () => {
    expect(adapters.ids().sort()).toEqual(["builtin", "cursor", "omp"]);
    expect(adapters.get("cursor")).toBe(cursorAdapter);
    expect(adapters.get("omp")).toBe(ompAdapter);
    expect(adapters.get("builtin")).toBeDefined();
  });

  it("throws for unknown providers", () => {
    expect(() => getAdapter("nope")).toThrow(/Неизвестный агент/);
  });

  it("adapterCommand/args prefer settings fields and fall back to defaults", () => {
    const custom = {
      ...DEFAULT_SETTINGS,
      cursorCommand: "my-cursor",
      cursorArgs: ["--custom"],
    } as AppSettings;
    expect(adapterCommand(cursorAdapter, custom)).toBe("my-cursor");
    expect(adapterArgs(cursorAdapter, custom)).toEqual(["--custom"]);
    // Missing fields fall back to the adapter defaults.
    expect(adapterCommand(cursorAdapter, DEFAULT_SETTINGS)).toBe("agent");
    expect(adapterArgs(cursorAdapter, DEFAULT_SETTINGS)).toEqual(["acp"]);
    expect(adapterCommand(ompAdapter, DEFAULT_SETTINGS)).toBe("omp");
  });
});

describe("user-defined agents", () => {
  afterEach(() => setCustomAdapters([]));

  const spec = {
    id: "my-agent",
    label: "My Agent",
    command: "C:\\tools\\agent.exe",
    args: ["--stdio"],
  };

  it("builds a resolvable adapter whose command lives in the spec", () => {
    setCustomAdapters([spec]);
    expect(adapters.ids()).toEqual(["cursor", "omp", "builtin", "my-agent"]);
    expect(adapters.get("my-agent")?.custom).toBe(true);
    // Empty settings fields fall through to the spec's command/args.
    expect(adapterCommand(getAdapter("my-agent"), DEFAULT_SETTINGS)).toBe("C:\\tools\\agent.exe");
    expect(adapterArgs(getAdapter("my-agent"), DEFAULT_SETTINGS)).toEqual(["--stdio"]);
  });

  it("forgets a removed agent", () => {
    setCustomAdapters([spec]);
    setCustomAdapters([]);
    expect(adapters.ids()).toEqual(["cursor", "omp", "builtin"]);
    expect(adapters.get("my-agent")).toBeUndefined();
    expect(() => getAdapter("my-agent")).toThrow(/Неизвестный агент/);
  });
});

describe("cursor adapter", () => {
  it("declares load restore with replay suppression and cursor_login auth", () => {
    expect(cursorAdapter.restoreMode).toBe("load");
    expect(cursorAdapter.suppressReplayOnLoad).toBe(true);
    expect(cursorAdapter.authenticateMethodId).toBe("cursor_login");
    expect(cursorAdapter.parameterizedModelPicker).toBe(true);
    expect(cursorAdapter.subagentStreaming).toBe(true);
    expect(cursorAdapter.readSubagentTranscript).toBeTypeOf("function");
  });

  it("classifies cursor subagent tool kinds", () => {
    expect(cursorAdapter.subagentToolKinds).toContain("task");
    expect(cursorAdapter.subagentToolKinds).toContain("explore");
  });

  it("maps extension requests and replies with the outcome envelope", () => {
    expect(cursorAdapter.extensionKinds["cursor/task"]).toBe("subagent_task");
    const reply = cursorAdapter.extensionReply!("cursor/task", {
      agentId: "a1",
      durationMs: 1200,
    });
    expect(reply).toEqual({ outcome: { outcome: "completed", agentId: "a1", durationMs: 1200 } });
    const todos = cursorAdapter.extensionReply!("cursor/update_todos", { todos: [{ id: 1 }] });
    expect(todos).toEqual({ outcome: { outcome: "accepted", todos: [{ id: 1 }] } });
  });

  it("normalizes cursor/task to a subagent card", () => {
    const mapped = cursorAdapter.subagentTaskCard!({
      tool_call_id: "call-1",
      title: "Проверь файл",
      status: "running",
      prompt: "прочитай x.md",
    });
    expect(mapped?.toolCallId).toBe("call-1");
    expect(mapped?.card.status).toBe("running");
    expect(mapped?.card.title).toBe("Проверь файл");
    // Launch prompt is not the card body — completion text comes later.
    expect(mapped?.card.body).toBeUndefined();
  });

  it("treats cursor/task without terminal signals as running", () => {
    const mapped = cursorAdapter.subagentTaskCard!({
      toolCallId: "call-2",
      description: "Random math A",
      prompt: "compute …",
    });
    expect(mapped?.card.status).toBe("running");
    expect(mapped?.card.title).toBe("Random math A");
  });

  it("marks cursor/task with durationMs as completed", () => {
    const mapped = cursorAdapter.subagentTaskCard!({
      toolCallId: "call-3",
      description: "Done task",
      durationMs: 1200,
      result: "answer",
    });
    expect(mapped?.card.status).toBe("completed");
    expect(mapped?.card.body).toBe("answer");
  });
});

describe("omp adapter", () => {
  it("declares resume restore, subagent streaming and cloud catalog", () => {
    expect(ompAdapter.restoreMode).toBe("resume");
    expect(ompAdapter.suppressReplayOnLoad).toBe(false);
    expect(ompAdapter.subagentStreaming).toBe(true);
    expect(ompAdapter.cloudCatalog).toBe(true);
    expect(ompAdapter.parameterizedModelPicker).toBe(false);
  });

  it("maps roster entries to normalized cards", () => {
    const card = ompAdapter.subagentCardFromRoster!({
      kind: "sub",
      id: "CalcG",
      displayName: "task",
      status: "running",
      activity: "считает",
      metrics: { tokens: 100, cost: 0.01 },
    });
    expect(card).not.toBeNull();
    expect(card!.agentId).toBe("CalcG");
    expect(card!.status).toBe("running");
    expect(card!.body).toContain("считает");
    // Non-sub entries and missing ids are skipped.
    expect(ompAdapter.subagentCardFromRoster!({ kind: "main", id: "x" })).toBeNull();
    expect(ompAdapter.subagentCardFromRoster!({ kind: "sub" })).toBeNull();
  });

  it("maps progress snapshots to normalized updates", () => {
    const card = ompAdapter.subagentCardFromProgress!({
      id: "CalcH",
      status: "completed",
      lastIntent: "посчитать",
      durationMs: 2500,
    });
    expect(card.status).toBe("completed");
    expect(card.body).toContain("посчитать");
    expect(card.body).toContain("время: 3 с");
  });
});
