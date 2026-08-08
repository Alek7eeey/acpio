import type { SlashCommandDto } from "@acprocess/shared";

export const BUILTIN_SLASH_COMMANDS: SlashCommandDto[] = [
  {
    name: "stop",
    description: "Остановить текущую генерацию",
  },
];

const HIDDEN_COMMAND_NAMES = new Set(["plugins", "plugin", "manage-plugins", "manage_plugins"]);

function isValidSlashCommandName(name: string) {
  return /^[a-z][\w-]*$/i.test(name);
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
  if (HIDDEN_COMMAND_NAMES.has(name.toLowerCase())) return null;

  const description = cmd.description.trim();
  if (/manage\s+plugins?/i.test(description)) return null;
  if (isBracketSyntaxHint(description)) return null;

  const inputHint = cmd.inputHint?.trim();
  const requiresInput = Boolean(cmd.requiresInput ?? inputHint);
  return {
    name,
    description: description || name,
    ...(requiresInput ? { requiresInput: true } : {}),
    ...(inputHint && !isBracketSyntaxHint(inputHint) ? { inputHint } : {}),
  };
}

export function mergeSlashCommands(agentCommands: SlashCommandDto[] = []) {
  const seen = new Set<string>();
  const out: SlashCommandDto[] = [];
  for (const cmd of [...BUILTIN_SLASH_COMMANDS, ...agentCommands]) {
    const clean = sanitizeSlashCommand(cmd);
    if (!clean) continue;
    const key = clean.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

export function getSlashContext(text: string, cursor: number) {
  const before = text.slice(0, cursor);
  const match = before.match(/(?:^|\n)\/([\w-]*)$/);
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
  return `/${cmd.name}${slashCommandRequiresInput(cmd) ? " " : ""}`;
}

export function findSlashCommand(commands: SlashCommandDto[], name: string) {
  const key = name.toLowerCase();
  return commands.find((cmd) => cmd.name.toLowerCase() === key) ?? null;
}

export function isSlashCommandReadyToSend(text: string, commands: SlashCommandDto[]) {
  const parsed = parseSlashCommandText(text);
  if (!parsed) return true;
  const cmd = findSlashCommand(commands, parsed.name);
  if (!cmd) return true;
  if (slashCommandRequiresInput(cmd) && !parsed.args) return false;
  return true;
}

export function parseSlashCommandText(text: string) {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/([\w-]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return {
    name: match[1],
    args: (match[2] ?? "").trim(),
  };
}

export function isSlashCommandText(text: string) {
  return Boolean(parseSlashCommandText(text));
}
