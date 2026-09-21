// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { GitStatusDto } from "@acpio/shared";
import { I18nProvider } from "../lib/i18n";
import { useAppStore } from "../lib/store";
import { GitBranchSwitcher } from "./ComposerGitBar";

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
};

afterEach(cleanup);

beforeEach(() => {
  useAppStore.setState((s) => ({ settings: { ...s.settings, locale: "ru" } }));
});

/**
 * The composer hosts the switcher inside its own `<form>`. A nested form there
 * is invalid DOM: the browser truncates the inner submit event at the outer
 * form, so React's delegated onSubmit never runs, the default GET submission
 * reloads the app and the branch is never created.
 */
function renderInForm(onSubmit: (e: React.FormEvent) => void) {
  const onCheckout = vi.fn().mockResolvedValue(undefined);
  render(
    <I18nProvider>
      <form onSubmit={onSubmit}>
        <GitBranchSwitcher status={STATUS} branchBusy={false} onCheckout={onCheckout} />
      </form>
    </I18nProvider>,
  );
  return { onCheckout };
}

async function openCreateRow(user: UserEvent) {
  await user.click(screen.getByRole("button", { name: "main" }));
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
