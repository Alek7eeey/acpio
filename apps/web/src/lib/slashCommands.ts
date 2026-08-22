import type { SlashCommandDto } from "@acprocess/shared";
import type { TranslateFn } from "@acprocess/i18n";

export function getBuiltinSlashCommands(t: TranslateFn): SlashCommandDto[] {
  return [
    {
      name: "stop",
      description: t("chat.stopGeneration"),
    },
  ];
}

const HIDDEN_COMMAND_NAMES = new Set(["plugins", "plugin", "manage-plugins", "manage_plugins"]);

function isValidSlashCommandName(name: string) {
  // `namespace:name` is legal (OMP skills arrive as `skill:<name>`); the
  // part after the colon must start with a letter so Windows paths like
  // "/C:/…" don't parse as commands.
  return /^[a-z][\w-]*(?::[a-z][\w-]*)?$/i.test(name);
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

export function mergeSlashCommands(agentCommands: SlashCommandDto[] = [], t: TranslateFn) {
  const seen = new Set<string>();
  const out: SlashCommandDto[] = [];
  for (const cmd of [...getBuiltinSlashCommands(t), ...agentCommands]) {
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
  // Token start: beginning, newline, or whitespace — so "/cmd" still works
  // after existing draft text. Mid-word "x/y" stays ignored.
  const match = before.match(/(?:^|[\s])\/([\w:-]*)$/);
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
  const match = trimmed.match(/^\/([a-z][\w-]*(?::[a-z][\w-]*)?)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return {
    name: match[1],
    args: (match[2] ?? "").trim(),
  };
}

export function isSlashCommandText(text: string) {
  return Boolean(parseSlashCommandText(text));
}
