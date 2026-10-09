/** Captures Chrome/Edge install prompt as early as possible (before React). */

export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type Listener = () => void;

declare global {
  interface Window {
    __acpDeferredInstall?: BeforeInstallPromptEvent | null;
  }
}

let deferred: BeforeInstallPromptEvent | null =
  typeof window !== "undefined" ? (window.__acpDeferredInstall ?? null) : null;
let installed =
  typeof window !== "undefined" &&
  (window.matchMedia("(display-mode: standalone)").matches ||
    ("standalone" in navigator && Boolean((navigator as { standalone?: boolean }).standalone)));

const listeners = new Set<Listener>();

function notify() {
  for (const listener of listeners) listener();
}

function stash(event: BeforeInstallPromptEvent) {
  deferred = event;
  if (typeof window !== "undefined") window.__acpDeferredInstall = event;
  notify();
}

function onBeforeInstallPrompt(e: Event) {
  e.preventDefault();
  stash(e as BeforeInstallPromptEvent);
}

function onAppInstalled() {
  deferred = null;
  installed = true;
  if (typeof window !== "undefined") window.__acpDeferredInstall = null;
  notify();
}

/** Call once from app entry, before React render. */
export function initPwaInstallCapture() {
  if (typeof window === "undefined") return;
  // Re-read anything the head script already captured.
  if (window.__acpDeferredInstall) deferred = window.__acpDeferredInstall;
  window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  window.addEventListener("appinstalled", onAppInstalled);
}

export function subscribePwaInstall(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getDeferredInstallPrompt() {
  return deferred ?? (typeof window !== "undefined" ? (window.__acpDeferredInstall ?? null) : null);
}

export function isPwaInstalled() {
  return installed;
}

/** Must be called from a direct user gesture (button click). */
export async function promptPwaInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const event = getDeferredInstallPrompt();
  if (!event) return "unavailable";
  deferred = null;
  if (typeof window !== "undefined") window.__acpDeferredInstall = null;
  await event.prompt();
  const { outcome } = await event.userChoice;
  if (outcome === "accepted") {
    installed = true;
  }
  notify();
  return outcome;
}
