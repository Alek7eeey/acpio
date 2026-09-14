import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  BUILD_INFO,
  type ChatActionId,
  type ChatComposerButtonId,
  type ChatHeaderIconId,
  type ChatMetaChipId,
  type ChatToolbarStyle,
  type ChatTreeElementId,
  type ChatTreeMenuId,
} from "@acpio/shared";
import { useLocale, useT } from "../lib/i18n";
import { formatDuration } from "../lib/partTiming";
import { isChatSearchEnabled } from "../lib/chatTreeSearch";
import styles from "./ChatSettingsPreview.module.css";

const CHIP_ORDER: ChatMetaChipId[] = [
  "folder",
  "gitBranch",
  "gitChanges",
  "thoughts",
  "mcp",
  "context",
  "console",
];
const ALL_META_CHIPS: ChatMetaChipId[] = [...CHIP_ORDER];

const CHIP_LABEL_KEY: Record<ChatMetaChipId, string> = {
  folder: "settings.chatMetaChipFolder",
  gitBranch: "settings.chatMetaChipGitBranch",
  gitChanges: "settings.chatMetaChipGitChanges",
  thoughts: "settings.chatMetaChipThoughts",
  mcp: "settings.chatMetaChipMcp",
  context: "settings.chatMetaChipContext",
  console: "settings.chatMetaChipConsole",
};
const TREE_ORDER: ChatTreeElementId[] = ["search", "pin", "archive", "more"];
const COMPOSER_ORDER: ChatComposerButtonId[] = ["attach", "model", "mode", "mic"];
const TREE_MENU_ORDER: ChatTreeMenuId[] = ["rename", "move", "export", "delete"];

/** i18n key for each action's tooltip/label. */
const ACTION_LABEL_KEY: Record<ChatActionId, string> = {
  copy: "common.copy",
  edit: "common.edit",
  like: "common.like",
  dislike: "common.dislike",
  share: "common.share",
  regenerate: "chat.regenerate",
  readAloud: "chat.readAloud",
};

/** i18n key for each optional tree control. */
const TREE_LABEL_KEY: Record<Exclude<ChatTreeElementId, "searchMsgs">, string> = {
  search: "settings.chatTreeElSearch",
  pin: "settings.chatTreeElPin",
  archive: "settings.chatTreeElArchive",
  more: "settings.chatTreeElMore",
};

/** i18n key for each optional composer button. */
const COMPOSER_LABEL_KEY: Record<ChatComposerButtonId, string> = {
  attach: "settings.chatComposerBtnAttach",
  mic: "settings.chatComposerBtnMic",
  model: "settings.chatComposerBtnModel",
  mode: "settings.chatComposerBtnMode",
};

/** i18n key for each "⋯" context menu command. */
const TREE_MENU_LABEL_KEY: Record<ChatTreeMenuId, string> = {
  rename: "chat.renameSession",
  move: "chat.newInFolder",
  export: "chat.exportChat",
  delete: "common.delete",
};

/** i18n key for each header icon. */
const HEADER_ICON_LABEL_KEY: Record<ChatHeaderIconId, string> = {
  lang: "settings.chatHeaderIconLang",
  install: "settings.chatHeaderIconInstall",
  theme: "settings.chatHeaderIconTheme",
};

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg className={styles.icon} viewBox="0 0 24 24" fill="none" aria-hidden>
      {children}
    </svg>
  );
}

function actionIcon(id: ChatActionId): ReactNode {
  switch (id) {
    case "copy":
      return (
        <Icon>
          <rect x="8" y="8" width="13" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.85" />
          <path
            d="M8 16H6.5A2.5 2.5 0 0 1 4 13.5v-9A2.5 2.5 0 0 1 6.5 2H15.5A2.5 2.5 0 0 1 18 4.5V8"
            stroke="currentColor"
            strokeWidth="1.85"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Icon>
      );
    case "edit":
      return (
        <Icon>
          <path
            d="M4 20h4.8L20 8.8 15.2 4 4 15.2V20Z"
            stroke="currentColor"
            strokeWidth="1.85"
            strokeLinejoin="round"
          />
          <path d="M12.8 6.8 17.2 11.2" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" />
        </Icon>
      );
    case "like":
      return (
        <Icon>
          <path
            d="M7 11v9H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h2Zm0 0 4.2-7.2A2.2 2.2 0 0 1 13.2 3h.3a2 2 0 0 1 2 2.3L14.8 11H20a2 2 0 0 1 2 2.3l-1.1 5.2A3 3 0 0 1 18 21H7"
            stroke="currentColor"
            strokeWidth="1.85"
            strokeLinejoin="round"
          />
        </Icon>
      );
    case "dislike":
      return (
        <Icon>
          <path
            d="M17 13V4h2a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2Zm0 0-4.2 7.2A2.2 2.2 0 0 1 10.8 21h-.3a2 2 0 0 1-2-2.3L9.2 13H4a2 2 0 0 1-2-2.3L3.1 5.5A3 3 0 0 1 6 3h11"
            stroke="currentColor"
            strokeWidth="1.85"
            strokeLinejoin="round"
          />
        </Icon>
      );
    case "share":
      return (
        <Icon>
          <path
            d="M12 3v10M12 3l-3.5 3.5M12 3l3.5 3.5M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"
            stroke="currentColor"
            strokeWidth="1.85"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Icon>
      );
    case "regenerate":
      return (
        <Icon>
          <path
            d="M4 12a8 8 0 0 1 13.7-5.7L20 8M20 4v4h-4M20 12a8 8 0 0 1-13.7 5.7L4 16M4 20v-4h4"
            stroke="currentColor"
            strokeWidth="1.85"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Icon>
      );
    case "readAloud":
      return (
        <Icon>
          <path
            d="M11 5 6 9H2v6h4l5 4V5Z"
            stroke="currentColor"
            strokeWidth="1.85"
            strokeLinejoin="round"
          />
          <path
            d="M15.5 8.5a5 5 0 0 1 0 7"
            stroke="currentColor"
            strokeWidth="1.85"
            strokeLinecap="round"
          />
          <path
            d="M19 5.5a9 9 0 0 1 0 13"
            stroke="currentColor"
            strokeWidth="1.85"
            strokeLinecap="round"
          />
        </Icon>
      );
  }
}

