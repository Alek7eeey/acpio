import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The plan is a file, not a message: the model edits it with the ordinary
 * `read`/`write`/`edit` tools, the reader opens it in their editor, and the
 * harness parses it for the side panel. One markdown document per session,
 * `openspec`-shaped but small: a frontmatter with the stage and the pace, an
 * overview, the steps as checkboxes, and the reasoning after them.
 *
 * Stage and pace live in the frontmatter on purpose — they survive a restart
 * and a `session/load` without a second store, and a reader can flip them by
 * hand as easily as the panel can.
 */

/** One step of the plan — what the harness draws as a checkbox row. */
export type PlanEntry = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
};

/**
 * The plan itself, for a user who asked for one: what the harness draws *above*
 * the steps in the right-hand panel — a title, a line or two on the shape of
 * it, and the plan as Markdown.
 */
export type PlanDocument = {
  name?: string;
  /**
   * What is wrong: the defect, the gap, the thing that costs the reader
   * something today. A plan the reader approves has to say what it fixes before
   * it says how — `apply_plan` refuses a plan that never states one.
   */
  problem?: string;
  /** The solution in one or two lines: what changes and why exactly that way. */
  overview?: string;
  plan?: string;
};

/**
 * `draft` — the plan is being written, nothing is implemented and the model is
 * never sent back to finish it; `applying` — the reader approved the plan and
 * every open step is a promise the turn has to keep.
 */
export type PlanStage = "draft" | "applying";

/**
 * How the reader wants the steps done: `whole` — work through the list in one
 * turn (the harness pushes the model to close it); `step` — one step, then the
 * floor is the reader's (nothing pushes the model on).
 */
export type PlanPacing = "whole" | "step";

/** Everything `.acpio/plan.md` carries. */
export type PlanState = PlanDocument & {
  entries: PlanEntry[];
  stage: PlanStage;
  pacing: PlanPacing;
  /**
   * The chat the plan belongs to. A folder holds many chats and one plan file,
   * so the file says whose plan it is: a session follows and reads only its own,
   * and the next chat to write it becomes its owner. Absent on a file written by
   * hand, or by a version that did not record the owner yet.
   */
  chat?: string;
};

/** Folder the plan lives in, relative to the session's working directory. */
export const PLAN_DIR = ".acpio";
export const PLAN_FILE = "plan.md";

export function planFilePath(cwd: string): string {
  return join(cwd, PLAN_DIR, PLAN_FILE);
}

export function emptyPlanState(): PlanState {
  return { entries: [], stage: "draft", pacing: "whole" };
}

const STEPS_HEADING = /^##[ \t]+(?:шаги|задачи|steps|tasks)[ \t]*$/im;
const ANY_HEADING = /^##[ \t]/m;
/** The wrapper headings the file itself owns — stripped on the way back in. */
const OVERVIEW_HEADING = /^##[ \t]+(?:обзор|решение|overview|solution|кратко)[ \t]*\r?\n?/i;
const PROBLEM_HEADING = /^##[ \t]+(?:проблема|problem)[ \t]*\r?\n?/im;
const ANY_SECTION = /^##[ \t]/m;
const PLAN_HEADING = /^##[ \t]+(?:план|plan)[ \t]*\r?\n?/i;
const CHECKBOX = /^[ \t]*[-*][ \t]+\[([ xX~/\-])\][ \t]+(.*)$/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

const STATUS_OF_MARK: Record<string, PlanEntry["status"]> = {
  " ": "pending",
  "": "pending",
  x: "completed",
  X: "completed",
  "~": "in_progress",
  "/": "in_progress",
  "-": "in_progress",
};

const MARK_OF_STATUS: Record<PlanEntry["status"], string> = {
  pending: " ",
  in_progress: "~",
  completed: "x",
};

type Headings = { problem: string; overview: string; steps: string; plan: string };

