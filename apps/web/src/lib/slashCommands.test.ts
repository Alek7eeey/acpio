import { describe, it, expect } from "vitest";
import {
  buildSlashInsertion,
  filterSlashCommands,
  findSlashCommand,
  getSlashContext,
  isSlashCommandReadyToSend,
  isSlashCommandText,
  isSlashSkill,
  mergeSlashCommands,
  parseSlashCommandText,
  slashCommandRequiresInput,
  splitSlashCommandHighlight,
} from "./slashCommands";
import type { SlashCommandDto } from "@acpio/shared";

/** Stub translator that echoes the message key. */
const t = (key: string) => key;

describe("parseSlashCommandText", () => {
  it("parses a bare /name", () => {
    expect(parseSlashCommandText("/stop")).toEqual({ name: "stop", args: "" });
  });

  it("parses a command with a single-word arg", () => {
    expect(parseSlashCommandText("/clear history")).toEqual({
      name: "clear",
      args: "history",
    });
  });

  it("parses a command with multi-word args", () => {
    expect(parseSlashCommandText("/echo hello world")).toEqual({
      name: "echo",
      args: "hello world",
    });
  });

  it("keeps inner whitespace runs inside args", () => {
    expect(parseSlashCommandText("/echo a   b")).toEqual({
      name: "echo",
      args: "a   b",
    });
  });

  it("trims trailing whitespace so the args come back empty", () => {
    expect(parseSlashCommandText("/stop   ")).toEqual({ name: "stop", args: "" });
  });

  it("trims leading whitespace before the slash", () => {
    expect(parseSlashCommandText("  /stop")).toEqual({ name: "stop", args: "" });
  });

  it("trims surrounding whitespace but keeps the arg content", () => {
    expect(parseSlashCommandText("  /echo hi  ")).toEqual({
      name: "echo",
      args: "hi",
    });
  });

  it("returns null for an empty string", () => {
    expect(parseSlashCommandText("")).toBeNull();
  });

  it("returns null for whitespace-only text", () => {
    expect(parseSlashCommandText("   ")).toBeNull();
  });

  it("returns null when the text has no leading slash", () => {
    expect(parseSlashCommandText("stop")).toBeNull();
  });

  it("returns null for a lone slash", () => {
    expect(parseSlashCommandText("/")).toBeNull();
  });

  it("returns null when the name starts with a digit", () => {
    expect(parseSlashCommandText("/1stop")).toBeNull();
  });

  it("parses namespace-style names", () => {
    expect(parseSlashCommandText("/skill:name")).toEqual({
      name: "skill:name",
      args: "",
    });
  });

  it("parses namespace-style names with args", () => {
    expect(parseSlashCommandText("/skill:name arg")).toEqual({
      name: "skill:name",
      args: "arg",
    });
  });

  it("returns null for Windows-style paths like /C:/foo", () => {
    expect(parseSlashCommandText("/C:/foo")).toBeNull();
  });

  it("allows a second slash inside the args", () => {
    expect(parseSlashCommandText("/stop /other")).toEqual({
      name: "stop",
      args: "/other",
    });
  });

  it("allows newlines inside the args", () => {
    expect(parseSlashCommandText("/stop\nrest")).toEqual({
      name: "stop",
      args: "rest",
    });
  });

  it("preserves the original case of the name", () => {
    expect(parseSlashCommandText("/Stop")).toEqual({ name: "Stop", args: "" });
  });
});

describe("getSlashContext", () => {
  it("captures the in-progress command name at the cursor", () => {
    expect(getSlashContext("/st", 3)).toEqual({ query: "st", start: 0 });
  });

  it("captures the full command name when the cursor sits right after it", () => {
    expect(getSlashContext("/stop now", 5)).toEqual({ query: "stop", start: 0 });
  });

  it("captures a partial name when the cursor is mid-word", () => {
    expect(getSlashContext("/stop", 4)).toEqual({ query: "sto", start: 0 });
  });

  it("returns null once whitespace separates the args", () => {
    expect(getSlashContext("/stop now", 6)).toBeNull();
  });

  it("captures a command typed on a new line", () => {
    expect(getSlashContext("foo\n/st", 7)).toEqual({ query: "st", start: 4 });
  });

  it("captures a command after existing draft text", () => {
    expect(getSlashContext("hello /st", 9)).toEqual({ query: "st", start: 6 });
  });

  it("returns an empty query for a bare slash after a space", () => {
    expect(getSlashContext("hello /", 7)).toEqual({ query: "", start: 6 });
  });

  it("returns null for empty text", () => {
    expect(getSlashContext("", 0)).toBeNull();
  });

  it("returns null when the cursor is before any text", () => {
    expect(getSlashContext("/st", 0)).toBeNull();
  });

  it("returns an empty query for a bare slash at the start", () => {
    expect(getSlashContext("/", 1)).toEqual({ query: "", start: 0 });
  });

  it("returns an empty query for a bare slash on a new line", () => {
    expect(getSlashContext("a\n/", 3)).toEqual({ query: "", start: 2 });
  });

  it("captures a slash after a space mid-line", () => {
    expect(getSlashContext("a /b", 4)).toEqual({ query: "b", start: 2 });
  });

  it("returns null when there is no slash at all", () => {
    expect(getSlashContext("hello", 5)).toBeNull();
  });

  it("accepts word chars, dashes, underscores and colons in the query", () => {
    expect(getSlashContext("/a-b_c:d", 10)).toEqual({
      query: "a-b_c:d",
      start: 0,
    });
  });

  it("ignores a slash inside a word when it is not at a line start", () => {
    expect(getSlashContext("x/y", 3)).toBeNull();
  });
});

