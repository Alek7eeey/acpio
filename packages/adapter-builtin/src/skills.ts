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
import { fileURLToPath } from "node:url";
import { normalizeSkillPaths, type SkillMode, type SlashCommandDto } from "@acpio/shared";

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
  /**
   * Ids of the harness's base rules (see `agent.ts`'s `RULES`) this skill words
   * itself. Declared by whoever owns the folder — a plugin, in its `skillPath`
   * contribution — never by the SKILL.md, so a third-party skill ships exactly
   * as its author wrote it. Honoured only while the skill is in effect from the
   * first turn (`active`, see {@link supersededRules}): the prompt then says a
   * thing once instead of twice with two priorities.
   */
  supersedes: string[];
  /**
   * Ships with the app — the adapter's own folder ({@link BUILTIN_SKILLS_DIR})
   * or a plugin's — instead of being found in the user's folders.
   */
  builtin?: boolean;
}

/**
 * Skills the app itself ships: ordinary skill folders inside the adapter
 * package, found by the same scan and read by the same `read` call as the
 * user's own. Their mode comes from Settings → Built-in agent —
 * `builtinSkillPaths` adds collections next to them, it does not own them.
 * A plugin ships its skills the same way, from its own folder (see
 * `discoverSettingsSkills` and plugin-api's `skillPath`).
 */
export const BUILTIN_SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));

/**
 * A folder that ships with the app without being the adapter's own: a plugin's
 * skills, and the base rules its skills declare (plugin-api's `skillPath`).
 */
export interface ShippedSkillFolder {
  path: string;
  supersedes?: Record<string, string[]>;
}

/** Folders whose skills count as shipped: the adapter's own, plus a plugin's. */
function shippedDirs(extra: readonly ShippedSkillFolder[] = []): Set<string> {
  return new Set([BUILTIN_SKILLS_DIR, ...extra.map((folder) => folder.path)].map((dir) => path.resolve(dir)));
}

