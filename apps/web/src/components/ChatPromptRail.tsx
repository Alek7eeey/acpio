import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../lib/i18n";
import { useFixedMenuPlacement, type MenuAnchor } from "../lib/menuPosition";
import { useIsTouchUi } from "../lib/pointerUi";
import {
  RAIL_PILL_BASE_PX,
  railPillWidth,
  railWindow,
  type PromptRailItem,
} from "../lib/promptRail";
import styles from "./ChatPromptRail.module.css";

/** Keeps the column off the thread's top and bottom edges. */
const TRACK_PAD_PX = 10;
/** Distance between a pill and its tooltip. */
const TIP_GAP_PX = 10;
/** Clipped prompts the dots' list spells out — the nearest ones to the column.
 *  A chat can clip hundreds, and a flyout of hundreds is a second chat. */
const CUT_LIST_MAX = 12;
/** Time a flyout survives the pointer leaving it — long enough to cross the gap
 *  between the dots and the list without it folding up under the cursor. */
const FLYOUT_CLOSE_MS = 160;

type ChatPromptRailProps = {
  items: PromptRailItem[];
  /** Top of the thread inside the chat column, in px. */
  top: number;
  /** Height of the thread's viewport, in px — the column never reaches the composer. */
  height: number;
  /** Prompt whose turn the reader is in — lit in the accent colour. */
  activeId: string | null;
  /** Jump to the message a pill stands for. */
  onSelect: (messageId: string) => void;
};

type HoveredPrompt = { kind: "pill"; index: number; item: PromptRailItem; anchor: MenuAnchor };

/** The dots under the pointer: the prompts they stand for, nearest first, plus
 *  how many of the clipped ones the list had no room to name. */
type HoveredCut = {
  kind: "cut";
  side: "above" | "below";
  prompts: PromptRailItem[];
  hidden: number;
  anchor: MenuAnchor;
};

type RailFlyout = HoveredPrompt | HoveredCut;

/** Stands in for the prompts an end of the column had to clip: three dots instead
 *  of a pill, so the rail keeps saying "there is more this way" while its pills
 *  stay inside the thread. The count is in the label, not in the glyph — the
 *  rail is a glance, and a number would outshout the pills; hovering the dots
 *  spells the clipped prompts out (see the flyout below). */
function CutDots({
  label,
  onEnter,
  onLeave,
}: {
  label: string;
  onEnter: (el: HTMLElement) => void;
  onLeave: () => void;
}) {
  return (
    <span
      className={styles.cut}
      role="img"
      aria-label={label}
      onPointerEnter={(e) => onEnter(e.currentTarget)}
      onPointerLeave={onLeave}
    >
      <span className={styles.cutDots} aria-hidden />
    </span>
  );
}

/**
 * A column of pills beside the chat thread — one per prompt the user sent, in
 * order, centred on the thread's height. Hovering raises a wave along the
 * column and names the prompt with the head of the answer it got; clicking jumps
 * to the message; the prompt the reader is currently in is lit.
 *
 * The pills are a list, not a map of the thread: each one takes a slot of the
 * shared pitch, so the hit areas tile the column instead of overlapping — a
 * click lands on the pill under the pointer, never on its neighbour.
 *
 * The rail is hover-only furniture, so it never renders for a touch pointer:
 * there is no hover to reveal a prompt, and the pills would only steal taps
 * from the thread.
 *
 * Each pill carries `data-prompt-id` — deliberately not `data-message-id`,
 * which belongs to the thread's rows and is looked up document-wide by message
 * hotkeys and the screenshot scripts; a pill carrying it would shadow the
 * message it points at.
 *
 * A thread too short for its prompts shows a window of them rather than a
 * column running over the header and the composer, and a chat too long for the
 * pills to keep their air is clipped the same way — packed edge to edge the
 * column is one thick stroke, not a list. Each clipped end is marked with dots
 * (lib/promptRail.ts: railWindow), and hovering the dots lists the prompts they
 * stand for, nearest to the column first, so a clipped prompt is still one hover
 * and one click away.
 */
