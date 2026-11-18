import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  COMPOSER_MODES,
  COMPOSER_MODE_LABEL_KEY,
  type ComposerMode,
} from "../lib/composerMode";
import { useT } from "../lib/i18n";
import styles from "./ModeHoverMenu.module.css";

/**
 * The mode a prompt goes out in, offered by the paperclip the way the field's
 * right click offers it — the same four rows, one press away from the button a
 * hand already rests on.
 *
 * A hover alone is not enough to open a menu: the reader's pointer travels over
 * the paperclip on its way to the field, so the popup waits for a rest, and it
 * outlives a leave long enough for the pointer to cross onto it — the strip
 * below the popup is part of its own box, so the crossing never passes over
 * dead space. Both clicks of the button keep whatever they did before: this
 * only watches.
 */
const OPEN_DELAY_MS = 350;
const CLOSE_DELAY_MS = 260;
/** The popup's width, and how much of it a narrow screen may take. */
const MENU_WIDTH = 148;
const VIEWPORT_GAP = 8;
/** The strip under the menu that joins it to its button — see the styles. */
const BRIDGE_PX = 8;

export function ModeHoverMenu({
  anchorRef,
  mode,
  onPick,
  disabled = false,
}: {
  /** The button the popup hangs from. */
  anchorRef: RefObject<HTMLElement | null>;
  /** The mode in force; the popup marks its row. */
  mode: ComposerMode;
  onPick: (mode: ComposerMode) => void;
  /** The button does nothing right now (a locked composer): nothing to offer. */
  disabled?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** The pointer is on the button or on the popup: neither closes the other. */
  const hoveringRef = useRef(false);
  /** The same as `open`, read from listeners that were bound before it changed. */
  const openRef = useRef(false);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  const show = useCallback((value: boolean) => {
    openRef.current = value;
    setOpen(value);
  }, []);
  const clearTimer = useCallback((timer: RefObject<number | null>) => {
    if (timer.current != null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const enter = useCallback((event?: Event) => {
    // A finger is not a hover: a tap would enter the button and leave it a
    // moment later, and a long press would flash a menu under the finger that
    // is already opening the file picker. Touch keeps its own ways in — the
    // field's long press opens the same four rows.
    if ((event as PointerEvent | undefined)?.pointerType === "touch") return;
    hoveringRef.current = true;
    clearTimer(closeTimer);
    clearTimer(openTimer);
    if (openRef.current || disabled) return;
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null;
      if (hoveringRef.current) show(true);
    }, OPEN_DELAY_MS);
  }, [clearTimer, disabled, show]);

  const leave = useCallback(() => {
    hoveringRef.current = false;
    clearTimer(openTimer);
    if (!openRef.current) return;
    clearTimer(closeTimer);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      // A pointer that reached the popup in the meantime keeps it standing.
      if (!hoveringRef.current) show(false);
    }, CLOSE_DELAY_MS);
  }, [clearTimer, show]);

  useEffect(() => {
    const el = anchorRef.current;
    if (!el || disabled) return;
    el.addEventListener("pointerenter", enter as EventListener);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointerleave", leave);
      clearTimer(openTimer);
      clearTimer(closeTimer);
    };
  }, [anchorRef, clearTimer, disabled, enter, leave]);

  // The popup's own listeners are attached to the portaled node: a popup that
  // hangs outside React's root hears its pointer events through the DOM.
  useEffect(() => {
    const el = menuRef.current;
    if (!open || !el) return;
    el.addEventListener("pointerenter", enter as EventListener);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointerenter", enter as EventListener);
      el.removeEventListener("pointerleave", leave);
    };
  }, [enter, leave, open]);

  // A popup left open by a pointer that never came back would stand over the
  // form forever: Escape, a press anywhere else, or a scroll drops it.
  useEffect(() => {
    if (!open) return;
    const close = () => show(false);
    const onDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[role="menu"]')) return;
      if (anchorRef.current?.contains(target as Node)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, { passive: true });
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close);
    };
  }, [anchorRef, open, show]);

  // Measured, then placed: the popup never leaves the window, however close to
  // an edge its button stands — over the button where there is room, under it
  // otherwise, and the same for the left and right edges.
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current?.getBoundingClientRect();
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const width = menu.offsetWidth || MENU_WIDTH;
    const height = menu.offsetHeight - BRIDGE_PX;
    const left = Math.max(
      VIEWPORT_GAP,
      Math.min(anchor.left, window.innerWidth - width - VIEWPORT_GAP),
    );
    const above = anchor.top - height - 2;
    const top =
      above >= VIEWPORT_GAP
        ? above
        : Math.min(window.innerHeight - height - VIEWPORT_GAP, anchor.bottom + 6);
    setPos({ left, top });
  }, [anchorRef, open]);

  if (!open) return null;
  return createPortal(
    <div
      ref={menuRef}
      className={styles.wrap}
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        width: Math.min(MENU_WIDTH, window.innerWidth - VIEWPORT_GAP * 2),
        visibility: pos ? "visible" : "hidden",
      }}
    >
      <div className={styles.menu} role="menu" aria-label={t("chat.modeSection")}>
        {COMPOSER_MODES.map((option) => (
          <button
            key={option}
            type="button"
            role="menuitem"
            aria-current={option === mode ? "true" : undefined}
            className={styles.row}
            onClick={() => {
              onPick(option);
              show(false);
            }}
          >
            <span className={styles.dot} data-composer-mode={option} aria-hidden />
            <span className={styles.label}>{t(COMPOSER_MODE_LABEL_KEY[option])}</span>
            {option === mode ? (
              <span className={styles.check} aria-hidden>
                ✓
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
