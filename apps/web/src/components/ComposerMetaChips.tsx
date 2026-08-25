import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { AgentMode, AppSettings, SessionDetailDto } from "@acprocess/shared";
import { useT } from "../lib/i18n";
import { OptionPicker } from "./OptionPicker";
import styles from "../pages/ChatPage.module.css";

const DESKTOP_MQ = "(min-width: 701px)";

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
  consoleLive,
  modeSwitcher,
  sessionMode,
  composerLocked,
  onModeChange,
  onOpenMcpDialog,
  modeLabel,
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
  consoleLive: boolean;
  modeSwitcher: Array<{ value: string; name?: string }>;
  sessionMode: AgentMode;
  composerLocked: boolean;
  onModeChange: (value: string) => void;
  onOpenMcpDialog: () => void;
  modeLabel: (value: string, fallback?: string) => string;
}) {
  const t = useT();
  const isDesktop = useDesktopMetaLayout();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [composerMetaEdge, setComposerMetaEdge] = useState({ left: false, right: false });

  const showMode =
    modeSwitcher.length > 0 && (settings.chatComposerButtons ?? []).includes("mode");

  const chipNodes = useMemo((): ReactNode[] => {
    const nodes: ReactNode[] = [];

    if (settings.chatMetaChips.includes("folder") && activeSession?.cwd?.trim()) {
      nodes.push(
        <div key="folder" className={styles.sessionCwd} title={activeSession.cwd}>
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
          <span className={styles.sessionCwdText}>{activeSession.cwd}</span>
        </div>,
      );
    }

    if (settings.chatMetaChips.includes("thoughts")) {
      nodes.push(
        <button
          key="thoughts"
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
        </button>,
      );
    }

    if (settings.chatMetaChips.includes("mcp") && activeSession && enabledMcpCount > 0) {
      nodes.push(
        <button
          key="mcp"
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
        </button>,
      );
    }

    if (settings.chatMetaChips.includes("context") && activeSession) {
      nodes.push(
        <span
          key="context"
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
        </span>,
      );
    }

    if (settings.chatMetaChips.includes("console") && activeSession) {
      nodes.push(
        <button
          key="console"
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
          {consoleLive ? <span className={styles.metaChipLiveDot} aria-hidden /> : null}
        </button>,
      );
    }

    return nodes;
  }, [
    activeSession,
    autoExpandSteps,
    chatMcp,
    consoleLive,
    consoleOpen,
    contextDisplay.label,
    contextDisplay.title,
    enabledMcpCount,
    onOpenMcpDialog,
    onToggleAutoExpandSteps,
    onToggleConsole,
    settings.chatMetaChips,
    settings.consoleChipStyle,
    settings.thoughtsChipStyle,
    t,
  ]);

  const chipKey = [
    settings.chatMetaChips.join(","),
    activeSession?.id ?? "",
    enabledMcpCount,
    contextDisplay.label,
    modeSwitcher.length,
  ].join("|");

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
  }, [chipKey, isDesktop, renderSkeleton]);

  const modePicker =
    showMode && !renderSkeleton ? (
      <OptionPicker
        className={styles.composerMode}
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
    ) : null;

  return (
    <div
      className={`${styles.composerMetaShell} ${
        !renderSkeleton && !isDesktop && composerMetaEdge.left ? styles.composerMetaFadeLeft : ""
      } ${!renderSkeleton && !isDesktop && composerMetaEdge.right ? styles.composerMetaFadeRight : ""}`}
    >
      <div
        ref={scrollRef}
        className={styles.composerMeta}
        aria-busy={renderSkeleton || undefined}
      >
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
            <span
              className={`${styles.metaChipSkeleton} ${styles.metaChipSkeletonMode}`}
              style={{ "--w": "4.8rem" } as CSSProperties}
              aria-hidden
            />
          </>
        ) : (
          <>
            {chipNodes}
            {modePicker}
          </>
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
    </div>
  );
}
