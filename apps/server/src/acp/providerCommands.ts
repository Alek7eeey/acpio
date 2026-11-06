import type { AgentProvider, SlashCommandDto } from "@acpio/shared";
import { builtinSlashCommands, discoverSettingsSkills } from "@acpio/adapter-builtin";
import { AcpClient } from "./AcpClient.js";
import { mergeSlashCommandLists, parseAvailableCommands } from "./slashCommands.js";
import { getAdapter, isBuiltinFamily } from "../adapters/registry.js";
import { getSettings } from "../services/settings.js";

/**
 * The `/` menu one provider offers for a folder, asked for before any session
 * exists — the board's new-task form writes a task's first message, so its
 * skill has to be offered before the task it belongs to.
 *
 * The built-in agent keeps its skills as `SKILL.md` files the server can read
 * on its own; every other harness holds its list inside its own CLI, so the
 * only way to hear it is to ask: a throwaway ACP session in the same folder
 * answers `available_commands_update` exactly as it would for a live chat, and
 * is disposed right after. The answer is cached per provider and folder — a
 * probe costs a process start, a folder's skills rarely change within minutes.
 */
const CACHE_TTL_MS = 5 * 60_000;
/** A cold agent may speak up late; an answer of nothing is only trusted briefly. */
const EMPTY_TTL_MS = 20_000;
/** How long a probe waits for `available_commands_update` after session/new. */
const WAIT_MS = 4_000;
/** Launch ceiling: the same budget the model probe gives a cold CLI. */
const START_TIMEOUT_MS = 20_000;

type CacheEntry = { at: number; commands: SlashCommandDto[] };

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<SlashCommandDto[]>>();

function cacheKey(provider: AgentProvider, cwd: string): string {
  return `${provider}\u0000${cwd}`;
}

export async function listProviderCommands(
  provider?: AgentProvider,
  cwd?: string,
): Promise<SlashCommandDto[]> {
  const settings = await getSettings();
  const selected = provider ?? settings.defaultProvider;
  const dir = cwd?.trim() || settings.defaultCwd || process.cwd();

  // The in-process agent needs no session to list its own menu: its commands
  // are constants and its skills are files, so both are read straight away.
  if (isBuiltinFamily(selected)) {
    const skills = await discoverSettingsSkills(settings, dir);
    return builtinSlashCommands(settings, skills);
  }

  const key = cacheKey(selected, dir);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < (cached.commands.length ? CACHE_TTL_MS : EMPTY_TTL_MS)) {
    return cached.commands;
  }
  const running = inflight.get(key);
  if (running) return running;

  const work = probeCommands(selected, dir)
    .then((commands) => {
      cache.set(key, { at: Date.now(), commands });
      return commands;
    })
    .catch((err) => {
      // A harness that cannot start has no menu to offer — keep the form quiet
      // instead of holding it on a spinner, and say why in the log only.
      console.warn(`[commands] ${selected} @ ${dir}: ${err instanceof Error ? err.message : err}`);
      cache.set(key, { at: Date.now(), commands: [] });
      return [] as SlashCommandDto[];
    })
    .finally(() => {
      if (inflight.get(key) === work) inflight.delete(key);
    });
  inflight.set(key, work);
  return work;
}

/** One ACP session's worth of `available_commands`, then the process is gone. */
async function probeCommands(
  provider: AgentProvider,
  cwd: string,
): Promise<SlashCommandDto[]> {
  const settings = await getSettings();
  if (settings.disabledProviders.includes(provider)) return [];
  const adapter = getAdapter(provider);
  // A harness that declares it cannot run yet must not be spawned to prove it.
  if (adapter.unavailableReason?.(settings)) return [];

  const client = new AcpClient(adapter, settings, cwd, settings.defaultMode);
  let commands: SlashCommandDto[] = [];
  let wake: (() => void) | null = null;
  const spoken = new Promise<void>((resolve) => {
    wake = resolve;
  });
  client.on("update", (update: import("./AcpClient.js").AcpUpdate) => {
    if (update.kind !== "available_commands") return;
    commands = mergeSlashCommandLists(commands, parseAvailableCommands(update.raw));
    wake?.();
  });
  try {
    // No MCP servers: a command list needs none, and the launch is quicker
    // without them. `catalogOnly` skips model/mode selection for the same
    // reason — this session exists only to be asked one question.
    await client.start(START_TIMEOUT_MS, { catalogOnly: true, mcpServers: [] });
    if (!commands.length) {
      await Promise.race([spoken, new Promise((resolve) => setTimeout(resolve, WAIT_MS))]);
    }
    return commands;
  } finally {
    client.dispose();
  }
}
