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

/**
 * Hydration is read through `selectLiveSessionDetail`, which the chat pane uses
 * as a zustand selector — and a selector must answer the same state with the
 * same object, or React re-renders until it gives up (#185, "Maximum update
 * depth exceeded", measured on rapid chat switching). A stale snapshot plus a
 * warm cache is exactly the case that spread into a fresh object per read, so
 * the result is remembered per snapshot and per cache list: the list is one
 * array reference until the next merge rewrites it.
 */
const hydrated = new WeakMap<
  SessionDetailDto,
  {
    cache: ReadonlyMap<string, SlashCommandDto[]>;
    list: SlashCommandDto[] | undefined;
    out: SessionDetailDto;
  }
>();

/** Merge a cached command list into a session detail snapshot. */
export function hydrateSessionSlashCommands(
  detail: SessionDetailDto | null | undefined,
  cache: ReadonlyMap<string, SlashCommandDto[]>,
): SessionDetailDto | null {
  if (!detail?.id) return detail ?? null;
  const list = cache.get(detail.id);
  const hit = hydrated.get(detail);
  if (hit && hit.cache === cache && hit.list === list) return hit.out;
  const merged = mergeSlashCommandLists(list, detail.slashCommands);
  const out =
    !merged.length || slashCommandsKey(detail.slashCommands) === slashCommandsKey(merged)
      ? detail
      : { ...detail, slashCommands: merged };
  hydrated.set(detail, { cache, list, out });
  return out;
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
