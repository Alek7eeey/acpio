import { useRef, useState } from "react";
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

type HoveredPrompt = { index: number; item: PromptRailItem; anchor: MenuAnchor };

/** Stands in for the prompts an end of the column had to clip: three dots instead
 *  of a pill, so the rail keeps saying "there is more this way" while its pills
 *  stay inside the thread. The count is in the tooltip, not in the glyph — the
 *  rail is a glance, and a number would outshout the pills. */
function CutDots({ side, count }: { side: "above" | "below"; count: number }) {
  const t = useT();
  const label = t(side === "above" ? "chat.promptRailCutAbove" : "chat.promptRailCutBelow", {
    count,
  });
  return (
    <span className={styles.cut} role="img" aria-label={label} title={label}>
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
 * column running over the header and the composer; the clipped end is marked
 * with dots (lib/promptRail.ts: railWindow).
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
  const [hovered, setHovered] = useState<HoveredPrompt | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const tipStyle = useFixedMenuPlacement(hovered?.anchor ?? null, tipRef);

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

  return (
    <div
      className={styles.rail}
      style={{ top, height }}
      role="navigation"
      aria-label={t("chat.promptRail")}
    >
      {view.above > 0 ? <CutDots side="above" count={view.above} /> : null}
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
              setHovered(null);
              onSelect(item.id);
            }}
            onPointerEnter={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setHovered({
                index,
                item,
                anchor: { x: rect.right + TIP_GAP_PX, y: rect.top },
              });
            }}
            onPointerLeave={() => setHovered(null)}
          >
            <span
              className={styles.pillBar}
              aria-hidden
              style={{
                width: hovered
                  ? railPillWidth(Math.abs(index - hovered.index))
                  : RAIL_PILL_BASE_PX,
              }}
            />
          </button>
        ))}
      </div>
      {view.below > 0 ? <CutDots side="below" count={view.below} /> : null}
      {hovered && tipStyle
        ? createPortal(
            <div ref={tipRef} className={styles.tip} style={tipStyle} role="tooltip">
              <p className={styles.tipPrompt}>{hovered.item.prompt}</p>
              {hovered.item.reply ? <p className={styles.tipReply}>{hovered.item.reply}</p> : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
