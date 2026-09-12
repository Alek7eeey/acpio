import { describe, expect, it } from "vitest";
import { dedupeCommitRefs } from "./gitCommitGraph";
import {
  buildGitSyncFeedback,
  formatGitErrorToast,
  gitSyncSuccessMessage,
  isGitConflictFile,
  parseGitSyncOutput,
  shouldAwaitGitRepo,
  shouldShowGitComposerUi,
} from "./gitUi";

const samplePushOutput = `remote:
remote: Visit the existing pull request:
remote:   https://scm.dev.imdomain/intermech/ips-kernel/pulls/2205
remote:
remote: . Processing 1 references
remote: Processed 1 references in total
To https://scm.dev.imdomain/intermech/ips-kernel.git
   b70853de9c5..681b8e6aaba  feature/11.0/bb1933042 -> feature/11.0/bb1933042`;

describe("parseGitSyncOutput", () => {
  it("extracts branch, range, and pull request url from push output", () => {
    expect(parseGitSyncOutput(samplePushOutput)).toEqual({
      pullRequestUrl: "https://scm.dev.imdomain/intermech/ips-kernel/pulls/2205",
      branch: "feature/11.0/bb1933042",
      range: "b70853de9c5..681b8e6aaba",
      isNewBranch: false,
    });
  });
});

describe("dedupeCommitRefs", () => {
  it("keeps one pill when local and origin refs share the same label", () => {
    expect(
      dedupeCommitRefs(["feature/11.0/bb1933042", "origin/feature/11.0/bb1933042"], "feature/11.0/bb1933042"),
    ).toEqual(["feature/11.0/bb1933042"]);
  });
});

describe("shouldAwaitGitRepo", () => {
  it("waits while status is loading", () => {
    expect(
      shouldAwaitGitRepo({
        loading: true,
        status: null,
        hasCwd: true,
      }),
    ).toBe(true);
  });

  it("waits for repo during an empty running chat", () => {
    expect(
      shouldAwaitGitRepo({
        loading: false,
        status: null,
        hasCwd: true,
        sessionStatus: "running",
        isEmptyChat: true,
      }),
    ).toBe(true);
  });

  it("stops waiting once repo appears", () => {
    expect(
      shouldAwaitGitRepo({
        loading: false,
        status: { repo: true } as never,
        hasCwd: true,
        sessionStatus: "running",
        isEmptyChat: true,
      }),
    ).toBe(false);
  });

  it("stops waiting when folder has no git repo", () => {
    expect(
      shouldAwaitGitRepo({
        loading: false,
        status: { repo: false } as never,
        hasCwd: true,
        sessionStatus: "running",
        streaming: true,
        isEmptyChat: true,
      }),
    ).toBe(false);
  });
});

describe("shouldShowGitComposerUi", () => {
  it("shows git ui for repos", () => {
    expect(
      shouldShowGitComposerUi({
        loading: false,
        awaiting: false,
        status: { repo: true } as never,
        hasCwd: true,
      }),
    ).toBe(true);
  });

  it("hides git ui when folder has no repo", () => {
    expect(
      shouldShowGitComposerUi({
        loading: false,
        awaiting: false,
        status: { repo: false } as never,
        hasCwd: true,
      }),
    ).toBe(false);
  });

  it("shows loader while git status is still loading", () => {
    expect(
      shouldShowGitComposerUi({
        loading: true,
        awaiting: true,
        status: null,
        hasCwd: true,
      }),
    ).toBe(true);
  });
});