/**
 * Toggle chip: the element is ALWAYS visible. "accent" variant highlights
 * the active state with the theme accent (message actions, header);
 * "dim" variant only changes opacity (tree, composer). Click toggles.
 */
function El({
  on,
  onToggle,
  label,
  children,
  variant = "accent",
  className,
}: {
  on: boolean;
  onToggle: () => void;
  label: string;
  children: ReactNode;
  variant?: "accent" | "dim";
  className?: string;
}) {
  const state =
    variant === "dim" ? (on ? styles.elDimOn : styles.elDimOff) : on ? styles.elOn : styles.elOff;
  return (
    <span
      className={`${styles.el} ${state}${className ? ` ${className}` : ""}`}
      title={label}
      onClick={onToggle}
    >
      {children}
    </span>
  );
}

function newChatIcon(size: number) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5.5 4.8h9.2A3.3 3.3 0 0 1 18 8.1v5.2a3.3 3.3 0 0 1-3.3 3.3H10l-3.4 2.6v-2.6H5.5A3.3 3.3 0 0 1 2.2 13.3V8.1A3.3 3.3 0 0 1 5.5 4.8Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M16.8 3.2 17.5 5.2 19.5 5.9 17.5 6.6 16.8 8.6 16.1 6.6 14.1 5.9 16.1 5.2 16.8 3.2Z"
        fill="currentColor"
      />
    </svg>
  );
}

function searchIcon(size: number) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** Drag-to-resize strip (header height). */
function DragBar({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const startY = useRef(0);
  const startVal = useRef(0);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const next = Math.round(
        Math.min(max, Math.max(min, startVal.current + (e.clientY - startY.current))),
      );
      onChange(next);
    };
    const onUp = () => setDragging(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging, min, max, onChange]);

  return (
    <div
      className={`${styles.dragBar}${dragging ? ` ${styles.dragBarActive}` : ""}`}
      title={label}
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      onPointerDown={(e) => {
        e.preventDefault();
        startY.current = e.clientY;
        startVal.current = value;
        setDragging(true);
      }}
    >
      <span className={styles.dragGrip} aria-hidden>
        ⋮
      </span>
    </div>
  );
}

/**
 * Message action bar mock: every applicable action renders as a draggable
 * icon in a STABLE slot (position never jumps when toggling). The "⋯"
 * overflow exists only in the real chat — the preview shows all actions.
 *
 * Pointer capture (not HTML5 DnD): nested click-to-toggle chips swallow
 * native dragstart/drop in Chromium, so reorder never fired.
 */
function PreviewActions({
  actions,
  ordered,
  onToggle,
  onReorder,
}: {
  actions: ChatActionId[];
  ordered: ChatActionId[];
  onToggle: (id: ChatActionId) => void;
  onReorder: (dragged: ChatActionId, target: ChatActionId) => void;
}) {
  const t = useT();
  const [overId, setOverId] = useState<ChatActionId | null>(null);
  const [draggingId, setDraggingId] = useState<ChatActionId | null>(null);
  const skipClickRef = useRef(false);
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const isOn = (id: ChatActionId) => actions.includes(id);

  const onPointerDown = (id: ChatActionId) => (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0) return;
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    const bar = e.currentTarget.parentElement;
    let moved = false;

    const hit = (x: number, y: number): ChatActionId | null => {
      if (!bar) return null;
      for (const el of bar.querySelectorAll<HTMLElement>("[data-action-id]")) {
        const r = el.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          return el.dataset.actionId as ChatActionId;
        }
      }
      return null;
    };

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!moved) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 8) return;
        moved = true;
        skipClickRef.current = true;
        setDraggingId(id);
      }
      setOverId(hit(ev.clientX, ev.clientY));
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const target = moved ? hit(ev.clientX, ev.clientY) : null;
      setDraggingId(null);
      setOverId(null);
      if (moved && target && target !== id) onReorderRef.current(id, target);
      if (moved) {
        window.setTimeout(() => {
          skipClickRef.current = false;
        }, 0);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return (
    <div className={styles.actions}>
      {ordered.map((id) => (
        <span
          key={id}
          data-action-id={id}
          className={`${styles.dragSlot}${overId === id ? ` ${styles.dragSlotOver}` : ""}${
            draggingId === id ? ` ${styles.dragSlotDragging}` : ""
          }`}
          onPointerDown={onPointerDown(id)}
        >
          <El
            on={isOn(id)}
            onToggle={() => {
              if (skipClickRef.current) return;
              onToggle(id);
            }}
            label={t(ACTION_LABEL_KEY[id] as "common.copy")}
          >
            <span className={styles.actIcon}>{actionIcon(id)}</span>
          </El>
        </span>
      ))}
    </div>
  );
}

