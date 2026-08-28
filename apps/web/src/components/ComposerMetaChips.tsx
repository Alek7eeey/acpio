import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { AgentMode, AppSettings, ChatMetaChipId, SessionDetailDto, GitStatusDto } from "@acpio/shared";
import { isShellSession } from "@acpio/shared";
import { useT } from "../lib/i18n";
import { OptionPicker } from "./OptionPicker";
import { ComposerGitChangesButton, GitChangesChipLoader } from "./ComposerGitBar";
import gitBarStyles from "./ComposerGitBar.module.css";
import { MiddleTruncate } from "./MiddleTruncate";
import styles from "../pages/ChatPage.module.css";

const DESKTOP_MQ = "(min-width: 701px)";
const META_CHIP_GAP = 8;
const MORE_BTN_WIDTH = 88;
const MENU_VIEWPORT_PAD = 12;

function placeOverflowMenu(menu: HTMLElement, anchor: DOMRect) {
  const pad = MENU_VIEWPORT_PAD;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;

  let left = anchor.left;
  if (left + mw > vw - pad) {
    left = anchor.right - mw;
  }
  left = Math.min(Math.max(pad, left), Math.max(pad, vw - pad - mw));

  let top = anchor.top - 8 - mh;
  if (top < pad) {
    top = anchor.bottom + 8;
  }
  top = Math.min(Math.max(pad, top), Math.max(pad, vh - pad - mh));

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.transform = "none";
}

