/** Capture one screenshot: node scripts/capture-one.mjs <name.webp> [locale] [theme] [action] */
import { chromium } from "playwright";
import sharp from "sharp";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [, , name, locale = "en", theme = "dark", action = "chat"] = process.argv;
if (!name) {
  console.error(
    "Usage: node scripts/capture-one.mjs <file.webp> [locale] [theme] [chat|settings|slash|search|split|mobile|remote|settings-agents]",
  );
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs", "screens");
const BASE = "http://localhost:5173";
const API = "http://127.0.0.1:3001";

async function api(pathname, init) {
  const res = await fetch(`${API}${pathname}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) throw new Error(`${pathname} → ${res.status}`);
  return res.json();
}

async function pickSession() {
  const sessions = await api("/api/sessions");
  return sessions.find((s) => s.status === "idle") ?? sessions[0] ?? null;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify({ locale, theme, showBootSplash: false, chatSplit: action === "split" }),
  });

  const mobile = action === "mobile";
  const needsChat =
    action === "chat" || action === "slash" || action === "search" || action === "split" || mobile;
  const session = needsChat ? await pickSession() : null;

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage", "--disable-gpu", "--no-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    await page.addInitScript(
      ({ locale, theme, sessionId }) => {
        localStorage.setItem("acprocess.locale", locale);
        localStorage.setItem("acprocess.theme", theme);
        localStorage.setItem("acprocess.bootSplashDismissed", "1");
        if (sessionId) localStorage.setItem("acprocess.activeSessionId", sessionId);
        sessionStorage.setItem(
          "acprocess.agentAvailability.v1",
          JSON.stringify({ cursor: true, omp: false }),
        );
        document.documentElement.setAttribute("data-theme", theme === "dark" ? "dark" : "light");
      },
      { locale, theme, sessionId: session?.id ?? null },
    );

    const url = action.startsWith("settings") || action === "remote" ? `${BASE}/settings` : `${BASE}/chat`;
    await page.goto(url, { waitUntil: "networkidle", timeout: 90_000 });
    await page.waitForTimeout(1000);

    const gate = page.getByRole("button", { name: /Continue|Продолжить/i });
    if (await gate.isVisible({ timeout: 2000 }).catch(() => false)) {
      await gate.click({ force: true });
      await page.waitForTimeout(500);
    }

    if (needsChat && session?.id) {
      await page.waitForSelector('[data-testid="chat-composer"], textarea, [contenteditable="true"]', {
        timeout: 20_000,
      }).catch(() => {});
      await page.waitForTimeout(600);
    }

    if (action === "slash") {
      const c = page.getByPlaceholder(/Message|Сообщение|команда/i);
      await c.click();
      await c.fill("/");
      await page.waitForTimeout(500);
    } else if (action === "search") {
      await page.getByRole("button", { name: /Search messages|Поиск по сообщениям/i }).click();
      await page.waitForTimeout(500);
    } else if (action === "split") {
      await page.getByRole("button", { name: /Split|Разделить|два чата/i }).click();
      await page.waitForTimeout(700);
    } else if (action === "remote") {
      await page.getByRole("button", { name: /Phone|Телефон|VPN/i }).first().click();
      await page.waitForTimeout(500);
    } else if (action === "settings-agents") {
      await page.getByRole("button", { name: /Agents|Агенты/i }).first().click();
      await page.waitForTimeout(500);
    }

    const tmp = path.join(OUT, name.replace(/\.webp$/i, ".png"));
    const out = path.join(OUT, name);
    await page.screenshot({ path: tmp, type: "png" });
    await sharp(tmp).webp({ quality: 90 }).toFile(out);
    await unlink(tmp).catch(() => {});
    console.log("✓", out);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
