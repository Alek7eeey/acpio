// @vitest-environment jsdom
//
// A settings reply is written by whatever build the server runs, and that build
// is not always the one the browser was loaded from. A reply that lacked a field
// used to be stored as it came: the composer's chip row read
// `chatChipOptions.folder.truncate`, the render threw and React unmounted the
// whole tree — typing one word into the field (a draft save is a settings write)
// blanked the page. Every reply is merged now, exactly like the boot payload.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@acpio/shared";

const apiMock = vi.hoisted(() => ({
  updateSettings: vi.fn(),
}));
vi.mock("./api", () => ({ api: apiMock }));

import { useAppStore } from "./store";

/** What a server started before the folder chip came back answers with: no
 *  `chatChipOptions.folder`, and no `fontFamily` either. */
function olderReply(): Partial<AppSettings> {
  return {
    theme: "dark",
    chatChipOptions: {
      gitBranch: { compress: true },
      gitChanges: { compress: true, metrics: "none" },
      context: { format: "usage" },
    } as unknown as AppSettings["chatChipOptions"],
    composerDrafts: { "chat-1": { text: "прив", files: [] } },
  };
}

describe("a settings reply from the server", () => {
  beforeEach(() => {
    apiMock.updateSettings.mockReset();
    useAppStore.setState({ settings: { ...useAppStore.getState().settings } });
  });

  it("is merged before it reaches the store, so a draft save cannot blank the app", async () => {
    apiMock.updateSettings.mockResolvedValue(olderReply());

    await useAppStore.getState().saveSettings({
      composerDrafts: { "chat-1": { text: "прив", files: [] } },
    });

    const settings = useAppStore.getState().settings;
    expect(settings.chatChipOptions.folder.truncate).toBe("middle");
    expect(settings.chatChipOptions.context.format).toBe("usage");
    // The reply's own values still win over the defaults.
    expect(settings.chatChipOptions.gitChanges.metrics).toBe("none");
    expect(settings.composerDrafts["chat-1"].text).toBe("прив");
  });

  it("is merged on a theme write too", async () => {
    apiMock.updateSettings.mockResolvedValue(olderReply());

    await useAppStore.getState().setTheme("dark");

    expect(useAppStore.getState().settings.chatChipOptions.folder.compress).toBe(true);
  });
});
