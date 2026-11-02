// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AppUpdateStateDto } from "@acpio/shared";
import { I18nProvider } from "../lib/i18n";
import { UPDATE_DISMISSED_KEY } from "../lib/appUpdate";
import { AppUpdateNotice } from "./AppUpdateNotice";

// The store is not what this component is about, and importing it drags in the
// whole app (and its storage) — the provider only wants a locale from it.
vi.mock("../lib/store", () => ({
  useAppStore: (selector: (state: { settings: { locale: string } }) => unknown) =>
    selector({ settings: { locale: "ru" } }),
}));

function state(patch: Partial<AppUpdateStateDto> = {}): AppUpdateStateDto {
  return {
    current: "0.1.41",
    latest: "0.1.42",
    available: true,
    status: "idle",
    // Unless a test says otherwise this copy came from npm, so the popup keeps
    // the button the rest of these tests press.
    selfUpdate: true,
    checkedAt: "2026-10-29T10:00:00.000Z",
    ...patch,
  };
}

const apiMock = vi.hoisted(() => ({
  appUpdate: vi.fn(),
  installAppUpdate: vi.fn(),
  restartApp: vi.fn(async () => ({ ok: true })),
  // The restarted build answers as itself: the page reloads onto that version.
  health: vi.fn(async () => ({ ok: true, platform: "test", version: "0.1.42" })),
}));
vi.mock("../lib/api", () => ({ api: apiMock }));

/**
 * A storage of its own: jsdom's localStorage is unusable on some Node
 * versions, and what the popup remembers ("Позже" for this version) is part of
 * what these tests check.
 */
const remembered = new Map<string, string>();
const originalLocalStorage = Object.getOwnPropertyDescriptor(window, "localStorage");

function stubLocalStorage() {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => remembered.get(key) ?? null,
      setItem: (key: string, value: string) => void remembered.set(key, String(value)),
      removeItem: (key: string) => void remembered.delete(key),
      clear: () => remembered.clear(),
      key: (index: number) => [...remembered.keys()][index] ?? null,
      get length() {
        return remembered.size;
      },
    },
  });
}

function renderNotice() {
  return render(
    <I18nProvider>
      <AppUpdateNotice />
    </I18nProvider>,
  );
}

beforeEach(() => {
  remembered.clear();
  stubLocalStorage();
  apiMock.appUpdate.mockResolvedValue(state());
  apiMock.installAppUpdate.mockResolvedValue(state({ status: "installing" }));
});

afterEach(() => {
  cleanup();
  if (originalLocalStorage) Object.defineProperty(window, "localStorage", originalLocalStorage);
  vi.clearAllMocks();
});

