import type { SessionDetailDto, SlashCommandDto } from "@acpio/shared";
import { mergeSlashCommandLists } from "./slashCommands";

export function slashListStillLoading(cmds?: SlashCommandDto[]) {
  return !cmds?.length;
}

export function slashCommandsKey(cmds?: SlashCommandDto[]) {
  if (!cmds?.length) return "";
  return cmds
    .map((c) => c.name.trim().replace(/^\//, "").toLowerCase())
    .sort()
    .join("\0");
}

/** Merge a cached command list into a session detail snapshot. */
export function hydrateSessionSlashCommands(
  detail: SessionDetailDto | null | undefined,
  cache: ReadonlyMap<string, SlashCommandDto[]>,
): SessionDetailDto | null {
  if (!detail?.id) return detail ?? null;
  const merged = mergeSlashCommandLists(cache.get(detail.id), detail.slashCommands);
  if (!merged.length) return detail;
  if (slashCommandsKey(detail.slashCommands) === slashCommandsKey(merged)) return detail;
  return { ...detail, slashCommands: merged };
}

/** Union live UI, warm cache, and a fresh GET snapshot — never shrink to empty. */
export function preferSessionSlashCommands(
  fetched: SessionDetailDto,
  live: SessionDetailDto | null | undefined,
  cache: ReadonlyMap<string, SlashCommandDto[]>,
): SessionDetailDto {
  const merged = mergeSlashCommandLists(
    live?.slashCommands,
    cache.get(fetched.id),
    fetched.slashCommands,
  );
  return merged.length ? { ...fetched, slashCommands: merged } : fetched;
}

export function rememberSessionSlashCommands(
  detail: SessionDetailDto,
  cache: Map<string, SlashCommandDto[]>,
): SessionDetailDto {
  const merged = mergeSlashCommandLists(cache.get(detail.id), detail.slashCommands);
  const next = merged.length ? { ...detail, slashCommands: merged } : detail;
  if (merged.length) cache.set(next.id, merged);
  return next;
}

export function mergeIncomingSlashCommands(
  sessionId: string,
  incoming: SlashCommandDto[] | undefined,
  live: SessionDetailDto | null | undefined,
  cache: ReadonlyMap<string, SlashCommandDto[]>,
): SlashCommandDto[] {
  return mergeSlashCommandLists(cache.get(sessionId), live?.slashCommands, incoming);
}
