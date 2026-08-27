import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: false,
      includeAssets: ["icon-180.png", "icon-192.png", "icon-512.png"],
      manifest: {
        name: "Acpio",
        short_name: "Acpio",
        description: "Self-hosted harness for ACP agents",
        theme_color: "#0866ff",
        background_color: "#f7f8fa",
        display: "standalone",
        orientation: "any",
        start_url: "/",
        scope: "/",
        lang: "ru",
        icons: [
          {
            src: "icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        // Server serves SPA routes; avoid precached shell that survives deploys.
        navigateFallback: null,
        globPatterns: ["**/*.{ico,png,svg,woff2}"],
        runtimeCaching: [
          {
            urlPattern: ({ sameOrigin, url }) =>
              sameOrigin &&
              !url.pathname.startsWith("/api") &&
              !url.pathname.startsWith("/ws"),
            handler: "NetworkOnly",
          },
        ],
      },
      // Full Workbox SW stays off in dev — its fetch path intermittently corrupted
      // binary /api (TTS). Installability in `npm run dev` uses public/pwa-dev-sw.js
      // (registered from main.tsx). Production still gets a proper SW that never
      // touches /api (navigateFallbackDenylist).
      devOptions: {
        enabled: false,
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@acpio/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts"),
      "@acpio/i18n": path.resolve(__dirname, "../../packages/i18n/src/index.ts"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    // Dev module responses carry an etag + "no-cache" (revalidate), and a bad
    // 304 path makes browsers keep STALE module bodies for unchanged URLs —
    // freshly added keys/strings never show up until the cache is cleared.
    // no-store forces a full fetch every time in dev.
    headers: {
      "Cache-Control": "no-store",
    },
    // TEMPORARY: allow Cloudflare quick tunnels (*.trycloudflare.com) and other Host headers.
    allowedHosts: true,
    proxy: {
      "/api": "http://127.0.0.1:3001",
      "/ws": {
        target: "ws://127.0.0.1:3001",
        ws: true,
      },
    },
  },
  preview: {
    host: "0.0.0.0",
    allowedHosts: true,
    headers: {
      "Cache-Control": "no-store",
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("audioDevice")) return "audio-device";
        },
      },
    },
  },
});
