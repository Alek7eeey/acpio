import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { initPwaInstallCapture } from "./lib/pwaInstall";
import { rememberDiagnosticsError, submitAutoErrorDump } from "./lib/diagnostics";
import "./styles/global.css";
import "./styles/settingsUi.css";

initPwaInstallCapture();

// Crashes outside a render — an event handler, an unawaited promise — do not
// reach the boundary, and on a phone their console is not open. They still
// leave a line in the report a later dump carries.
function noteUncaught(message: string, source: string) {
  rememberDiagnosticsError(message, source);
  void submitAutoErrorDump(message);
}

window.addEventListener("error", (event) => {
  const err = event.error instanceof Error ? event.error : null;
  noteUncaught(err?.message ?? event.message ?? "unknown error", "window");
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  noteUncaught(reason instanceof Error ? reason.message : String(reason), "promise");
});

if (!import.meta.env.DEV && "caches" in window) {
  // Drop legacy Workbox precache entries from older builds.
  void caches.keys().then((keys) =>
    Promise.all(keys.filter((key) => key.startsWith("workbox-")).map((key) => caches.delete(key))),
  );
}

// Service workers require HTTPS or localhost — over LAN HTTP (e.g. 192.168.x.x)
// navigator.serviceWorker is undefined and must not be touched.
if ("serviceWorker" in navigator) {
  if (import.meta.env.DEV) {
    // Full Workbox SW is off in vite PWA devOptions (corrupts binary /api).
    // Register a tiny SW + static public/manifest.webmanifest for installability.
    void navigator.serviceWorker
      .register("/pwa-dev-sw.js", { scope: "/", updateViaCache: "none" })
      .then((reg) => reg.update())
      .catch(() => {});
  } else {
    registerSW({
      immediate: true,
      onNeedRefresh() {
        window.location.reload();
      },
    });
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </AppErrorBoundary>
  </StrictMode>,
);
