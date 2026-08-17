// Pure unit tests for sessionManager's exported helper functions.
// Importing the module is side-effect-free at import time (lazy pg pool);
// these tests never touch the database.
import { describe, it, expect } from "vitest";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
} from "@acprocess/shared";
import {
  coerceUiMode,
  normalizePlanPartPayload,
  paramsFromModelWire,
  parseRpcId,
  effectiveMcpServers,
  pickRestoreMode,
  requestIdFor,
  subagentFieldsFromRaw,
  textFromUnknown,
} from "./sessionManager.js";

describe("coerceUiMode", () => {
  it.each([
    ["agent", "agent"],
    ["plan", "plan"],
    ["ask", "ask"],
    ["code", "agent"],
    ["edit", "agent"],
    ["default", "agent"],
    ["normal", "agent"],
    ["architect", "plan"],
    ["chat", "ask"],
    ["readonly", "ask"],
    ["read-only", "ask"],
    ["read", "ask"],
    // case-insensitive + trimming
    ["AGENT", "agent"],
    ["Architect", "plan"],
    ["  Ask  ", "ask"],
    ["EDIT ", "agent"],
    // unknown / empty -> null
    ["unknown", null],
    ["", null],
    ["   ", null],
    [null, null],
    [undefined, null],
  ] as const)("maps %j to %j", (raw, expected) => {
    expect(coerceUiMode(raw as string)).toBe(expected);
  });
});

describe("textFromUnknown", () => {
  it.each([
    // falsy values -> ""
    ["", ""],
    [null, ""],
    [undefined, ""],
    [0, ""],
    [false, ""],
    [42, ""],
    // plain strings pass through verbatim (no trimming of non-JSON strings)
    ["hello", "hello"],
    ["  hello  ", "  hello  "],
    // JSON-string arrays / objects get parsed and recursed
    ['["a","b"]', "a\n\nb"],
    ['{"text":"hi"}', "hi"],
    ['[{"text":"a"},{"output":"b"}]', "a\n\nb"],
    ['{"output":"o","content":"c"}', "o"],
    // JSON-looking but unparseable -> original value
    ["[not json", "[not json"],
    ["{oops}", "{oops}"],
    // JSON that parses to something without extractable text -> ""
    ['{"a":1}', ""],
    // arrays
    [["a", "b", ""], "a\n\nb"],
    [["a", 1, null], "a"],
    [[["a"], ["b"]], "a\n\nb"],
    [[{ text: "a" }, { output: "b" }], "a\n\nb"],
    [[[{ text: "a" }], [{ result: "b" }]], "a\n\nb"],
    // object field precedence: text > prompt > output > content > result
    [{ text: "hello" }, "hello"],
    [{ prompt: "p" }, "p"],
    [{ output: "o" }, "o"],
    [{ content: "c" }, "c"],
    [{ result: "r" }, "r"],
    [{ text: "t", output: "o" }, "t"],
    [{ prompt: "p", output: "o" }, "p"],
    [{ output: "o", content: "c" }, "o"],
    [{ content: "c", result: "r" }, "c"],
    // non-string text falls through the chain
    [{ text: 42, output: "o" }, "o"],
    [{ text: 42 }, ""],
    [{ text: "" }, ""],
    // nested content / result
    [{ content: { text: "deep" } }, "deep"],
    [{ result: { output: "deep2" } }, "deep2"],
    [{ content: ["x", "y"] }, "x\n\ny"],
    [{ content: "" }, ""],
    // empty object -> ""
    [{}, ""],
  ])("textFromUnknown(%j) === %j", (value, expected) => {
    expect(textFromUnknown(value)).toBe(expected);
  });
});

