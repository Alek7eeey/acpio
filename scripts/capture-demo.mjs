/**
 * Records the short tour that sits under the README header.
 *
 *   node scripts/demo-data.mjs --locale en      (once: it leaves the server up)
 *   node scripts/capture-demo.mjs --locale en
 *
 * The clip is a GIF, not a video: GitHub plays an image in a README and
 * nothing else. Frames are taken of the page as the tour drives it — a handful
 * of stills would look like a slideshow, so the scroll and the transitions are
 * stepped through the page itself.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";
import gifenc from "gifenc";

const { GIFEncoder, quantize, applyPalette } = gifenc;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const LOCALE = arg("locale", "en");
const PORT = Number(arg("port", "18772"));
const BASE = (process.env.SCREEN_BASE_URL ?? `http://127.0.0.1:${PORT}`).trim().replace(/\/$/, "");
const OUT = path.join(ROOT, "docs", "screens", `demo-${LOCALE}.gif`);
/** The width the README shows; the page itself is shot at 1440 for sharpness. */
const FRAME_WIDTH = Number(arg("width", "900"));
/** The page is shot at the width the board needs, so its Done lane is in the clip. */
const PAGE_WIDTH = 1720;
const PAGE_HEIGHT = 1075;
const FRAME_HEIGHT = Math.round((FRAME_WIDTH * PAGE_HEIGHT) / PAGE_WIDTH);
const DELAY_MS = 110;

async function api(pathname) {
  const res = await fetch(`${BASE}${pathname}`, { headers: { "Content-Type": "application/json" } });
  if (!res.ok) throw new Error(`${pathname} → ${res.status}`);
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The chat with the most turns is the one worth touring. */
async function pickChat() {
  const sessions = await api("/api/sessions");
  let best = null;
  for (const session of sessions) {
    const detail = await api(`/api/sessions/${session.id}`);
    const count = detail.messages?.length ?? 0;
    if (!best || count > best.count) best = { id: session.id, title: detail.title, count };
  }
  if (!best) throw new Error("the demo database has no chats — run demo-data.mjs first");
  return best;
}

async function main() {
  const chat = await pickChat();
  const boards = await api("/api/boards");
  if (!boards.length) throw new Error("the demo database has no board — run demo-data.mjs first");
  const board = boards[0];
  console.log(`  chat: ${chat.title} (${chat.count} messages)`);
  console.log(`  board: ${board.name}`);

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage", "--disable-gpu", "--no-sandbox"],
  });

  const frames = [];
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: PAGE_WIDTH, height: PAGE_HEIGHT });
    await page.addInitScript(
      ({ locale, sessionId }) => {
        localStorage.setItem("acpio.locale", locale);
        localStorage.setItem("acpio.theme", "dark");
        localStorage.setItem("acpio.bootSplashDismissed", "1");
        localStorage.setItem("acpio.notificationsPrompt.v1", "1");
        localStorage.setItem("acpio.activeSessionId", sessionId);
        localStorage.removeItem("acpio.gitPanelOpen.v1");
        localStorage.removeItem("acpio.consoleOpen.v1");
        sessionStorage.setItem("acpio.agentAvailability.v1", JSON.stringify({ cursor: true, omp: false }));
        document.documentElement.setAttribute("data-theme", "dark");
      },
      { locale: LOCALE, sessionId: chat.id },
    );
    // Same reason as the stills: this build is behind npm, and the popup would
    // land in the middle of the clip.
    await page.route("**/api/app/update", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "idle", available: false }) }),
    );

    await page.goto(`${BASE}/chat`, { waitUntil: "networkidle", timeout: 90_000 });
    await page.waitForFunction((loc) => document.documentElement.lang === loc, LOCALE, { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(1200);

    // The first visit opens the "agents on this PC" gate; it is in every shot
    // otherwise, and it blocks the clicks the tour makes.
    const gate = page.getByRole("button", { name: LOCALE === "ru" ? /^Продолжить$/ : /^Continue$/i });
    if (await gate.isVisible({ timeout: 2000 }).catch(() => false)) {
      await gate.click({ force: true });
      await page.waitForTimeout(500);
    }

    let last = null;
    const grab = async () => {
      const png = await page.screenshot({ type: "png" });
      // A still frame repeated is one frame with a longer delay: the GIF stays
      // small, and the tour keeps the beat it was recorded with.
      if (last && png.equals(last)) {
        frames[frames.length - 1].hold += 1;
        return;
      }
      last = png;
      frames.push({ png, hold: 1 });
    };
    const hold = async (count) => {
      for (let i = 0; i < count; i++) {
        await grab();
        await sleep(DELAY_MS);
      }
    };

    await hold(6);

    // A turn opens: the reasoning and the tool call a collapsed "Worked" hides.
    // This chat is shorter than the screen, so scrolling it would move nothing.
    const worked = page.getByRole("button", { name: LOCALE === "ru" ? /^Работал/ : /^Worked/ }).first();
    if (await worked.count()) {
      await worked.click();
      await sleep(350);
      await hold(10);
    }

    // Typing is the clip's motion: this chat fits the screen, so there is
    // nothing to scroll, and a still frame per step would read as a slideshow.
    const composer = page.getByPlaceholder(/Message or \/command|Сообщение или/i);
    await composer.click();
    await hold(2);
    for (const ch of LOCALE === "ru" ? "почему так медленно?" : "why is the run so slow?") {
      await page.keyboard.type(ch);
      await sleep(60);
      await grab();
    }
    await hold(3);
    // A left-over draft reopens the composer's menu on the next load.
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await hold(2);

    // The board the tasks of this workspace live on.
    await page.locator(`[data-board-id="${board.id}"]`).first().click();
    await page.waitForTimeout(600);
    await hold(6);
    await page.mouse.move(1200, 320);
    await sleep(250);
    await hold(6);

    // Back to the chat the clip started from.
    await page.locator(`[data-session-id="${chat.id}"]`).first().click();
    await page.waitForTimeout(500);
    await hold(6);
  } finally {
    await browser.close();
  }

  console.log(`  frames: ${frames.length} (holds ${frames.map((f) => f.hold).join(",")})`);
  if (process.argv.includes("--debug")) {
    const dump = path.join(ROOT, "tmp", `demo-${LOCALE}`);
    frames.forEach((frame, i) => fs.writeFileSync(path.join(dump, `frame-${String(i).padStart(2, "0")}.png`), frame.png));
    console.log(`  frames dumped into ${dump}`);
  }
  const encoder = GIFEncoder();
  for (const frame of frames) {
    const { data } = await sharp(frame.png)
      .resize(FRAME_WIDTH, FRAME_HEIGHT, { fit: "cover" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const palette = quantize(data, 256, { format: "rgba4444" });
    const index = applyPalette(data, palette, "rgba4444");
    encoder.writeFrame(index, FRAME_WIDTH, FRAME_HEIGHT, {
      palette,
      delay: Math.round(DELAY_MS * frame.hold),
      repeat: 0,
    });
  }
  encoder.finish();
  fs.writeFileSync(OUT, encoder.bytes());
  console.log(`✓ ${OUT} (${(fs.statSync(OUT).size / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
