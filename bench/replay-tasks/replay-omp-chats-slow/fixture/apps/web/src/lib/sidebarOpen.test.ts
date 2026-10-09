// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const TREE_KEY = "acpio.sidebarOpen.v1";
const SETTINGS_KEY = "acpio.sidebarOpen.settings.v1";

const apiMock = vi.hoisted(() => ({
  listSessions: vi.fn(),
  getSession: vi.fn(),
  getLiveTurn: vi.fn(),
}));
vi.mock("./api", () => ({ api: apiMock }));

/** Fresh module instance so the store's initial state is recomputed for `width`. */
async function loadStore(width: number) {
  vi.resetModules();
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  return import("./store");
}

afterEach(() => {
  localStorage.clear();
});

describe("sidebar collapse persistence", () => {
  it("restores a collapsed tree after a reload", async () => {
    const first = await loadStore(1024);
    expect(first.useAppStore.getState().sidebarOpen).toBe(true);

    first.useAppStore.getState().setSidebarOpen(false);
    expect(localStorage.getItem(TREE_KEY)).toBe("0");

    const reloaded = await loadStore(1024);
    expect(reloaded.useAppStore.getState().sidebarOpen).toBe(false);
  });

  it("restores an expanded tree after collapsing and expanding again", async () => {
    const first = await loadStore(1024);
    first.useAppStore.getState().setSidebarOpen(false);
    first.useAppStore.getState().setSidebarOpen(true);

    const reloaded = await loadStore(1024);
    expect(reloaded.useAppStore.getState().sidebarOpen).toBe(true);
  });

  it("starts with the tree open when nothing is stored", async () => {
    const store = await loadStore(1024);
    expect(store.useAppStore.getState().sidebarOpen).toBe(true);
  });

  it("keeps the settings nav state separate from the chat tree", async () => {
    const store = await loadStore(1024);
    const s = () => store.useAppStore.getState();

    s().setSidebarOpen(false); // collapse the chat tree
    s().setSidebarPanel("settings"); // settings has no preference yet — inherits
    expect(s().sidebarOpen).toBe(false);

    s().setSidebarOpen(true); // expand settings only
    expect(localStorage.getItem(SETTINGS_KEY)).toBe("1");
    expect(localStorage.getItem(TREE_KEY)).toBe("0");

    s().setSidebarPanel("tree");
    expect(s().sidebarOpen).toBe(false); // tree stayed collapsed
    s().setSidebarPanel("settings");
    expect(s().sidebarOpen).toBe(true); // settings stayed expanded
  });

  it("restores both panels independently after a reload", async () => {
    const first = await loadStore(1024);
    const s = () => first.useAppStore.getState();
    s().setSidebarOpen(false);
    s().setSidebarPanel("settings");
    s().setSidebarOpen(true);

    const reloaded = await loadStore(1024);
    const r = () => reloaded.useAppStore.getState();
    expect(r().sidebarOpen).toBe(false); // initial scope is the tree

    r().setSidebarPanel("settings");
    expect(r().sidebarOpen).toBe(true);
  });

  it("ignores stored desktop preferences on a phone-sized viewport", async () => {
    localStorage.setItem(TREE_KEY, "1");
    localStorage.setItem(SETTINGS_KEY, "1");

    const store = await loadStore(500);
    const s = () => store.useAppStore.getState();
    expect(s().sidebarOpen).toBe(false);
    expect(s().setSidebarPanel("settings")).toBe(false);
    expect(s().sidebarOpen).toBe(false);
  });

  it("does not persist mobile sheet toggles", async () => {
    const store = await loadStore(500);
    const s = () => store.useAppStore.getState();
    s().setSidebarOpen(true);
    s().setSidebarOpen(false);
    s().setSidebarPanel("settings");
    s().setSidebarOpen(true);

    expect(localStorage.getItem(TREE_KEY)).toBeNull();
    expect(localStorage.getItem(SETTINGS_KEY)).toBeNull();
  });
});
