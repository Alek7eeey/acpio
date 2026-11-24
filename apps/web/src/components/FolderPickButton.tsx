import { useState } from "react";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { isTouchUi } from "../lib/pointerUi";
import { ServerFolderBrowseDialog } from "./ServerFolderBrowseDialog";

/** Hosts that mean "this page runs on the machine the server does". */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Whether the OS dialog would appear on the reader's own screen. The native
 * picker is opened by the server process, so it is only the reader's screen
 * when the page itself came from that machine.
 */
function onServerMachine(): boolean {
  if (typeof window === "undefined") return false;
  return LOCAL_HOSTS.has(window.location.hostname.toLowerCase());
}

type FolderPickButtonProps = {
  /** The field's value: both dialogs start where it points. */
  value?: string;
  /** Where they start instead when the field is empty (the resolved default). */
  fallback?: string;
  /** Button caption; the section's own "Выбрать папку…" by default. */
  label?: string;
  className?: string;
  disabled?: boolean;
  onPick: (path: string) => void;
};

/**
 * One folder field's picker, in the two variants the app offers everywhere:
 * a click opens the OS dialog and a right click opens the app's own browser.
 *
 * On a phone — and for a page served from another machine — the OS dialog
 * belongs to the server's screen, where nobody is looking, so both gestures
 * open the browser that lives in the page. A machine with no dialog to open
 * (a headless server, a Linux box without zenity) falls back to it as well.
 */
export function FolderPickButton({
  value,
  fallback,
  label,
  className,
  disabled,
  onPick,
}: FolderPickButtonProps) {
  const t = useT();
  const [browseOpen, setBrowseOpen] = useState(false);
  // The OS dialog is modal on the server's screen, so a second click while it
  // stands must not spawn a second one.
  const [asking, setAsking] = useState(false);
  const caption = label ?? t("common.selectFolder");
  const start = (value ?? "").trim() || (fallback ?? "").trim();

  const openOwn = () => setBrowseOpen(true);

  const openNative = async () => {
    if (isTouchUi() || !onServerMachine()) {
      openOwn();
      return;
    }
    setAsking(true);
    try {
      const res = await api.pickDirectory(start || undefined);
      // Cancelled is still a dialog: the reader closed it and wants the field
      // left alone, not our browser opening on top of that answer.
      if (res.path) onPick(res.path);
    } catch {
      openOwn();
    } finally {
      setAsking(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={className}
        disabled={disabled || asking}
        title={`${caption} · ${t("settings.folderPickSwapHint")}`}
        onClick={() => void openNative()}
        onContextMenu={(e) => {
          e.preventDefault();
          openOwn();
        }}
      >
        {caption}
      </button>
      <ServerFolderBrowseDialog
        open={browseOpen}
        initialPath={start || undefined}
        onClose={() => setBrowseOpen(false)}
        onSelect={(path) => onPick(path)}
      />
    </>
  );
}