describe("formatGitErrorToast", () => {
  const sampleCheckoutError =
    "error: Your local changes to the following files would be overwritten by checkout: web/packages/common/src/menu/DefaultContextMenu.tsx web/packages/common/src/menu/menuItemsUtils.ts Please commit your changes or stash them before you switch branches. Aborting";

  const sampleCheckoutErrorMultiline =
    "error: Your local changes to the following files would be overwritten by checkout:\n\tweb/packages/common/src/menu/DefaultContextMenu.tsx\n\tweb/packages/common/src/menu/menuItemsUtils.ts\nPlease commit your changes or stash them before you switch branches.\nAborting";

  const t = (key: string) => key;

  it("formats checkout blocked errors with file bullets", () => {
    expect(formatGitErrorToast(sampleCheckoutError, t)).toBe(
      [
        "git.checkoutBlocked",
        "• web/packages/common/src/menu/DefaultContextMenu.tsx",
        "• web/packages/common/src/menu/menuItemsUtils.ts",
        "git.checkoutBlockedHint",
      ].join("\n"),
    );
  });

  it("formats multiline checkout blocked errors", () => {
    expect(formatGitErrorToast(sampleCheckoutErrorMultiline, t)).toContain("git.checkoutBlocked");
    expect(formatGitErrorToast(sampleCheckoutErrorMultiline, t)).toContain(
      "• web/packages/common/src/menu/menuItemsUtils.ts",
    );
  });

  it("keeps the git reason visible under the localized summary", () => {
    expect(formatGitErrorToast("error: some unknown git failure", t, { context: "checkout" })).toBe(
      "git.checkoutFailed\nsome unknown git failure",
    );
    expect(
      formatGitErrorToast("fatal: Authentication failed for 'https://github.com/a/b.git'", t, {
        fallback: "git.commitFailed",
      }),
    ).toBe("git.commitFailed\nAuthentication failed for 'https://github.com/a/b.git'");
  });

  it("keeps a rejected push, whose reason is not the first line", () => {
    const output =
      "To github.com:a/b.git\n ! [rejected]        dev -> dev (fetch first)\nerror: failed to push some refs to 'github.com:a/b.git'";
    expect(formatGitErrorToast(output, t, { fallback: "git.syncFailed" })).toBe(
      `git.syncFailed\n${output}`,
    );
  });

  it("shows only the summary when git gave no output", () => {
    expect(formatGitErrorToast("", t, { context: "checkout" })).toBe("git.checkoutFailed");
    expect(formatGitErrorToast("", t, { fallback: "git.syncFailed" })).toBe("git.syncFailed");
  });

  it("caps a wall of git hints", () => {
    const toast = formatGitErrorToast(`fatal: nope\n${"hint: x\n".repeat(200)}`, t, {
      fallback: "git.syncFailed",
    });
    expect(toast.startsWith("git.syncFailed\nnope\n")).toBe(true);
    expect(toast.length).toBeLessThanOrEqual("git.syncFailed\n".length + 480);
  });
});

describe("isGitConflictFile", () => {
  it("detects unmerged porcelain states", () => {
    expect(isGitConflictFile({ path: "a.ts", index: "U", worktree: "U", staged: true, unstaged: true, additions: 0, deletions: 0 })).toBe(true);
    expect(isGitConflictFile({ path: "b.ts", index: "A", worktree: "A", staged: true, unstaged: true, additions: 0, deletions: 0 })).toBe(true);
    expect(isGitConflictFile({ path: "c.ts", index: "M", worktree: "M", staged: true, unstaged: true, additions: 1, deletions: 1 })).toBe(false);
  });
});

describe("buildGitSyncFeedback", () => {
  const t = (key: string, vars?: Record<string, string>) => {
    if (key === "git.pushOk") return `Pushed ${vars?.branch} (${vars?.range})`;
    if (key === "git.fetchOk") return "Fetch completed";
    if (key === "git.pullOk") return "Pull completed";
    if (key === "git.syncOk") return "Done";
    return key;
  };

  it("returns a short message instead of raw git output", () => {
    expect(gitSyncSuccessMessage("push", samplePushOutput, t)).toBe(
      "Pushed feature/11.0/bb1933042 (b70853d…681b8e6)",
    );
    expect(buildGitSyncFeedback("push", samplePushOutput, t).href).toBe(
      "https://scm.dev.imdomain/intermech/ips-kernel/pulls/2205",
    );
  });
});