describe("filterSlashCommands", () => {
  const cmds: SlashCommandDto[] = [
    { name: "clear", description: "Clear the chat history" },
    { name: "connect", description: "Connect to a remote agent" },
  ];

  it("returns every command for an empty query (same reference)", () => {
    expect(filterSlashCommands(cmds, "")).toBe(cmds);
  });

  it("returns every command for a whitespace-only query", () => {
    expect(filterSlashCommands(cmds, "   ")).toBe(cmds);
  });

  it("matches commands by name prefix", () => {
    expect(filterSlashCommands(cmds, "cle")).toEqual([cmds[0]]);
  });

  it("matches command names case-insensitively", () => {
    expect(filterSlashCommands(cmds, "CLEAR")).toEqual([cmds[0]]);
  });

  it("matches commands by description substring", () => {
    expect(filterSlashCommands(cmds, "remote")).toEqual([cmds[1]]);
  });

  it("matches descriptions case-insensitively", () => {
    expect(filterSlashCommands(cmds, "REMOTE")).toEqual([cmds[1]]);
  });

  it("trims surrounding whitespace from the query", () => {
    expect(filterSlashCommands(cmds, "  cle  ")).toEqual([cmds[0]]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterSlashCommands(cmds, "zzz")).toEqual([]);
  });

  it("matches a description term even when it does not prefix the name", () => {
    expect(filterSlashCommands(cmds, "hist")).toEqual([cmds[0]]);
  });
});

describe("mergeSlashCommands", () => {
  it("returns an empty list when no agent commands are given", () => {
    expect(mergeSlashCommands([], t)).toEqual([]);
  });

  it("defaults agentCommands to an empty array", () => {
    expect(mergeSlashCommands(undefined, t)).toEqual([]);
  });

  it("keeps agent commands", () => {
    expect(mergeSlashCommands([{ name: "clear", description: "Clear" }], t)).toEqual([
      { name: "clear", description: "Clear" },
    ]);
  });

  it("keeps stop when the agent advertises it", () => {
    expect(mergeSlashCommands([{ name: "stop", description: "dupe" }], t)).toEqual([
      { name: "stop", description: "dupe" },
    ]);
  });

  it("dedupes repeated agent commands, keeping the later snapshot", () => {
    expect(
      mergeSlashCommands(
        [
          { name: "a", description: "first" },
          { name: "a", description: "second" },
        ],
        t,
      ),
    ).toEqual([{ name: "a", description: "second" }]);
  });

  it("strips a leading slash and trims the name/description of agent commands", () => {
    expect(mergeSlashCommands([{ name: "/clear", description: "  Clear now  " }], t)[0]).toEqual({
      name: "clear",
      description: "Clear now",
    });
  });

  it("keeps namespace-style command names", () => {
    expect(mergeSlashCommands([{ name: "skill:foo", description: "d" }], t)[0]).toEqual({
      name: "skill:foo",
      description: "d",
    });
  });

  it("lists user skills above other advertised commands", () => {
    expect(
      mergeSlashCommands(
        [
          { name: "copy-request-id", description: "Copy the last request ID" },
          { name: "compact", description: "Compact" },
          { name: "git-commit-ru", description: "Commit in Russian (user skill)" },
          { name: "create-pr", description: "Open a PR" },
        ],
        t,
      ).map((c) => c.name),
    ).toEqual(["git-commit-ru", "copy-request-id", "compact", "create-pr"]);
  });

  it("lists OMP skill: names with user skills", () => {
    expect(
      mergeSlashCommands(
        [
          { name: "compact", description: "Compact" },
          { name: "skill:git-commit-ru", description: "OMP" },
        ],
        t,
      ).map((c) => c.name),
    ).toEqual(["skill:git-commit-ru", "compact"]);
  });

  it("dedupes OMP skill:name against the unprefixed skill name", () => {
    expect(
      mergeSlashCommands(
        [
          { name: "skill:git-commit-ru", description: "OMP" },
          { name: "git-commit-ru", description: "Skill", kind: "skill" },
        ],
        t,
      ).map((c) => c.name),
    ).toEqual(["skill:git-commit-ru"]);
  });
});

