import { describe, expect, it } from "vitest";
import type { SessionDetailDto, SlashCommandDto } from "@acprocess/shared";
import {
  hydrateSessionSlashCommands,
  mergeIncomingSlashCommands,
  preferSessionSlashCommands,
  rememberSessionSlashCommands,
  slashCommandsKey,
  slashListStillLoading,
} from "./sessionSlashCommands";

const cmdsA: SlashCommandDto[] = [
  { name: "compact", description: "Compact" },
  { name: "git-commit-ru", description: "Commit (user skill)" },
];

function detail(
  id: string,
  slashCommands?: SlashCommandDto[],
  extra: Partial<SessionDetailDto> = {},
): SessionDetailDto {
  return {
    id,
    title: id,
    cwd: "/proj",
    provider: "cursor",
    mode: "agent",
    status: "idle",
    themeId: null,
    archived: false,
    pinned: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messages: [],
    slashCommands,
    acpSessionId: null,
    ...extra,
  };
}

describe("slashListStillLoading", () => {
  it("treats an empty list as still loading", () => {
    expect(slashListStillLoading([])).toBe(true);
    expect(slashListStillLoading(undefined)).toBe(true);
    expect(slashListStillLoading(cmdsA)).toBe(false);
  });
});

describe("hydrateSessionSlashCommands", () => {
  it("restores commands from the warm cache when the detail snapshot is empty", () => {
    const cache = new Map([["s1", cmdsA]]);
    expect(hydrateSessionSlashCommands(detail("s1"), cache)?.slashCommands).toEqual(cmdsA);
  });

  it("returns null for a missing detail", () => {
    expect(hydrateSessionSlashCommands(null, new Map())).toBeNull();
  });

  it("keeps the same object reference when slash commands are unchanged", () => {
    const cache = new Map([["s1", cmdsA]]);
    const input = detail("s1", cmdsA);
    expect(hydrateSessionSlashCommands(input, cache)).toBe(input);
  });
});

describe("preferSessionSlashCommands", () => {
  it("keeps cached commands when GET returns an empty list", () => {
    const cache = new Map([["s1", cmdsA]]);
    const fetched = detail("s1", []);
    expect(preferSessionSlashCommands(fetched, null, cache).slashCommands).toEqual(cmdsA);
  });

  it("keeps live commands when GET and cache are empty", () => {
    const live = detail("s1", cmdsA);
    const fetched = detail("s1", []);
    expect(preferSessionSlashCommands(fetched, live, new Map()).slashCommands).toEqual(cmdsA);
  });

  it("unions cache, live, and fetched snapshots", () => {
    const cache = new Map<string, SlashCommandDto[]>([
      ["s1", [{ name: "compact", description: "old" }]],
    ]);
    const live = detail("s1", [{ name: "stop", description: "Stop" }]);
    const fetched = detail("s1", [{ name: "compact", description: "new" }]);
    expect(
      preferSessionSlashCommands(fetched, live, cache)
        .slashCommands?.map((c) => c.name)
        .sort(),
    ).toEqual(["compact", "stop"]);
  });
});

describe("rememberSessionSlashCommands", () => {
  it("writes the merged list back into the cache", () => {
    const cache = new Map<string, SlashCommandDto[]>();
    const next = rememberSessionSlashCommands(detail("s1", cmdsA), cache);
    expect(next.slashCommands).toEqual(cmdsA);
    expect(cache.get("s1")).toEqual(cmdsA);
  });
});

describe("mergeIncomingSlashCommands", () => {
  it("merges websocket updates with cache and live state", () => {
    const cache = new Map([["s1", [{ name: "compact", description: "c" }]]]);
    const live = detail("s1", [{ name: "stop", description: "s" }]);
    expect(
      mergeIncomingSlashCommands(
        "s1",
        [{ name: "git-commit-ru", description: "skill" }],
        live,
        cache,
      )
        .map((c) => c.name)
        .sort(),
    ).toEqual(["compact", "git-commit-ru", "stop"]);
  });

  it("ignores empty websocket payloads", () => {
    const cache = new Map([["s1", cmdsA]]);
    expect(mergeIncomingSlashCommands("s1", [], null, cache)).toEqual(cmdsA);
  });
});

describe("slashCommandsKey", () => {
  it("changes when command names differ even if counts match", () => {
    expect(slashCommandsKey([{ name: "a", description: "d" }])).not.toBe(
      slashCommandsKey([{ name: "b", description: "d" }]),
    );
  });
});

describe("chat switch scenarios", () => {
  it("simulates returning to a chat whose detail cache missed WS commands", () => {
    const cache = new Map<string, SlashCommandDto[]>();
    const sessionA = detail("a", cmdsA);
    rememberSessionSlashCommands(sessionA, cache);

    const staleSnapshot = detail("a");
    const optimistic = hydrateSessionSlashCommands(staleSnapshot, cache);
    expect(optimistic?.slashCommands).toEqual(cmdsA);

    const fetchedEmpty = preferSessionSlashCommands(detail("a", []), optimistic, cache);
    expect(fetchedEmpty.slashCommands).toEqual(cmdsA);
  });

  it("simulates WS update arriving while another chat is active", () => {
    const cache = new Map<string, SlashCommandDto[]>();
    const merged = mergeIncomingSlashCommands(
      "b",
      [{ name: "compact", description: "Compact" }],
      null,
      cache,
    );
    cache.set("b", merged);

    const laterSelect = hydrateSessionSlashCommands(detail("b"), cache);
    expect(laterSelect?.slashCommands?.map((c) => c.name)).toEqual(["compact"]);
  });

  it("does not let a stale empty GET shrink a fuller cached list", () => {
    const cache = new Map([["a", cmdsA]]);
    const afterGet = preferSessionSlashCommands(detail("a", []), null, cache);
    expect(afterGet.slashCommands).toEqual(cmdsA);
    expect(slashListStillLoading(afterGet.slashCommands)).toBe(false);
  });
});