export function ChatPromptRail({
  items,
  top,
  height,
  activeId,
  onSelect,
}: ChatPromptRailProps) {
  const t = useT();
  const touch = useIsTouchUi();
  const [flyout, setFlyout] = useState<RailFlyout | null>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const flyoutStyle = useFixedMenuPlacement(flyout?.anchor ?? null, flyoutRef);
  /** A pending close: the pointer has to cross the gap from the dots into their
   *  list, so a leave waits instead of folding the list up under the cursor. */
  const closeTimer = useRef<number | null>(null);
  const cancelClose = () => {
    if (closeTimer.current === null) return;
    window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const closeSoon = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setFlyout(null);
    }, FLYOUT_CLOSE_MS);
  };
  useEffect(() => cancelClose, []);

  if (touch || items.length === 0 || height <= 0) return null;

  const available = Math.max(0, height - TRACK_PAD_PX * 2);
  const activeIndex = items.findIndex((item) => item.id === activeId);
  // No lit pill (the reader is between turns): the window ends on the last one.
  const view = railWindow(
    items.length,
    activeIndex < 0 ? items.length - 1 : activeIndex,
    available,
  );
  const shown = items.slice(view.start, view.start + view.count);
  const cutHint = (side: "above" | "below", count: number) =>
    t(side === "above" ? "chat.promptRailCutAbove" : "chat.promptRailCutBelow", { count });

  /** The dots of one end, wired to the list of the prompts they stand for — the
   *  ones nearest the column, the rest counted in the list's footer. */
  const cutDots = (side: "above" | "below") => {
    const count = side === "above" ? view.above : view.below;
    if (count <= 0) return null;
    const clipped =
      side === "above" ? items.slice(0, view.start) : items.slice(view.start + view.count);
    const prompts =
      side === "above" ? clipped.slice(-CUT_LIST_MAX) : clipped.slice(0, CUT_LIST_MAX);
    return (
      <CutDots
        label={cutHint(side, count)}
        onEnter={(el) => {
          const rect = el.getBoundingClientRect();
          cancelClose();
          setFlyout({
            kind: "cut",
            side,
            prompts,
            hidden: clipped.length - prompts.length,
            anchor: { x: rect.right + TIP_GAP_PX, y: rect.top },
          });
        }}
        onLeave={closeSoon}
      />
    );
  };

  return (
    <div
      className={styles.rail}
      style={{ top, height }}
      role="navigation"
      aria-label={t("chat.promptRail")}
    >
      {cutDots("above")}
      <div className={styles.stack}>
        {shown.map((item, index) => (
          <button
            key={item.id}
            type="button"
            className={`${styles.pill}${item.id === activeId ? ` ${styles.pillActive}` : ""}`}
            style={{ height: view.slot }}
            data-prompt-id={item.id}
            aria-current={item.id === activeId ? "true" : undefined}
            aria-label={item.prompt}
            onClick={() => {
              setFlyout(null);
              onSelect(item.id);
            }}
            onPointerEnter={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              cancelClose();
              setFlyout({
                kind: "pill",
                index,
                item,
                anchor: { x: rect.right + TIP_GAP_PX, y: rect.top },
              });
            }}
            onPointerLeave={() => setFlyout(null)}
          >
            <span
              className={styles.pillBar}
              aria-hidden
              style={{
                width:
                  flyout?.kind === "pill"
                    ? railPillWidth(Math.abs(index - flyout.index))
                    : RAIL_PILL_BASE_PX,
              }}
            />
          </button>
        ))}
      </div>
      {cutDots("below")}
      {flyout && flyoutStyle
        ? createPortal(
            flyout.kind === "pill" ? (
              <div ref={flyoutRef} className={styles.tip} style={flyoutStyle} role="tooltip">
                <p className={styles.tipPrompt}>{flyout.item.prompt}</p>
                {flyout.item.reply ? <p className={styles.tipReply}>{flyout.item.reply}</p> : null}
              </div>
            ) : (
              <div
                ref={flyoutRef}
                className={styles.cutList}
                style={flyoutStyle}
                role="group"
                aria-label={cutHint(flyout.side, flyout.prompts.length + flyout.hidden)}
                onPointerEnter={cancelClose}
                onPointerLeave={closeSoon}
              >
                <p className={styles.cutListTitle}>
                  {cutHint(flyout.side, flyout.prompts.length + flyout.hidden)}
                </p>
                <ul className={styles.cutListRows}>
                  {flyout.prompts.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className={styles.cutListRow}
                        title={item.prompt}
                        onClick={() => {
                          setFlyout(null);
                          onSelect(item.id);
                        }}
                      >
                        {item.prompt}
                      </button>
                    </li>
                  ))}
                </ul>
                {flyout.hidden > 0 ? (
                  <p className={styles.cutListMore}>
                    {t("chat.promptRailCutMore", { count: flyout.hidden })}
                  </p>
                ) : null}
              </div>
            ),
            document.body,
          )
        : null}
    </div>
  );
}