describe("isSlashSkill", () => {
  it("uses agent skill markers, not unknown names", () => {
    expect(isSlashSkill({ name: "skill:foo", description: "d" })).toBe(true);
    expect(isSlashSkill({ name: "git-commit-ru", description: "Commit (user skill)" })).toBe(true);
    expect(isSlashSkill({ name: "review", description: "Review (project skill)" })).toBe(true);
    expect(isSlashSkill({ name: "automate", description: "d" })).toBe(false);
    expect(isSlashSkill({ name: "compact", description: "d" })).toBe(false);
    expect(isSlashSkill({ name: "tagged", description: "d", kind: "skill" })).toBe(true);
  });
});

describe("mergeSlashCommands keeps previously hidden names", () => {
  it.each(["plugins", "plugin", "manage-plugins", "manage_plugins", "PLUGINS", "Manage-Plugins"])(
    "keeps the command %j",
    (name) => {
      expect(mergeSlashCommands([{ name, description: "d" }], t)[0]?.name.toLowerCase()).toBe(
        name.toLowerCase(),
      );
    },
  );

  it.each(["manage plugins", "Manage Plugins", "manage plugin", "MANAGE PLUGINS"])(
    "keeps commands whose description mentions plugin management: %j",
    (description) => {
      expect(mergeSlashCommands([{ name: "x", description }], t)).toEqual([
        { name: "x", description },
      ]);
    },
  );

  it("keeps commands whose description starts with a bracket placeholder", () => {
    expect(mergeSlashCommands([{ name: "create-pr", description: "[title|body] Open a PR" }], t)[0]).toEqual({
      name: "create-pr",
      description: "[title|body] Open a PR",
    });
  });

  it("keeps descriptions that only contain brackets mid-text", () => {
    expect(mergeSlashCommands([{ name: "x", description: "tool [a|b]" }], t)[0]).toEqual({
      name: "x",
      description: "tool [a|b]",
    });
  });

  it("skips agent commands with invalid names", () => {
    expect(mergeSlashCommands([{ name: "1bad", description: "d" }], t)).toEqual([]);
  });

  it("preserves requiresInput on agent commands", () => {
    expect(mergeSlashCommands([{ name: "ask", description: "d", requiresInput: true }], t)[0]).toEqual({
      name: "ask",
      description: "d",
      requiresInput: true,
    });
  });

  it("falls back to the name for an empty description", () => {
    expect(mergeSlashCommands([{ name: "bare", description: "  " }], t)[0]).toEqual({
      name: "bare",
      description: "bare",
    });
  });

  it("keeps a plain inputHint and marks the command as requiring input", () => {
    expect(mergeSlashCommands([{ name: "ask", description: "d", inputHint: "prompt" }], t)[0]).toEqual({
      name: "ask",
      description: "d",
      requiresInput: true,
      inputHint: "prompt",
    });
  });

  it("drops a bracket-syntax inputHint", () => {
    expect(mergeSlashCommands([{ name: "ask", description: "d", inputHint: "[a|b]" }], t)[0]).toEqual({
      name: "ask",
      description: "d",
    });
  });
});

describe("isSlashCommandReadyToSend", () => {
  const stop: SlashCommandDto = { name: "stop", description: "d" };
  const clear: SlashCommandDto = { name: "clear", description: "d", requiresInput: true };
  const ask: SlashCommandDto = { name: "ask", description: "d", inputHint: "hint" };

  it("allows plain text that is not a slash command", () => {
    expect(isSlashCommandReadyToSend("hello world", [])).toBe(true);
  });

  it("allows a known command that needs no input", () => {
    expect(isSlashCommandReadyToSend("/stop", [stop])).toBe(true);
  });

  it("sends known commands without args so the agent can handle them", () => {
    expect(isSlashCommandReadyToSend("/clear", [stop, clear])).toBe(true);
  });

  it("allows a known command that requires input when args are present", () => {
    expect(isSlashCommandReadyToSend("/clear now", [stop, clear])).toBe(true);
  });

  it("allows unknown commands", () => {
    expect(isSlashCommandReadyToSend("/nope", [stop])).toBe(true);
  });

  it("sends a command that only has an inputHint", () => {
    expect(isSlashCommandReadyToSend("/ask", [ask])).toBe(true);
  });

  it("allows an inputHint command once args are typed", () => {
    expect(isSlashCommandReadyToSend("/ask something", [ask])).toBe(true);
  });

  it("does not block trailing whitespace before send", () => {
    expect(isSlashCommandReadyToSend("/clear  ", [clear])).toBe(true);
  });

  it("respects an explicit requiresInput:false even with an inputHint", () => {
    const cmd: SlashCommandDto = { name: "x", description: "d", requiresInput: false, inputHint: "hint" };
    expect(isSlashCommandReadyToSend("/x", [cmd])).toBe(true);
  });
});