/** The rules a skill of `dir` declares, by skill name, declared by its owner. */
function declaredRules(
  folders: readonly ShippedSkillFolder[],
  dir: string,
): Record<string, string[]> {
  const key = path.resolve(dir);
  const owner = folders.find((folder) => path.resolve(folder.path) === key);
  return owner?.supersedes ?? {};
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
async function skillsInDir(
  dir: string,
  shipped: ReadonlySet<string>,
  declared: Record<string, string[]> = {},
): Promise<BuiltinSkill[]> {
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
      supersedes: declared[name.toLowerCase()] ?? [],
      path: md,
      ...(shipped.has(path.resolve(dir)) ? { builtin: true } : {}),
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
 * `shippedFolders` are folders that ship with the app without being the
 * adapter's own (a plugin's skills): their skills count as `builtin` too, so the
 * settings page offers them the same mode switch, and the rules they declare
 * travel with them.
 */
export async function discoverSkills(
  paths: unknown,
  cwd: string,
  home: string = homedir(),
  shippedFolders: readonly ShippedSkillFolder[] = [],
): Promise<BuiltinSkill[]> {
  const rels = normalizeSkillPaths(paths);
  if (!rels.length || !cwd) return [];
  const shipped = shippedDirs(shippedFolders);
  const skills: BuiltinSkill[] = [];
  const names = new Set<string>();
  for (const rel of rels) {
    const dir = resolveSkillDir(rel, cwd, home);
    for (const skill of await skillsInDir(dir, shipped, declaredRules(shippedFolders, dir))) {
      if (names.has(skill.name)) continue;
      names.add(skill.name);
      skills.push(skill);
      if (skills.length >= MAX_SKILLS) return skills;
    }
  }
  return skills;
}

/**
 * The mode a skill runs in. Unset means `listed` — what every skill did before
 * the setting existed. `off` is the only mode that takes a skill away from the
 * user too; `hidden` merely keeps it out of the system prompt, so `/name` still
 * invokes it (see {@link matchSkillInvocation}) and the `/` menu still offers
 * it.
 */
export function skillMode(modes: Record<string, SkillMode> | undefined, name: string): SkillMode {
  return modes?.[name.toLowerCase()] ?? "listed";
}

/** Skills the agent has at all: the `/` menu and `/name` see these, `off` is gone. */
export function enabledSkills(
  skills: readonly BuiltinSkill[],
  modes?: Record<string, SkillMode>,
): BuiltinSkill[] {
  return skills.filter((skill) => skillMode(modes, skill.name) !== "off");
}

/**
 * The built-in agent's slash menu for a session: its own commands — a manual
 * compaction pass, the wire thinking switch, the mid-think fuse — followed by
 * the folder's skills. One builder serves both the announce at attach and the
 * board's new-task form, which has no session to ask, so the form offers the
 * very list a chat composer opens.
 */
export function builtinSlashCommands(
  settings: { locale?: string; builtinSkillModes?: Record<string, SkillMode> },
  skills: readonly BuiltinSkill[],
): SlashCommandDto[] {
  const ru = settings.locale === "ru";
  return [
    // The manual pass is offered next to the skills: the composer merges this
    // list into its slash menu, so `/compact` is discoverable without docs.
    {
      name: "compact",
      description: ru
        ? "Сжать историю сейчас (необязательно — на чём сфокусироваться)"
        : "Compact the history now (optionally: what to focus on)",
      inputHint: ru ? "[фокус]" : "[focus]",
    },
    // The wire switch sits next to the manual pass, not in the ⋯ menu: that
    // menu only shapes the prompt, this one stops the endpoint thinking at all.
    {
      name: "thinking",
      description: ru
        ? "Выключить или включить проход размышлений у эндпоинта (по умолчанию — включён)"
        : "Turn the endpoint's thinking pass off or on (on by default)",
      inputHint: "on|off",
    },
    // The mid-think fuse: cuts a model call whose private reasoning runs long
    // and carries the turn on with a reminder — prompt-side, session-level.
    {
      name: "thinking-limit",
      description: ru
        ? "Оборвать слишком длинные размышления шага и продолжить с напоминанием действовать"
        : "Cut a step's overlong private reasoning and continue with a reminder to act",
      inputHint: ru ? "on|off|<символы>" : "on|off|<chars>",
    },
    // A `hidden` skill is still offered here — hidden means "out of the
    // system prompt", not "gone". Only `off` takes the command away.
    ...enabledSkills(skills, settings.builtinSkillModes).map((skill) => ({
      name: skill.name,
      description: skill.description || skill.name,
      kind: "skill",
    })),
  ];
}

/**
 * Skills the model is told about: `hidden` and `off` are absent here, so a
 * hidden skill leaves no trace in the prompt — not even the header of the
 * section, which only appears when a listed or active skill remains.
 */
export function advertisedSkills(
  skills: readonly BuiltinSkill[],
  modes?: Record<string, SkillMode>,
): BuiltinSkill[] {
  return enabledSkills(skills, modes).filter(
    (skill) => skillMode(modes, skill.name) !== "hidden" && !skill.disableModelInvocation,
  );
}

/**
 * Every skill the built-in agent has: the ones shipped with the app first, then
 * the configured folders. A shipped skill wins a name clash — it is the one the
 * mode setting names, and the user can switch it off instead of shadowing it.
 * That covers a plugin's folder too: its `ponytail` is the copy that declares
 * what it supersedes, so an older copy of the same name in the user's own
 * folders must not take its place.
 */
export async function discoverAgentSkills(
  paths: unknown,
  cwd: string,
  home?: string,
  shippedFolders: readonly ShippedSkillFolder[] = [],
): Promise<BuiltinSkill[]> {
  const shipped = shippedDirs(shippedFolders);
  const own = await skillsInDir(BUILTIN_SKILLS_DIR, shipped);
  const fromPlugins: BuiltinSkill[] = [];
  for (const folder of shippedFolders) {
    fromPlugins.push(...(await skillsInDir(folder.path, shipped, folder.supersedes)));
  }
  const taken = new Set([...own, ...fromPlugins].map((skill) => skill.name.toLowerCase()));
  const found = await discoverSkills(paths, cwd, home, shippedFolders);
  return [...own, ...fromPlugins, ...found.filter((s) => !taken.has(s.name.toLowerCase()))];
}

/**
 * Skills for one settings snapshot: the user's folders plus the ones plugins
 * ship (`pluginSkills`, filled by the plugin host at boot). One entry point so
 * the prompt, the `/` menu and the settings page scan the very same list.
 */
export async function discoverSettingsSkills(
  settings: { builtinSkillPaths: string[]; pluginSkills?: ShippedSkillFolder[] },
  cwd: string,
  home?: string,
): Promise<BuiltinSkill[]> {
  const shipped = settings.pluginSkills ?? [];
  return discoverAgentSkills(
    [...settings.builtinSkillPaths, ...shipped.map((folder) => folder.path)],
    cwd,
    home,
    shipped,
  );
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
  modes?: Record<string, SkillMode>,
): { skill: BuiltinSkill; args: string } | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/([A-Za-z][\w.-]*)\s*([\s\S]*)$/);
  if (!match) return null;
  const skill = enabledSkills(skills, modes).find(
    (s) => s.name.toLowerCase() === match[1].toLowerCase(),
  );
  if (!skill) return null;
  return { skill, args: match[2].trim() };
}