/** Frontmatter keys, one `key: value` per line — enough for four scalars. */
function readFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const match = FRONTMATTER.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim().toLowerCase();
    const value = line
      .slice(at + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key) meta[key] = value;
  }
  return { meta, body: text.slice(match[0].length) };
}

/**
 * The problem sits above everything the steps are about: it is the first `##`
 * section of the body, and whatever follows it (the solution) is what the
 * overview has always been.
 */
function splitProblem(above: string): { problem: string; overview: string } {
  const heading = PROBLEM_HEADING.exec(above);
  if (!heading) return { problem: "", overview: above };
  const rest = above.slice(heading.index + heading[0].length);
  const boundary = ANY_SECTION.exec(rest);
  const problem = boundary ? rest.slice(0, boundary.index) : rest;
  const tail = boundary ? rest.slice(boundary.index) : "";
  return { problem, overview: [above.slice(0, heading.index), tail].join("\n") };
}

/** The four regions of the body: problem, solution, steps, what follows. */
function splitSections(body: string): Headings {
  const heading = STEPS_HEADING.exec(body);
  if (heading) {
    const before = body.slice(0, heading.index);
    // Past the heading's own line: the steps run to the next `## ` heading.
    const afterHeading = body.slice(heading.index + heading[0].length).replace(/^\r?\n/, "");
    const boundary = ANY_HEADING.exec(afterHeading);
    const steps = boundary ? afterHeading.slice(0, boundary.index) : afterHeading;
    const rest = boundary ? afterHeading.slice(boundary.index) : "";
    return { ...splitProblem(before), steps, plan: rest };
  }
  // A hand-written plan with no headings at all: the checkboxes are the steps,
  // the prose before and after them is the document.
  const lines = body.split(/\r?\n/);
  const first = lines.findIndex((line) => CHECKBOX.test(line));
  if (first < 0) return { problem: "", overview: body, steps: "", plan: "" };
  let last = first;
  for (let i = first; i < lines.length; i += 1) {
    if (CHECKBOX.test(lines[i] ?? "")) last = i;
  }
  return {
    ...splitProblem(lines.slice(0, first).join("\n")),
    steps: lines.slice(first, last + 1).join("\n"),
    plan: lines.slice(last + 1).join("\n"),
  };
}

function parseEntries(steps: string): PlanEntry[] {
  const entries: PlanEntry[] = [];
  for (const line of steps.split(/\r?\n/)) {
    const match = CHECKBOX.exec(line);
    if (!match) continue;
    const content = (match[2] ?? "").trim();
    if (!content) continue;
    entries.push({
      content,
      status: STATUS_OF_MARK[match[1] ?? " "] ?? "pending",
      priority: "medium",
    });
  }
  return entries;
}

/** Parse `.acpio/plan.md`. Anything unrecognised stays out of the way, so a
 *  hand-edited file still yields a plan instead of throwing. */
export function parsePlan(text: string): PlanState {
  const { meta, body } = readFrontmatter(text);
  const sections = splitSections(body);
  const name = (meta.name ?? "").trim();
  const chat = (meta.chat ?? meta.session ?? "").trim();
  const stage: PlanStage = /^applying$/i.test((meta.stage ?? "").trim()) ? "applying" : "draft";
  const pacing: PlanPacing = /^step$/i.test((meta.pacing ?? "").trim()) ? "step" : "whole";
  const problem = sections.problem.trim().replace(PROBLEM_HEADING, "").trim();
  const overview = sections.overview.trim().replace(OVERVIEW_HEADING, "").trim();
  const plan = sections.plan.trim().replace(PLAN_HEADING, "").trim();
  return {
    ...(name ? { name } : {}),
    ...(chat ? { chat } : {}),
    ...(problem ? { problem } : {}),
    ...(overview ? { overview } : {}),
    ...(plan ? { plan } : {}),
    entries: parseEntries(sections.steps),
    stage,
    pacing,
  };
}