function PreviewGitBranchOnly({ dragging = false }: { dragging?: boolean }) {
  return (
    <span
      className={`${styles.previewGitBranch}${dragging ? ` ${styles.previewGitBranchDragging}` : ""}`}
    >
      <PreviewGitBranchIcon />
      <span>main</span>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden className={styles.previewGitChevron}>
        <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function PreviewGitChangesOnly() {
  return (
    <span className={styles.previewGitChangesChip}>
      <span className={styles.previewGitChangesAdd}>+2</span>
      <span className={styles.previewGitChangesDel}>-1</span>
      <span className={styles.previewGitChangesSep}>·</span>
      <span>3</span>
    </span>
  );
}

function hitGitZone(x: number, y: number): "below" | "above" | null {
  for (const el of document.querySelectorAll<HTMLElement>("[data-git-zone]")) {
    const r = el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      const zone = el.dataset.gitZone;
      if (zone === "above" || zone === "below") return zone;
    }
  }
  return null;
}

function PreviewGitDropHint({
  hintPos,
  label,
}: {
  hintPos: { x: number; y: number } | null;
  label: string | null;
}) {
  if (!hintPos || !label || typeof document === "undefined") return null;
  return createPortal(
    <span
      className={styles.previewGitDropHintFixed}
      style={{ left: hintPos.x, top: hintPos.y }}
      aria-hidden
    >
      {label}
    </span>,
    document.body,
  );
}

function PreviewMetaChips({
  chips,
  ordered,
  onToggle,
  onReorder,
  gitBranchAbove = false,
  onGitBranchPositionChange,
}: {
  chips: ChatMetaChipId[];
  ordered: ChatMetaChipId[];
  onToggle: (id: ChatMetaChipId) => void;
  onReorder: (dragged: ChatMetaChipId, target: ChatMetaChipId) => void;
  gitBranchAbove?: boolean;
  onGitBranchPositionChange?: (next: "below" | "above") => void;
}) {
  const t = useT();
  const [overId, setOverId] = useState<ChatMetaChipId | null>(null);
  const [draggingId, setDraggingId] = useState<ChatMetaChipId | null>(null);
  const [gitHintPos, setGitHintPos] = useState<{ x: number; y: number } | null>(null);
  const [gitHoverZone, setGitHoverZone] = useState<"below" | "above" | null>(null);
  const [chipsEdge, setChipsEdge] = useState({ left: false, right: false });
  const chipsRef = useRef<HTMLDivElement>(null);
  const skipClickRef = useRef(false);
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const onGitPositionRef = useRef(onGitBranchPositionChange);
  onGitPositionRef.current = onGitBranchPositionChange;
  const isOn = (id: ChatMetaChipId) => chips.includes(id);

  const onPointerDown = (id: ChatMetaChipId) => (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0) return;
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    const bar = e.currentTarget.parentElement;
    let moved = false;

    const hit = (x: number, y: number): ChatMetaChipId | null => {
      if (!bar) return null;
      for (const el of bar.querySelectorAll<HTMLElement>("[data-chip-id]")) {
        const r = el.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          return el.dataset.chipId as ChatMetaChipId;
        }
      }
      return null;
    };

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!moved) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 8) return;
        moved = true;
        skipClickRef.current = true;
        setDraggingId(id);
      }
      if (id === "gitBranch" && gitBranchAbove) {
        const zone = hitGitZone(ev.clientX, ev.clientY);
        if (zone === "below") {
          setGitHoverZone(zone);
          setGitHintPos({ x: ev.clientX, y: ev.clientY + 18 });
          setOverId(null);
          return;
        }
        setGitHoverZone(null);
        setGitHintPos(null);
      }
      setOverId(hit(ev.clientX, ev.clientY));
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const zone = moved ? hitGitZone(ev.clientX, ev.clientY) : null;
      const target = moved ? hit(ev.clientX, ev.clientY) : null;
      setDraggingId(null);
      setOverId(null);
      setGitHoverZone(null);
      setGitHintPos(null);
      if (id === "gitBranch" && gitBranchAbove && moved && zone === "below") {
        onGitPositionRef.current?.("below");
      } else if (moved && target && target !== id) {
        onReorderRef.current(id, target);
      }
      if (moved) {
        window.setTimeout(() => {
          skipClickRef.current = false;
        }, 0);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const gitHintLabel =
    gitHoverZone === "below"
      ? t("settings.chatGitBranchDragHint")
      : gitHoverZone === "above"
        ? t("settings.chatGitBranchPositionAbove")
        : null;

  useEffect(() => {
    const el = chipsRef.current;
    if (!el) return;
    const sync = () => {
      const max = el.scrollWidth - el.clientWidth;
      const left = el.scrollLeft > 2;
      const right = max > 2 && el.scrollLeft < max - 2;
      setChipsEdge((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
    };
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", sync);
      ro.disconnect();
    };
  }, [ordered, chips, gitBranchAbove]);

  const scrollChipsRight = () => {
    const el = chipsRef.current;
    if (!el) return;
    el.scrollBy({ left: Math.max(96, el.clientWidth * 0.55), behavior: "smooth" });
  };

  const scrollChipsLeft = () => {
    const el = chipsRef.current;
    if (!el) return;
    el.scrollBy({ left: -Math.max(96, el.clientWidth * 0.55), behavior: "smooth" });
  };

  return (
    <>
      <div
        className={`${styles.previewChipsShell}${
          chipsEdge.right ? ` ${styles.previewChipsFadeRight}` : ""
        }${chipsEdge.left ? ` ${styles.previewChipsFadeLeft}` : ""}`}
      >
        <div ref={chipsRef} className={styles.chips} data-git-zone="above">
        {ordered.map((id) => (
          <span
            key={id}
            data-chip-id={id}
            className={`${styles.dragSlot}${overId === id ? ` ${styles.dragSlotOver}` : ""}${
              draggingId === id ? ` ${styles.dragSlotDragging}` : ""
            }`}
            onPointerDown={onPointerDown(id)}
          >
            <El
              on={isOn(id)}
              variant="dim"
              onToggle={() => {
                if (skipClickRef.current) return;
                onToggle(id);
              }}
              label={t(CHIP_LABEL_KEY[id] as "settings.chatMetaChipFolder")}
            >
              {id === "gitBranch" && isOn("gitBranch") ? (
                gitBranchAbove ? (
                  <PreviewGitBranchOnly dragging={draggingId === "gitBranch"} />
                ) : (
                  <span className={styles.chip} aria-hidden>
                    {t("settings.chatMetaChipGitBranch")}
                  </span>
                )
              ) : id === "gitChanges" && isOn("gitChanges") ? (
                <PreviewGitChangesOnly />
              ) : (
                <span className={styles.chip} aria-hidden>
                  {t(CHIP_LABEL_KEY[id] as "settings.chatMetaChipFolder")}
                </span>
              )}
            </El>
          </span>
        ))}
        </div>
        {chipsEdge.left ? (
          <button
            type="button"
            className={`${styles.previewChipsMore} ${styles.previewChipsMoreLeft}`}
            aria-label={t("settings.chatPreviewScrollChipsLeft")}
            title={t("settings.chatPreviewScrollChipsLeft")}
            onClick={scrollChipsLeft}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M15 6l-6 6 6 6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        ) : null}
        {chipsEdge.right ? (
          <button
            type="button"
            className={`${styles.previewChipsMore} ${styles.previewChipsMoreRight}`}
            aria-label={t("settings.chatPreviewScrollChipsRight")}
            title={t("settings.chatPreviewScrollChipsRight")}
            onClick={scrollChipsRight}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M9 6l6 6-6 6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        ) : null}
      </div>
      <PreviewGitDropHint hintPos={gitHintPos} label={gitHintLabel} />
    </>
  );
}

function PreviewGitBranchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM18 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path d="M6 9v6M18 12c0 3-12 1-12 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function PreviewGitBranch({
  position,
  onPositionChange,
}: {
  position: "below" | "above";
  onPositionChange: (next: "below" | "above") => void;
}) {
  const t = useT();
  const [dragging, setDragging] = useState(false);
  const [hoverZone, setHoverZone] = useState<"below" | "above" | null>(null);
  const [hintPos, setHintPos] = useState<{ x: number; y: number } | null>(null);
  const skipClickRef = useRef(false);

  const onPointerDown = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0) return;
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!moved) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 8) return;
        moved = true;
        skipClickRef.current = true;
        setDragging(true);
      }
      const zone = hitGitZone(ev.clientX, ev.clientY);
      setHoverZone(zone);
      if (zone && zone !== position) {
        setHintPos({ x: ev.clientX, y: ev.clientY + 18 });
      } else {
        setHintPos(null);
      }
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const zone = moved ? hitGitZone(ev.clientX, ev.clientY) : null;
      setDragging(false);
      setHoverZone(null);
      setHintPos(null);
      if (zone && zone !== position) onPositionChange(zone);
      if (moved) {
        window.setTimeout(() => {
          skipClickRef.current = false;
        }, 0);
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const hintLabel =
    hoverZone === "above"
      ? t("settings.chatGitBranchPositionAbove")
      : hoverZone === "below"
        ? t("settings.chatGitBranchDragHint")
        : null;

  return (
    <>
      <span
        className={styles.previewGitBranchDragWrap}
        aria-label={t("settings.chatGitBranchDragHint")}
        onPointerDown={onPointerDown}
        onClick={(e) => {
          if (skipClickRef.current) e.preventDefault();
        }}
      >
        <PreviewGitBranchOnly dragging={dragging} />
      </span>
      <PreviewGitDropHint hintPos={hintPos} label={hintLabel} />
    </>
  );
}