function useDesktopMetaLayout() {
  const [desktop, setDesktop] = useState(
    () => typeof window !== "undefined" && window.matchMedia(DESKTOP_MQ).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_MQ);
    const sync = () => setDesktop(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return desktop;
}

function ThoughtSparkIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3.2 13.2 8.1 18 9.3 13.2 10.5 12 15.4 10.8 10.5 6 9.3 10.8 8.1 12 3.2Z"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinejoin="round"
      />
      <path
        d="M18.2 14.2 18.8 16.6 21.2 17.2 18.8 17.8 18.2 20.2 17.6 17.8 15.2 17.2 17.6 16.6 18.2 14.2Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M6.2 13.8 6.7 15.8 8.7 16.3 6.7 16.8 6.2 18.8 5.7 16.8 3.7 16.3 5.7 15.8 6.2 13.8Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type MetaChipId = ChatMetaChipId | "plan";

type MetaChipItem = {
  id: MetaChipId;
  node: ReactNode;
};

export function ComposerMetaChips({
  renderSkeleton,
  settings,
  activeSession,
  autoExpandSteps,
  onToggleAutoExpandSteps,
  chatMcp,
  enabledMcpCount,
  contextDisplay,
  consoleOpen,
  onToggleConsole,
  modeSwitcher,
  sessionMode,
  composerLocked,
  onModeChange,
  onOpenMcpDialog,
  modeLabel,
  planChip,
  gitChip,
  trailing,
}: {
  renderSkeleton: boolean;
  settings: AppSettings;
  activeSession: SessionDetailDto | null;
  autoExpandSteps: boolean;
  onToggleAutoExpandSteps: () => void;
  chatMcp: Array<{ id: string; name: string }>;
  enabledMcpCount: number;
  contextDisplay: { label: string; title: string };
  consoleOpen: boolean;
  onToggleConsole: () => void;
  modeSwitcher: Array<{ value: string; name?: string }>;
  sessionMode: AgentMode;
  composerLocked: boolean;
  onModeChange: (value: string) => void;
  onOpenMcpDialog: () => void;
  modeLabel: (value: string, fallback?: string) => string;
  planChip?: {
    visible: boolean;
    open: boolean;
    pending?: boolean;
    onClick: () => void;
  };
  gitChip?: {
    status: GitStatusDto | null;
    loading?: boolean;
    awaiting?: boolean;
    branchBusy: boolean;
    onCheckout: (branch: string, create?: boolean) => Promise<void>;
    changesOpen: boolean;
    onOpenChanges: () => void;
  };
  trailing?: ReactNode;
}) {
  const t = useT();
  const isDesktop = useDesktopMetaLayout();

  const shellRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const modeRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuAnchorRef = useRef<DOMRect | null>(null);
  const chipRefs = useRef(new Map<MetaChipId, HTMLElement>());
  const chipWidthsRef = useRef(new Map<MetaChipId, number>());

  const [composerMetaEdge, setComposerMetaEdge] = useState({ left: false, right: false });
  const [visibleCount, setVisibleCount] = useState<number | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [overflowMenuReady, setOverflowMenuReady] = useState(false);

  const showMode =
    modeSwitcher.length > 0 && (settings.chatComposerButtons ?? []).includes("mode");

  const chipItems = useMemo((): MetaChipItem[] => {
    const items: MetaChipItem[] = [];

    if (planChip?.visible && !isDesktop) {
      items.push({
        id: "plan",
        node: (
          <button
            type="button"
            className={`${styles.metaChip} ${styles.metaChipIconOnly}${
              planChip.open ? ` ${styles.metaChipActive}` : ""
            }${planChip.pending ? ` ${styles.metaChipPending}` : ""}`}
            aria-pressed={planChip.open}
            aria-label={t("planPanel.title")}
            title={t("planPanel.title")}
            onClick={planChip.onClick}
          >
            <span className={styles.metaChipIcon} aria-hidden>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                <path
                  d="M8 6h13M8 12h13M8 18h9"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
                <path
                  d="M4 6h.01M4 12h.01M4 18h.01"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            {planChip.pending ? <span className={styles.metaChipLiveDot} aria-hidden /> : null}
          </button>
        ),
      });
    }

    for (const id of settings.chatMetaChips) {
      let node: ReactNode | null = null;

      if (id === "folder" && activeSession?.cwd?.trim()) {
        node = (
          <div className={styles.sessionCwd}>
            <span className={styles.sessionCwdIcon} aria-hidden>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
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
            </span>
            <MiddleTruncate text={activeSession.cwd} className={styles.sessionCwdText} />
          </div>
        );
      } else if (id === "git" && (gitChip?.awaiting || gitChip?.loading)) {
        node = (
          <div className={gitBarStyles.barComposerFooter}>
            <GitChangesChipLoader premium />
          </div>
        );
      } else if (id === "git" && gitChip?.status?.repo) {
        node = (
          <div className={gitBarStyles.barComposerFooter}>
            <ComposerGitChangesButton
              status={gitChip.status}
              changesOpen={gitChip.changesOpen}
              onOpenChanges={gitChip.onOpenChanges}
              premium
            />
          </div>
        );
      } else if (id === "thoughts") {
        node = (
          <button
            type="button"
            className={`${styles.metaChip} ${autoExpandSteps ? styles.metaChipActive : ""}${
              settings.thoughtsChipStyle === "icon" ? ` ${styles.metaChipIconOnly}` : ""
            }`}
            aria-pressed={autoExpandSteps}
            aria-label={t("common.autoSteps")}
            title={t("common.autoStepsHint")}
            onClick={onToggleAutoExpandSteps}
          >
            <span className={styles.metaChipIcon} aria-hidden>
              <ThoughtSparkIcon size={15} />
            </span>
            {settings.thoughtsChipStyle !== "icon" ? (
              <span className={styles.metaChipLabel}>{t("common.autoSteps")}</span>
            ) : null}
          </button>
        );
      } else if (id === "mcp" && activeSession && enabledMcpCount > 0) {
        node = (
          <button
            type="button"
            className={styles.metaChip}
            aria-label={t("chat.mcpChipTitle", {
              names:
                chatMcp.length > 0 ? chatMcp.map((s) => s.name).join(", ") : t("chat.mcpChipNone"),
            })}
            title={t("chat.mcpChipTitle", {
              names:
                chatMcp.length > 0 ? chatMcp.map((s) => s.name).join(", ") : t("chat.mcpChipNone"),
            })}
            onClick={onOpenMcpDialog}
          >
            <span className={styles.metaChipIcon} aria-hidden>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path
                  d="M9 2v5M15 2v5M7 7h10v3a5 5 0 0 1-5 5 5 5 0 0 1-5-5V7ZM12 15v6"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className={styles.metaChipLabel}>
              {t("chat.mcpChipCount", { count: chatMcp.length })}
            </span>
          </button>
        );
      } else if (id === "context" && activeSession) {
        node = (
          <span
            className={`${styles.metaChip} ${styles.metaChipForceLabel}`}
            title={contextDisplay.title}
          >
            <span className={styles.metaChipIcon} aria-hidden>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path
                  d="M12 3 3 8l9 5 9-5-9-5ZM3 16l9 5 9-5M3 12l9 5 9-5"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className={styles.metaChipLabel}>{contextDisplay.label}</span>
          </span>
        );
      } else if (id === "console" && activeSession && !isShellSession(activeSession.provider)) {
        node = (
          <button
            type="button"
            className={`${styles.metaChip} ${consoleOpen ? styles.metaChipActive : ""}${
              settings.consoleChipStyle === "icon" ? ` ${styles.metaChipIconOnly}` : ""
            }`}
            aria-pressed={consoleOpen}
            aria-label={t("console.title")}
            title={t("console.chipHint")}
            onClick={onToggleConsole}
          >
            <span className={styles.metaChipIcon} aria-hidden>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path
                  d="M4 6h16M4 10h10M4 14h14M4 18h8"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            {settings.consoleChipStyle !== "icon" ? (
              <span className={styles.metaChipLabel}>{t("console.title")}</span>
            ) : null}
          </button>
        );
      }

      if (node) items.push({ id, node });
    }

    return items;
  }, [
    activeSession,
    autoExpandSteps,
    chatMcp,
    consoleOpen,
    contextDisplay.label,
    contextDisplay.title,
    enabledMcpCount,
    gitChip,
    isDesktop,
    onOpenMcpDialog,
    onToggleAutoExpandSteps,
    onToggleConsole,
    planChip,
    settings.chatMetaChips,
    settings.consoleChipStyle,
    settings.thoughtsChipStyle,
    t,
  ]);

  const chipKey = chipItems.map((item) => item.id).join(",");
  const measuring = isDesktop && visibleCount === null && !renderSkeleton;
  const overflowCount =
    isDesktop && visibleCount !== null ? Math.max(0, chipItems.length - visibleCount) : 0;
  const overflowItems =
    isDesktop && visibleCount !== null ? chipItems.slice(visibleCount) : [];

  const computeVisibleCount = useCallback(
    (captureWidths: boolean) => {
      const shell = shellRef.current;
      if (!shell) return chipItems.length;

      const gap = META_CHIP_GAP;
      const containerW = shell.clientWidth;
      const modeW = showMode && modeRef.current ? modeRef.current.offsetWidth + gap : 0;

      if (captureWidths) {
        for (const item of chipItems) {
          const el = chipRefs.current.get(item.id);
          if (el) chipWidthsRef.current.set(item.id, el.offsetWidth);
        }
      }

      const widths = chipItems.map((item) => chipWidthsRef.current.get(item.id) ?? 0);
      if (widths.some((w) => w <= 0)) return chipItems.length;

      for (let visible = chipItems.length; visible >= 0; visible -= 1) {
        const hidden = chipItems.length - visible;
        let chipsW = 0;
        for (let i = 0; i < visible; i += 1) {
          chipsW += widths[i];
          if (i > 0) chipsW += gap;
        }
        const moreW = hidden > 0 ? MORE_BTN_WIDTH + gap : 0;
        if (chipsW + modeW + moreW <= containerW + 1) return visible;
      }
      return 0;
    },
    [chipItems, showMode],
  );

  useEffect(() => {
    chipWidthsRef.current.clear();
    setVisibleCount(null);
    setOverflowOpen(false);
  }, [chipKey]);

  useEffect(() => {
    if (!isDesktop) setVisibleCount(null);
  }, [isDesktop]);

  useLayoutEffect(() => {
    if (!isDesktop || renderSkeleton) return;
    if (visibleCount !== null) return;
    if (chipItems.length === 0) {
      setVisibleCount(0);
      return;
    }
    const next = computeVisibleCount(true);
    setVisibleCount(next);
  }, [chipItems.length, chipKey, computeVisibleCount, isDesktop, renderSkeleton, visibleCount]);

  useEffect(() => {
    if (!isDesktop || renderSkeleton || visibleCount === null) return;
    const shell = shellRef.current;
    if (!shell) return;
    const onResize = () => {
      const next = computeVisibleCount(false);
      setVisibleCount((prev) => (prev === next ? prev : next));
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(shell);
    const mode = modeRef.current;
    if (mode) ro.observe(mode);
    return () => ro.disconnect();
  }, [chipKey, computeVisibleCount, isDesktop, renderSkeleton, showMode, visibleCount]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || isDesktop) return;
    const sync = () => {
      const max = el.scrollWidth - el.clientWidth;
      const left = el.scrollLeft > 2;
      const right = max > 2 && el.scrollLeft < max - 2;
      setComposerMetaEdge((prev) =>
        prev.left === left && prev.right === right ? prev : { left, right },
      );
    };
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", sync);
      ro.disconnect();
    };
  }, [chipKey, isDesktop, renderSkeleton, trailing]);

  useLayoutEffect(() => {
    if (!overflowOpen || !menuAnchorRef.current) return;

    const place = () => {
      const menu = menuRef.current;
      const anchor = menuAnchorRef.current;
      if (!menu || !anchor) return;
      placeOverflowMenu(menu, anchor);
      setOverflowMenuReady(true);
    };

    place();
    window.addEventListener("resize", place);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      window.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [overflowOpen, overflowItems.length]);

  useEffect(() => {
    if (!overflowOpen) {
      setOverflowMenuReady(false);
      menuAnchorRef.current = null;
    }
  }, [overflowOpen]);

  useEffect(() => {
    if (!overflowOpen) return;
    const close = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setOverflowOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOverflowOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [overflowOpen]);

  const openOverflowMenu = (anchor: HTMLElement) => {
    menuAnchorRef.current = anchor.getBoundingClientRect();
    setOverflowMenuReady(false);
    setOverflowOpen(true);
  };

  const modePicker =
    showMode && !renderSkeleton ? (
      <div ref={modeRef} className={styles.composerMode}>
        <OptionPicker
          variant="quiet"
          placement="up"
          menuTitle={t("modes.label")}
          value={
            modeSwitcher.some((m) => m.value === sessionMode)
              ? sessionMode
              : (modeSwitcher[0]?.value ?? "agent")
          }
          disabled={composerLocked}
          onChange={(v) => void onModeChange(v)}
          options={modeSwitcher.map((m) => ({
            value: m.value,
            label: modeLabel(m.value, m.name),
          }))}
        />
      </div>
    ) : null;

  return (
    <div
      ref={shellRef}
      className={`${styles.composerMetaShell} ${isDesktop ? styles.composerMetaShellDesktop : ""} ${
        !renderSkeleton && !isDesktop && composerMetaEdge.left ? styles.composerMetaFadeLeft : ""
      } ${!renderSkeleton && !isDesktop && composerMetaEdge.right ? styles.composerMetaFadeRight : ""}`}
    >
      <div
        ref={scrollRef}
        className={`${styles.composerMeta} ${isDesktop ? styles.composerMetaDesktop : ""}`}
        aria-busy={renderSkeleton || undefined}
      >
        <div className={styles.composerMetaStart}>
          {renderSkeleton ? (
            <>
              <span
                className={styles.metaChipSkeleton}
                style={{ "--w": "7.2rem" } as CSSProperties}
                aria-hidden
              />
              <span
                className={styles.metaChipSkeleton}
                style={{ "--w": "6.4rem" } as CSSProperties}
                aria-hidden
              />
              <span
                className={styles.metaChipSkeleton}
                style={{ "--w": "4.2rem" } as CSSProperties}
                aria-hidden
              />
              <span
                className={styles.metaChipSkeleton}
                style={{ "--w": "5.6rem" } as CSSProperties}
                aria-hidden
              />
            </>
          ) : (
            chipItems.map((item, index) => {
              const hidden =
                isDesktop && !measuring && visibleCount !== null && index >= visibleCount;
              return (
                <div
                  key={item.id}
                  ref={(el) => {
                    if (el) chipRefs.current.set(item.id, el);
                    else chipRefs.current.delete(item.id);
                  }}
                  className={hidden ? styles.composerMetaChipHidden : styles.composerMetaChipWrap}
                >
                  {item.node}
                </div>
              );
            })
          )}
          {!renderSkeleton && trailing && !isDesktop ? (
            <div className={`${styles.composerMetaChipWrap} ${styles.composerMetaTrailing}`}>
              {trailing}
            </div>
          ) : null}
          {!renderSkeleton && isDesktop && overflowCount > 0 ? (
            <button
              type="button"
              className={styles.composerMetaMoreBtn}
              aria-expanded={overflowOpen}
              aria-haspopup="menu"
              title={t("chat.metaChipsMoreTitle", { count: overflowCount })}
              onClick={(e) => {
                if (overflowOpen) setOverflowOpen(false);
                else openOverflowMenu(e.currentTarget);
              }}
            >
              {t("chat.metaChipsMore", { count: overflowCount })}
            </button>
          ) : null}
        </div>
        {renderSkeleton ? (
          <span
            className={`${styles.metaChipSkeleton} ${styles.metaChipSkeletonMode}`}
            style={{ "--w": "4.8rem" } as CSSProperties}
            aria-hidden
          />
        ) : (
          modePicker
        )}
      </div>

      {!renderSkeleton && !isDesktop && composerMetaEdge.right ? (
        <span className={styles.composerMetaMore} aria-hidden>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <path
              d="M9 6l6 6-6 6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      ) : null}

      {overflowOpen && overflowItems.length > 0
        ? createPortal(
            <div
              ref={menuRef}
              className={styles.composerMetaOverflowMenu}
              style={{ visibility: overflowMenuReady ? "visible" : "hidden" }}
              role="menu"
            >
              {overflowItems.map((item) => (
                <div
                  key={item.id}
                  className={styles.composerMetaOverflowItem}
                  role="none"
                  onClick={() => setOverflowOpen(false)}
                >
                  {item.node}
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
