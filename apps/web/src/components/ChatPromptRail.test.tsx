// @vitest-environment jsdom
// The rail beside the thread: one pill per prompt, in order — and, when the
// chat has more prompts than the thread can draw, a window of them closed with
// a cut marker, so the column never runs over the header or the composer.

import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DEFAULT_SETTINGS } from "@acpio/shared";
import { useAppStore } from "../lib/store";
import { I18nProvider } from "../lib/i18n";
import { RAIL_CUT_HEIGHT_PX, railWindow, type PromptRailItem } from "../lib/promptRail";
import { ChatPromptRail } from "./ChatPromptRail";

// The store reads localStorage the moment it is imported and this vitest's jsdom
// environment brings none, so a chat component cannot be imported without a
// shim. `vi.hoisted` is what puts it before those imports run.
vi.hoisted(() => {
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, String(value)),
      removeItem: (key: string) => void map.delete(key),
      clear: () => map.clear(),
      key: (index: number) => Array.from(map.keys())[index] ?? null,
      get length() {
        return map.size;
      },
    },
  });
});

// The rail is hover-only furniture: a jsdom window has no pointer to hover with.
vi.mock("../lib/pointerUi", () => ({ isTouchUi: () => false, useIsTouchUi: () => false }));

/** A chat with `count` prompts, oldest first. */
function prompts(count: number): PromptRailItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `u${i}`,
    prompt: `prompt ${i}`,
    reply: `reply ${i}`,
  }));
}

function renderRail(items: PromptRailItem[], height: number, activeId: string | null) {
  useAppStore.setState({ settings: DEFAULT_SETTINGS });
  return render(
    <I18nProvider>
      <ChatPromptRail
        items={items}
        top={0}
        height={height}
        activeId={activeId}
        onSelect={() => {}}
      />
    </I18nProvider>,
  );
}

const pills = () => document.querySelectorAll("[data-prompt-id]");

afterEach(() => {
  cleanup();
});

describe("ChatPromptRail", () => {
  it("draws a pill per prompt while they fit the thread", () => {
    renderRail(prompts(4), 600, "u3");

    expect(pills()).toHaveLength(4);
    // Nothing was clipped, so nothing claims to be.
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("clips a long chat's column at the thread's height and marks the cut", () => {
    const items = prompts(300);
    renderRail(items, 600, "u299");

    const view = railWindow(300, 299, 600 - 20);
    expect(view.above).toBeGreaterThan(0);
    expect(pills()).toHaveLength(view.count);
    expect(pills().length).toBeLessThan(items.length);
    // The clipped prompts above are named by a marker instead of drawn.
    expect(screen.getByRole("img", { name: `${view.above} more above` })).toBeTruthy();
    expect(screen.queryByRole("img", { name: /more below/ })).toBeNull();
  });

  it("keeps the prompt the reader is in inside the window", () => {
    // Far up a long chat: the lit pill is the first drawn one, the rest of the
    // chat is clipped below.
    renderRail(prompts(300), 600, "u2");

    const current = document.querySelector('[aria-current="true"]');
    expect(current?.getAttribute("data-prompt-id")).toBe("u2");
    expect(screen.getByRole("img", { name: /more below/ })).toBeTruthy();
  });

  it("counts the marker in the column's height, not on top of it", () => {
    renderRail(prompts(300), 600, "u299");

    const drawn = Array.from(pills()).reduce(
      (sum, pill) => sum + Number.parseFloat((pill as HTMLElement).style.height),
      0,
    );
    expect(drawn + RAIL_CUT_HEIGHT_PX).toBeLessThanOrEqual(600 - 20);
  });
});
