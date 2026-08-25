/** Lightweight in-app toast queue — call `showToast` from anywhere, render via `<ToastHost />`. */

export type ToastTone = "info" | "success" | "danger";

export type ToastItem = {
  id: string;
  message: string;
  tone: ToastTone;
  /** Auto-dismiss after ms; 0 = sticky until dismissed. */
  durationMs: number;
  createdAt: number;
};

export type ShowToastOptions = {
  tone?: ToastTone;
  durationMs?: number;
  /** Replace an existing toast with the same id (e.g. rapid copy spam). */
  id?: string;
};

const EVENT = "acpio:toast";
const MAX_VISIBLE = 4;
const DEFAULT_DURATION_MS = 2800;

type ToastListener = (items: ToastItem[]) => void;

let items: ToastItem[] = [];
const listeners = new Set<ToastListener>();
const timers = new Map<string, number>();

function emit() {
  const snapshot = items.slice();
  for (const listener of listeners) listener(snapshot);
}

function clearTimer(id: string) {
  const handle = timers.get(id);
  if (handle != null) {
    window.clearTimeout(handle);
    timers.delete(id);
  }
}

function scheduleDismiss(id: string, durationMs: number) {
  clearTimer(id);
  if (durationMs <= 0) return;
  timers.set(
    id,
    window.setTimeout(() => {
      dismissToast(id);
    }, durationMs),
  );
}

function uid(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Push a toast. Safe to call outside React. */
export function showToast(message: string, options: ShowToastOptions = {}): string {
  const text = message.trim();
  if (!text) return "";
  const tone = options.tone ?? "info";
  const durationMs = options.durationMs ?? DEFAULT_DURATION_MS;
  const id = options.id ?? uid();

  const next: ToastItem = {
    id,
    message: text,
    tone,
    durationMs,
    createdAt: Date.now(),
  };

  const without = items.filter((t) => t.id !== id);
  items = [...without, next].slice(-MAX_VISIBLE);
  scheduleDismiss(id, durationMs);
  emit();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
  }
  return id;
}

export function dismissToast(id: string): void {
  clearTimer(id);
  const before = items.length;
  items = items.filter((t) => t.id !== id);
  if (items.length !== before) emit();
}

export function clearToasts(): void {
  for (const id of [...timers.keys()]) clearTimer(id);
  if (!items.length) return;
  items = [];
  emit();
}

export function getToasts(): ToastItem[] {
  return items.slice();
}

export function subscribeToasts(listener: ToastListener): () => void {
  listeners.add(listener);
  listener(items.slice());
  return () => {
    listeners.delete(listener);
  };
}
