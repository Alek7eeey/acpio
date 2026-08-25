import type { SlashCommandDto } from "@acpio/shared";
import type { TranslateFn } from "@acpio/i18n";

export function slashCommandBareName(name: string) {
  return name.trim().replace(/^\//, "").replace(/^skill:/i, "").toLowerCase();
}

function preferSlashCommand(prev: SlashCommandDto, next: SlashCommandDto): SlashCommandDto {
  const merged: SlashCommandDto = {
    ...next,
    ...(prev.local || next.local ? { local: true } : {}),
    ...(prev.kind === "skill" || next.kind === "skill" ? { kind: "skill" } : {}),
  };
  const prevSkill = prev.name.toLowerCase().startsWith("skill:");
  const nextSkill = next.name.toLowerCase().startsWith("skill:");
  const keepPrev =
    (prev.local && !next.local) ||
    (Boolean(prev.local) === Boolean(next.local) && prevSkill && !nextSkill) ||
    (Boolean(prev.local) === Boolean(next.local) && prevSkill === nextSkill && prev.name.length < next.name.length);
  if (keepPrev) {
    return {
      ...prev,
      ...(merged.local ? { local: true } : {}),
      ...(merged.kind ? { kind: merged.kind } : {}),
    };
  }
  return merged;
}

export function mergeSlashCommandLists(
  ...lists: Array<SlashCommandDto[] | undefined>
): SlashCommandDto[] {
  const byName = new Map<string, SlashCommandDto>();
  for (const list of lists) {
    if (!list?.length) continue;
    for (const cmd of list) {
      const name = cmd.name.trim().replace(/^\//, "");
      if (!name) continue;
      const key = name.toLowerCase();
      const prev = byName.get(key);
      const next: SlashCommandDto = { ...cmd, name };
      if (prev?.local || cmd.local) next.local = true;
      if (prev?.kind === "skill" || cmd.kind === "skill") next.kind = "skill";
      byName.set(key, next);
    }
  }
  const byBare = new Map<string, SlashCommandDto>();
  for (const cmd of byName.values()) {
    const bare = slashCommandBareName(cmd.name);
    const prev = byBare.get(bare);
    byBare.set(bare, prev ? preferSlashCommand(prev, cmd) : cmd);
  }
  return [...byBare.values()];
}

export function getBuiltinSlashCommands(_t: TranslateFn): SlashCommandDto[] {
  return [];
}

function isValidSlashCommandName(name: string) {
  // `namespace:name` is legal (OMP skills arrive as `skill:<name>`); the
  // part after the colon must start with a letter so Windows paths like
  // "/C:/…" don't parse as commands.
  return /^[a-z][\w.-]*(?::[a-z][\w.-]*)*$/i.test(name);
}

function isBracketSyntaxHint(hint: string) {
  return /^\[[^\]]*\|[^\]]*\]/.test(hint.trim());
}

export function slashCommandRequiresInput(cmd: SlashCommandDto) {
  return Boolean(cmd.requiresInput ?? cmd.inputHint);
}

