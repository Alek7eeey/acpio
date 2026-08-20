import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { initPwaInstallCapture } from "./lib/pwaInstall";
import "./styles/global.css";

initPwaInstallCapture();

if (import.meta.env.DEV) {
  // Full Workbox SW is off in vite PWA devOptions (corrupts binary /api).
  // Register a tiny SW + static public/manifest.webmanifest for installability.
  void navigator.serviceWorker
    .register("/pwa-dev-sw.js", { scope: "/", updateViaCache: "none" })
    .then((reg) => reg.update())
    .catch(() => {});
} else {
  registerSW({ immediate: true });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