/** Render the state back into the file — the one place the format is written. */
export function renderPlan(state: PlanState, locale: "ru" | "en" = "ru"): string {
  const ru = locale !== "en";
  const stepsHeading = ru ? "## Шаги" : "## Steps";
  const planHeading = ru ? "## План" : "## Plan";
  const overviewHeading = ru ? "## Решение" : "## Solution";
  const problemHeading = ru ? "## Проблема" : "## Problem";
  const problem = (state.problem ?? "").trim();
  const overview = (state.overview ?? "").trim();
  const plan = (state.plan ?? "").trim();
  const steps = state.entries
    .map((entry) => `- [${MARK_OF_STATUS[entry.status] ?? " "}] ${entry.content}`)
    .join("\n");
  return [
    "---",
    ...((state.name ?? "").trim()
      ? [`name: ${(state.name ?? "").trim().replace(/\r?\n/g, " ")}`]
      : []),
    ...((state.chat ?? "").trim() ? [`chat: ${(state.chat ?? "").trim()}`] : []),
    `stage: ${state.stage}`,
    `pacing: ${state.pacing}`,
    "---",
    "",
    ...(problem ? [problemHeading, "", problem, ""] : []),
    ...(overview ? [overviewHeading, "", overview, ""] : []),
    stepsHeading,
    "",
    ...(steps ? [steps, ""] : []),
    ...(plan ? [planHeading, "", plan, ""] : []),
  ].join("\n");
}

export function readPlan(file: string): PlanState | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return parsePlan(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Write the state, and only when the bytes differ: a rewrite with the same
 * content would bump the mtime and make the watcher publish a change nobody
 * made.
 */
export function writePlan(file: string, state: PlanState, locale: "ru" | "en" = "ru"): boolean {
  const text = renderPlan(state, locale);
  try {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file) && readFileSync(file, "utf8") === text) return false;
    writeFileSync(file, text, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Change what the reader owns — the stage and the pace — without touching the
 * rest of the file. Used by the panel's switches: they speak to the harness
 * through the file, so the agent picks the change up exactly like a hand edit.
 */
export function setPlanOptions(
  file: string,
  patch: { stage?: PlanStage; pacing?: PlanPacing; chat?: string },
  locale: "ru" | "en" = "ru",
): boolean {
  const state = readPlan(file);
  if (!state) return false;
  return writePlan(file, { ...state, ...patch }, locale);
}

/** Copy a finished plan aside before a new one takes its place. */
export function archivePlan(file: string, now = new Date()): string | undefined {
  if (!existsSync(file)) return undefined;
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const target = join(dirname(file), "plans", `${stamp}.md`);
  try {
    mkdirSync(dirname(target), { recursive: true });
    renameSync(file, target);
    return target;
  } catch {
    return undefined;
  }
}

/**
 * A plan is being replaced, not advanced: the call brought a new document and
 * either the title changed or everything on the old list is done. The old file
 * is archived and the stage drops back to `draft` — a new task is not an
 * approved one.
 */
export function startsNewPlan(prev: PlanState | undefined, next: PlanDocument): boolean {
  if (!prev) return false;
  const document = [next.name, next.overview, next.plan].some((v) => (v ?? "").trim());
  if (!document) return false;
  // A finished list is done with: the next document is the next task.
  if (prev.entries.length > 0 && prev.entries.every((entry) => entry.status === "completed")) {
    return true;
  }
  // An empty plan under a different title is a new one; an unfinished plan that
  // merely gets renamed is still the same work — archiving it would lose steps.
  const renamed = (next.name ?? "").trim() && (next.name ?? "").trim() !== (prev.name ?? "").trim();
  return Boolean(renamed) && prev.entries.length === 0;
}

/** Comparable shape of a plan — the watcher tells its own writes from a hand edit. */
export function planSignature(state: PlanState | undefined): string {
  if (!state) return "";
  return JSON.stringify([
    state.stage,
    state.pacing,
    state.chat ?? "",
    state.name ?? "",
    state.problem ?? "",
    state.overview ?? "",
    state.plan ?? "",
    state.entries.map((entry) => [entry.content, entry.status]),
  ]);
}
