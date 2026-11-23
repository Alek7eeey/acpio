import {
  buildClientDiagnosticsPayload,
  rememberDiagnosticsError,
  submitDiagnosticsDump,
} from "./diagnostics";

/** What the browser is actually running. A bundle name pins the build that
 *  broke, which a report without it leaves open — a crash fixed two commits ago
 *  and one still in the tree read exactly the same otherwise. */
function bundleName(): string {
  if (typeof document === "undefined") return "";
  const scripts = Array.from(document.scripts)
    .map((s) => s.getAttribute("src") ?? "")
    .filter((src) => src.includes("/assets/"));
  return scripts.join(" ");
}

/** A thrown value as the three lines a report needs. */
export function crashDetails(error: unknown, componentStack?: string | null) {
  const err = error instanceof Error ? error : new Error(String(error));
  return {
    message: err.message || String(error),
    stack: (err.stack ?? "").slice(0, 8000),
    componentStack: (componentStack ?? "").slice(0, 4000),
  };
}

/**
 * The report the reader copies or saves when the interface dies.
 *
 * A blank screen used to be all a crash left behind: the message went to the
 * console, the console went away with the reload, and the next chat started
 * from "it breaks when I type". So the text carries everything that decided the
 * shape of the failure — the error and its component stack, the build, the
 * viewport, and the app state the render was reading from (settings included,
 * keys redacted as "[set]").
 */
export function buildCrashReport(error: unknown, componentStack?: string | null): string {
  const crash = crashDetails(error, componentStack);
  const payload = buildClientDiagnosticsPayload({
    note: `crash: ${crash.message}`.slice(0, 500),
    crash,
  });
  const viewport = payload.viewport;
  return [
    "Acpio interface crash",
    `at: ${payload.at}`,
    `url: ${payload.href}`,
    `bundle: ${bundleName()}`,
    `viewport: ${viewport ? `${viewport.width}x${viewport.height} @${viewport.dpr}` : ""}`,
    `ua: ${payload.userAgent}`,
    "",
    `message: ${crash.message}`,
    "",
    "stack:",
    crash.stack,
    "",
    "component stack:",
    crash.componentStack || "(none)",
    "",
    "--- app state (JSON) ---",
    JSON.stringify(payload, null, 2),
    "",
  ].join("\n");
}

/**
 * Write the crash into the diagnostics folder without asking.
 *
 * The reader may copy nothing at all — most do, and then reload — so the file
 * has to be on disk by the time the card is readable. The folder is the one
 * Settings → Diagnostics already writes to, and the same one a support dump
 * lands in.
 */
let lastAutoAt = 0;
let lastAutoMessage = "";

export function reportCrash(
  error: unknown,
  componentStack?: string | null,
  opts?: { manual?: boolean },
) {
  const crash = crashDetails(error, componentStack);
  rememberDiagnosticsError(crash.message, "render");
  // One crash can throw twice — two places rendering the same broken field, a
  // retry — and the folder does not need the same stack twice. The button a
  // reader presses is theirs and always writes.
  if (!opts?.manual) {
    const now = Date.now();
    if (crash.message === lastAutoMessage && now - lastAutoAt < 30_000) {
      return Promise.resolve(null);
    }
    lastAutoAt = now;
    lastAutoMessage = crash.message;
  }
  return submitDiagnosticsDump({
    reason: "error",
    note: `crash: ${crash.message}`.slice(0, 2000),
    crash,
  });
}
