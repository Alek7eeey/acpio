/**
 * Shared harness for the two end-to-end specs: one fake-agent chat per test,
 * the app's global settings put back to the seed before every test, and the
 * two ways of opening the UI (with and without the boot gate).
 */
import { expect, test as base, type APIRequestContext, type Page } from "playwright/test";
import {
  E2E_AGENT_ECHO,
  E2E_AGENT_ID,
  E2E_RESET_SETTINGS,
  REPO_ROOT,
} from "./seed.mjs";

export { expect } from "playwright/test";

export type Chat = { id: string; title: string };

/**
 * The availability map the app keeps in sessionStorage after its own probe.
 * A tab that starts with it does not raise the boot gate — the same door
 * scripts/capture-one.mjs uses. The gate has its own spec, which opens a tab
 * without it.
 */
const AVAILABILITY_KEY = "acpio.agentAvailability.v1";
const SPLASH_KEY = "acpio.bootSplashDismissed";
const ACTIVE_CHAT_KEY = "acpio.activeSessionId";

/** Create a chat on the fake agent — the API the "New chat" picker itself calls. */
export async function createChat(
  request: APIRequestContext,
  title: string,
  cwd = REPO_ROOT,
): Promise<Chat> {
  const res = await request.post("/api/sessions", {
    data: { provider: E2E_AGENT_ID, title, cwd },
  });
  expect(res.status(), await res.text()).toBe(200);
  const session = await res.json();
  return { id: session.id, title: session.title };
}

/** Answer a chat's prompt outside the browser, so a spec can seed a transcript. */
export async function sendPrompt(
  request: APIRequestContext,
  sessionId: string,
  text: string,
): Promise<void> {
  const res = await request.post(`/api/sessions/${sessionId}/prompt`, { data: { text } });
  expect(res.status(), await res.text()).toBe(200);
  // The turn runs in the background; wait for the fake agent's own answer.
  await expect
    .poll(() => storedTranscript(request, sessionId), { timeout: 30_000 })
    .toContain(E2E_AGENT_ECHO(text));
}

/** `role:text` lines of a stored conversation — what the server kept, not what the DOM drew. */
export async function storedTranscript(
  request: APIRequestContext,
  sessionId: string,
): Promise<string> {
  const res = await request.get(`/api/sessions/${sessionId}`);
  expect(res.ok()).toBeTruthy();
  const detail = await res.json();
  return (detail.messages ?? [])
    .map((message: { role: string; parts?: { type: string; payload?: { text?: string } }[] }) => {
      const text = (message.parts ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.payload?.text ?? "")
        .join("");
      return `${message.role}:${text}`;
    })
    .join("\n");
}

/** The composer textarea — the one box every layout keeps in reach. */
export function composer(page: Page) {
  return page.getByPlaceholder(/Message or \/command/);
}

/**
 * Open the app on `path`. A tab that starts with the agent already known skips
 * the boot gate (`skipBootGate: false` is the gate's own spec); a `sessionId`
 * also makes the tab reopen that chat on every navigation, so a reload is part
 * of several specs.
 */
export async function openApp(
  page: Page,
  options: { path?: string; sessionId?: string; skipBootGate?: boolean } = {},
) {
  const { path = "/chat", sessionId, skipBootGate = true } = options;
  await page.addInitScript(
    (init: {
      availabilityKey: string;
      splashKey: string;
      activeKey: string;
      agentId: string;
      online: boolean;
      sessionId: string | null;
    }) => {
      if (init.online) {
        sessionStorage.setItem(init.availabilityKey, JSON.stringify({ [init.agentId]: true }));
      }
      localStorage.setItem(init.splashKey, "1");
      if (init.sessionId) localStorage.setItem(init.activeKey, init.sessionId);
    },
    {
      availabilityKey: AVAILABILITY_KEY,
      splashKey: SPLASH_KEY,
      activeKey: ACTIVE_CHAT_KEY,
      agentId: E2E_AGENT_ID,
      online: skipBootGate,
      sessionId: sessionId ?? null,
    },
  );
  await page.goto(path);
}

/** Open a chat and wait until its composer is on screen. */
export async function openChat(page: Page, sessionId: string) {
  await openApp(page, { path: "/chat", sessionId });
  await expect(composer(page)).toBeVisible();
}

/**
 * Tap the phone's bottom puller until the sheet is up and returns it.
 *
 * The puller reads a whole gesture, not a click: a tap that lands while the
 * page is still re-rendering (right after a route change) is cancelled by the
 * browser and does nothing — a phone user taps again, and so does this.
 */
export async function openSheet(page: Page, puller: string, label: string) {
  const sheet = page.getByRole("dialog", { name: label });
  await expect(async () => {
    if (!(await sheet.count())) {
      await page.getByRole("button", { name: puller, exact: true }).click();
    }
    // …and it has to stay up: a tap swallowed by a re-render opens the sheet
    // and then loses it again, which is a second tap for a phone user.
    await page.waitForTimeout(600);
    await expect(sheet).toBeVisible();
  }).toPass({ timeout: 20_000 });
  return sheet;
}

/** How far the document scrolls sideways — 0 means nothing sticks out. */
export async function sidewaysOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
}

type Fixtures = {
  chat: Chat;
  /** Put the global settings back before every test — and never after it. */
  resetSettings: void;
};

export const test = base.extend<Fixtures>({
  resetSettings: [
    async ({ request }, use) => {
      // A theme or a language is one setting for the whole install, not a tab:
      // a spec that clicks one would otherwise color the next spec's labels.
      const res = await request.put("/api/settings", { data: E2E_RESET_SETTINGS });
      expect(res.ok(), await res.text()).toBeTruthy();
      await use();
    },
    { auto: true },
  ],

  chat: async ({ request }, use, testInfo) => {
    // The fixture's name is the searchable, unambiguous title of this test's chat.
    const title = `e2e ${testInfo.title}`.slice(0, 70);
    const chat = await createChat(request, title);
    await use(chat);
    // The next spec inherits the database, not the debris: a leftover chat
    // would sit in every tree and match every search.
    await request.delete(`/api/sessions/${chat.id}`);
  },
});
