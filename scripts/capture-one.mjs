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
const BASE = "http://localhost:18751";
const API = "http://127.0.0.1:18741";

async function api(pathname, init) {
  const res = await fetch(`${API}${pathname}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) throw new Error(`${pathname} → ${res.status}`);
  return res.json();
}

function userText(message) {
  const part = message.parts?.find((p) => p.type === "text");
  return (part?.payload?.text ?? "").trim();
}

function analyzeSession(detail) {
  let thought = 0;
  let tool = 0;
  let text = 0;
  let user = 0;
  let focusMessageId = null;
  let searchHint = "";

  for (const message of detail.messages ?? []) {
    if (message.role === "user") {
      user++;
      const t = userText(message);
      if (t && !t.startsWith("/") && t.length > searchHint.length) searchHint = t.slice(0, 40);
    }
    let hasTool = false;
    let hasThought = false;
    for (const part of message.parts ?? []) {
      if (part.type === "thought") hasThought = true;
      if (part.type === "tool_call") hasTool = true;
      if (part.type === "thought") thought++;
      if (part.type === "tool_call") tool++;
      if (part.type === "text" && part.payload?.text) text += part.payload.text.length;
    }
    if (!focusMessageId && hasTool && hasThought) focusMessageId = message.id;
  }

  const title = (detail.title ?? "").trim();
  let bonus = 0;
  if (tool >= 2) bonus += 40;
  if (thought >= 2) bonus += 20;
  if (/test|retest|check|debug/i.test(title)) bonus -= 30;
  if (/^как дела$/i.test(title) || /^new chat$/i.test(title) || /^новый чат$/i.test(title)) bonus -= 25;
  if (title.length > 8 && !/^новый чат$/i.test(title) && !/^new chat$/i.test(title)) bonus += 10;

  const lang = sessionContentLang(detail);
  const total = thought * 15 + tool * 12 + text / 40 + user * 4 + bonus;

  return { thought, tool, text, user, total, lang, focusMessageId, searchHint: searchHint || "folder" };
}

function sessionContentLang(detail) {
  const chunks = [detail.title ?? ""];
  for (const message of detail.messages ?? []) {
    for (const part of message.parts ?? []) {
      if (part.type === "text") chunks.push(String(part.payload?.text ?? ""));
    }
  }
  const blob = chunks.join(" ");
  const letters = blob.replace(/[^A-Za-zА-Яа-яЁё]/g, "");
  if (!letters) return "en";
  const cyr = (blob.match(/[А-Яа-яЁё]/g) ?? []).length;
  return cyr / letters.length >= 0.28 ? "ru" : "en";
}

async function scoreSession(summary) {
  const detail = await api(`/api/sessions/${summary.id}`);
  const stats = analyzeSession(detail);
  return {
    id: summary.id,
    title: summary.title,
    status: summary.status,
    detail,
    ...stats,
  };
}

async function pickRichSessions(locale) {
  const override = process.env.SCREEN_SESSION_ID?.trim();
  if (override) {
    const detail = await api(`/api/sessions/${override}`);
    const stats = analyzeSession(detail);
    return {
      primary: { id: override, focusMessageId: stats.focusMessageId, searchHint: stats.searchHint },
      secondary: null,
    };
  }

  const sessions = await api("/api/sessions");
  const candidates = sessions.filter((s) => s.status !== "closed");
  const scored = [];
  for (const summary of candidates.slice(0, 30)) {
    try {
      const row = await scoreSession(summary);
      if ((row.detail.messages?.length ?? 0) >= 4) scored.push(row);
    } catch {
      /* skip */
    }
  }

  if (!scored.length) {
    for (const summary of sessions.slice(0, 15)) {
      try {
        const row = await scoreSession(summary);
        if ((row.detail.messages?.length ?? 0) >= 4) scored.push(row);
      } catch {
        /* skip */
      }
    }
  }

  const wantedLang = locale === "ru" ? "ru" : "en";
  const matching = scored.filter((s) => s.lang === wantedLang);
  const pool = matching.length ? matching : scored;
  if (!matching.length && scored.length) {
    console.warn(`  no ${wantedLang} conversations with enough messages; falling back`);
  }
  pool.sort((a, b) => b.total - a.total);
  const primary = pool[0];
  const secondary =
    pool.find((s) => s.id !== primary?.id && s.tool >= 2 && s.lang === wantedLang) ??
    pool.find((s) => s.id !== primary?.id && s.lang === wantedLang) ??
    pool.find((s) => s.id !== primary?.id) ??
    null;

  if (!primary) return { primary: null, secondary: null };

  console.log(
    `  session: ${primary.title} [${primary.lang}] (${primary.tool} tools, ${primary.thought} thoughts)`,
  );
  if (secondary) {
    console.log(`  split pane: ${secondary.title}`);
  }

  return {
    primary: {
      id: primary.id,
      focusMessageId: primary.focusMessageId,
      searchHint: primary.searchHint,
    },
    secondary: secondary
      ? {
          id: secondary.id,
          focusMessageId: secondary.focusMessageId,
          searchHint: secondary.searchHint,
        }
      : null,
  };
}

async function scrollToMessage(page, messageId) {
  if (!messageId) return;
  const el = page.locator(`[data-message-id="${messageId}"]`);
  if (await el.count()) {
    await el.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify({
      locale,
      theme,
      showBootSplash: false,
      chatSplit: action === "split",
      chatTreeElements: ["search", "searchMsgs", "pin", "archive", "more"],
      chatToolbarStyle: "classic",
    }),
  });

  const mobile = action === "mobile";
  const needsChat =
    action === "chat" || action === "slash" || action === "search" || action === "split" || mobile;
  const picked = needsChat ? await pickRichSessions(locale) : null;
  const session = picked?.primary ?? null;
  const splitSecond = action === "split" ? picked?.secondary ?? null : null;

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage", "--disable-gpu", "--no-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });

    const panePayload =
      action === "split" && session && splitSecond
        ? JSON.stringify({ ids: [session.id, splitSecond.id], focus: 0 })
        : null;

    await page.addInitScript(
      ({ locale, theme, sessionId, panePayload }) => {
        localStorage.setItem("acpio.locale", locale);
        localStorage.setItem("acpio.theme", theme);
        localStorage.setItem("acpio.bootSplashDismissed", "1");
        localStorage.removeItem("acpio.gitPanelOpen.v1");
        localStorage.removeItem("acpio.consoleOpen.v1");
        if (sessionId) localStorage.setItem("acpio.activeSessionId", sessionId);
        if (panePayload) localStorage.setItem("acpio.chatPanes.v1", panePayload);
        sessionStorage.setItem(
          "acpio.agentAvailability.v1",
          JSON.stringify({ cursor: true, omp: false }),
        );
        document.documentElement.setAttribute("data-theme", theme === "dark" ? "dark" : "light");
      },
      { locale, theme, sessionId: session?.id ?? null, panePayload },
    );

    const url =
      action === "settings"
        ? `${BASE}/settings?section=interface&leaf=chat`
        : action === "settings-agents"
          ? `${BASE}/settings?section=agent&leaf=connect`
          : action === "remote"
            ? `${BASE}/settings?section=agent&leaf=remote`
            : `${BASE}/chat`;
    await page.goto(url, { waitUntil: "networkidle", timeout: 90_000 });
    await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0, {
      timeout: 30_000,
    });
    await page.waitForFunction((loc) => document.documentElement.lang === loc, locale, { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(1000);

    const gate = page.getByRole("button", { name: locale === "ru" ? /^Продолжить$/ : /^Continue$/i });
    if (await gate.isVisible({ timeout: 2000 }).catch(() => false)) {
      await gate.click({ force: true });
      await page.waitForTimeout(500);
    }

    if (needsChat && session?.id) {
      await page
        .waitForSelector('textarea, [contenteditable="true"]', {
          timeout: 20_000,
        })
        .catch(() => {});
      await page.waitForTimeout(600);
      await scrollToMessage(page, session.focusMessageId);
    }

    if (action === "slash") {
      const c = page.getByPlaceholder(/Message or \/command|Сообщение или/i);
      await c.click({ timeout: 15_000 });
      await c.fill("/");
      await page.waitForTimeout(500);
    } else if (action === "search") {
      await page
        .getByRole("button", { name: locale === "ru" ? /^Поиск$/ : /^Search$/ })
        .first()
        .click();
      await page.waitForTimeout(400);
      const q = session?.searchHint?.slice(0, 20) ?? (locale === "ru" ? "папка" : "folder");
      await page.getByRole("dialog").locator("input[type='search']").fill(q);
      await page.waitForTimeout(500);
    } else if (action === "split") {
      if (!splitSecond) {
        await page.getByRole("button", { name: locale === "ru" ? /Разделить|два чата/i : /Split|two chats/i }).click();
        await page.waitForTimeout(700);
      } else {
        await page.waitForTimeout(700);
      }
      if (session?.focusMessageId) await scrollToMessage(page, session.focusMessageId);
    } else if (action === "remote") {
      await page.waitForTimeout(400);
    } else if (action === "settings-agents") {
      await page.waitForTimeout(400);
    } else if (action === "settings") {
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
