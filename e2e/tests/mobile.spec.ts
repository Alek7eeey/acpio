/**
 * Phone end-to-end: the bottom-sheet layout, where the tree, the settings
 * navigation and the composer all have to fit a hand-sized screen.
 *
 * The same spec runs on two devices (Pixel 7 and iPhone SE, see
 * playwright.config.ts) — every assertion here has to hold at 375 points of
 * width as well as 412.
 */
import {
  composer,
  createChat,
  expect,
  openApp,
  openChat,
  openSheet,
  sendPrompt,
  sidewaysOverflow,
  test,
} from "../support/app";
import { E2E_AGENT_ECHO } from "../support/seed.mjs";

test.describe("phone chat", () => {
  test("the composer sits on screen and sends a prompt", async ({ page, chat }) => {
    await openChat(page, chat.id);
    const text = "hello from the phone";

    const box = await composer(page).boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    // Nothing is cropped: the whole input is inside the screen and not under it.
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
    expect(await sidewaysOverflow(page)).toBe(0);

    await composer(page).fill(text);
    await page.getByRole("button", { name: "Send", exact: true }).click();

    await expect(page.getByText(E2E_AGENT_ECHO(text))).toBeVisible({ timeout: 30_000 });
    await expect(composer(page)).toHaveValue("");
  });

  test("the chats sheet lists the tree and switches the conversation", async ({
    page,
    chat,
    request,
  }) => {
    // A neighbour with a transcript of its own, so "switched" is observable.
    const other = await createChat(request, "e2e phone neighbour");
    try {
      await sendPrompt(request, other.id, "the other conversation");
      await openChat(page, chat.id);

      // The sheet starts closed: the phone keeps the transcript full-screen.
      await expect(page.getByRole("dialog", { name: "Open sidebar" })).toHaveCount(0);
      const sheet = await openSheet(page, "Chats", "Open sidebar");
      await expect(sheet.getByText(chat.title, { exact: true }).first()).toBeVisible();

      await sheet.getByText("e2e phone neighbour", { exact: true }).first().click();

      await expect(page.getByRole("dialog", { name: "Open sidebar" })).toHaveCount(0);
      await expect(page.getByText(E2E_AGENT_ECHO("the other conversation"))).toBeVisible({
        timeout: 30_000,
      });
      expect(await sidewaysOverflow(page)).toBe(0);
    } finally {
      await request.delete(`/api/sessions/${other.id}`);
    }
  });
});

test.describe("phone settings", () => {
  test("settings open from the header and a section is reachable from the sheet", async ({
    page,
    chat,
  }) => {
    await openChat(page, chat.id);

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL(/\/settings/);
    await expect(page.getByText("Agent connection")).toBeVisible();
    expect(await sidewaysOverflow(page)).toBe(0);

    // The sections live behind the same bottom sheet the tree uses.
    const sheet = await openSheet(page, "Sections", "Settings sections");

    // The sheet opens at half height and the tree scrolls inside it.
    const leaf = sheet.getByText("Interface", { exact: true });
    await leaf.scrollIntoViewIfNeeded();
    await leaf.click();

    await expect(page).toHaveURL(/section=interface/);
    await expect(page.getByText("Appearance", { exact: true }).first()).toBeVisible();
    expect(await sidewaysOverflow(page)).toBe(0);
  });

  test("one tap on the puller opens the sections right after the page arrives", async ({
    page,
    chat,
  }) => {
    await openChat(page, chat.id);

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByText("Agent connection")).toBeVisible();

    // A single tap, right after the route change: the sheet has to come up and
    // stay up. A dismissal armed by that change used to close it again ~100 ms
    // after it opened, so the first tap looked dead and only the second worked.
    await page.getByRole("button", { name: "Sections", exact: true }).tap();

    const sheet = page.getByRole("dialog", { name: "Settings sections" });
    await expect(sheet).toBeVisible();
    await page.waitForTimeout(700);
    await expect(sheet).toBeVisible();
  });
});

test.describe("phone board", () => {
  test("a board keeps its lanes on screen and scrolls inside itself", async ({ page, request }) => {
    const created = await request.post("/api/boards", {
      data: { name: "e2e phone board", folders: [] },
    });
    expect(created.status(), await created.text()).toBe(200);
    const board = await created.json();

    try {
      await openApp(page, { path: `/board/${board.id}` });

      await expect(page.locator("header")).toContainText("e2e phone board");
      await expect(page.getByText("Todo", { exact: true })).toBeVisible();
      await expect(page.getByText("In Progress", { exact: true })).toBeVisible();
      // The lanes scroll sideways inside the board, the page itself never does.
      expect(await sidewaysOverflow(page)).toBe(0);
    } finally {
      await request.delete(`/api/boards/${board.id}`);
    }
  });
});