describe("subagentFieldsFromRaw", () => {
  it.each([
    // prompt sources
    [{ prompt: "do x" }, { prompt: "do x" }],
    [{ prompt: '{"text":"do x"}' }, { prompt: "do x" }],
    [{ prompt: ["step 1", "step 2"] }, { prompt: "step 1\n\nstep 2" }],
    [{ rawInput: { prompt: "p" } }, { prompt: "p" }],
    [{ arguments: { prompt: "p" } }, { prompt: "p" }],
    [{ input: { prompt: "p" } }, { prompt: "p" }],
    // raw.prompt wins over nested sources
    [{ prompt: "a", rawInput: { prompt: "b" } }, { prompt: "a" }],
    [{ rawInput: { prompt: "b" }, arguments: { prompt: "c" } }, { prompt: "b" }],
    // no prompt anywhere -> omitted
    [{ result: "out" }, { result: "out" }],
    // result sources
    [{ result: "out" }, { result: "out" }],
    [{ content: "out" }, { result: "out" }],
    [{ result: '{"output":"out"}' }, { result: "out" }],
    [{ result: { text: "t" } }, { result: "t" }],
    [{ result: "", content: "c" }, { result: "c" }],
    // title from explicit fields, precedence title > description > name > label
    [{ title: "My Task" }, { title: "My Task", description: "My Task" }],
    [{ description: "Desc" }, { title: "Desc", description: "Desc" }],
    [{ name: "Named" }, { title: "Named", description: "Named" }],
    [{ label: "Labelled" }, { title: "Labelled", description: "Labelled" }],
    [
      { title: "T", description: "D", name: "N", label: "L" },
      { title: "T", description: "T" },
    ],
    // generic titles filtered out (case-insensitive, incl. Cyrillic)
    [{ title: "task" }, {}],
    [{ title: "Tool" }, {}],
    [{ title: "subagent" }, {}],
    [{ title: "субагент" }, {}],
    [{ title: "  task  " }, {}],
    [{ label: "task", result: "### Real Title\nbody" }, { result: "### Real Title\nbody", title: "Real Title", description: "Real Title" }],
    // title from body: ### heading
    [{ result: "### My Plan\nbody" }, { result: "### My Plan\nbody", title: "My Plan", description: "My Plan" }],
    [{ result: "### Plan [phase 1]\nbody" }, { result: "### Plan [phase 1]\nbody", title: "Plan", description: "Plan" }],
    [{ result: "Intro\n### Deep Section\nmore" }, { result: "Intro\n### Deep Section\nmore", title: "Deep Section", description: "Deep Section" }],
    [{ result: "###   Spaced  \nbody" }, { result: "###   Spaced  \nbody", title: "Spaced", description: "Spaced" }],
    // title from body: Label:
    [{ result: "\nLabel: The Label\n" }, { result: "\nLabel: The Label\n", title: "The Label", description: "The Label" }],
    // title from body: <task-result id="...">
    [{ result: '<task-result id="abc-123">x</task-result>' }, { result: '<task-result id="abc-123">x</task-result>', title: "abc-123", description: "abc-123" }],
    [{ result: '<TASK-RESULT ID="XYZ">' }, { result: '<TASK-RESULT ID="XYZ">', title: "XYZ", description: "XYZ" }],
    // explicit title beats body-derived title
    [{ label: "L", result: "### H\n" }, { result: "### H\n", title: "L", description: "L" }],
    // body title without any explicit field
    [{ result: "### OnlyBody\n" }, { result: "### OnlyBody\n", title: "OnlyBody", description: "OnlyBody" }],
    // body with no extractable title -> no title key
    [{ result: "no heading here" }, { result: "no heading here" }],
    // all fields together
    [{ prompt: "p", result: "r", title: "T" }, { prompt: "p", result: "r", title: "T", description: "T" }],
    // empty raw -> {}
    [{}, {}],
  ])("subagentFieldsFromRaw(%j) === %j", (raw, expected) => {
    expect(subagentFieldsFromRaw(raw)).toEqual(expected);
  });
});