/**
 * Interactive full-app mock: header + chat tree + chat thread + composer.
 * Every configurable element is always visible — active elements get the
 * theme accent, inactive ones stay semi-transparent. Click toggles.
 */
/** Decorative parts of the chat preview. The mock mirrors how a real turn
 *  reads, so it has to track the timeline rules: spoiler → text → spoiler while
 *  the agent works, with the "Работал" header and the measured span next to it
 *  once it stops. */

const PREVIEW_SPARK = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
    <path
      d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
    />
  </svg>
);

const PREVIEW_FOLDER = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
    <path
      d="M3.5 8.5V7a2 2 0 0 1 2-2h4.2l1.6 1.7H18.5a2 2 0 0 1 2 2v1"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M3.5 10.2h17v6.3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-6.3Z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  </svg>
);

const PREVIEW_CHECK = (
  <svg className={styles.toolCheck} width="13" height="13" viewBox="0 0 24 24" fill="none">
    <path
      d="M5 13l4 4L19 7"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** One activity spoiler: header with its measured span, indented body. */
function PreviewWork({
  label,
  time,
  children,
}: {
  label: string;
  time: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.pvWork} aria-hidden>
      <div className={styles.pvWorkHead}>
        <span className={styles.pvChevron}>▾</span>
        <span className={styles.pvWorkLabel}>{label}</span>
        {time ? <span className={styles.pvTime}>{time}</span> : null}
      </div>
      <div className={styles.pvWorkBody}>{children}</div>
    </div>
  );
}

