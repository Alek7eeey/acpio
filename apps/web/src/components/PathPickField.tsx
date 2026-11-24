import { useRef, useState } from "react";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { isTouchUi } from "../lib/pointerUi";
import { AttachDialog } from "./AttachDialog";
import { MiddleTruncate } from "./MiddleTruncate";
import { ServerFolderBrowseDialog } from "./ServerFolderBrowseDialog";
import styles from "./PathPickField.module.css";

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

type PickButtonProps = {
  /** A folder (default) or one file. */
  kind?: "folder" | "file";
  /** Where both dialogs start. */
  start?: string;
  /** Button caption; "Выбрать папку…" / "Выбрать файл…" by default. */
  caption?: string;
  className?: string;
  disabled?: boolean;
  /** What the page's own file dialog offers (kind="file"). */
  accept?: string;
  /** The OS file dialog's answer, read in the page (kind="file"). */
  onPickFile?: (file: File) => void;
  /** A path — a folder, or a file on the server's disk. */
  onPick: (path: string) => void;
};

/**
 * The app's one pick control, behind every folder and file field: a click
 * opens the OS dialog, a right click opens the app's own browser.
 *
 * On a phone — and for a page served from another machine — the OS dialog
 * belongs to the server's screen, where nobody is looking, so both gestures
 * open the browser that lives in the page. A machine with no dialog to open
 * (a headless server, a Linux box without zenity) falls back to it as well.
 */
export function PickButton({
  kind = "folder",
  start,
  caption,
  className,
  disabled,
  accept,
  onPickFile,
  onPick,
}: PickButtonProps) {
  const t = useT();
  const isFile = kind === "file";
  const [ownOpen, setOwnOpen] = useState(false);
  // The OS dialog is modal on the server's screen, so a second click while it
  // stands must not spawn a second one.
  const [asking, setAsking] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const label = caption ?? (isFile ? t("common.selectFile") : t("common.selectFolder"));

  const openOwn = () => setOwnOpen(true);

  const openNative = async () => {
    if (isTouchUi() || !onServerMachine()) {
      openOwn();
      return;
    }
    if (isFile) {
      const input = fileInputRef.current;
      if (!input) return;
      // Re-picking the same file must fire onChange again.
      input.value = "";
      input.click();
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
        title={`${label} · ${t("settings.folderPickSwapHint")}`}
        onClick={() => void openNative()}
        onContextMenu={(e) => {
          e.preventDefault();
          openOwn();
        }}
      >
        {label}
      </button>
      {isFile ? (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept={accept}
            hidden
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (file) onPickFile?.(file);
            }}
          />
          <AttachDialog
            open={ownOpen}
            title={label}
            initialDir={start || undefined}
            onClose={() => setOwnOpen(false)}
            onAttach={(files) => {
              const picked = files[0];
              if (picked) onPick(picked.path);
            }}
          />
        </>
      ) : (
        <ServerFolderBrowseDialog
          open={ownOpen}
          initialPath={start || undefined}
          onClose={() => setOwnOpen(false)}
          onSelect={onPick}
        />
      )}
    </>
  );
}

type PathPickFieldProps = {
  /** The chosen path; empty is the default the placeholder names. */
  value: string;
  onPick: (path: string) => void;
  /** Back to the default — the row's own reset. */
  onReset: () => void;
  /** Shown while nothing is chosen — usually what the empty value means. */
  placeholder: string;
  /** Where the dialogs start when the value is empty (the resolved default). */
  fallback?: string;
  pickCaption?: string;
  clearLabel?: string;
  /** The row's own button class (each section styles its secondary buttons). */
  buttonClassName?: string;
  disabled?: boolean;
};

/**
 * A path field of the settings table: the chosen path, the pick button and the
 * way back to the default. Every path row of every settings page renders this
 * one component, so the four of them cannot drift apart again.
 *
 * The path is read-only on purpose. It is a server-side location, and the
 * dialogs are the only way to produce one: a free-text box inside the settings
 * form took an autofilled provider endpoint as its value (Chromium read the
 * nameless input as "some text field" and filled it from what the form had
 * been submitted with), and Enter in it submitted the whole form — a setting
 * was saved by a keystroke nobody meant as one.
 */
export function PathPickField({
  value,
  onPick,
  onReset,
  placeholder,
  fallback,
  pickCaption,
  clearLabel,
  buttonClassName,
  disabled,
}: PathPickFieldProps) {
  const t = useT();
  const button = `${styles.button}${buttonClassName ? ` ${buttonClassName}` : ""}`;
  return (
    <div className={styles.row}>
      <MiddleTruncate
        className={`${styles.field}${value ? "" : ` ${styles.fieldEmpty}`}`}
        text={value || placeholder}
      />
      <PickButton
        className={button}
        start={value.trim() || fallback}
        caption={pickCaption}
        disabled={disabled}
        onPick={onPick}
      />
      {value ? (
        <button type="button" className={button} disabled={disabled} onClick={onReset}>
          {clearLabel ?? t("common.reset")}
        </button>
      ) : null}
    </div>
  );
}
