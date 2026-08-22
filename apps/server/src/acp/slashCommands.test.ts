import { describe, expect, it } from "vitest";
import { mergeSlashCommandLists, parseAvailableCommands } from "./slashCommands.js";

describe("parseAvailableCommands", () => {
  it("reads camelCase, snake_case and nested update payloads", () => {
    expect(
      parseAvailableCommands({
        available_commands: [{ name: "create-pr", description: "Open a PR" }],
      }).map((c) => c.name),
    ).toEqual(["create-pr"]);
    expect(
      parseAvailableCommands({
        update: { availableCommands: [{ name: "compact", description: "Compact" }] },
      }).map((c) => c.name),
    ).toEqual(["compact"]);
  });

  it("keeps commands whose description starts with a bracket hint", () => {
    expect(
      parseAvailableCommands({
        availableCommands: [{ name: "create-pr", description: "[title|body] Open a PR" }],
      }),
    ).toEqual([{ name: "create-pr", description: "[title|body] Open a PR" }]);
  });

  it("tags Cursor user skills from the description suffix", () => {
    expect(
      parseAvailableCommands({
        availableCommands: [
          { name: "git-commit-ru", description: "Commit in Russian (user skill)" },
        ],
      }),
    ).toEqual([
      {
        name: "git-commit-ru",
        description: "Commit in Russian (user skill)",
        kind: "skill",
      },
    ]);
  });

  it("accepts string entries and command/id aliases", () => {
    expect(
      parseAvailableCommands({
        commands: ["create-pr", { command: "review", description: "Review" }],
      }).map((c) => c.name),
    ).toEqual(["create-pr", "review"]);
  });
});

describe("mergeSlashCommandLists", () => {
  it("unions lists and lets a later snapshot win on the same name", () => {
    expect(
      mergeSlashCommandLists(
        [{ name: "create-pr", description: "old" }],
        [{ name: "compact", description: "c" }],
        [{ name: "create-pr", description: "new" }],
      ),
    ).toEqual([
      { name: "create-pr", description: "new" },
      { name: "compact", description: "c" },
    ]);
  });

  it("ignores empty lists so a stale GET cannot shrink the menu", () => {
    expect(
      mergeSlashCommandLists([{ name: "create-pr", description: "Open a PR" }], []),
    ).toEqual([{ name: "create-pr", description: "Open a PR" }]);
  });

  it("collapses skill:name onto the unprefixed name", () => {
    expect(
      mergeSlashCommandLists(
        [{ name: "skill:git-commit-ru", description: "OMP" }],
        [{ name: "git-commit-ru", description: "Skill", kind: "skill" }],
      ).map((c) => c.name),
    ).toEqual(["skill:git-commit-ru"]);
  });
});