/** A reasoning block nested in a spoiler — its own header, its own span. */
function PreviewReasoning({ time, open }: { time: string; open: boolean }) {
  const t = useT();
  return (
    <div className={styles.pvReasoning} aria-hidden>
      <div className={styles.pvReasoningHead}>
        <span className={styles.pvChevron}>{open ? "▾" : "▸"}</span>
        {PREVIEW_SPARK}
        <span>{t("common.reasoning")}</span>
        {time ? <span className={styles.pvTime}>{time}</span> : null}
      </div>
      {open ? (
        <div className={styles.pvReasoningBody}>{t("settings.chatPreviewThought")}</div>
      ) : null}
    </div>
  );
}

function PreviewToolRow({ time }: { time: string }) {
  const t = useT();
  return (
    <div className={styles.pvTool} aria-hidden>
      {PREVIEW_CHECK}
      <span className={styles.pvToolName}>{t("settings.chatPreviewTool")}</span>
      {time ? <span className={styles.pvTime}>{time}</span> : null}
    </div>
  );
}

export function ChatSettingsPreview({
  actions,
  chips,
  composerButtons,
  treeElements,
  treeMenu,
  showArchive,
  showTime,
  headerHeight,
  headerIcons,
  chatSplit,
  chatToolbarStyle,
  chatGitBranchPosition = "below",
  agentTurnTimeline = false,
  onToggleAction,
  onToggleChip,
  onReorderChip,
  onToggleComposerButton,
  onToggleTreeElement,
  onToggleTreeMenu,
  onToggleShowArchive,
  onReorderAction,
  onHeaderHeight,
  onToggleHeaderIcon,
  onToggleChatSplit,
  onGitBranchPositionChange,
}: {
  actions: ChatActionId[];
  chips: ChatMetaChipId[];
  composerButtons: ChatComposerButtonId[];
  treeElements: ChatTreeElementId[];
  treeMenu: ChatTreeMenuId[];
  showArchive: boolean;
  showTime: boolean;
  headerHeight: number;
  headerIcons: ChatHeaderIconId[];
  chatSplit: boolean;
  chatToolbarStyle: ChatToolbarStyle;
  chatGitBranchPosition?: "below" | "above";
  /** Mirrors the agent-turn-timeline setting: the mock shows the reading it selects. */
  agentTurnTimeline?: boolean;
  onToggleAction: (id: ChatActionId) => void;
  onToggleChip: (id: ChatMetaChipId) => void;
  onReorderChip: (nextOrder: ChatMetaChipId[]) => void;
  onToggleComposerButton: (id: ChatComposerButtonId) => void;
  onToggleTreeElement: (id: ChatTreeElementId) => void;
  onToggleTreeMenu: (id: ChatTreeMenuId) => void;
  onToggleShowArchive: () => void;
  onReorderAction: (nextOrder: ChatActionId[]) => void;
  onHeaderHeight: (next: number) => void;
  onToggleHeaderIcon: (id: ChatHeaderIconId) => void;
  onToggleChatSplit: () => void;
  onGitBranchPositionChange: (position: "below" | "above") => void;
}) {
  const t = useT();
  const locale = useLocale();
  const mainBarActions = actions.filter((a) => a !== "edit");
  const userBarActions = actions.filter((a) => a === "copy" || a === "edit");
  // User messages can only carry copy/edit; the bot's bar never shows edit.
  const USER_APPLICABLE: ChatActionId[] = ["copy", "edit"];
  const BOT_APPLICABLE: ChatActionId[] = [
    "copy",
    "like",
    "dislike",
    "share",
    "regenerate",
    "readAloud",
  ];
  // Stable display order: initialized from the enabled order + the rest in
  // canonical order; only drag&drop changes it, so toggling never jumps.
  const ALL_ACTIONS: ChatActionId[] = [
    "copy",
    "edit",
    "like",
    "dislike",
    "share",
    "regenerate",
    "readAloud",
  ];
  const [displayOrder, setDisplayOrder] = useState<ChatActionId[]>(() => [
    ...actions,
    ...ALL_ACTIONS.filter((id) => !actions.includes(id)),
  ]);
  const [chipDisplayOrder, setChipDisplayOrder] = useState<ChatMetaChipId[]>(() => [
    ...chips,
    ...ALL_META_CHIPS.filter((id) => !chips.includes(id)),
  ]);
  const orderedFor = (applicable: ChatActionId[]): ChatActionId[] =>
    applicable
      .filter((id) => displayOrder.includes(id))
      .sort((a, b) => displayOrder.indexOf(a) - displayOrder.indexOf(b));
  const gitBranchChipOn = chips.includes("gitBranch");
  const showGitBranchFooter = gitBranchChipOn && chatGitBranchPosition === "below";
  const handleReorder = (dragged: ChatActionId, target: ChatActionId) => {
    const from = displayOrder.indexOf(dragged);
    const to = displayOrder.indexOf(target);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...displayOrder];
    next.splice(from, 1);
    next.splice(to, 0, dragged);
    setDisplayOrder(next);
    onReorderAction(next);
  };
  const handleChipReorder = (dragged: ChatMetaChipId, target: ChatMetaChipId) => {
    const from = chipDisplayOrder.indexOf(dragged);
    const to = chipDisplayOrder.indexOf(target);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...chipDisplayOrder];
    next.splice(from, 1);
    next.splice(to, 0, dragged);
    setChipDisplayOrder(next);
    const enabled = new Set(chips);
    onReorderChip(next.filter((id) => enabled.has(id)));
  };
  const [treeMenuPos, setTreeMenuPos] = useState<{ top: number; left: number } | null>(null);
  const treeMenuRef = useRef<HTMLDivElement>(null);
  const [mobileTreeOpen, setMobileTreeOpen] = useState(false);
  useEffect(() => {
    if (!treeMenuPos) return;
    const onDown = (e: Event) => {
      if (treeMenuRef.current && !treeMenuRef.current.contains(e.target as Node)) {
        setTreeMenuPos(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [treeMenuPos]);
  const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const treeOn = (id: ChatTreeElementId) =>
    id === "search" || id === "searchMsgs"
      ? isChatSearchEnabled(treeElements)
      : treeElements.includes(id);
  const btnOn = (id: ChatComposerButtonId) => composerButtons.includes(id);
  const iconOn = (id: ChatHeaderIconId) => headerIcons.includes(id);
  const menuOn = (id: ChatTreeMenuId) => treeMenu.includes(id);
  const toolbarMinimal = chatToolbarStyle === "minimal";

  return (
    <div className={styles.wrap}>
      {/* ── Header (height + icons configurable) ─────────────── */}
      <div className={styles.headerWrap}>
        <div className={styles.header} style={{ height: `${headerHeight}px` }}>
          <span className={styles.headerBrand} aria-hidden>
            <span className={styles.brandLetters}>
              {"Acpio".split("").map((ch, i) => (
                <span key={i} className={i < 3 ? styles.brandMark : undefined}>
                  {ch}
                </span>
              ))}
            </span>
            <span className={styles.brandVersion}>{BUILD_INFO.version}</span>
          </span>
          <span className={styles.headerChatCtx} aria-hidden>
            <span className={styles.headerChatFolder}>acpio</span>
            <span className={styles.headerChatSep}>/</span>
            <span className={styles.headerChatTitle}>{t("settings.chatPreviewChatTitle")}</span>
          </span>
          <div className={styles.headerActions}>
            <span className={styles.agentChipWrap} aria-hidden>
              <span className={`${styles.agentChip} ${styles.agentChipOn}`}>
                <span className={styles.agentCount}>1</span>
                <span className={styles.agentPip} />
              </span>
            </span>
            <span className={styles.toolCluster}>
              <El
                className={styles.headerToolEl}
                on={iconOn("lang")}
                onToggle={() => onToggleHeaderIcon("lang")}
                label={t("settings.chatHeaderIconLang")}
              >
                <span className={styles.toolClusterBtn}>
                  <span className={styles.toolClusterLang}>{locale}</span>
                </span>
              </El>
              <El
                className={styles.headerToolEl}
                on={iconOn("install")}
                onToggle={() => onToggleHeaderIcon("install")}
                label={t("settings.chatHeaderIconInstall")}
              >
                <span className={styles.toolClusterBtn} aria-hidden>
                  <svg viewBox="0 0 24 24" fill="none">
                    <path
                      d="M12 3v10m0 0-3.5-3.5M12 13l3.5-3.5"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M5 17.5V19a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-1.5"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    />
                  </svg>
                </span>
              </El>
              <El
                className={styles.headerToolEl}
                on={iconOn("theme")}
                onToggle={() => onToggleHeaderIcon("theme")}
                label={t("settings.chatHeaderIconTheme")}
              >
                <span className={styles.toolClusterBtn} aria-hidden>
                  <svg viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="4" fill="currentColor" />
                    <g stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                      <path d="M12 2.6v2M12 19.4v2M2.6 12h2M19.4 12h2M5.15 5.15l1.4 1.4M17.45 17.45l1.4 1.4M5.15 18.85l1.4-1.4M17.45 6.55l1.4-1.4" />
                    </g>
                  </svg>
                </span>
              </El>
              <span className={`${styles.toolClusterBtn} ${styles.headerStatic}`} aria-hidden>
                <svg viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  />
                  <path
                    d="M19.4 13a7.9 7.9 0 0 0 .1-2l2-1.5-2-3.5-2.3.7a8 8 0 0 0-1.7-1L15 3h-6l-.5 2.7a8 8 0 0 0-1.7 1L4.5 6 2.5 9.5l2 1.5a7.9 7.9 0 0 0 0 2l-2 1.5 2 3.5 2.3-.7a8 8 0 0 0 1.7 1L9 21h6l.5-2.7a8 8 0 0 0 1.7-1l2.3.7 2-3.5-2-1.5Z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            </span>
          </div>
        </div>
        <DragBar
          label={t("settings.chatHeaderSizeHint")}
          value={headerHeight}
          min={40}
          max={72}
          onChange={onHeaderHeight}
        />
      </div>

      <div className={styles.body}>
        {/* ── Tree ──────────────────────────────────────────────── */}
        {mobileTreeOpen ? (
          <button
            type="button"
            className={styles.treeOverlay}
            onClick={() => setMobileTreeOpen(false)}
            aria-label={t("common.backToChat")}
          />
        ) : null}
        <div className={`${styles.column} ${mobileTreeOpen ? styles.columnOpen : ""}`}>
          <div className={styles.tree}>
            <div
              className={`${styles.treeToolbar} ${
                toolbarMinimal ? styles.treeToolbarMinimal : styles.treeToolbarClassic
              }`}
            >
              <span
                className={
                  toolbarMinimal ? styles.treeToolbarRow : styles.treeToolbarClassicNew
                }
                aria-hidden
              >
                {toolbarMinimal ? (
                  <>
                    {newChatIcon(13)}
                    {t("common.newChat")}
                  </>
                ) : (
                  <>
                    <span className={styles.treeToolbarClassicNewIcon}>{newChatIcon(14)}</span>
                    <span>{t("common.newChat")}</span>
                  </>
                )}
              </span>

              <El
                on={treeOn("search")}
                variant="dim"
                className={styles.treeToolbarSearchEl}
                onToggle={() => onToggleTreeElement("search")}
                label={t("settings.chatTreeElSearch")}
              >
                <span
                  className={
                    toolbarMinimal ? styles.treeToolbarRow : styles.treeToolbarClassicSearch
                  }
                  aria-hidden
                >
                  {searchIcon(12)}
                  <span className={styles.treeToolbarSearchLabel}>
                    {t("chat.searchPlaceholder")}
                  </span>
                  {!toolbarMinimal ? (
                    <kbd className={styles.treeToolbarSearchKbd} aria-hidden>
                      /
                    </kbd>
                  ) : null}
                </span>
              </El>
            </div>

            <div className={styles.treeFolder}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M3.5 8.5V7a2 2 0 0 1 2-2h4.2l1.6 1.7H18.5a2 2 0 0 1 2 2v1"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M3.5 10.2h17v6.3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-6.3Z"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
              </svg>
              <span className={styles.treeFolderLabel}>E:\share\acpio</span>
              {/* Mandatory: folder add */}
              <span className={styles.treeAdd} aria-hidden>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                  <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                </svg>
              </span>
            </div>

            {[
              { title: t("settings.chatPreviewChatTitle"), busy: true },
              { title: t("settings.chatPreviewChatTitle2"), busy: false },
            ].map((row, i) => (
              <div
                key={row.title}
                className={`${styles.treeRow}${i === 0 ? ` ${styles.treeRowActive}` : ""}`}
              >
                <span className={styles.treeRowTitle}>
                  {row.title}
                  
                </span>
                <El
                  on={treeOn("pin")} variant="dim"
                  onToggle={() => onToggleTreeElement("pin")}
                  label={t("settings.chatTreeElPin")}
                >
                  <span className={styles.treeAct} aria-hidden>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M9.2 4h5.6l.6 4.8 2.6 2.2v2.6H6v-2.6l2.6-2.2.6-4.8Z"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinejoin="round"
                      />
                      <path d="M12 13.6V20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </span>
                </El>
                <El
                  on={treeOn("archive")} variant="dim"
                  onToggle={() => onToggleTreeElement("archive")}
                  label={t("settings.chatTreeElArchive")}
                >
                  <span className={styles.treeAct} aria-hidden>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M4.5 7.5h15V18a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V7.5Z"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinejoin="round"
                      />
                      <path d="M4.5 7.5V5.5A1.5 1.5 0 0 1 6 4h12a1.5 1.5 0 0 1 1.5 1.5v2" stroke="currentColor" strokeWidth="1.5" />
                    </svg>
                  </span>
                </El>
                {treeMenu.length > 0 ? (
                  <span
                    className={styles.treeAct}
                    aria-hidden
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setTreeMenuPos({ top: r.bottom + 4, left: r.left });
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                      <circle cx="5" cy="12" r="1.5" />
                      <circle cx="12" cy="12" r="1.5" />
                      <circle cx="19" cy="12" r="1.5" />
                    </svg>
                  </span>
                ) : null}
              </div>
            ))}

            <El
              on={showArchive} variant="dim"
              onToggle={onToggleShowArchive}
              label={t("settings.chatTreeElArchive")}
            >
              <span className={styles.treeArchiveHead} aria-hidden>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M4.5 7.5h15V18a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V7.5Z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                  />
                  <path d="M4.5 7.5V5.5A1.5 1.5 0 0 1 6 4h12a1.5 1.5 0 0 1 1.5 1.5v2" stroke="currentColor" strokeWidth="1.5" />
                </svg>
                {t("chat.archiveSection")}
                <span className={styles.treeArchiveCount}>2</span>
              </span>
            </El>
          </div>
        </div>

        {treeMenuPos ? (
          <div
            ref={treeMenuRef}
            className={styles.treeMenuPop}
            role="menu"
            style={{ top: treeMenuPos.top, left: treeMenuPos.left }}
          >
            {TREE_MENU_ORDER.map((id) => (
              <El
                key={id}
                variant="dim"
                on={menuOn(id)}
                onToggle={() => onToggleTreeMenu(id)}
                label={t(TREE_MENU_LABEL_KEY[id] as "common.delete")}
              >
                <span className={styles.treeMenuItem}>
                  {t(TREE_MENU_LABEL_KEY[id] as "common.delete")}
                </span>
              </El>
            ))}
          </div>
        ) : null}

        {/* ── Chat ──────────────────────────────────────────────── */}
        <div className={`${styles.column} ${styles.chatColumn}`}>
          <span className={styles.previewSplitSlot}>
          <El
            on={chatSplit}
            onToggle={onToggleChatSplit}
            label={t("settings.chatSplit")}
          >
            <span className={styles.previewSplitFab} aria-hidden>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                <rect x="3.75" y="5.5" width="7" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.7" />
                <rect
                  x="13.25"
                  y="5.5"
                  width="7"
                  height="13"
                  rx="1.5"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  opacity="0.55"
                />
              </svg>
            </span>
          </El>
          </span>
          <button
            type="button"
            className={styles.mobileTreeBtn}
            onClick={() => setMobileTreeOpen((v) => !v)}
          >
            {mobileTreeOpen ? "✕" : "☰"}
          </button>
          <div className={styles.chatPane}>
            <div className={styles.thread}>
              <div className={styles.threadInner}>
              <div className={`${styles.msgRow} ${styles.userMsg}`}>
                <div className={styles.userBubble}>
                  {t("settings.chatPreviewUser")}
                  {showTime ? <span className={styles.time}>{now}</span> : null}
                </div>
              </div>
              <div className={`${styles.msgRow} ${styles.userActionsRow}`}>
                <PreviewActions
                  actions={userBarActions}
                  ordered={orderedFor(USER_APPLICABLE)}
                  onToggle={onToggleAction}
                  onReorder={handleReorder}
                />
              </div>

              <div className={`${styles.msgRow} ${styles.assistantMsg}`}>
                <div className={styles.assistantCol}>
                  {agentTurnTimeline ? (
                    <>
                      <PreviewWork
                        label={t("common.working")}
                        time={formatDuration(4300, locale, t)}
                      >
                        <PreviewToolRow time={formatDuration(1100, locale, t)} />
                        <PreviewReasoning time={formatDuration(2200, locale, t)} open />
                      </PreviewWork>
                      <div className={styles.pvText}>{t("settings.chatPreviewNote")}</div>
                      <PreviewWork
                        label={t("common.working")}
                        time={formatDuration(600, locale, t)}
                      >
                        <PreviewToolRow time="" />
                      </PreviewWork>
                    </>
                  ) : (
                    <PreviewWork
                      label={t("common.worked")}
                      time={formatDuration(6000, locale, t)}
                    >
                      <PreviewToolRow time={formatDuration(1100, locale, t)} />
                      <PreviewReasoning time={formatDuration(2200, locale, t)} open />
                    </PreviewWork>
                  )}
                  <div className={styles.assistantText}>
                    {t("settings.chatPreviewAssistant")}
                    {showTime ? <span className={styles.time}>{now}</span> : null}
                  </div>
                  <div className={styles.typing} aria-hidden>
                    <span />
                    <span />
                    <span />
                  </div>
                  <PreviewActions
                    actions={mainBarActions}
                    ordered={orderedFor(BOT_APPLICABLE)}
                    onToggle={onToggleAction}
                    onReorder={handleReorder}
                  />
                </div>
              </div>
              </div>
            </div>

            <div className={styles.composer}>
              <div className={styles.composerTopRow}>
                <PreviewMetaChips
                  chips={chips}
                  ordered={chipDisplayOrder}
                  onToggle={onToggleChip}
                  onReorder={handleChipReorder}
                  gitBranchAbove={gitBranchChipOn && chatGitBranchPosition === "above"}
                  onGitBranchPositionChange={onGitBranchPositionChange}
                />
                <div className={styles.composerModeSlot}>
                  <El
                    on={btnOn("mode")}
                    variant="dim"
                    onToggle={() => onToggleComposerButton("mode")}
                    label={t("settings.chatComposerBtnMode")}
                  >
                    <span className={styles.composerChip} aria-hidden>
                      {t("modes.agent")}
                    </span>
                  </El>
                </div>
              </div>
              <div className={styles.pill}>
                <El
                  on={btnOn("attach")} variant="dim"
                  onToggle={() => onToggleComposerButton("attach")}
                  label={t("settings.chatComposerBtnAttach")}
                >
                  <span className={styles.composerBtn} aria-hidden>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                </El>
                <span className={styles.inputMock}>{t("common.messageOrCommand")}</span>
                <El
                  on={btnOn("model")} variant="dim"
                  onToggle={() => onToggleComposerButton("model")}
                  label={t("settings.chatComposerBtnModel")}
                >
                  <span className={styles.composerChip} aria-hidden>
                    {t("models.auto")}
                  </span>
                </El>
                <El
                  on={btnOn("mic")} variant="dim"
                  onToggle={() => onToggleComposerButton("mic")}
                  label={t("settings.chatComposerBtnMic")}
                >
                  <span className={`${styles.composerBtn} ${styles.composerBtnRound}`} aria-hidden>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                      <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.7" />
                      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                    </svg>
                  </span>
                </El>
                <span className={styles.sendMock} aria-hidden>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M12 19V5M12 5l-6 6M12 5l6 6"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              </div>
              {gitBranchChipOn ? (
                <div
                  className={`${styles.gitDropZoneBelow}${showGitBranchFooter ? ` ${styles.gitDropZoneActive}` : ""}`}
                  data-git-zone="below"
                >
                  {showGitBranchFooter ? (
                    <PreviewGitBranch
                      position="below"
                      onPositionChange={onGitBranchPositionChange}
                    />
                  ) : (
                    <span className={styles.previewGitDropZoneHint}>{t("settings.chatGitBranchDropZone")}</span>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