describe("normalizePlanPartPayload", () => {
  it.each([
    // name from name or title, trimmed
    [{ name: "Plan" }, { name: "Plan" }],
    [{ name: "  N  " }, { name: "N" }],
    [{ title: "T" }, { title: "T", name: "T" }],
    // empty-after-trim values stay as-is via the raw spread (no cleaned key added)
    [{ name: "   " }, { name: "   " }],
    // overview
    [{ overview: "  Ov  " }, { overview: "Ov" }],
    // plan from plan or content
    [{ plan: "  Pl  " }, { plan: "Pl" }],
    [{ content: "C" }, { content: "C", plan: "C" }],
    // empty raw -> {}
    [{}, {}],
    // unknown fields pass through via spread
    [{ weird: "field", name: "N" }, { weird: "field", name: "N" }],
    // non-string name coerced
    [{ name: 42 }, { name: "42" }],
    // todos passthrough with cleaning
    [{ todos: [{ content: "a", status: "done", id: "1" }] }, { todos: [{ content: "a", status: "done", id: "1" }] }],
    [{ todos: [{ content: "" }, { content: "Keep" }] }, { todos: [{ content: "Keep" }] }],
    [{ todos: [{ content: "  " }] }, { todos: [{ content: "  " }] }],
    // entries mapped into {id, content, status}
    [
      { entries: [{ content: "A" }, { content: "B", status: "done" }, { title: "C" }] },
      {
        entries: [{ content: "A" }, { content: "B", status: "done" }, { title: "C" }],
        todos: [
          { id: "entry-0", content: "A", status: "pending" },
          { id: "entry-1", content: "B", status: "done" },
          { id: "entry-2", content: "C", status: "pending" },
        ],
      },
    ],
    // explicit ids win over entry-N fallback
    [
      { entries: [{ id: "x1", content: "A" }] },
      { entries: [{ id: "x1", content: "A" }], todos: [{ id: "x1", content: "A", status: "pending" }] },
    ],
    // status mapping: missing/null -> pending, others stringified
    [
      { entries: [{ content: "A", status: null }, { content: "B", status: 2 }] },
      {
        entries: [{ content: "A", status: null }, { content: "B", status: 2 }],
        todos: [
          { id: "entry-0", content: "A", status: "pending" },
          { id: "entry-1", content: "B", status: "2" },
        ],
      },
    ],
    // non-object entries -> empty rows, cleaned away
    [{ entries: ["plain", null, 42] }, { entries: ["plain", null, 42] }],
    // empty-content entries cleaned out, ids preserved for survivors
    [
      { entries: [{ content: "" }, { content: "Real" }] },
      {
        entries: [{ content: "" }, { content: "Real" }],
        todos: [{ id: "entry-1", content: "Real", status: "pending" }],
      },
    ],
    // whitespace-only entry titles are empty content
    [{ entries: [{ title: "  " }] }, { entries: [{ title: "  " }] }],
    // todos field wins over entries when both present
    [
      { todos: [{ content: "T" }], entries: [{ content: "E" }] },
      {
        todos: [{ content: "T" }],
        entries: [{ content: "E" }],
      },
    ],
    // empty todos array wins over entries (empty array is not nullish)
    [{ todos: [], entries: [{ content: "E" }] }, { todos: [], entries: [{ content: "E" }] }],
    // phases passthrough (array only)
    [{ phases: [{ name: "p1" }] }, { phases: [{ name: "p1" }] }],
    [{ phases: "nope" }, { phases: "nope" }],
    [{ phases: 42 }, { phases: 42 }],
    // full payload
    [
      { name: "Plan", overview: "Ov", plan: "Pl", phases: ["x"], todos: [{ content: "T" }] },
      { name: "Plan", overview: "Ov", plan: "Pl", phases: ["x"], todos: [{ content: "T" }] },
    ],
  ])("normalizePlanPartPayload(%j) === %j", (raw, expected) => {
    expect(normalizePlanPartPayload(raw)).toEqual(expected);
  });
});

describe("requestIdFor / parseRpcId", () => {
  it.each([
    [5, 5],
    [0, 0],
    [-3, -3],
    [3.5, 3.5],
    ["abc", "abc"],
    ["007", "007"],
    ["y:z", "y:z"],
    ["12345678901234567890", "12345678901234567890"],
    ["", ""],
  ])("round-trips rpcId %j for session 'sess'", (rpcId, expected) => {
    const requestId = requestIdFor("sess", rpcId as string | number);
    expect(parseRpcId(requestId, "sess")).toBe(expected);
  });

  it.each([
    ["sess", 42, "sess:42"],
    ["sess", "abc", "sess:abc"],
    ["a:b", 7, "a:b:7"],
    ["x", 0, "x:0"],
  ])("requestIdFor(%j, %j) === %j", (sessionId, rpcId, expected) => {
    expect(requestIdFor(sessionId, rpcId as string | number)).toBe(expected);
  });

  it.each([
    ["sess:42", "sess", 42],
    ["sess:abc", "sess", "abc"],
    ["sess:", "sess", ""],
    ["sess:Infinity", "sess", "Infinity"],
    ["sess:1e21", "sess", "1e21"],
    ["a:b:7", "a:b", 7],
  ])("parseRpcId(%j, %j) === %j", (requestId, sessionId, expected) => {
    expect(parseRpcId(requestId, sessionId)).toBe(expected);
  });
});