describe("AppUpdateNotice", () => {
  it("says nothing while the running build is the newest", async () => {
    apiMock.appUpdate.mockResolvedValue(state({ latest: "0.1.41", available: false }));
    renderNotice();
    await waitFor(() => expect(apiMock.appUpdate).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: /Доступна версия/ })).toBeNull();
  });

  it("opens the popup by itself when npm has a newer version", async () => {
    renderNotice();
    const popup = await screen.findByRole("dialog", { name: "Доступна новая версия" });
    expect(popup.textContent).toContain("Установлена 0.1.41 · в npm уже 0.1.42");
    expect(screen.getByRole("button", { name: "Обновить" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Позже" })).toBeTruthy();
    // The chip beside the version carries the number waiting on npm.
    expect(screen.getByRole("button", { name: "Доступна версия 0.1.42" })).toBeTruthy();
  });

  it("downloads the new version on the button", async () => {
    const user = userEvent.setup();
    renderNotice();
    await user.click(await screen.findByRole("button", { name: "Обновить" }));
    expect(apiMock.installAppUpdate).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Обновляем Acpio… Это может занять несколько минут.")).toBeTruthy();
    // Nothing to press twice while npm works.
    expect(screen.queryByRole("button", { name: "Обновить" })).toBeNull();
  });

  it("remembers \"later\" against this version and leaves the chip in place", async () => {
    const user = userEvent.setup();
    renderNotice();
    await user.click(await screen.findByRole("button", { name: "Позже" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(window.localStorage.getItem(UPDATE_DISMISSED_KEY)).toBe("0.1.42");
    // The way back: the chip still names the version and reopens the popup.
    await user.click(screen.getByRole("button", { name: "Доступна версия 0.1.42" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("does not reopen the popup for a version already put off", async () => {
    window.localStorage.setItem(UPDATE_DISMISSED_KEY, "0.1.42");
    renderNotice();
    await waitFor(() => expect(apiMock.appUpdate).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Доступна версия 0.1.42" })).toBeTruthy();
  });

  it("shows why the install failed and offers another try", async () => {
    const user = userEvent.setup();
    apiMock.appUpdate
      .mockResolvedValueOnce(state())
      // Every poll after the click: npm stopped with an error.
      .mockResolvedValue(state({ status: "error", message: "npm error resource busy" }));
    renderNotice();
    await user.click(await screen.findByRole("button", { name: "Обновить" }));
    // The popup follows the server's state on its own timer.
    await waitFor(() => expect(screen.getByText("Не удалось обновить")).toBeTruthy(), {
      timeout: 6_000,
    });
    expect(screen.getByText("npm error resource busy")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Повторить" })).toBeTruthy();
  });

  it("restarts the server onto the downloaded version", async () => {
    const user = userEvent.setup();
    apiMock.appUpdate
      .mockResolvedValueOnce(state())
      .mockResolvedValue(state({ status: "done" }));
    renderNotice();
    await user.click(await screen.findByRole("button", { name: "Обновить" }));
    await waitFor(() => expect(apiMock.restartApp).toHaveBeenCalledTimes(1), { timeout: 6_000 });
    expect(
      screen.getByText("Готово. Перезапускаем Acpio — страница обновится сама."),
    ).toBeTruthy();
  });

  // A build that did not come from npm has nothing to install here: the news
  // stays, the button that changes nothing goes.
  it("keeps the news and drops the install when this copy is not npm's", async () => {
    apiMock.appUpdate.mockResolvedValue(state({ selfUpdate: false }));
    renderNotice();
    const popup = await screen.findByRole("dialog", { name: "Доступна новая версия" });
    expect(popup.textContent).toContain("Установлена 0.1.41 · в npm уже 0.1.42");
    expect(screen.queryByRole("button", { name: "Обновить" })).toBeNull();
    expect(popup.textContent).toContain("установлена не из npm");
    expect(screen.getByRole("button", { name: "Позже" })).toBeTruthy();
    expect(apiMock.installAppUpdate).not.toHaveBeenCalled();
  });

  // The restart is verified by the version the server answers with: a build
  // that never handed over keeps answering as the old one, and the page must
  // not reload into it pretending the update worked.
  it("does not pass off the old build as the restarted one", async () => {
    const user = userEvent.setup();
    apiMock.appUpdate.mockResolvedValue(state());
    apiMock.installAppUpdate.mockResolvedValue(state({ status: "installing" }));
    renderNotice();
    await user.click(await screen.findByRole("button", { name: "Обновить" }));
    apiMock.appUpdate.mockResolvedValue(state({ status: "done" }));
    await waitFor(() => expect(apiMock.restartApp).toHaveBeenCalledTimes(1), { timeout: 6_000 });
    // The process never handed over: whatever answers is still the old build.
    apiMock.health.mockResolvedValue({ ok: true, platform: "test", version: "0.1.41" });
    await waitFor(
      () => expect(screen.getByText("Не удалось обновить")).toBeTruthy(),
      { timeout: 20_000 },
    );
    expect(screen.getByText(/версия осталась 0\.1\.41/)).toBeTruthy();
  });
});
