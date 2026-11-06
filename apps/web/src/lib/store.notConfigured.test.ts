// @vitest-environment jsdom
// A board card's chat lives in `boardSessions`, not in the sidebar's tree.
// Sending a prompt from the card asks the store why the harness cannot take it
// — and that lookup used to see only the tree, so a built-in agent without an
// endpoint answered "nothing to warn about": the message went to a server that
// refused it and waited in the queue with no reason shown anywhere.
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type AdapterMetaDto, type SessionDto } from "@acpio/shared";

vi.mock("./api", () => ({ api: {} }));

import { useAppStore } from "./store";

const BUILTIN: AdapterMetaDto = {
  id: "builtin",
  label: "Built-in",
  enabled: true,
  family: "builtin",
  commandField: "",
  argsField: "",
  defaultCommand: "",
  defaultArgs: [],
  installHint: "",
  restoreMode: "resume",
  parameterizedModelPicker: true,
  subagentStreaming: false,
  cloudCatalog: false,
  midTurnSteering: true,
  defaultModes: [],
  subagentToolKinds: [],
};

/** The card's chat as the board holds it. */
function task(): SessionDto {
  return {
    id: "t1",
    title: "Task",
    provider: "builtin",
    cwd: "C:/proj",
    mode: "agent",
    status: "idle",
    acpSessionId: null,
    themeId: null,
    sortOrder: 0,
    pinned: false,
    archived: false,
    boardId: "b1",
    taskDescription: "Task",
    startedAt: null,
    doneAt: null,
    mcpDisabledIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastMessageAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("a board card whose harness is not configured", () => {
  it("names the missing setting instead of handing the message to a refusing server", () => {
    const card = task();
    useAppStore.setState({
      adapters: [BUILTIN],
      settings: { ...DEFAULT_SETTINGS, builtinProviders: [] },
      // The card is on the board; the tree that lists chats holds nothing.
      sessions: [],
      boardSessions: [card],
      activeSessionId: null,
      activeSession: null,
      harnessNotConfigured: null,
    });

    expect(useAppStore.getState().warnIfHarnessNotConfigured(card.id)).toBe(true);
    expect(useAppStore.getState().harnessNotConfigured).toEqual({
      provider: "builtin",
      reason: "endpoint",
    });
  });
});