describe("pickRestoreMode", () => {
  const base = {
    provider: "omp" as const,
    preferResume: true,
    toggle: true,
    hasStoredSession: true,
    cwdMatches: true,
  };

  it.each([
    // caller explicitly wants a fresh slate (edit/regenerate)
    [{ ...base, preferResume: false }, "new"],
    // toggle off
    [{ ...base, toggle: false }, "new"],
    // no stored ACP session yet
    [{ ...base, hasStoredSession: false }, "new"],
    // cwd or provider changed since the session was created
    [{ ...base, cwdMatches: false }, "new"],
    // omp → silent resume
    [{ ...base }, "resume"],
    [{ ...base, provider: "omp" }, "resume"],
    // cursor → load with history replay
    [{ ...base, provider: "cursor" }, "load"],
    // every combination of missing preconditions stays new
    [{ ...base, preferResume: false, toggle: false }, "new"],
    [{ ...base, hasStoredSession: false, cwdMatches: false }, "new"],
    [{ ...base, provider: "cursor", preferResume: false }, "new"],
  ] as const)("pickRestoreMode(%j) === %j", (input, expected) => {
    expect(pickRestoreMode({ ...input })).toBe(expected);
  });
});

describe("paramsFromModelWire", () => {
  const modelOpt = (currentValue: string, values: string[]) => [
    { id: "model", category: "model", type: "select", currentValue, options: values.map((value) => ({ value })) },
  ];

  it("synthesizes params from the current model's wire", () => {
    const params = paramsFromModelWire(
      modelOpt("composer-2.5[fast=true]", ["composer-2.5[fast=true]"]),
    );
    expect(params).toEqual([
      { id: "fast", name: "Fast", currentValue: "true", options: [{ value: "true", name: "Fast" }] },
    ]);
  });

  it("orders fast → effort and reads the current wire's values", () => {
    const params = paramsFromModelWire(
      modelOpt("grok-4.6[effort=high,fast=true]", [
        "grok-4.6[effort=high,fast=true]",
        "gpt-5.4[context=272k,reasoning=medium,fast=false]",
      ]),
    );
    const ids = params.map((p) => p.id);
    expect(ids).toEqual(["fast", "effort"]);
    const effort = params.find((p) => p.id === "effort")!;
    expect(effort.currentValue).toBe("high");
    expect(effort.options).toEqual([{ value: "high", name: "High" }]);
  });

  it("offers only values listed for the current base — not a cross-model union", () => {
    const params = paramsFromModelWire(
      modelOpt("gpt-5.4[reasoning=medium,fast=false]", [
        "grok-4.6[effort=high,fast=true]",
        "gpt-5.4[reasoning=medium,fast=false]",
        "composer-2.5[fast=true]",
      ]),
    );
    const fast = params.find((p) => p.id === "fast")!;
    // fast=false only: grok's fast=true and composer's fast=true belong to other bases.
    expect(fast.options.map((o) => o.value)).toEqual(["false"]);
    expect(params.find((p) => p.id === "effort")).toBeUndefined();
  });

  it("returns [] when no model option or the current base is unknown", () => {
    expect(paramsFromModelWire([])).toEqual([]);
    expect(paramsFromModelWire([{ id: "model", currentValue: "", options: [] }])).toEqual([]);
  });

  it("keeps defaults when the current model has no params", () => {
    const params = paramsFromModelWire(
      modelOpt("gemini-3.1-pro[]", ["gemini-3.1-pro[]", "glm-5.2[reasoning=high]"]),
    );
    expect(params).toEqual([]);
  });
});

describe("effectiveMcpServers", () => {
  const mcp = (id: string, enabled = true) => ({
    id,
    name: id,
    enabled,
    type: "local" as const,
    url: `http://localhost/${id}`,
  });
  const settings = {
    mcpServers: [mcp("a"), mcp("b"), mcp("c", false)],
  } as never; // narrow: effectiveMcpServers only reads mcpServers

  it.each([
    ["no disabled ids → all enabled servers", undefined, ["a", "b"]],
    ["empty disabled list", [], ["a", "b"]],
    ["one disabled", ["a"], ["b"]],
    ["all disabled", ["a", "b"], []],
    ["unknown ids ignored", ["nope"], ["a", "b"]],
    ["disabled applies to disabled server too (no-op)", ["c"], ["a", "b"]],
  ] as const)("%s", (_name, disabledIds, expected) => {
    const result = effectiveMcpServers(settings, disabledIds);
    expect(result.map((s) => s.id)).toEqual(expected);
  });

  it("filters by enabled and url regardless of disabled list", () => {
    const withEmptyUrl = { ...settings, mcpServers: [{ ...mcp("x"), url: "  " }] };
    expect(effectiveMcpServers(withEmptyUrl, [])).toEqual([]);
  });
});
