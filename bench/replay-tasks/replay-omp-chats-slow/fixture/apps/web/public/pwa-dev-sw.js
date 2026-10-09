/* Dev-only SW for Chrome installability without Workbox.
 * VitePWA Workbox stays off in dev (corrupted binary /api, e.g. TTS).
 * Empty fetch handlers are ignored by Chrome — we network-passthrough
 * navigations only and never touch /api or /ws. */
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/ws")) return;

  // Functional fetch handler (required for beforeinstallprompt); network-only.
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request));
  }
});
