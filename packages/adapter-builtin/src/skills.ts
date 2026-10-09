// Skill discovery for the built-in agent. Skills are folders holding a
// `SKILL.md` (frontmatter `name`/`description` plus a markdown body); the
// configured search paths come from Settings → Built-in agent — relative to
// the chat's cwd, `~` for the server user's home, absolute for anything else
// global. Found skills are announced
// to the harness as slash commands, and the model-invocable ones are listed in
// the system prompt — a SKILL.md carrying `disable-model-invocation: true`
// stays user-invocable only, because announcing a skill the model may not call
// is pure overhead. The model applies a listed skill by reading its SKILL.md
// with the `read` tool, and an explicit `/name` message has the body injected
// up front.
import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { normalizeSkillPaths } from "@acpio/shared";

export interface BuiltinSkill {
  /** Slash-invocable name: frontmatter `name`, else the folder's. */
  name: string;
  /** Frontmatter `description`, else "". */
  description: string;
  /** Absolute path of the SKILL.md the model reads to apply the skill. */
  path: string;
  /**
   * Frontmatter `disable-model-invocation: true`: the user reaches the skill
   * with `/name`, but it is never advertised to the model.
   */
  disableModelInvocation: boolean;
}

const MAX_SKILLS = 100;
const SKILL_BODY_CHAR_LIMIT = 24_000;
const SKILL_NAME_RE = /^[A-Za-z][\w.-]*$/;

/** Frontmatter plus the markdown body that follows it. */
export interface ParsedSkillMarkdown {
  name: string;
  description: string;
  disableModelInvocation: boolean;
  body: string;
}

/**
 * `---`-fenced `key: value` frontmatter off a SKILL.md. Only `name`,
 * `description` and `disable-model-invocation` matter; an absent or malformed
 * block degrades to the folder name and an empty description instead of
 * rejecting the skill.
 */
export function parseSkillMarkdown(text: string, fallbackName: string): ParsedSkillMarkdown {
  const out: ParsedSkillMarkdown = {
    name: fallbackName,
    description: "",
    disableModelInvocation: false,
    body: text.trim(),
  };
  if (!text.startsWith("---")) return out;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return out;
  const block = text.slice(3, end);
  for (const line of block.split("\n")) {
    const at = line.indexOf(":");
    if (at === -1) continue;
    const key = line.slice(0, at).trim().toLowerCase();
    if (key !== "name" && key !== "description" && key !== "disable-model-invocation") continue;
    const value = line
      .slice(at + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!value) continue;
    if (key === "name") out.name = value;
    else if (key === "description") out.description = value;
    else out.disableModelInvocation = /^(true|yes|1|on)$/i.test(value);
  }
  out.body = text.slice(end + 4).trim();
  return out;
}

/** Names the model may be asked to invoke: a slash-safe token. */
function usableName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, "-");
  return SKILL_NAME_RE.test(name) ? name : "";
}

/** One folder's direct subfolders that carry a SKILL.md, best-effort. */
async function skillsInDir(dir: string): Promise<BuiltinSkill[]> {
  let entries: Dirent[] = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // an absent search path is normal
  }
  const found: BuiltinSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const md = path.join(dir, entry.name, "SKILL.md");
    let text: string;
    try {
      text = await readFile(md, "utf8");
    } catch {
      continue; // a skill folder without SKILL.md is not one
    }
    const parsed = parseSkillMarkdown(text, entry.name);
    const name = usableName(parsed.name);
    if (!name) continue;
    found.push({
      name,
      description: parsed.description,
      disableModelInvocation: parsed.disableModelInvocation,
      path: md,
    });
  }
  return found;
}

/** Resolve a configured path: `~` → home, absolute → as-is, else per-chat cwd. */
function resolveSkillDir(rel: string, cwd: string, home: string): string {
  if (rel === "~") return home;
  if (rel.startsWith("~/")) return path.join(home, rel.slice(2));
  if (path.isAbsolute(rel)) return rel;
  return path.resolve(cwd, rel);
}

/**
 * Scan every configured path for skills. The first folder wins a name, and a
 * folder that cannot be read or has no skills is silently skipped — discovery
 * must never break the turn that only wanted to list what exists. `home` is
 * `os.homedir()` unless a caller injects another root for `~` paths.
 */
export async function discoverSkills(
  paths: unknown,
  cwd: string,
  home: string = homedir(),
): Promise<BuiltinSkill[]> {
  const rels = normalizeSkillPaths(paths);
  if (!rels.length || !cwd) return [];
  const skills: BuiltinSkill[] = [];
  const names = new Set<string>();
  for (const rel of rels) {
    for (const skill of await skillsInDir(resolveSkillDir(rel, cwd, home))) {
      if (names.has(skill.name)) continue;
      names.add(skill.name);
      skills.push(skill);
      if (skills.length >= MAX_SKILLS) return skills;
    }
  }
  return skills;
}

/** The SKILL.md body handed to the model, bounded so a huge file can't eat a turn. */
export async function loadSkillBody(skill: BuiltinSkill): Promise<string> {
  let text: string;
  try {
    text = await readFile(skill.path, "utf8");
  } catch {
    return "";
  }
  const parsed = parseSkillMarkdown(text, skill.name);
  if (parsed.body.length <= SKILL_BODY_CHAR_LIMIT) return parsed.body;
  const head = SKILL_BODY_CHAR_LIMIT / 2;
  return `${parsed.body.slice(0, head)}\n...[truncated]...\n${parsed.body.slice(-head)}`;
}

/** `/name args` → the named skill plus the rest of the line, or null. */
export function matchSkillInvocation(
  text: string,
  skills: readonly BuiltinSkill[],
): { skill: BuiltinSkill; args: string } | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/([A-Za-z][\w.-]*)\s*([\s\S]*)$/);
  if (!match) return null;
  const skill = skills.find((s) => s.name.toLowerCase() === match[1].toLowerCase());
  if (!skill) return null;
  return { skill, args: match[2].trim() };
}

/**
 * System-prompt block listing the skills the model may invoke by itself; empty
 * when none qualifies. A skill flagged `disable-model-invocation` stays out:
 * the user still reaches it with `/name` — see {@link expandSkillInvocation} —
 * but announcing it would invite a call the model is not allowed to make.
 */
export function renderSkillsSection(skills: readonly BuiltinSkill[]): string {
  const offered = skills.filter((s) => !s.disableModelInvocation);
  if (!offered.length) return "";
  const rows = offered.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ""} — \`${s.path}\``);
  return [
    "",
    "Skills available (read a skill's SKILL.md with `read` and follow it when the user's task matches):",
    ...rows,
    "A message that is exactly `/name` (optionally followed by the request) invokes that skill — read its SKILL.md and carry out the request through it, even when the message says nothing else.",
  ].join("\n");
}

/**
 * Expand a `/name args` message into the skill's body plus the request, so an
 * explicit invocation costs no read round-trip. Returns null when the text is
 * not a skill call or the SKILL.md became unreadable — the prompt then passes
 * through unchanged and the system-prompt section still guides the model.
 */
export async function expandSkillInvocation(
  text: string,
  skills: readonly BuiltinSkill[],
): Promise<string | null> {
  const matched = matchSkillInvocation(text, skills);
  if (!matched) return null;
  const body = await loadSkillBody(matched.skill);
  if (!body) return null;
  const request = matched.args || "(no additional request — just follow the skill)";
  return `[The user invoked the skill "${matched.skill.name}". Follow the skill instructions below.]\n\n${body}\n\n---\nUser request: ${request}`;
}
