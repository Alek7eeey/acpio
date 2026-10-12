import { describe, expect, it } from "vitest";
import { isBackgroundJobNote, parseBackgroundJobNote } from "./backgroundNote.js";

/** The note as the server writes it today (ru). */
const RU = [
  "[Фоновая задача] «wait10-2» завершилась: код 0, длительность 10s (id bg-6).",
  "Команда: sleep 10 && echo 'НАпиши результат 5+5='",
  "Лог: C:/data/bg-logs/chat-1/bg-6.log",
  "Последние строки вывода:",
  "НАпиши результат 5+5=",
  'Читай лог окнами через read или ищи в нём grep; хвост — mcp__acpio_bg_output({ jobId: "bg-6" }), остальные задачи — mcp__acpio_bg_list().',
].join("\n");

/** The same note while the reader's UI is English. */
const EN = [
  '[Background task] "npm run build" was stopped: exit —, took 2m 5s (id bg-7).',
  "Command: npm run build",
  "Log: C:/data/bg-logs/chat-1/bg-7.log",
  "Last output lines:",
  "tsc: 2 errors",
  "Read the log with read (windows) or grep; tail — mcp__acpio_bg_output({ jobId: \"bg-7\" }), other jobs — mcp__acpio_bg_list().",
].join("\n");

/** The template from before the log path and the "read more" line were added:
 *  no `Log:` line, and a shorter instruction. Kept: old chats are still read. */
const OLD = [
  "[Фоновая задача] «wait10-2» завершилась: код 0, длительность 10s (id bg-6).",
  "Команда: sleep 10 && echo 'НАпиши результат 5+5='",
  "Последние строки вывода:",
  "НАпиши результат 5+5=",
  'Продолжи вывод: mcp__acpio_bg_output({ jobId: "bg-6" }), остальные задачи: mcp__acpio_bg_list().',
].join("\n");

describe("telling a background job's note apart from a prompt", () => {
  it("takes both locales of the note, not a message that merely mentions one", () => {
    expect(isBackgroundJobNote(RU)).toBe(true);
    expect(isBackgroundJobNote(EN)).toBe(true);
    // The delivery always starts the message; a note quoted mid-prompt is text.
    expect(isBackgroundJobNote(`смотри: ${RU}`)).toBe(false);
    expect(isBackgroundJobNote("запусти sleep 10 в фоне")).toBe(false);
    expect(isBackgroundJobNote("")).toBe(false);
  });
});

describe("the note block's fields", () => {
  it("reads a ru note head, command, log, output tail and hint", () => {
    const note = parseBackgroundJobNote(RU);
    expect(note).toMatchObject({
      id: "bg-6",
      label: "wait10-2",
      status: "exited",
      exitCode: "0",
      elapsed: "10s",
      command: "sleep 10 && echo 'НАпиши результат 5+5='",
      logPath: "C:/data/bg-logs/chat-1/bg-6.log",
      output: "НАпиши результат 5+5=",
      emptyOutput: false,
      rest: [],
    });
    expect(note?.hint).toContain("mcp__acpio_bg_list()");
  });

  it("reads an en note, a stopped job and a multi-line tail", () => {
    const note = parseBackgroundJobNote(EN);
    expect(note).toMatchObject({
      id: "bg-7",
      label: "npm run build",
      status: "killed",
      exitCode: "—",
      elapsed: "2m 5s",
      command: "npm run build",
      logPath: "C:/data/bg-logs/chat-1/bg-7.log",
      output: "tsc: 2 errors",
      emptyOutput: false,
      rest: [],
    });
    expect(note?.hint).toContain("mcp__acpio_bg_list()");
  });

  it("reads the older template without losing a line", () => {
    const note = parseBackgroundJobNote(OLD);
    expect(note).toMatchObject({
      id: "bg-6",
      status: "exited",
      command: "sleep 10 && echo 'НАпиши результат 5+5='",
      logPath: null,
      output: "НАпиши результат 5+5=",
      rest: [],
    });
    expect(note?.hint).toContain("mcp__acpio_bg_list()");
  });

  it("says so when the note carries no output", () => {
    const note = parseBackgroundJobNote(
      [
        "[Фоновая задача] «build» завершилась с ошибкой: код 2, длительность 1m 0s (id bg-9).",
        "Команда: npm run build",
        "Лог: C:/data/bg-logs/chat-1/bg-9.log",
        "Вывода нет.",
        "Читай лог окнами через read.",
      ].join("\n"),
    );
    expect(note).toMatchObject({ status: "failed", output: null, emptyOutput: true, rest: [] });
  });

  it("keeps a head it cannot read instead of dropping it", () => {
    const note = parseBackgroundJobNote(
      "[Фоновая задача] что-то новое: код 0, длительность 3s (id bg-1).",
    );
    expect(note).toMatchObject({ id: null, label: null, status: "unknown", output: null });
    expect(note?.rest).toEqual([
      "[Фоновая задача] что-то новое: код 0, длительность 3s (id bg-1).",
    ]);
  });

  it("takes output but not the hint when the note stops before it", () => {
    const note = parseBackgroundJobNote(
      [
        "[Фоновая задача] «tail» завершилась: код 0, длительность 1s (id bg-2).",
        "Последние строки вывода:",
        "первая",
        "вторая",
      ].join("\n"),
    );
    expect(note).toMatchObject({ output: "первая\nвторая", hint: null, rest: [] });
  });

  it("is null for anything that is not a note", () => {
    expect(parseBackgroundJobNote("привет")).toBeNull();
    expect(parseBackgroundJobNote("")).toBeNull();
  });
});