export function sanitizeSlashCommand(cmd: SlashCommandDto): SlashCommandDto | null {
  const name = cmd.name.trim().replace(/^\//, "");
  if (!isValidSlashCommandName(name)) return null;

  const description = cmd.description.trim();

  const inputHint = cmd.inputHint?.trim();
  const kind = cmd.kind?.trim();
  return {
    name,
    description: description || name,
    ...(cmd.requiresInput || (inputHint && !isBracketSyntaxHint(inputHint))
      ? { requiresInput: true }
      : {}),
    ...(inputHint && !isBracketSyntaxHint(inputHint) ? { inputHint } : {}),
    ...(kind ? { kind } : {}),
    ...(cmd.local ? { local: true } : {}),
  };
}

const SKILL_SCOPE_RE = /\((?:user |project |builtin )?skill\)\s*$/i;
const USER_SKILL_SCOPE_RE = /\(user skill\)\s*$/i;

function commandLooksLikeSkill(cmd: SlashCommandDto) {
  const name = cmd.name.trim().toLowerCase();
  const kind = (cmd.kind ?? "").trim().toLowerCase();
  return (
    kind === "skill" ||
    kind === "skills" ||
    name.startsWith("skill:") ||
    name.startsWith("skills:") ||
    SKILL_SCOPE_RE.test(cmd.description)
  );
}

/** User-installed skills go first; Cursor tags them `(user skill)`, OMP as `skill:name`. */
export function isUserSlashSkill(cmd: SlashCommandDto) {
  const name = cmd.name.trim().toLowerCase();
  if (name.startsWith("skill:") || name.startsWith("skills:")) return true;
  return USER_SKILL_SCOPE_RE.test(cmd.description);
}

export function isSlashSkill(cmd: SlashCommandDto) {
  return isUserSlashSkill(cmd) || commandLooksLikeSkill(cmd);
}

function slashMenuRank(cmd: SlashCommandDto) {
  if (isUserSlashSkill(cmd)) return 0;
  if (isSlashSkill(cmd)) return 1;
  return 2;
}

export function mergeSlashCommands(agentCommands: SlashCommandDto[] = [], t: TranslateFn) {
  const cleaned: SlashCommandDto[] = [];
  for (const cmd of [...getBuiltinSlashCommands(t), ...agentCommands]) {
    const clean = sanitizeSlashCommand(cmd);
    if (!clean) continue;
    cleaned.push(clean);
  }
  const out = mergeSlashCommandLists(cleaned);
  return [...out].sort((a, b) => slashMenuRank(a) - slashMenuRank(b));
}

export function getSlashContext(text: string, cursor: number) {
  const before = text.slice(0, cursor);
  // Token start: beginning, newline, or whitespace — so "/cmd" still works
  // after existing draft text. Mid-word "x/y" stays ignored.
  const match = before.match(/(?:^|[\s])\/([\w:.-]*)$/);
  if (!match) return null;
  const query = match[1] ?? "";
  const start = before.lastIndexOf("/");
  return { query, start };
}

export function filterSlashCommands(commands: SlashCommandDto[], query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter(
    (cmd) =>
      cmd.name.toLowerCase().startsWith(q) ||
      cmd.description.toLowerCase().includes(q),
  );
}

export function buildSlashInsertion(cmd: SlashCommandDto) {
  return `/${cmd.name} `;
}

export function findSlashCommand(commands: SlashCommandDto[], name: string) {
  const key = name.toLowerCase();
  return commands.find((cmd) => cmd.name.toLowerCase() === key) ?? null;
}

export function isSlashCommandReadyToSend(_text: string, _commands: SlashCommandDto[]) {
  return true;
}

export function parseSlashCommandText(text: string) {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/([a-z][\w.-]*(?::[a-z][\w.-]*)*)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return {
    name: match[1],
    args: (match[2] ?? "").trim(),
  };
}

export function isSlashCommandText(text: string) {
  return Boolean(parseSlashCommandText(text));
}

const SLASH_TOKEN_RE = /(^|[\s])(\/[a-z][\w.-]*(?::[a-z][\w.-]*)*)(?=\s|$)/gi;

/** Split user text so `/command` tokens can be highlighted without a special card. */
export function splitSlashCommandHighlight(text: string, knownNames?: Iterable<string>) {
  const known = knownNames
    ? new Set([...knownNames].map((n) => n.replace(/^\//, "").toLowerCase()))
    : null;
  const out: { kind: "text" | "command"; value: string }[] = [];
  const pushText = (value: string) => {
    if (!value) return;
    const prev = out[out.length - 1];
    if (prev?.kind === "text") prev.value += value;
    else out.push({ kind: "text", value });
  };
  SLASH_TOKEN_RE.lastIndex = 0;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = SLASH_TOKEN_RE.exec(text)) !== null) {
    const prefix = match[1] ?? "";
    const cmd = match[2] ?? "";
    const cmdStart = match.index + prefix.length;
    if (cmdStart > last) pushText(text.slice(last, cmdStart));
    const name = cmd.slice(1).toLowerCase();
    if (!known || known.has(name)) out.push({ kind: "command", value: cmd });
    else pushText(cmd);
    last = cmdStart + cmd.length;
  }
  if (last < text.length) pushText(text.slice(last));
  if (out.length === 0) out.push({ kind: "text", value: text });
  return out;
}
