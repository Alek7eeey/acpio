// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { GitStatusDto } from "@acpio/shared";
import { I18nProvider } from "../lib/i18n";
import { useAppStore } from "../lib/store";
import { GitBranchSwitcher, type GitBranchDeleteOutcome } from "./ComposerGitBar";

const STATUS: GitStatusDto = {
  repo: true,
  root: "C:/repo",
  branch: "main",
  dirty: false,
  conflict: false,
  branches: ["main"],
  files: [],
  stagedCount: 0,
  unstagedCount: 0,
  additions: 0,
  deletions: 0,
  stashCount: 0,
  aheadCount: 0,
  behindCount: 0,
  protectedBranches: ["main"],
};

const DELETED: GitBranchDeleteOutcome = { ok: true, unmerged: false };
const UNMERGED: GitBranchDeleteOutcome = { ok: false, unmerged: true };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  useAppStore.setState((s) => ({ settings: { ...s.settings, locale: "ru" } }));
});

/**
 * The composer hosts the switcher inside its own `<form>`. A nested form there
 * is invalid DOM: the browser truncates the inner submit event at the outer
 * form, so React's delegated onSubmit never runs, the default GET submission
 * reloads the app and the branch is never created.
 */
function renderInForm(
  onSubmit: (e: React.FormEvent) => void,
  opts: { status?: GitStatusDto; outcomes?: GitBranchDeleteOutcome[] } = {},
) {
  const onCheckout = vi.fn().mockResolvedValue(undefined);
  const outcomes = opts.outcomes ?? [DELETED];
  const onDeleteBranch = vi
    .fn<(branch: string, opts?: { force?: boolean }) => Promise<GitBranchDeleteOutcome>>()
    .mockImplementation(() => Promise.resolve(outcomes.shift() ?? DELETED));
  render(
    <I18nProvider>
      <form onSubmit={onSubmit}>
        <GitBranchSwitcher
          status={opts.status ?? STATUS}
          branchBusy={false}
          onCheckout={onCheckout}
          onDeleteBranch={onDeleteBranch}
        />
      </form>
    </I18nProvider>,
  );
  return { onCheckout, onDeleteBranch };
}

async function openMenu(user: UserEvent, name = "main") {
  await user.click(screen.getByRole("button", { name }));
}

async function openCreateRow(user: UserEvent, name = "main") {
  await openMenu(user, name);
  return await screen.findByPlaceholderText("Имя новой ветки");
}

describe("GitBranchSwitcher branch creation", () => {
  it("creates the branch without submitting the form around the switcher", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    const { onCheckout } = renderInForm(onSubmit);

    const input = await openCreateRow(user);
    await user.type(input, "feature/from-menu");
    await user.click(screen.getByRole("button", { name: "Создать" }));

    await waitFor(() => expect(onCheckout).toHaveBeenCalledWith("feature/from-menu", true));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("creates the branch on Enter in the branch field", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    const { onCheckout } = renderInForm(onSubmit);

    const input = await openCreateRow(user);
    await user.type(input, "feature/enter{Enter}");

    await waitFor(() => expect(onCheckout).toHaveBeenCalledWith("feature/enter", true));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("GitBranchSwitcher branch deletion", () => {
  /** Sitting on a feature branch: `main` is neither protected by being current nor hidden. */
  const ON_FEATURE: GitStatusDto = {
    ...STATUS,
    branch: "feature-a",
    branches: ["feature-a", "feature-b", "main"],
    protectedBranches: ["feature-a", "main"],
  };

  it("offers delete only for the branches it may delete", async () => {
    const user = userEvent.setup();
    renderInForm(vi.fn(), { status: ON_FEATURE });
    await openMenu(user, "feature-a");

    expect(await screen.findByRole("button", { name: "Удалить ветку feature-b" })).toBeTruthy();
    // The checked-out branch...
    expect(screen.queryByRole("button", { name: "Удалить ветку feature-a" })).toBeNull();
    // ...and the repository's main branch, even though neither is checked out.
    expect(screen.queryByRole("button", { name: "Удалить ветку main" })).toBeNull();
  });

  it("deletes a merged branch after one confirmation", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { onDeleteBranch } = renderInForm(vi.fn(), { status: ON_FEATURE });
    await openMenu(user, "feature-a");

    await user.click(await screen.findByRole("button", { name: "Удалить ветку feature-b" }));

    await waitFor(() => expect(onDeleteBranch).toHaveBeenCalledWith("feature-b"));
    expect(onDeleteBranch).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("asks again and forces when git reports the branch as unmerged", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { onDeleteBranch } = renderInForm(vi.fn(), {
      status: ON_FEATURE,
      outcomes: [UNMERGED, DELETED],
    });
    await openMenu(user, "feature-a");

    await user.click(await screen.findByRole("button", { name: "Удалить ветку feature-b" }));

    await waitFor(() => expect(onDeleteBranch).toHaveBeenCalledWith("feature-b", { force: true }));
    expect(onDeleteBranch).toHaveBeenNthCalledWith(1, "feature-b");
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("leaves the branch alone when the confirmation is declined", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { onDeleteBranch } = renderInForm(vi.fn(), { status: ON_FEATURE });
    await openMenu(user, "feature-a");

    await user.click(await screen.findByRole("button", { name: "Удалить ветку feature-b" }));

    expect(onDeleteBranch).not.toHaveBeenCalled();
  });

  it("keeps the unmerged branch when the second confirmation is declined", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(true).mockReturnValueOnce(false);
    const { onDeleteBranch } = renderInForm(vi.fn(), {
      status: ON_FEATURE,
      outcomes: [UNMERGED],
    });
    await openMenu(user, "feature-a");

    await user.click(await screen.findByRole("button", { name: "Удалить ветку feature-b" }));

    await waitFor(() => expect(onDeleteBranch).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});