describe("buildSlashInsertion", () => {
  it("inserts a slash command with a trailing space so the menu can close", () => {
    expect(buildSlashInsertion({ name: "stop", description: "d" })).toBe("/stop ");
  });

  it("appends a trailing space for commands that require input", () => {
    expect(buildSlashInsertion({ name: "clear", description: "d", requiresInput: true })).toBe("/clear ");
  });

  it("appends a trailing space when only an inputHint is present", () => {
    expect(buildSlashInsertion({ name: "ask", description: "d", inputHint: "hint" })).toBe("/ask ");
  });

  it("still appends a space when requiresInput is explicitly false", () => {
    expect(buildSlashInsertion({ name: "x", description: "d", requiresInput: false, inputHint: "hint" })).toBe("/x ");
  });

  it("handles namespace-style names", () => {
    expect(buildSlashInsertion({ name: "skill:foo", description: "d" })).toBe("/skill:foo ");
  });
});

describe("slashCommandRequiresInput", () => {
  it("is true when requiresInput is set", () => {
    expect(slashCommandRequiresInput({ name: "a", description: "d", requiresInput: true })).toBe(true);
  });

  it("is false when requiresInput is explicitly false", () => {
    expect(slashCommandRequiresInput({ name: "a", description: "d", requiresInput: false })).toBe(false);
  });

  it("is true when only an inputHint is present", () => {
    expect(slashCommandRequiresInput({ name: "a", description: "d", inputHint: "hint" })).toBe(true);
  });

  it("is false for an empty inputHint", () => {
    expect(slashCommandRequiresInput({ name: "a", description: "d", inputHint: "" })).toBe(false);
  });

  it("prefers an explicit false over an inputHint", () => {
    expect(
      slashCommandRequiresInput({ name: "a", description: "d", requiresInput: false, inputHint: "hint" }),
    ).toBe(false);
  });

  it("is false when nothing is set", () => {
    expect(slashCommandRequiresInput({ name: "a", description: "d" })).toBe(false);
  });
});

describe("findSlashCommand", () => {
  const cmds: SlashCommandDto[] = [
    { name: "stop", description: "d" },
    { name: "clear", description: "d" },
  ];

  it("finds a command by exact name", () => {
    expect(findSlashCommand(cmds, "clear")).toEqual(cmds[1]);
  });

  it("matches case-insensitively", () => {
    expect(findSlashCommand(cmds, "STOP")).toEqual(cmds[0]);
  });

  it("returns null when the command is unknown", () => {
    expect(findSlashCommand(cmds, "nope")).toBeNull();
  });
});

describe("isSlashCommandText", () => {
  it("recognizes slash command text", () => {
    expect(isSlashCommandText("/stop")).toBe(true);
  });

  it("rejects plain text", () => {
    expect(isSlashCommandText("hello")).toBe(false);
  });
});

describe("splitSlashCommandHighlight", () => {
  it("highlights a bare command", () => {
    expect(splitSlashCommandHighlight("/stop")).toEqual([{ kind: "command", value: "/stop" }]);
  });

  it("keeps args as ordinary text", () => {
    expect(splitSlashCommandHighlight("/ask what is this")).toEqual([
      { kind: "command", value: "/ask" },
      { kind: "text", value: " what is this" },
    ]);
  });

  it("ignores Windows paths", () => {
    expect(splitSlashCommandHighlight("/C:/Users/me")).toEqual([
      { kind: "text", value: "/C:/Users/me" },
    ]);
  });

  it("ignores mid-word slashes", () => {
    expect(splitSlashCommandHighlight("x/y")).toEqual([{ kind: "text", value: "x/y" }]);
  });

  it("only highlights a full match when known names are given", () => {
    expect(splitSlashCommandHighlight("/sto", ["stop"])).toEqual([
      { kind: "text", value: "/sto" },
    ]);
    expect(splitSlashCommandHighlight("/stop", ["stop"])).toEqual([
      { kind: "command", value: "/stop" },
    ]);
    expect(splitSlashCommandHighlight("/stop now", ["stop"])).toEqual([
      { kind: "command", value: "/stop" },
      { kind: "text", value: " now" },
    ]);
    expect(splitSlashCommandHighlight("/ask", ["stop"])).toEqual([{ kind: "text", value: "/ask" }]);
  });
});
