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
import styles from "./ModeMenu.module.css";

/** The popup's width, and how much of it a narrow screen may take. */
const MENU_WIDTH = 148;
const VIEWPORT_GAP = 8;
/** The strip under the menu that joins it to its anchor — see the styles. */
const BRIDGE_PX = 8;

/**
 * The mode a prompt goes out in: the field's own four rows, in a popup small
 * enough to sit beside the control that offers them. Two doors reach it — a
 * rest on the paperclip in the board's form ({@link ModeHoverMenu}) and a press
 * on the composer's mode chip in a chat — and both hang from the element the
 * reader touched.
 *
 * `anchor` is that element, and `null` closes the menu: the chip that opens it
 * is the one that was pressed, which matters in the "…" row where the same chip
 * is mounted twice.
 */
export function ModeMenu({
  anchor,
  mode,
  onPick,
  onClose,
  menuRef,
}: {
  /** The element the popup hangs from; `null` while it is closed. */
  anchor: HTMLElement | null;
  /** The mode in force; the popup marks its row. */
  mode: ComposerMode;
  onPick: (mode: ComposerMode) => void;
  onClose: () => void;
  /** The hover door watches the popup's own pointer events (ModeHoverMenu). */
  menuRef?: RefObject<HTMLDivElement | null>;
}) {
  const t = useT();
  const ownRef = useRef<HTMLDivElement>(null);
  const ref = menuRef ?? ownRef;
  const [pos, setPos] = useState<{ anchor: HTMLElement; left: number; top: number } | null>(
    null,
  );

  // A popup left open by a pointer that never came back would stand over the
  // form forever: Escape, a press anywhere else, or a scroll drops it.
  useEffect(() => {
    if (!anchor) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[role="menu"]')) return;
      if (target instanceof Node && anchor.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    // Captured: the chip's own row scrolls under a phone's finger, and the
    // popup would stay behind where its anchor used to be.
    window.addEventListener("scroll", onClose, { capture: true, passive: true });
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, { capture: true });
    };
  }, [anchor, onClose]);

  // A closed popup forgets where it stood: the chip it hangs from may have
  // moved (a scrolled row) by the time it opens again.
  useEffect(() => {
    if (!anchor) setPos(null);
  }, [anchor]);

  // Measured, then placed: the popup never leaves the window, however close to
  // an edge its anchor stands — over it where there is room, under it
  // otherwise, and the same for the left and right edges.
  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const menu = ref.current;
      if (!menu) return;
      const box = anchor.getBoundingClientRect();
      const width = menu.offsetWidth || MENU_WIDTH;
      const height = menu.offsetHeight - BRIDGE_PX;
      const left = Math.max(
        VIEWPORT_GAP,
        Math.min(box.left, window.innerWidth - width - VIEWPORT_GAP),
      );
      const above = box.top - height - 2;
      const top =
        above >= VIEWPORT_GAP
          ? above
          : Math.min(window.innerHeight - height - VIEWPORT_GAP, box.bottom + 6);
      setPos({ anchor, left, top });
    };
    place();
    window.addEventListener("resize", place);
    window.visualViewport?.addEventListener("resize", place);
    return () => {
      window.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("resize", place);
    };
  }, [anchor, ref]);

  if (!anchor) return null;
  // The place is the anchor's own: a measurement taken for the chip the reader
  // pressed is never reused for another one.
  const placed = pos?.anchor === anchor ? pos : null;
  return createPortal(
    <div
      ref={ref}
      className={styles.wrap}
      style={{
        left: placed?.left ?? 0,
        top: placed?.top ?? 0,
        width: Math.min(MENU_WIDTH, window.innerWidth - VIEWPORT_GAP * 2),
        visibility: placed ? "visible" : "hidden",
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
              onClose();
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

const OPEN_DELAY_MS = 350;
const CLOSE_DELAY_MS = 260;

/**
 * The same menu, offered by the paperclip: a rest of 350 ms opens it, and a
 * leave gives the pointer 260 ms to cross onto the popup. Both clicks of the
 * button keep whatever they did before — this only watches.
 */
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
  const [open, setOpen] = useState(false);
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
  const close = useCallback(() => show(false), [show]);
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

  return (
    <ModeMenu
      anchor={open ? anchorRef.current : null}
      mode={mode}
      onPick={onPick}
      onClose={close}
      menuRef={menuRef}
    />
  );
}