/**
 * Base rules the active skills replace with their own words: only a skill in
 * effect from the first turn can stand in for one, because only its body is in
 * the very same prompt — a merely listed skill is applied mid-chat, when the
 * prompt is already fixed (see `renderSkillsSection`).
 */
export function supersededRules(
  skills: readonly BuiltinSkill[],
  modes?: Record<string, SkillMode>,
): Set<string> {
  const ids = new Set<string>();
  for (const skill of advertisedSkills(skills, modes)) {
    if (skillMode(modes, skill.name) !== "active") continue;
    for (const id of skill.supersedes) ids.add(id);
  }
  return ids;
}

/**
 * System-prompt block listing the skills the model may invoke by itself; empty
 * when none qualifies. A skill flagged `disable-model-invocation` stays out:
 * the user still reaches it with `/name` — see {@link expandSkillInvocation} —
 * but announcing it would invite a call the model is not allowed to make. A
 * `hidden` or `off` skill (Settings → Built-in agent) stays out too, and an
 * `active` one brings its SKILL.md body along — that mode exists precisely so
 * the skill is in effect from the first turn instead of waiting for a match.
 */
export async function renderSkillsSection(
  skills: readonly BuiltinSkill[],
  modes?: Record<string, SkillMode>,
): Promise<string> {
  const offered = advertisedSkills(skills, modes);
  if (!offered.length) return "";
  const active: string[] = [];
  const applied = new Set<string>();
  for (const skill of offered) {
    if (skillMode(modes, skill.name) !== "active") continue;
    const body = await loadSkillBody(skill);
    // The header says which of the two sets wins: a skill is the specific case,
    // and the base rules already tell the model to follow it where they overlap.
    if (!body) continue;
    active.push(`--- ${skill.name} (active by default — follow it now) ---\n${body}`);
    applied.add(skill.name);
  }
  // An active skill is listed by name alone: its whole text is a few lines below,
  // so both its path and its description would say the same thing twice.
  const rows = offered.map((s) =>
    applied.has(s.name)
      ? `- ${s.name} — already in effect, its text is below.`
      : `- ${s.name}${s.description ? `: ${s.description}` : ""} — \`${s.path}\``,
  );
  return [
    "",
    // One header carries both ways in: matching the task, or naming the skill.
    "Skills available (read a skill's SKILL.md with `read` when the task matches; a message that is " +
      "exactly `/name` invokes that skill):",
    ...rows,
    // Said here, not among the rules: it is about this block, and a skill the
    // user turned on is the more specific instruction — a rule it words itself
    // is not left above it to argue with (see `supersededRules`).
    "A skill is the more specific instruction: where it and a rule disagree, the skill wins.",
    ...(active.length ? ["", "Skills active by default:", ...active] : []),
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
  modes?: Record<string, SkillMode>,
): Promise<string | null> {
  const matched = matchSkillInvocation(text, skills, modes);
  if (!matched) return null;
  const body = await loadSkillBody(matched.skill);
  if (!body) return null;
  const request = matched.args || "(no additional request — just follow the skill)";
  return `[The user invoked the skill "${matched.skill.name}". Follow the skill instructions below.]\n\n${body}\n\n---\nUser request: ${request}`;
}
