import { type SlashCommandDto } from "@acpio/shared";

export const SLASH_COMMAND_NAME_RE = /^[a-z][\w.-]*(?::[a-z][\w.-]*)*$/i;
const SLASH_PROMPT_RE = /^\/([a-z][\w.-]*(?::[a-z][\w.-]*)*)(?:\s+([\s\S]*))?$/i;

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

export function isAgentSlashPrompt(text: string) {
  return SLASH_PROMPT_RE.test(text.trim());
}

export function parseSlashPrompt(text: string) {
  const match = text.trim().match(SLASH_PROMPT_RE);
  if (!match) return null;
  return { name: match[1], args: (match[2] ?? "").trim() };
}

function commandArrayFromRaw(raw: Record<string, unknown>): unknown[] {
  const nested =
    raw.update && typeof raw.update === "object" && !Array.isArray(raw.update)
      ? (raw.update as Record<string, unknown>)
      : null;
  const candidates = [
    raw.availableCommands,
    raw.available_commands,
    raw.commands,
    nested?.availableCommands,
    nested?.available_commands,
    nested?.commands,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length) return candidate;
  }
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

export function parseAvailableCommands(raw: Record<string, unknown>): SlashCommandDto[] {
  const list = commandArrayFromRaw(raw);
  const out: SlashCommandDto[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item === "string") {
      const parsed = parseCommandFields({ name: item });
      if (!parsed || seen.has(parsed.name.toLowerCase())) continue;
      seen.add(parsed.name.toLowerCase());
      out.push(parsed);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const parsed = parseCommandFields(item as Record<string, unknown>);
    if (!parsed || seen.has(parsed.name.toLowerCase())) continue;
    seen.add(parsed.name.toLowerCase());
    out.push(parsed);
  }
  return out;
}

function parseCommandFields(cmd: Record<string, unknown>): SlashCommandDto | null {
  const rawName = String(cmd.name ?? cmd.command ?? cmd.id ?? cmd.slug ?? "")
    .trim()
    .replace(/\s+/g, "-");
  // Zed-style bridges (zcode-acp-server) prefix skills with `$` for editor
  // grouping; the composer always emits `/name`, so store the bare name.
  const isSkillPrefix = rawName.startsWith("$");
  const name = rawName.replace(/^[$/]/, "");
  if (!name || !SLASH_COMMAND_NAME_RE.test(name)) return null;
  const description = String(cmd.description ?? cmd.title ?? cmd.summary ?? "").trim();
  const input = cmd.input;
  let inputHint = "";
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const hint = (input as { hint?: unknown }).hint;
    if (typeof hint === "string") inputHint = hint.trim();
  } else if (typeof input === "string") {
    inputHint = input.trim();
  }
  if (inputHint && /^\[[^\]]*\|[^\]]*\]/.test(inputHint)) inputHint = "";
  const meta =
    cmd._meta && typeof cmd._meta === "object" && !Array.isArray(cmd._meta)
      ? (cmd._meta as Record<string, unknown>)
      : {};
  let kind = String(
    cmd.kind ?? cmd.source ?? cmd.category ?? cmd.type ?? meta.kind ?? meta.source ?? meta.type ?? "",
  ).trim();
  const desc = description || name;
  if (
    !kind &&
    (/^skill:/i.test(name) || isSkillPrefix || /\((?:user |project |builtin )?skill\)\s*$/i.test(desc))
  ) {
    kind = "skill";
  }
  return {
    name,
    description: desc,
    ...(inputHint ? { requiresInput: true, inputHint } : {}),
    ...(kind ? { kind } : {}),
  };
}
