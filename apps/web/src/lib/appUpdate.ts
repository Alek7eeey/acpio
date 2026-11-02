import { useCallback, useEffect, useRef, useState } from "react";
import type { AppUpdateStateDto } from "@acpio/shared";
import { api } from "./api";

/**
 * The header's update popup, end to end: ask the server whether npm has a
 * newer Acpio, download it on a click, restart the process onto the new build
 * and come back on the page that build serves.
 *
 * The server owns the registry answer (one cached check for the whole app) and
 * the install; this hook owns what the reader sees — which popup is open and
 * which step of the download is under way.
 */

/** Where "later" is remembered: the popup returns for the next version, not this one. */
export const UPDATE_DISMISSED_KEY = "acpio.update.dismissed";
/** A kept-open tab is how this app is usually run: ask the registry now and then. */
const CHECK_INTERVAL_MS = 30 * 60_000;
/** npm's progress is not streamed; the state it leaves behind is polled. */
const INSTALL_POLL_MS = 2_000;
/** The successor needs a moment to take the port and the database lock. */
const RESTART_FIRST_POLL_MS = 1_500;
const RESTART_POLL_MS = 1_000;
/** After this the popup stops pretending the server is coming back by itself. */
const RESTART_GIVE_UP_MS = 45_000;
/**
 * How long a server that answers with the version it had before counts as "not
 * restarted yet". The successor exits within a third of a second and is up in
 * a second or two; a build still answering after this never handed over — the
 * install went to another copy.
 */
const RESTART_UNCHANGED_MS = 6_000;

/** The error the hook reports when the restarted server never answered. */
export const RESTART_TIMEOUT = "restart-timeout";
/** The error the hook reports when something answered, but as the old build. */
export const RESTART_UNCHANGED = "restart-unchanged";

export type AppUpdatePhase = "idle" | "installing" | "restarting" | "failed";

export interface AppUpdateHandle {
  state: AppUpdateStateDto | null;
  phase: AppUpdatePhase;
  /** Why the install (or the restart) failed — the popup's error line. */
  error: string;
  /** Whether the popup is on screen. An install keeps it there by itself. */
  open: boolean;
  /** A newer version exists: the chip beside the brand belongs in the header. */
  visible: boolean;
  /** Can this build replace itself with the new version at all? */
  selfUpdate: boolean;
  /** The chip: open the popup, or close it when it is already up. */
  toggle: () => void;
  /** "Позже" — this version will not open the popup again. */
  dismiss: () => void;
  /** "Обновить" / "Повторить". */
  start: () => void;
}

function readDismissed(): string {
  try {
    return window.localStorage.getItem(UPDATE_DISMISSED_KEY) ?? "";
  } catch {
    // Private mode: nothing remembered, the popup simply opens next time.
    return "";
  }
}

function rememberDismissed(version: string): void {
  try {
    window.localStorage.setItem(UPDATE_DISMISSED_KEY, version);
  } catch {
    // Ditto.
  }
}

export function useAppUpdate(): AppUpdateHandle {
  const [state, setState] = useState<AppUpdateStateDto | null>(null);
  const [phase, setPhase] = useState<AppUpdatePhase>("idle");
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(readDismissed);
  /** The version the install was made from: the restart is verified by it. */
  const targetRef = useRef<string | null>(null);

  // The check: on mount, then now and then while the tab stays open.
  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const next = await api.appUpdate();
        if (alive) setState(next);
      } catch {
        // An older server, no network, or a page left open across a restart:
        // the header says nothing rather than claiming to know.
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), CHECK_INTERVAL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  // A version worth announcing opens the popup on its own — once. "Позже" is
  // remembered against that version, so a newer one opens it again.
  useEffect(() => {
    if (!state?.available || !state.latest) return;
    if (state.latest === dismissed) return;
    setOpen(true);
  }, [state?.available, state?.latest, dismissed]);

  const start = useCallback(() => {
    setError("");
    setPhase("installing");
    setOpen(true);
    api
      .installAppUpdate()
      .then((next) => {
        setState(next);
        // What the restart is verified by: the version this install was made from.
        targetRef.current = next.latest ?? targetRef.current;
        if (next.status === "error") {
          setPhase("failed");
          setError(next.message ?? "");
        }
      })
      .catch((err: unknown) => {
        setPhase("failed");
        setError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  const dismiss = useCallback(() => {
    setOpen(false);
    if (phase === "idle" && state?.latest) {
      rememberDismissed(state.latest);
      setDismissed(state.latest);
    }
  }, [phase, state?.latest]);

  const toggle = useCallback(() => {
    setOpen((wasOpen) => !wasOpen);
  }, []);

  // npm works in the background; the popup follows the state it leaves behind.
  useEffect(() => {
    if (phase !== "installing") return;
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const next = await api.appUpdate();
        if (!alive) return;
        setState(next);
        if (next.status === "done") {
          targetRef.current = next.latest ?? targetRef.current;
          setPhase("restarting");
          return;
        }
        if (next.status === "error") {
          setPhase("failed");
          setError(next.message ?? "");
          return;
        }
      } catch {
        // The server may already be gone or restarting: a failed poll is not a
        // failed install, so keep asking until one of them answers.
      }
      if (alive) timer = window.setTimeout(() => void tick(), INSTALL_POLL_MS);
    };
    timer = window.setTimeout(() => void tick(), INSTALL_POLL_MS);
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [phase]);

  // The new build is on disk: hand the process over and wait for a server that
  // reports *that* version, then reload onto it. Health alone does not answer
  // the question — the build that was running before answers it just as well,
  // and reloading into it is an update that silently changed nothing.
  useEffect(() => {
    if (phase !== "restarting") return;
    let alive = true;
    let timer: number | undefined;
    const startedAt = Date.now();
    const target = targetRef.current;
    void api.restartApp().catch(() => {
      // 409 (no command line to repeat) or an already-dead server: the poll
      // below is what decides whether anything came back.
    });
    const tick = async () => {
      if (!alive) return;
      const waited = Date.now() - startedAt;
      if (waited > RESTART_GIVE_UP_MS) {
        setPhase("failed");
        setError(RESTART_TIMEOUT);
        return;
      }
      try {
        const answered = await api.health();
        if (!alive) return;
        // A build that cannot be verified (no version known) is taken as it
        // answers, the way this poll worked before the versions were compared.
        if (!target || answered.version === target) {
          window.location.reload();
          return;
        }
        if (waited > RESTART_UNCHANGED_MS) {
          setPhase("failed");
          setError(RESTART_UNCHANGED);
          return;
        }
      } catch {
        // Still down — the successor is starting.
      }
      if (alive) timer = window.setTimeout(() => void tick(), RESTART_POLL_MS);
    };
    timer = window.setTimeout(() => void tick(), RESTART_FIRST_POLL_MS);
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [phase]);

  return {
    state,
    phase,
    error,
    // An install in progress is not something "Позже" may hide.
    open: open || phase === "installing" || phase === "restarting",
    visible: Boolean(state?.available),
    // Unknown until the first poll: a build that cannot be asked yet is not a
    // reason to hide the button that most installs do have.
    selfUpdate: state?.selfUpdate !== false,
    toggle,
    dismiss,
    start,
  };
}
