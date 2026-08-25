/** Completion notifications: Notification API + a short WebAudio beep. */

const PROMPT_DISMISSED_KEY = "acprocess.notificationsPrompt.v1";

let audioCtx: AudioContext | null = null;

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function wasNotificationPromptDismissed(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return localStorage.getItem(PROMPT_DISMISSED_KEY) === "1";
  } catch {
    return true;
  }
}

export function markNotificationPromptDismissed(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(PROMPT_DISMISSED_KEY, "1");
  } catch {
    /* private mode */
  }
}

/** Show the first-visit hint while permission is still default and user has not dismissed it. */
export function shouldShowNotificationPrompt(): boolean {
  if (!notificationsSupported()) return false;
  if (Notification.permission !== "default") return false;
  return !wasNotificationPromptDismissed();
}

/** Ask for notification permission — call from a user gesture (e.g. Enable button). */
export async function requestNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (!notificationsSupported()) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/** Called when an assistant turn finishes while the tab is hidden. */
export function notifyTurnComplete(sessionTitle: string | undefined): void {
  if (typeof window === "undefined") return;
  const title = sessionTitle?.trim() ? sessionTitle.trim() : "ACProcess";
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      const n = new Notification(title, {
        body: "Ответ агента готов",
        tag: "acprocess-turn-complete",
        silent: true,
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {
      // some platforms reject Notification during background throttling
    }
  }
  playBeep();
}

function playBeep(): void {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    if (!audioCtx) audioCtx = new Ctor();
    if (audioCtx.state === "suspended") void audioCtx.resume();
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.setValueAtTime(1174.66, t + 0.12);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.32);
  } catch {
    // audio is a nicety — never break the chat
  }
}
