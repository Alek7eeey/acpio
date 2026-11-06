import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  archivePlan,
  emptyPlanState,
  parsePlan,
  planFilePath,
  planSignature,
  readPlan,
  renderPlan,
  setPlanOptions,
  startsNewPlan,
  writePlan,
  type PlanState,
} from "./planFile.js";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "acpio-plan-file-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PLAN: PlanState = {
  name: "План как файл",
  overview: "План уезжает в `.acpio/plan.md`, панель его читает.",
  plan: "## Файлы\n\n`agent.ts`.\n\n## Проверка\n\n`npm test`.",
  entries: [
    { content: "Прочитать код", status: "completed", priority: "medium" },
    { content: "Написать модуль", status: "in_progress", priority: "medium" },
    { content: "Тесты", status: "pending", priority: "medium" },
  ],
  stage: "draft",
  pacing: "whole",
};

it("round-trips a plan through the file", () => {
  expect(parsePlan(renderPlan(PLAN))).toEqual(PLAN);
});

it("round-trips in English too", () => {
  const text = renderPlan({ ...PLAN, name: undefined }, "en");
  expect(text).toContain("## Steps");
  expect(text).not.toContain("name:");
  const back = parsePlan(text);
  expect(back.name).toBeUndefined();
  expect(back.entries.map((e) => e.status)).toEqual(["completed", "in_progress", "pending"]);
});

it("keeps a plan written by hand with no frontmatter and no headings", () => {
  const state = parsePlan(
    ["Сначала прочитать код.", "", "- [ ] Прочитать код", "- [x] Написать модуль", "", "Проверка: тесты"].join(
      "\n",
    ),
  );
  expect(state.overview).toBe("Сначала прочитать код.");
  expect(state.entries.map((e) => [e.content, e.status])).toEqual([
    ["Прочитать код", "pending"],
    ["Написать модуль", "completed"],
  ]);
  expect(state.plan).toContain("Проверка: тесты");
  // Nothing said about the stage: a hand-written plan is a draft.
  expect(state.stage).toBe("draft");
  expect(state.pacing).toBe("whole");
});

it("does not rewrite a file whose bytes are already right", () => {
  const file = join(tempDir(), ".acpio", "plan.md");
  expect(writePlan(file, PLAN)).toBe(true);
  const stamp = readFileSync(file, "utf8");
  expect(writePlan(file, PLAN)).toBe(false);
  expect(readFileSync(file, "utf8")).toBe(stamp);
});

it("flips the stage and the pace without touching the rest", () => {
  const file = join(tempDir(), ".acpio", "plan.md");
  writePlan(file, PLAN);
  expect(setPlanOptions(file, { stage: "applying", pacing: "step" })).toBe(true);
  const after = readPlan(file);
  expect(after?.stage).toBe("applying");
  expect(after?.pacing).toBe("step");
  expect(after?.overview).toBe(PLAN.overview);
  expect(after?.entries).toEqual(PLAN.entries);
  // An option on a file that is not there is a no, not a crash.
  expect(setPlanOptions(join(tempDir(), "nope.md"), { stage: "applying" })).toBe(false);
});

it("reports no plan for a missing file", () => {
  expect(readPlan(join(tempDir(), ".acpio", "plan.md"))).toBeUndefined();
  expect(parsePlan("")).toEqual(emptyPlanState());
});

it("moves a finished plan aside", () => {
  const dir = tempDir();
  const file = planFilePath(dir);
  writePlan(file, PLAN);
  const archived = archivePlan(file, new Date("2026-02-11T10:20:30Z"));
  expect(archived).toBe(join(dir, ".acpio", "plans", "2026-02-11T10-20-30.md"));
  expect(existsSync(archived!)).toBe(true);
  expect(existsSync(file)).toBe(false);
});

it("knows a document that replaces a plan from one that advances it", () => {
  // No document on the call: a status move, never a new plan.
  expect(startsNewPlan(PLAN, {})).toBe(false);
  // A finished list makes room for the next task.
  const done = { ...PLAN, entries: PLAN.entries.map((e) => ({ ...e, status: "completed" as const })) };
  expect(startsNewPlan(done, { name: "Новая задача" })).toBe(true);
  // An unfinished plan keeps its name: a rename mid-task must not archive it.
  expect(startsNewPlan(PLAN, { name: "Другое имя" })).toBe(false);
  expect(startsNewPlan(undefined, { name: "Новая задача" })).toBe(false);
});

it("signs the plan so the watcher can tell its own write from a hand edit", () => {
  expect(planSignature(undefined)).toBe("");
  expect(planSignature(PLAN)).toBe(planSignature(parsePlan(renderPlan(PLAN))));
  expect(planSignature({ ...PLAN, stage: "applying" })).not.toBe(planSignature(PLAN));
});

it("reads a file that a hand edit broke without throwing", () => {
  const file = join(tempDir(), "plan.md");
  writeFileSync(file, "---\nstage: [unclosed\n---\n\n## Шаги\n- [ ] один\n", "utf8");
  expect(readPlan(file)?.entries).toEqual([{ content: "один", status: "pending", priority: "medium" }]);
});
