/**
 * Desktop end-to-end: the shell at 1440×900, a real turn against a real ACP
 * agent process, and the three pages a self-hosted install lives on — chat,
 * board, settings.
 */
import {
  composer,
  createChat,
  expect,
  openApp,
  openChat,
  sendPrompt,
  sidewaysOverflow,
  storedTranscript,
  test,
} from "../support/app";
import { E2E_AGENT_ECHO, E2E_AGENT_LABEL } from "../support/seed.mjs";

test.describe("desktop shell", () => {
  test("boots the chat view with the tree, the composer and the open chat", async ({
    page,
    chat,
  }) => {
    await openChat(page, chat.id);

    await expect(page).toHaveTitle("Acpio");
    await expect(page.getByRole("button", { name: /^Acpio / })).toBeVisible();
    // The sidebar tree is part of the desktop layout, not something to open.
    await expect(page.getByRole("button", { name: "New chat" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Search", exact: true }).first()).toBeVisible();
    // The active chat is the one the tab was handed.
    await expect(page.locator("header")).toContainText(chat.title);
    expect(await sidewaysOverflow(page)).toBe(0);
  });

  test("a prompt reaches the agent and the answer streams into the transcript", async ({
    page,
    chat,
    request,
  }) => {
    await openChat(page, chat.id);
    const text = "hello from the desktop suite";

    await composer(page).fill(text);
    await composer(page).press("Enter");

    // The user's line is drawn at once, the answer a moment later.
    await expect(
      page.locator("[data-message-id]").filter({ hasText: text }).first(),
    ).toBeVisible();
    await expect(page.getByText(E2E_AGENT_ECHO(text))).toBeVisible({ timeout: 30_000 });
    // The agent's reasoning rides along as a collapsed step, not as an answer.
    await expect(page.getByText("Worked", { exact: true })).toBeVisible();
    // A sent prompt leaves the composer empty.
    await expect(composer(page)).toHaveValue("");

    // The transcript is the server's, not the tab's: both roles are stored.
    await expect.poll(() => storedTranscript(request, chat.id)).toContain(`user:${text}`);
    await expect.poll(() => storedTranscript(request, chat.id)).toContain(
      `assistant:${E2E_AGENT_ECHO(text)}`,
    );
  });

  test("a finished conversation survives a reload", async ({ page, chat }) => {
    await openChat(page, chat.id);
    const text = "stay in the transcript";

    await composer(page).fill(text);
    await composer(page).press("Enter");
    await expect(page.getByText(E2E_AGENT_ECHO(text))).toBeVisible({ timeout: 30_000 });

    await page.reload();

    await expect(page.getByText(E2E_AGENT_ECHO(text))).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("header")).toContainText(chat.title);
    // …and it is the same chat, not a fresh one.
    await expect(page.getByText(text, { exact: true })).toBeVisible();
  });

  test("collapses the tree and opens it again from the header", async ({ page, chat }) => {
    await openChat(page, chat.id);
    const tree = page.getByRole("dialog", { name: "Open sidebar" });

    // The open tree is a panel the app says is open…
    await expect(tree).toBeVisible();
    await page.getByRole("button", { name: "Collapse sidebar", exact: true }).first().click();

    // …and the collapsed one hands the toggle back to the header.
    await expect(tree).toHaveCount(0);
    const reopen = page.getByRole("button", { name: "Open sidebar", exact: true });
    await expect(reopen).toBeVisible();
    await expect(reopen).toHaveAttribute("aria-expanded", "false");

    await reopen.click();

    await expect(tree).toBeVisible();
  });

  test("lists the online harness in the boot gate and hands over to the app", async ({
    page,
    chat,
  }) => {
    // No seeded availability: this is the first tab the app ever sees.
    await openApp(page, { path: "/chat", sessionId: chat.id, skipBootGate: false });

    const gate = page.getByRole("dialog", { name: "Agents on this PC" });
    await expect(gate).toBeVisible();
    await expect(gate.getByText(E2E_AGENT_LABEL)).toBeVisible();
    await expect(gate.getByText("online", { exact: true })).toBeVisible();

    const proceed = gate.getByRole("button", { name: "Continue" });
    await expect(proceed).toBeEnabled({ timeout: 30_000 });
    await proceed.click();

    await expect(gate).toHaveCount(0);
    await expect(composer(page)).toBeEditable();
  });
});

test.describe("desktop settings", () => {
  test("the header opens settings and the theme switch is stored", async ({ page, chat, request }) => {
    await openChat(page, chat.id);

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL(/\/settings/);
    await expect(page.getByRole("button", { name: "Agents", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Dark theme" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    // The choice belongs to the install, not to this tab.
    await expect
      .poll(async () => (await (await request.get("/api/settings")).json()).theme)
      .toBe("dark");
  });

  test("the language switch translates the interface and is stored", async ({ page, chat, request }) => {
    await openChat(page, chat.id);

    await page.getByRole("button", { name: "Language", exact: true }).click();
    await page.getByText("Русский", { exact: true }).click();

    await expect(page.locator("html")).toHaveAttribute("lang", "ru");
    await expect(page.getByRole("button", { name: "Новый чат" }).first()).toBeVisible();
    await expect
      .poll(async () => (await (await request.get("/api/settings")).json()).locale)
      .toBe("ru");
  });
});

test.describe("desktop workspace", () => {
  test("the search dialog finds a chat by its title", async ({ page, chat }) => {
    // The dialog's own icons have to parse: a malformed path is a console error
    // and a blank glyph — the browser keeps the shape it could read until the
    // bad number, so nothing on screen would say the icon is broken.
    const brokenIcons: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" && message.text().includes("attribute d")) {
        brokenIcons.push(message.text());
      }
    });

    await openChat(page, chat.id);

    await page.getByRole("button", { name: "Search", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Search" });
    await expect(dialog).toBeVisible();

    // A word of this test's own chat only: nothing else in the database can match.
    const needle = chat.title.split(" ").slice(-2).join(" ");
    await dialog.getByPlaceholder(/Find by title/).fill(needle);

    await expect(dialog.getByText(chat.title).first()).toBeVisible();
    expect(brokenIcons).toEqual([]);
  });

  test("a board draws its four lanes", async ({ page, request }) => {
    const created = await request.post("/api/boards", {
      data: { name: "e2e board", folders: [] },
    });
    expect(created.status(), await created.text()).toBe(200);
    const board = await created.json();

    await openApp(page, { path: `/board/${board.id}` });

    await expect(page.locator("header")).toContainText("e2e board");
    for (const lane of ["Todo", "In Progress", "Wait", "Done"]) {
      await expect(page.getByText(lane, { exact: true })).toBeVisible();
    }
    // A board without folders says so instead of showing empty lanes as errors.
    await expect(page.getByText("No folders yet — add a project to start")).toBeVisible();
    expect(await sidewaysOverflow(page)).toBe(0);

    await request.delete(`/api/boards/${board.id}`);
  });

  test("a second chat's transcript is what the tree hands over", async ({ page, chat, request }) => {
    // A conversation the tab has never drawn: seeded through the same API.
    const other = await createChat(request, "e2e seeded neighbour");
    try {
      await sendPrompt(request, other.id, "seeded elsewhere");
      await openChat(page, chat.id);

      await page.getByRole("button", { name: "Search", exact: true }).first().click();
      const dialog = page.getByRole("dialog", { name: "Search" });
      await dialog.getByPlaceholder(/Find by title/).fill("e2e seeded neighbour");
      await dialog.getByText("e2e seeded neighbour").first().click();

      await expect(page.getByText(E2E_AGENT_ECHO("seeded elsewhere"))).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.locator("header")).toContainText("e2e seeded neighbour");
    } finally {
      await request.delete(`/api/sessions/${other.id}`);
    }
  });
});
