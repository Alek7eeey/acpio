import { Link } from "react-router-dom";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  migrateModelParamValues,
  peelAnswerFromThought,
  usesCloudModelCatalog,
  type AgentMode,
  type MessageDto,
  type MessagePartDto,
  type ModelParamDto,
  type SlashCommandDto,
} from "@acprocess/shared";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { sanitizeCatalogModes, useAppStore } from "../lib/store";
import { ModelPicker } from "../components/ModelPicker";
import { HoverTip } from "../components/HoverTip";
import { ChatInlinePrompt } from "../components/ChatInlinePrompt";
import { PlanSidePanel, PlanTabButton } from "../components/PlanSidePanel";
import { coercePlanPayload, type PlanPayload } from "../components/PlanApprovalBody";
import { OptionPicker } from "../components/OptionPicker";
import {
  collectRecentCwds,
  CreateSessionFolderPicker,
} from "../components/CreateSessionFolderPicker";
import { MarkdownContent } from "../components/MarkdownContent";
import { SlashCommandMenu } from "../components/SlashCommandMenu";
import {
  buildSlashInsertion,
  filterSlashCommands,
  getSlashContext,
  isSlashCommandReadyToSend,
  mergeSlashCommands,
  parseSlashCommandText,
  slashCommandRequiresInput,
} from "../lib/slashCommands";
import styles from "./ChatPage.module.css";

/** Desktop-only: avoid popping the mobile keyboard during stream / scroll updates. */
function shouldAutoFocusComposer() {
  if (typeof window === "undefined") return true;
  return window.matchMedia("(pointer: fine)").matches;
}

function UserMessage({
  message,
  slashCommands,
  onEdit,
}: {
  message: MessageDto;
  slashCommands: SlashCommandDto[];
  onEdit: (messageId: string, text: string) => void;
}) {
  const t = useT();
  const text = message.parts
    .filter((p) => p.type === "text")
    .map((p) => String(p.payload.text ?? ""))
    .join("\n")
    .trim();
  const explicitCommand = message.parts.some(
    (p) => p.type === "text" && Boolean(p.payload.isSlashCommand),
  );
  const parsed = parseSlashCommandText(text);
  const isCommand = explicitCommand || Boolean(parsed);

  if (!text) return null;

  const body =
    isCommand && parsed ? (
      <div className={styles.userCommand}>
        <div className={styles.userCommandHeader}>
          <span className={styles.userCommandBadge}>{t("common.command")}</span>
          <code className={styles.userCommandName}>/{parsed.name}</code>
        </div>
        {parsed.args ? (
          <p className={styles.userCommandArgs}>{parsed.args}</p>
        ) : metaDescription(slashCommands, parsed.name) ? (
          <p className={styles.userCommandDesc}>{metaDescription(slashCommands, parsed.name)}</p>
        ) : null}
      </div>
    ) : (
      <div className={styles.userBubble} contentEditable={false} suppressContentEditableWarning>
        {message.parts.map((part) =>
          part.type === "text" ? (
            <div key={part.id}>{String(part.payload.text ?? "")}</div>
          ) : (
            <PartView key={part.id} part={part} />
          ),
        )}
      </div>
    );

  return (
    <div className={styles.userMsg}>
      {body}
      <UserMessageActions text={text} onEdit={() => onEdit(message.id, text)} />
    </div>
  );
}

function metaDescription(slashCommands: SlashCommandDto[], name: string) {
  return slashCommands.find((c) => c.name.toLowerCase() === name.toLowerCase())?.description;
}

function MsgIcon({ children }: { children: ReactNode }) {
  return (
    <svg className={styles.msgActionIcon} viewBox="0 0 24 24" fill="none" aria-hidden>
      {children}
    </svg>
  );
}

function IconCopy({ done = false }: { done?: boolean }) {
  if (done) {
    return (
      <MsgIcon>
        <path
          d="M5 13l4 4L19 7"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </MsgIcon>
    );
  }
  return (
    <MsgIcon>
      <rect x="8" y="8" width="13" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.85" />
      <path
        d="M8 16H6.5A2.5 2.5 0 0 1 4 13.5v-9A2.5 2.5 0 0 1 6.5 2H15.5A2.5 2.5 0 0 1 18 4.5V8"
        stroke="currentColor"
        strokeWidth="1.85"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </MsgIcon>
  );
}

function IconEdit() {
  return (
    <MsgIcon>
      <path
        d="M4 20h4.8L20 8.8 15.2 4 4 15.2V20Z"
        stroke="currentColor"
        strokeWidth="1.85"
        strokeLinejoin="round"
      />
      <path d="M12.8 6.8 17.2 11.2" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" />
    </MsgIcon>
  );
}

function UserMessageActions({ text, onEdit }: { text: string; onEdit: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  };

  return (
    <div className={`${styles.msgActions} ${styles.userMsgActions}`} aria-label={t("common.actions")}>
      <button
        type="button"
        className={styles.msgAction}
        title={copied ? t("common.copied") : t("common.copy")}
        aria-label={t("common.copy")}
        onClick={() => void copy()}
      >
        <IconCopy done={copied} />
      </button>
      <button
        type="button"
        className={styles.msgAction}
        title={t("common.edit")}
        aria-label={t("common.edit")}
        onClick={() => onEdit()}
      >
        <IconEdit />
      </button>
    </div>
  );
}

function coalesceParts(
  parts: MessagePartDto[],
  opts?: { peelAnswer?: boolean },
): MessagePartDto[] {
  const out: MessagePartDto[] = [];
  for (const part of parts) {
    const prev = out[out.length - 1];
    if (
      prev &&
      part.type === prev.type &&
      (part.type === "thought" || part.type === "text")
    ) {
      const prevText = String(prev.payload.text ?? "");
      const nextText = String(part.payload.text ?? "");
      out[out.length - 1] = {
        ...prev,
        payload: { ...prev.payload, text: prevText + nextText },
      };
      continue;
    }
    // Merge any later thought into the first thought block of the message
    if (part.type === "thought") {
      const thoughtIdx = out.findIndex((p) => p.type === "thought");
      if (thoughtIdx >= 0) {
        const existing = out[thoughtIdx];
        out[thoughtIdx] = {
          ...existing,
          payload: {
            ...existing.payload,
            text: String(existing.payload.text ?? "") + String(part.payload.text ?? ""),
          },
        };
        continue;
      }
    }
    out.push(part);
  }

  // Display-only peel for history: never destroy the thought row (that caused
  // flicker when the server later sent the real text part).
  const peelAnswer = opts?.peelAnswer !== false;
  const hasText = out.some((p) => p.type === "text" && String(p.payload.text ?? "").trim());
  if (peelAnswer && !hasText) {
    const thoughtIdx = out.findIndex((p) => p.type === "thought");
    if (thoughtIdx >= 0) {
      const thought = out[thoughtIdx];
      const peeled = peelAnswerFromThought(String(thought.payload.text ?? ""));
      const answer = peeled.answer.trim();
      const remain = peeled.thought.trim();
      // Only split when we have a distinct answer — leave thought-only turns alone
      // until the server appends a real text part.
      if (answer && remain && answer !== remain) {
        out[thoughtIdx] = {
          ...thought,
          payload: { ...thought.payload, text: remain },
        };
        out.splice(thoughtIdx + 1, 0, {
          ...thought,
          id: `${thought.id}-peeled-answer`,
          type: "text",
          order: thought.order + 0.5,
          payload: { text: answer },
        });
      }
    }
  }

  // Keep single thought near the top of assistant content
  const thought = out.find((p) => p.type === "thought");
  const rest = out.filter((p) => p.type !== "thought");
  return thought ? [thought, ...rest] : out;
}

function extractStructuredText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (
      (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
      (trimmed.startsWith("{") && trimmed.endsWith("}"))
    ) {
      try {
        return extractStructuredText(JSON.parse(trimmed));
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => extractStructuredText(item))
      .filter(Boolean)
      .join("\n\n");
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.output === "string") return obj.output;
    if (typeof obj.result === "string") return obj.result;
    if (obj.content !== undefined) return extractStructuredText(obj.content);
  }
  return "";
}

function titleFromSubagentBody(text: string): string {
  const heading = text.match(/^###\s+([^\n\[]+?)(?:\s*\[|$)/m);
  if (heading?.[1]?.trim()) return heading[1].trim();
  const label = text.match(/^\s*Label:\s*(.+)$/m);
  if (label?.[1]?.trim()) return label[1].trim();
  const taskResult = text.match(/<task-result\b[^>]*\bid="([^"]+)"/i);
  if (taskResult?.[1]?.trim()) return taskResult[1].trim();
  return "";
}

function resolveSubagentTitle(part: MessagePartDto, body: string): string {
  const candidates = [
    part.payload.description,
    part.payload.title,
    (part.payload.raw as { title?: string; description?: string; name?: string; label?: string } | undefined)
      ?.title,
    (part.payload.raw as { description?: string } | undefined)?.description,
    (part.payload.raw as { name?: string } | undefined)?.name,
    (part.payload.raw as { label?: string } | undefined)?.label,
    titleFromSubagentBody(body),
    part.payload.subagentType,
  ]
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)
    .filter((v) => !/^(tool|task|subagent|субагент)$/i.test(v));
  return candidates[0] ?? "";
}

function resolveSubagentBody(part: MessagePartDto): string {
  const raw = (part.payload.raw as Record<string, unknown> | undefined) ?? {};
  return (
    extractStructuredText(part.payload.result) ||
    extractStructuredText(raw.result) ||
    extractStructuredText(raw.content) ||
    extractStructuredText(raw.output) ||
    extractStructuredText(part.payload.prompt) ||
    extractStructuredText(raw.prompt)
  ).trim();
}

function PartView({
  part,
  streaming,
  embedded = false,
}: {
  part: MessagePartDto;
  streaming?: boolean;
  embedded?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  const toggleProps = {
    type: "button" as const,
    tabIndex: -1,
    className: styles.partToggle,
    onMouseDown: (e: MouseEvent) => e.preventDefault(),
  };

  if (part.type === "text") {
    const text = String(part.payload.text ?? "");
    if (!text.trim()) return null;
    return (
      <MarkdownContent
        text={text}
        streaming={streaming}
        className={streaming ? styles.streaming : undefined}
      />
    );
  }

  if (part.type === "thought") {
    const text = String(part.payload.text ?? "").trim();
    if (!text) return null;
    const body = <pre className={styles.thoughtBody}>{text}</pre>;
    if (embedded) {
      return (
        <div className={`${styles.thoughtEmbedded} ${streaming ? styles.thoughtLive : ""}`}>
          {body}
        </div>
      );
    }
    // Standalone thoughts are folded into the thinking spoiler; keep a minimal fallback.
    return (
      <div
        className={`${styles.thought} ${open ? styles.thoughtOpen : ""} ${
          streaming ? styles.thoughtLive : ""
        }`}
      >
        <button {...toggleProps} onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className={styles.thoughtLabel}>
            {streaming && <span className={styles.pulseDot} />}
            {t("common.reasoning")}
          </span>
          <span className={styles.thoughtChevron} aria-hidden>
            {open ? "▾" : "▸"}
          </span>
        </button>
        {open && body}
      </div>
    );
  }

  if (part.type === "subagent") {
    const body = resolveSubagentBody(part);
    const title = resolveSubagentTitle(part, body);
    const status = String(part.payload.status ?? "");
    const live = streaming && status !== "completed" && status !== "failed";
    const label = title ? `${t("agent.subagent")} · ${title}` : t("agent.subagent");
    return (
      <div className={styles.subagent}>
        <button {...toggleProps} onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className={styles.thoughtLabel}>
            {live && <span className={styles.pulseDot} />}
            {label}
            {status === "failed" ? t("common.subagentFailed") : live ? t("common.subagentWorking") : ""}
          </span>
          <span className={styles.thoughtChevron} aria-hidden>
            {open ? "▾" : "▸"}
          </span>
        </button>
        {open && (
          <div className={styles.subagentBody}>
            {body ? (
              <MarkdownContent text={body} className={styles.subagentMarkdown} />
            ) : (
              <p className={styles.subagentPrompt}>{t("common.emptyList")}</p>
            )}
          </div>
        )}
      </div>
    );
  }

  // Regular tool calls stay hidden — only thoughts + subagent cards + answer text.
  if (part.type === "tool_call") {
    return null;
  }

  if (part.type === "error") {
    return <div className={styles.error}>{String(part.payload.message ?? t("common.error"))}</div>;
  }

  return null;
}

/** Icon for thinking toggle (composer) and in-message thinking header. */
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

function isThoughtPart(part: MessagePartDto) {
  return part.type === "thought" && Boolean(String(part.payload.text ?? "").trim());
}

function StepsSpoiler({
  parts,
  streaming,
  autoExpand,
}: {
  parts: MessagePartDto[];
  streaming: boolean;
  autoExpand: boolean;
}) {
  const t = useT();
  // Open with the turn so thinking doesn't appear as a second stage after the bubble.
  const [open, setOpen] = useState(() => Boolean(streaming || autoExpand));
  const thoughts = parts.filter(isThoughtPart);
  const startedAtRef = useRef<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    if (streaming) {
      setOpen(true);
      return;
    }
    if (autoExpand) setOpen(true);
  }, [autoExpand, streaming]);

  useEffect(() => {
    if (!streaming) return;
    if (startedAtRef.current == null) startedAtRef.current = Date.now();
    const tick = () => {
      const start = startedAtRef.current ?? Date.now();
      setElapsedSec(Math.max(1, Math.round((Date.now() - start) / 1000)));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [streaming]);

  useEffect(() => {
    if (streaming) return;
    if (startedAtRef.current == null) return;
    setElapsedSec(Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000)));
  }, [streaming]);

  // Show one stable thinking row for the whole turn (including empty pending).
  if (thoughts.length === 0 && !streaming) return null;

  // Same title while live — don't flip «Думаю…» ↔ «Размышления».
  const label = streaming
    ? t("common.steps")
    : elapsedSec > 0
      ? t("common.thoughtFor", { seconds: elapsedSec, count: elapsedSec })
      : t("common.steps");

  return (
    <div className={`${styles.steps} ${open ? styles.stepsOpen : ""}`}>
      <button
        type="button"
        tabIndex={-1}
        className={styles.stepsToggle}
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.stepsIcon}>
          <ThoughtSparkIcon size={16} />
        </span>
        <span className={styles.stepsTitle}>
          {streaming ? <span className={styles.pulseDot} /> : null}
          {label}
        </span>
        <span
          className={`${styles.stepsChevron} ${open ? styles.stepsChevronOpen : ""}`}
          aria-hidden
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <path
              d="M9 6l6 6-6 6"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>
      {open && thoughts.length > 0 && (
        <div className={styles.stepsBody}>
          {thoughts.map((part, idx) => (
            <PartView
              key={part.id}
              part={part}
              embedded
              streaming={streaming && idx === thoughts.length - 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function hasRenderableAssistantContent(parts: MessagePartDto[]) {
  return parts.some((p) => {
    if (p.type === "text" || p.type === "thought") {
      return Boolean(String(p.payload.text ?? "").trim());
    }
    if (p.type === "error") {
      return Boolean(String(p.payload.message ?? "").trim());
    }
    if (p.type === "subagent") {
      return true;
    }
    return false;
  });
}

function assistantPlainText(message: MessageDto) {
  return coalesceParts(message.parts)
    .filter((p) => p.type === "text")
    .map((p) => String(p.payload.text ?? ""))
    .join("\n\n")
    .trim();
}

function MessageActions({ text, hidden = false }: { text: string; hidden?: boolean }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  };

  return (
    <div
      className={`${styles.msgActions}${hidden ? ` ${styles.msgActionsHidden}` : ""}`}
      aria-label={t("common.actions")}
      aria-hidden={hidden}
    >
      <button
        type="button"
        className={styles.msgAction}
        title={copied ? t("common.copied") : t("common.copy")}
        aria-label={t("common.copy")}
        tabIndex={hidden ? -1 : undefined}
        onClick={() => void copy()}
      >
        <IconCopy done={copied} />
      </button>
      <HoverTip as="button" className={styles.msgAction} aria-label={t("common.like")} text={t("common.soon")}>
        <MsgIcon>
          <path
            d="M7 11v9H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h2Zm0 0 4.2-7.2A2.2 2.2 0 0 1 13.2 3h.3a2 2 0 0 1 2 2.3L14.8 11H20a2 2 0 0 1 2 2.3l-1.1 5.2A3 3 0 0 1 18 21H7"
            stroke="currentColor"
            strokeWidth="1.85"
            strokeLinejoin="round"
          />
        </MsgIcon>
      </HoverTip>
      <HoverTip as="button" className={styles.msgAction} aria-label={t("common.dislike")} text={t("common.soon")}>
        <MsgIcon>
          <path
            d="M17 13V4h2a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2Zm0 0-4.2 7.2A2.2 2.2 0 0 1 10.8 21h-.3a2 2 0 0 1-2-2.3L9.2 13H4a2 2 0 0 1-2-2.3L3.1 5.5A3 3 0 0 1 6 3h11"
            stroke="currentColor"
            strokeWidth="1.85"
            strokeLinejoin="round"
          />
        </MsgIcon>
      </HoverTip>
      <HoverTip as="button" className={styles.msgAction} aria-label={t("common.share")} text={t("common.soon")}>
        <MsgIcon>
          <path
            d="M12 3v10M12 3l-3.5 3.5M12 3l3.5 3.5M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"
            stroke="currentColor"
            strokeWidth="1.85"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </MsgIcon>
      </HoverTip>
      <HoverTip as="button" className={styles.msgAction} aria-label={t("common.retry")} text={t("common.soon")}>
        <MsgIcon>
          <path
            d="M4 12a8 8 0 0 1 13.7-5.7L20 8M20 4v4h-4M20 12a8 8 0 0 1-13.7 5.7L4 16M4 20v-4h4"
            stroke="currentColor"
            strokeWidth="1.85"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </MsgIcon>
      </HoverTip>
      <HoverTip as="button" className={styles.msgAction} aria-label={t("common.more")} text={t("common.soon")}>
        <MsgIcon>
          <circle cx="5" cy="12" r="1.7" fill="currentColor" />
          <circle cx="12" cy="12" r="1.7" fill="currentColor" />
          <circle cx="19" cy="12" r="1.7" fill="currentColor" />
        </MsgIcon>
      </HoverTip>
    </div>
  );
}

function subagentKey(part: MessagePartDto): string | null {
  const id = String(
    part.payload.toolCallId ??
      part.payload.tool_call_id ??
      (part.payload.raw as { toolCallId?: string; tool_call_id?: string } | undefined)?.toolCallId ??
      (part.payload.raw as { tool_call_id?: string } | undefined)?.tool_call_id ??
      "",
  ).trim();
  if (id) return `call:${id}`;
  const taskId = String(
    part.payload.task_id ??
      part.payload.taskId ??
      (part.payload.raw as { task_id?: string; taskId?: string } | undefined)?.task_id ??
      (part.payload.raw as { taskId?: string } | undefined)?.taskId ??
      "",
  ).trim();
  if (taskId) return `task:${taskId}`;
  return null;
}

function subagentDisplayTitle(part: MessagePartDto): string {
  return String(
    part.payload.description ?? part.payload.title ?? part.payload.subagentType ?? "",
  ).trim();
}

function isGenericSubagentTitle(title: string) {
  return !title || /^(tool|task|subagent|агент|субагент)$/i.test(title);
}

function preferSubagentPart(a: MessagePartDto, b: MessagePartDto): MessagePartDto {
  const aTitle = subagentDisplayTitle(a);
  const bTitle = subagentDisplayTitle(b);
  const aGeneric = isGenericSubagentTitle(aTitle);
  const bGeneric = isGenericSubagentTitle(bTitle);
  if (aGeneric && !bGeneric) return { ...a, payload: { ...a.payload, ...b.payload, title: bTitle || aTitle, description: bTitle || aTitle } };
  if (!aGeneric && bGeneric) return { ...a, payload: { ...a.payload, ...b.payload, title: aTitle, description: aTitle } };
  // Prefer longer/more specific title, keep richer payload.
  const title = bTitle.length > aTitle.length ? bTitle : aTitle;
  return {
    ...a,
    type: "subagent",
    payload: {
      ...a.payload,
      ...b.payload,
      title: title || aTitle || bTitle || "",
      description: title || aTitle || bTitle || "",
    },
  };
}

function isSubagentLike(part: MessagePartDto) {
  if (part.type === "subagent") return true;
  if (part.type !== "tool_call") return false;
  const title = String(part.payload.title ?? part.payload.description ?? "");
  const kind = String(
    (part.payload.raw as { kind?: string } | undefined)?.kind ?? part.payload.kind ?? "",
  );
  return /task|subagent|explore|browser|generalPurpose|ci-investigator|bugbot|security-review|best-of-n/i.test(
    `${title} ${kind}`,
  );
}

function coalesceAssistantParts(
  parts: MessagePartDto[],
  opts?: { peelAnswer?: boolean },
): MessagePartDto[] {
  const coalesced = coalesceParts(parts, opts);
  const out: MessagePartDto[] = [];
  const subagentIndexByKey = new Map<string, number>();

  for (const part of coalesced) {
    if (part.type === "thought" || part.type === "text" || part.type === "error") {
      out.push(part);
      continue;
    }

    if (!isSubagentLike(part)) continue;

    const asSubagent: MessagePartDto =
      part.type === "tool_call" ? { ...part, type: "subagent" } : part;
    const key = subagentKey(asSubagent);

    if (key && subagentIndexByKey.has(key)) {
      const idx = subagentIndexByKey.get(key)!;
      out[idx] = preferSubagentPart(out[idx], asSubagent);
      continue;
    }

    // Drop a lone generic "Tool" card if a named sibling already exists without shared id.
    const title = subagentDisplayTitle(asSubagent);
    if (isGenericSubagentTitle(title)) {
      const hasNamed = out.some(
        (p) => p.type === "subagent" && !isGenericSubagentTitle(subagentDisplayTitle(p)),
      );
      if (hasNamed) continue;
    }

    if (key) subagentIndexByKey.set(key, out.length);
    out.push(asSubagent);
  }

  return out;
}

function AssistantParts({
  message,
  streaming,
  autoExpandSteps,
}: {
  message: MessageDto;
  streaming: boolean;
  autoExpandSteps: boolean;
}) {
  // Keep typewriter "live" after the turn so late/peeled text still types out
  // instead of dumping in one frame when status flips to idle.
  const [paintStreaming, setPaintStreaming] = useState(streaming);
  useEffect(() => {
    if (streaming) {
      setPaintStreaming(true);
      return;
    }
    const id = window.setTimeout(() => setPaintStreaming(false), 3200);
    return () => window.clearTimeout(id);
  }, [streaming]);

  const parts = useMemo(() => {
    return coalesceAssistantParts(message.parts, {
      peelAnswer: !streaming && !paintStreaming,
    });
  }, [message.parts, streaming, paintStreaming]);

  const thoughtParts = useMemo(
    () => parts.filter((p) => p.type === "thought" && Boolean(String(p.payload.text ?? "").trim())),
    [parts],
  );
  const mainParts = useMemo(
    () => parts.filter((p) => p.type === "text" || p.type === "error" || p.type === "subagent"),
    [parts],
  );
  const plain = useMemo(() => {
    return mainParts
      .filter((p) => p.type === "text")
      .map((p) => String(p.payload.text ?? ""))
      .join("\n\n")
      .trim();
  }, [mainParts]);

  return (
    <div className={styles.parts}>
      <StepsSpoiler
        parts={thoughtParts}
        streaming={streaming}
        autoExpand={autoExpandSteps}
      />
      {mainParts.map((part, idx) => {
        const isLast = idx === mainParts.length - 1;
        return (
          <PartView
            key={part.id}
            part={part}
            streaming={
              paintStreaming && isLast && (part.type === "text" || part.type === "subagent")
            }
          />
        );
      })}
      {plain ? <MessageActions text={plain} hidden={paintStreaming} /> : null}
    </div>
  );
}

function findLatestPlan(session: { messages: MessageDto[] } | null): PlanPayload | null {
  if (!session) return null;
  for (let mi = session.messages.length - 1; mi >= 0; mi -= 1) {
    const parts = session.messages[mi]?.parts ?? [];
    for (let pi = parts.length - 1; pi >= 0; pi -= 1) {
      const part = parts[pi];
      if (!part) continue;
      if (part.type === "plan" || part.type === "question" || part.type === "permission") {
        const coerced = coercePlanPayload(part.payload);
        if (coerced) return coerced;
      }
    }
  }
  return null;
}

export function ChatPage() {
  const t = useT();
  const activeSession = useAppStore((s) => s.activeSession);
  const sessions = useAppStore((s) => s.sessions);
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const sendPrompt = useAppStore((s) => s.sendPrompt);
  const cancelPrompt = useAppStore((s) => s.cancelPrompt);
  const createSession = useAppStore((s) => s.createSession);
  const error = useAppStore((s) => s.error);
  const modelsCatalog = useAppStore((s) => s.modelsCatalog);
  const modelsLoading = useAppStore((s) => s.modelsLoading);
  const ensureModels = useAppStore((s) => s.ensureModels);
  const rememberModelsCatalog = useAppStore((s) => s.rememberModelsCatalog);
  const pendingPermission = useAppStore((s) => s.pendingPermission);
  const pendingQuestion = useAppStore((s) => s.pendingQuestion);
  const answerQuestion = useAppStore((s) => s.answerQuestion);
  const [text, setText] = useState("");
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [composerMultiline, setComposerMultiline] = useState(false);
  const composerMultilineRef = useRef(false);
  const [cursorPos, setCursorPos] = useState(0);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashKeyboardNav, setSlashKeyboardNav] = useState(false);
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);
  const [planPanelOpen, setPlanPanelOpen] = useState(false);
  const [modelParamValues, setModelParamValues] = useState<Record<string, string>>(
    () => settings.defaultModelParams ?? {},
  );
  const [model, setModel] = useState(settings.defaultModel);
  const [folderPicker, setFolderPicker] = useState<{ x: number; y: number } | null>(null);
  const [autoExpandSteps, setAutoExpandSteps] = useState(() => {
    try {
      // v2: thinking/steps open by default (legacy key defaulted to off).
      const raw = localStorage.getItem("acprocess.autoExpandSteps.v2");
      if (raw === null) return true;
      return raw === "1";
    } catch {
      return true;
    }
  });
  /** Assistant message ids that already existed when the toggle was turned on — skip them. */
  const [thoughtsSkipIds, setThoughtsSkipIds] = useState<Set<string>>(() => new Set());
  /** True after skip-set is snapshotted so old messages don't flash open. */
  const [thoughtsArmed, setThoughtsArmed] = useState(false);
  const [paramsLoading, setParamsLoading] = useState(false);
  const [stableParams, setStableParams] = useState<ModelParamDto[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const userJustSentRef = useRef(false);
  const keepComposerFocus = useRef(false);
  const paramsCacheRef = useRef(new Map<string, ModelParamDto[]>());

  useEffect(() => {
    try {
      localStorage.setItem("acprocess.autoExpandSteps.v2", autoExpandSteps ? "1" : "0");
    } catch {
      // ignore
    }
  }, [autoExpandSteps]);

  // When enabling (incl. restored from localStorage) or switching chat — only future replies open.
  useEffect(() => {
    if (!autoExpandSteps) {
      setThoughtsSkipIds(new Set());
      setThoughtsArmed(false);
      return;
    }
    const ids = new Set(
      (activeSession?.messages ?? [])
        .filter((m) => m.role === "assistant")
        .map((m) => m.id),
    );
    setThoughtsSkipIds(ids);
    setThoughtsArmed(true);
    // Snapshot once per toggle/session — not on every streamed part.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoExpandSteps, activeSession?.id]);
  const streaming = activeSession?.status === "running" || activeSession?.status === "waiting";

  const planPending = pendingQuestion?.kind === "create_plan";
  const activePlan = useMemo((): PlanPayload | null => {
    if (planPending && pendingQuestion) {
      return coercePlanPayload(pendingQuestion.payload) ?? null;
    }
    return findLatestPlan(activeSession);
  }, [planPending, pendingQuestion, activeSession]);

  const planSignature = useMemo(() => {
    if (!activePlan) return "";
    return [
      activePlan.name ?? "",
      (activePlan.plan ?? "").slice(0, 120),
      String(activePlan.todos?.length ?? 0),
      pendingQuestion?.requestId ?? "",
    ].join("|");
  }, [activePlan, pendingQuestion?.requestId]);

  useEffect(() => {
    if (planPending || planSignature) setPlanPanelOpen(true);
  }, [planPending, pendingQuestion?.requestId, planSignature]);

  useEffect(() => {
    setPlanPanelOpen(false);
  }, [activeSession?.id]);

  const setComposerMultilineIfNeeded = (next: boolean) => {
    composerMultilineRef.current = next;
    setComposerMultiline((prev) => (prev === next ? prev : next));
  };

  const applyComposerHeight = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 40), 160)}px`;
  };

  const syncComposerSize = (el: HTMLTextAreaElement) => {
    const value = el.value;
    // Never poke width — that flicker + single↔multi oscillation is what made the pill "dance".
    el.style.width = "";

    if (!value) {
      el.style.height = "";
      setComposerMultilineIfNeeded(false);
      return;
    }

    const hasNewline = value.includes("\n");
    const pillW = el.parentElement?.clientWidth ?? el.clientWidth;
    const textBudget = Math.max(96, pillW - 230);
    const approxFit = Math.max(8, Math.floor(textBudget / 7.2));
    // Hysteresis: enter early, leave only when clearly short again (no bounce at the edge).
    const enterAt = Math.min(approxFit, 36);
    const exitAt = Math.max(4, Math.floor(enterAt * 0.45));

    if (composerMultilineRef.current) {
      if (!hasNewline && value.length <= exitAt) {
        setComposerMultilineIfNeeded(false);
        requestAnimationFrame(() => {
          const node = textareaRef.current;
          if (!node) return;
          applyComposerHeight(node);
        });
        return;
      }
      applyComposerHeight(el);
      return;
    }

    if (hasNewline) {
      setComposerMultilineIfNeeded(true);
      applyComposerHeight(el);
      return;
    }

    el.style.height = "auto";
    const wrapsNow = el.scrollHeight > 44;
    if (wrapsNow || value.length >= enterAt) {
      setComposerMultilineIfNeeded(true);
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (!node) return;
        applyComposerHeight(node);
      });
      return;
    }

    applyComposerHeight(el);
  };

  // Models / ACP only after the user explicitly connected an agent.
  const agentProvider = settings.connectedProvider ?? null;
  const agentMissing = !agentProvider;

  const catalog =
    agentProvider && modelsCatalog?.provider === agentProvider ? modelsCatalog : null;
  const models = catalog?.models ?? [];
  const modelParams = catalog?.modelParams ?? [];
  const modeOptions = agentProvider
    ? sanitizeCatalogModes(agentProvider, catalog?.modes)
    : [];
  const modeSwitcher = modeOptions.length >= 2 ? modeOptions : [];
  const sessionMode = activeSession?.mode ?? settings.defaultMode;
  // Block typing while agent missing, or while models are loading with empty list.
  // Once the agent is already answering, don't keep the composer stuck on "loading models".
  const composerLocked =
    agentMissing || (!streaming && modelsLoading && models.length === 0);

  const slashCommands = useMemo(
    () => mergeSlashCommands(activeSession?.slashCommands, t),
    [activeSession?.slashCommands, t],
  );
  const slashCtx = useMemo(() => getSlashContext(text, cursorPos), [text, cursorPos]);
  const filteredSlashCommands = useMemo(() => {
    if (!slashCtx) return [];
    return filterSlashCommands(slashCommands, slashCtx.query);
  }, [slashCommands, slashCtx]);
  const slashMenuOpen =
    !slashMenuDismissed &&
    !composerLocked &&
    !streaming &&
    slashCtx != null &&
    filteredSlashCommands.length > 0;

  const slashInputHint = useMemo(() => {
    const parsed = parseSlashCommandText(text);
    if (!parsed || parsed.args) return null;
    const cmd = slashCommands.find((c) => c.name.toLowerCase() === parsed.name.toLowerCase());
    if (!cmd || !slashCommandRequiresInput(cmd)) return null;
    return cmd.inputHint ?? cmd.description;
  }, [text, slashCommands]);

  const insertSlashCommand = (cmd: SlashCommandDto) => {
    const insertion = buildSlashInsertion(cmd);
    setText(insertion);
    setCursorPos(insertion.length);
    setSlashMenuDismissed(true);
    setComposerMultilineIfNeeded(insertion.includes("\n"));
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.setSelectionRange(insertion.length, insertion.length);
      syncComposerSize(el);
    });
  };

  useEffect(() => {
    setSlashIndex(0);
    setSlashKeyboardNav(false);
    setSlashMenuDismissed(false);
  }, [slashCtx?.query, slashCtx?.start]);

  const applySlashCommand = (cmd: SlashCommandDto) => {
    setSlashMenuDismissed(true);
    if (cmd.name === "stop") {
      setText("");
      setCursorPos(0);
      setComposerMultilineIfNeeded(false);
      const el = textareaRef.current;
      if (el) el.style.height = "auto";
      void cancelPrompt();
      requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
      return;
    }
    if (slashCommandRequiresInput(cmd)) {
      insertSlashCommand(cmd);
      return;
    }
    submitMessage(`/${cmd.name}`);
  };

  const submitMessage = (raw: string) => {
    const value = raw.trim();
    if (!value || composerLocked || streaming) return;
    if (!isSlashCommandReadyToSend(value, slashCommands)) {
      if (shouldAutoFocusComposer()) focusComposer();
      return;
    }
    if (value === "/stop") {
      setText("");
      setEditingMessageId(null);
      setComposerMultilineIfNeeded(false);
      void cancelPrompt();
      return;
    }
    if (shouldAutoFocusComposer()) {
      keepComposerFocus.current = true;
    } else {
      keepComposerFocus.current = false;
    }
    userJustSentRef.current = true;
    const editId = editingMessageId;
    setText("");
    setEditingMessageId(null);
    setCursorPos(0);
    setComposerMultilineIfNeeded(false);
    setSlashMenuDismissed(true);
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
    }
    if (shouldAutoFocusComposer()) {
      focusComposer();
      void sendPrompt(value, editId ? { editMessageId: editId } : undefined).finally(() => {
        requestAnimationFrame(focusComposer);
        window.setTimeout(focusComposer, 0);
        window.setTimeout(focusComposer, 100);
      });
    } else {
      textareaRef.current?.blur();
      void sendPrompt(value, editId ? { editMessageId: editId } : undefined);
    }
  };

  const recentCwds = useMemo(
    () => collectRecentCwds(sessions, settings.defaultCwd),
    [sessions, settings.defaultCwd],
  );
  useEffect(() => {
    if (!agentProvider) return;
    const cached = useAppStore.getState().modelsCatalog;
    const needForce =
      !cached || cached.provider !== agentProvider || usesCloudModelCatalog(agentProvider);
    void ensureModels(agentProvider, { force: needForce });
    void api.warmModelParams(agentProvider);
  }, [agentProvider, ensureModels]);

  useEffect(() => {
    if (paramsLoading) return;
    setStableParams(modelParams);
    if (model && modelParams.length) {
      paramsCacheRef.current.set(model, modelParams);
    }
  }, [modelParams, model, paramsLoading]);

  useEffect(() => {
    if (!agentProvider || !model) return;
    if (paramsCacheRef.current.get(model)?.length) return;
    if (modelParams.length) return;
    let cancelled = false;
    void api
      .getModelParams(agentProvider, model, { sessionId: activeSession?.id ?? undefined })
      .then((res) => {
        if (cancelled || !res.modelParams?.length) return;
        paramsCacheRef.current.set(model, res.modelParams);
        setStableParams((prev) => (prev.length ? prev : res.modelParams));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [agentProvider, model, activeSession?.id, modelParams.length]);

  useEffect(() => {
    if (!catalog?.models.length) {
      setModel(settings.defaultModel);
      setModelParamValues(settings.defaultModelParams ?? {});
      return;
    }
    // Drop a defaultModel that belongs to another agent (e.g. Cursor id in OpenCode chat).
    const preferred = settings.defaultModel || catalog.currentModel || "";
    const nextModel =
      preferred && catalog.models.some((m) => m.value === preferred)
        ? preferred
        : catalog.currentModel || catalog.models[0]?.value || "";
    setModel(nextModel);
    const exposed = catalog.modelParams ?? [];
    if (!exposed.length) {
      setModelParamValues(settings.defaultModelParams ?? {});
      return;
    }
    const migrated = migrateModelParamValues(settings.defaultModelParams ?? {}, exposed);
    setModelParamValues(
      Object.keys(migrated).length
        ? migrated
        : Object.fromEntries(
            exposed
              .filter((p) => p.currentValue != null && p.currentValue !== "")
              .map((p) => [p.id, p.currentValue!]),
          ),
    );
  }, [catalog, settings.defaultModel, settings.defaultModelParams]);

  const applyModelSelection = async (
    nextModel: string,
    nextParams: Record<string, string>,
  ) => {
    // Alias-aware prune (effort ↔ reasoning). Don't wipe before options load.
    const supported =
      modelParams.length === 0
        ? nextParams
        : migrateModelParamValues(nextParams, modelParams);
    setModel(nextModel);
    setModelParamValues(supported);
    await saveSettings({ defaultModel: nextModel, defaultModelParams: supported });
    if (!agentProvider) return modelParams;
    if (activeSession?.id) {
      try {
        const res = await api.setSessionModel(activeSession.id, nextModel, supported);
        // Prefer agent-refreshed params, but keep prior Effort if the payload is empty.
        const nextModelParams =
          res.modelParams && res.modelParams.length > 0 ? res.modelParams : modelParams;
        if (res.models?.length || (res.modelParams && res.modelParams.length > 0)) {
          rememberModelsCatalog({
            provider: agentProvider,
            models: res.models?.length ? res.models : models,
            modelParams: nextModelParams,
            // Never keep prior Cursor modes when the agent returns an empty list (OMP).
            modes: res.modes ?? [],
            currentModel: res.currentModel ?? nextModel,
            at: Date.now(),
          });
          setModelParamValues((prev) => migrateModelParamValues(prev, nextModelParams));
          return nextModelParams;
        }
      } catch {
        // settings already saved; live apply optional
      }
    } else {
      const cat = await ensureModels(agentProvider, { force: true });
      return cat?.modelParams ?? modelParams;
    }
    return modelParams;
  };

  const loadParamsForModel = async (nextModel: string) => {
    const cached = paramsCacheRef.current.get(nextModel);
    if (cached?.length) {
      setStableParams(cached);
      return;
    }
    if (nextModel === model) {
      if (modelParams.length) {
        paramsCacheRef.current.set(nextModel, modelParams);
        setStableParams(modelParams);
        return;
      }
      const catParams = catalog?.modelParams ?? [];
      if (catParams.length) {
        paramsCacheRef.current.set(nextModel, catParams);
        setStableParams(catParams);
        return;
      }
    }
    if (!agentProvider) return;
    setParamsLoading(true);
    try {
      const res = await api.getModelParams(agentProvider, nextModel, {
        sessionId: activeSession?.id,
      });
      const committed = res.modelParams?.length ? res.modelParams : [];
      paramsCacheRef.current.set(nextModel, committed);
      setStableParams(committed);
      if (committed.length && nextModel === model) {
        rememberModelsCatalog({
          provider: agentProvider,
          models,
          modelParams: committed,
          modes: catalog?.modes ?? [],
          currentModel: model,
          at: Date.now(),
        });
      }
    } finally {
      setParamsLoading(false);
    }
  };

  const onModelChange = async (value: string) => {
    // Don't carry Fast/Effort from the previous model — they often aren't valid
    // for the new one and used to leave the ACP session broken.
    await applyModelSelection(value, {});
  };

  const modeLabel = (value: string, fallback?: string) => {
    if (value === "agent") return t("modes.agent");
    if (value === "plan") return t("modes.plan");
    if (value === "ask") return t("modes.ask");
    return (fallback || value).trim() || value;
  };

  const onModeChange = async (nextMode: string) => {
    if (nextMode !== "agent" && nextMode !== "plan" && nextMode !== "ask") return;
    const mode = nextMode as AgentMode;
    if (mode === sessionMode) return;

    const sessionId = activeSession?.id ?? null;
    const prevMode = sessionMode;
    const prevSettingsMode = settings.defaultMode;

    // Show the new mode immediately — ACP sync can take seconds.
    useAppStore.setState((s) => ({
      settings: { ...s.settings, defaultMode: mode },
      sessions: sessionId
        ? s.sessions.map((row) => (row.id === sessionId ? { ...row, mode } : row))
        : s.sessions,
      activeSession:
        sessionId && s.activeSession?.id === sessionId
          ? { ...s.activeSession, mode }
          : s.activeSession,
    }));

    try {
      if (sessionId) {
        const res = await api.setSessionMode(sessionId, mode);
        if (res.session) {
          useAppStore.setState((s) => ({
            settings: { ...s.settings, defaultMode: mode },
            sessions: s.sessions.map((row) => (row.id === res.session!.id ? res.session! : row)),
            activeSession:
              s.activeSession?.id === res.session!.id
                ? { ...s.activeSession, ...res.session!, mode: res.session!.mode ?? mode }
                : s.activeSession,
          }));
        }
      } else {
        await saveSettings({ defaultMode: mode });
      }
    } catch (err) {
      useAppStore.setState((s) => ({
        error: err instanceof Error ? err.message : String(err),
        settings: { ...s.settings, defaultMode: prevSettingsMode },
        sessions: sessionId
          ? s.sessions.map((row) => (row.id === sessionId ? { ...row, mode: prevMode } : row))
          : s.sessions,
        activeSession:
          sessionId && s.activeSession?.id === sessionId
            ? { ...s.activeSession, mode: prevMode }
            : s.activeSession,
      }));
    }
  };

  const onParamsChange = async (next: Record<string, string>) => {
    const fresh = await applyModelSelection(model, next);
    if (fresh?.length) {
      paramsCacheRef.current.set(model, fresh);
      setStableParams(fresh);
    }
  };

  const focusComposer = () => {
    if (!shouldAutoFocusComposer()) return;
    const el = textareaRef.current;
    if (!el) return;
    if (document.activeElement !== el) {
      el.focus({ preventScroll: true });
      const len = el.value.length;
      try {
        el.setSelectionRange(len, len);
      } catch {
        // ignore
      }
    }
    // Don't syncComposerSize here during stream — height thrash makes the thread jump.
  };

  useEffect(() => {
    const el = textareaRef.current;
    if (el) syncComposerSize(el);
  }, [text]);

  useEffect(() => {
    if (streaming) {
      if (shouldAutoFocusComposer()) {
        keepComposerFocus.current = true;
        focusComposer();
      } else {
        keepComposerFocus.current = false;
        textareaRef.current?.blur();
      }
      return;
    }
    const t = window.setTimeout(() => {
      keepComposerFocus.current = false;
    }, 300);
    return () => window.clearTimeout(t);
  }, [streaming]);

  const lastMessageId = activeSession?.messages.at(-1)?.id;
  const messageCount = activeSession?.messages.length ?? 0;
  const activeSessionId = activeSession?.id ?? null;
  const streamDigest = useMemo(() => {
    if (!activeSession?.messages.length) return `${activeSession?.status ?? ""}`;
    let parts = 0;
    let chars = 0;
    for (const m of activeSession.messages) {
      parts += m.parts.length;
      for (const p of m.parts) {
        const text = p.payload?.text;
        if (typeof text === "string") chars += text.length;
        const message = p.payload?.message;
        if (typeof message === "string") chars += message.length;
      }
    }
    return `${parts}:${chars}:${activeSession.status}`;
  }, [activeSession?.messages, activeSession?.status]);
  const prevSessionIdRef = useRef<string | null>(null);
  const stickToBottomRef = useRef(true);
  const suppressScrollWatchRef = useRef(false);
  const scrollRafRef = useRef(0);
  const threadInnerRef = useRef<HTMLDivElement>(null);
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;

  const scrollThreadToEnd = () => {
    const thread = threadRef.current;
    if (!thread) return;
    suppressScrollWatchRef.current = true;
    stickToBottomRef.current = true;
    thread.scrollTop = thread.scrollHeight;
    window.requestAnimationFrame(() => {
      const node = threadRef.current;
      if (node) node.scrollTop = node.scrollHeight;
      suppressScrollWatchRef.current = false;
      stickToBottomRef.current = true;
    });
  };

  const scheduleScrollToEnd = () => {
    if (!stickToBottomRef.current && !streamingRef.current && !userJustSentRef.current) return;
    if (scrollRafRef.current) return;
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = 0;
      if (stickToBottomRef.current || streamingRef.current || userJustSentRef.current) {
        scrollThreadToEnd();
      }
    });
  };

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    const onScroll = () => {
      if (suppressScrollWatchRef.current) return;
      // Growth during stream can temporarily look like "scrolled away" before we catch up.
      if (streamingRef.current || userJustSentRef.current) {
        stickToBottomRef.current = true;
        return;
      }
      const gap = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
      stickToBottomRef.current = gap < 140;
    };
    thread.addEventListener("scroll", onScroll, { passive: true });
    return () => thread.removeEventListener("scroll", onScroll);
  }, [activeSessionId]);

  useEffect(() => {
    const inner = threadInnerRef.current;
    if (!inner || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stickToBottomRef.current || streamingRef.current || userJustSentRef.current) {
        scrollThreadToEnd();
      }
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [activeSessionId]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current) window.cancelAnimationFrame(scrollRafRef.current);
    };
  }, []);

  // Snap on session switch, send, stream tokens, and permission prompts.
  useLayoutEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    const sessionChanged = activeSessionId !== prevSessionIdRef.current;
    const promptId =
      pendingPermission?.requestId ?? pendingQuestion?.requestId ?? null;
    if (sessionChanged) {
      prevSessionIdRef.current = activeSessionId;
      stickToBottomRef.current = true;
      userJustSentRef.current = false;
      scrollThreadToEnd();
      if (!shouldAutoFocusComposer()) {
        textareaRef.current?.blur();
      } else if (keepComposerFocus.current) {
        focusComposer();
      }
      return;
    }
    if (userJustSentRef.current || promptId) {
      stickToBottomRef.current = true;
      userJustSentRef.current = false;
      scrollThreadToEnd();
      return;
    }
    // Follow while streaming; when the turn ends, don't hard-jump (composer
    // chrome changes would otherwise look like a full remount).
    if (streaming) {
      stickToBottomRef.current = true;
      scrollThreadToEnd();
      return;
    }
    if (!stickToBottomRef.current) return;
    scheduleScrollToEnd();
  }, [
    activeSessionId,
    lastMessageId,
    messageCount,
    streamDigest,
    streaming,
    pendingPermission?.requestId,
    pendingQuestion?.requestId,
  ]);

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    const onFocusIn = (e: FocusEvent) => {
      if (!shouldAutoFocusComposer() || !keepComposerFocus.current) return;
      const target = e.target as HTMLElement | null;
      if (!target || target === textareaRef.current) return;
      // Don't steal focus from permission / question actions or other controls in the thread.
      if (
        target.closest(
          "button, a, input, textarea, select, [role='button'], [role='option'], [role='menuitem']",
        )
      ) {
        return;
      }
      if (thread.contains(target)) {
        focusComposer();
      }
    };
    thread.addEventListener("focusin", onFocusIn);
    return () => thread.removeEventListener("focusin", onFocusIn);
  }, []);

  useEffect(() => {
    return () => {
      keepComposerFocus.current = false;
      textareaRef.current?.blur();
    };
  }, []);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submitMessage(text);
  };

  return (
    <div className={`${styles.page} ${planPanelOpen && activePlan ? styles.pageWithPlan : ""}`}>
      <div className={styles.mainColumn}>
      <div className={styles.thread} ref={threadRef}>
        <div className={styles.threadInner} ref={threadInnerRef}>
        {!activeSession && (
          <div className={styles.empty}>
            <h1>
              <span>ACP</span>rocess
            </h1>
            <p>{t("chat.emptyDescription")}</p>
            <div className={styles.emptyActions}>
              {agentMissing ? (
                <Link
                  className={styles.secondary}
                  to="/settings?section=agent&leaf=connect"
                  style={{ display: "inline-flex", alignItems: "center" }}
                >
                  {t("chat.connectAgent")}
                </Link>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={(e) => {
                      const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
                      setFolderPicker({ x: rect.left, y: rect.bottom + 8 });
                    }}
                  >
                    {t("chat.newSession")}
                  </button>
                  <Link
                    className={styles.secondary}
                    to="/settings"
                    style={{ display: "inline-flex", alignItems: "center" }}
                  >
                    {t("common.settings")}
                  </Link>
                </>
              )}
            </div>
          </div>
        )}

        {(activeSession?.messages ?? []).map((msg, index) => {
          const isLiveAssistant =
            streaming &&
            msg.role === "assistant" &&
            index === (activeSession?.messages.length ?? 0) - 1;
          if (
            msg.role === "assistant" &&
            !hasRenderableAssistantContent(msg.parts) &&
            !isLiveAssistant
          ) {
            return null;
          }
          return (
            <article
              key={msg.id}
              className={`${styles.msg} ${styles[msg.role]} ${isLiveAssistant ? styles.live : ""}`}
              onMouseDown={(e) => {
                if (!keepComposerFocus.current) return;
                const target = e.target as HTMLElement;
                if (target.closest("button,a,input,textarea")) return;
                e.preventDefault();
              }}
            >
              {msg.role === "user" ? (
                <UserMessage
                  message={msg}
                  slashCommands={slashCommands}
                  onEdit={(messageId, value) => {
                    setEditingMessageId(messageId);
                    setText(value);
                    window.requestAnimationFrame(() => {
                      const el = textareaRef.current;
                      if (!el) return;
                      el.focus();
                      syncComposerSize(el);
                      const end = value.length;
                      el.setSelectionRange(end, end);
                    });
                  }}
                />
              ) : (
                <AssistantParts
                  message={msg}
                  streaming={!!isLiveAssistant}
                  autoExpandSteps={
                    isLiveAssistant
                      ? autoExpandSteps
                      : thoughtsArmed && autoExpandSteps && !thoughtsSkipIds.has(msg.id)
                  }
                />
              )}
            </article>
          );
        })}
        <div ref={messageEndRef} className={styles.threadEnd} aria-hidden />
        </div>
      </div>

      {(pendingPermission || pendingQuestion) &&
      (!pendingPermission || pendingPermission.sessionId === activeSession?.id) &&
      (!pendingQuestion || pendingQuestion.sessionId === activeSession?.id) ? (
        <div className={styles.inlinePromptDock}>
          <ChatInlinePrompt onOpenPlan={() => setPlanPanelOpen(true)} />
        </div>
      ) : null}

      {error && <div className={styles.banner}>{error}</div>}

      <form className={styles.composer} onSubmit={onSubmit}>
        <div className={styles.composerInner}>
          <div className={styles.composerStatusSlot} aria-live="polite">
            {editingMessageId && (
              <div className={styles.typingBar}>
                <span>{t("chat.editingMessage")}</span>
                <button
                  type="button"
                  className={styles.editCancel}
                  onClick={() => {
                    setEditingMessageId(null);
                    setText("");
                    setComposerMultilineIfNeeded(false);
                  }}
                >
                  {t("common.cancel")}
                </button>
              </div>
            )}
            {!editingMessageId && agentMissing && (
              <div className={styles.typingBar}>{t("common.connectAgentInSettings")}</div>
            )}
            {!editingMessageId && !agentMissing && activeSession?.status === "waiting" && (
              <div className={styles.typingBar}>{t("common.waitingInput")}</div>
            )}
            {!editingMessageId &&
              !agentMissing &&
              composerLocked &&
              !streaming && (
                <div className={styles.typingBar}>
                  <span className={styles.modelsLoaderSpin} aria-hidden />
                  <span>{t("common.loadingModels")}</span>
                </div>
              )}
          </div>
          <div className={styles.composerMeta}>
            <div className={styles.composerMetaStart}>
              {activeSession?.cwd?.trim() ? (
                <div className={styles.sessionCwd} title={activeSession.cwd}>
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
                </div>
              ) : null}
              <button
                type="button"
                className={`${styles.metaChip} ${autoExpandSteps ? styles.metaChipActive : ""}`}
                aria-pressed={autoExpandSteps}
                aria-label={t("common.autoSteps")}
                title={t("common.autoStepsHint")}
                onClick={() => setAutoExpandSteps((v) => !v)}
              >
                <span className={styles.metaChipIcon} aria-hidden>
                  <ThoughtSparkIcon size={15} />
                </span>
                <span className={styles.metaChipLabel}>{t("common.autoSteps")}</span>
              </button>
            </div>
            {modeSwitcher.length > 0 ? (
              <OptionPicker
                className={`${styles.composerMode} ${styles.composerModeDesktop}`}
                variant="quiet"
                placement="up"
                menuTitle={t("modes.label")}
                value={
                  modeSwitcher.some((m) => m.value === sessionMode)
                    ? sessionMode
                    : modeSwitcher[0]?.value ?? "agent"
                }
                disabled={composerLocked}
                onChange={(v) => void onModeChange(v)}
                options={modeSwitcher.map((m) => ({
                  value: m.value,
                  label: modeLabel(m.value, m.name),
                }))}
              />
            ) : null}
          </div>
          <div
            className={`${styles.pill} ${composerMultiline ? styles.pillMultiline : ""} ${
              streaming ? styles.pillBusy : ""
            } ${composerLocked ? styles.pillLoading : ""}`}
          >
            <SlashCommandMenu
              open={slashMenuOpen}
              commands={filteredSlashCommands}
              activeIndex={slashIndex}
              scrollActiveIntoView={slashKeyboardNav}
              anchorRef={textareaRef}
              onSelect={applySlashCommand}
              onActiveIndexChange={(idx) => {
                setSlashKeyboardNav(false);
                setSlashIndex(idx);
              }}
            />
            <textarea
              ref={textareaRef}
              className={styles.pillInput}
              value={text}
              onChange={(e) => {
                if (composerLocked) return;
                setText(e.target.value);
                setCursorPos(e.target.selectionStart);
                syncComposerSize(e.currentTarget);
              }}
              onClick={(e) => setCursorPos(e.currentTarget.selectionStart)}
              onKeyUp={(e) => setCursorPos(e.currentTarget.selectionStart)}
              placeholder={
                slashInputHint ??
                (agentMissing
                  ? t("common.connectAgentEllipsis")
                  : composerLocked
                    ? t("common.loadingModels")
                    : t("common.messageOrCommand"))
              }
              rows={1}
              disabled={composerLocked}
              readOnly={composerLocked}
              aria-busy={composerLocked || undefined}
              onKeyDown={(e) => {
                if (composerLocked) {
                  e.preventDefault();
                  return;
                }
                if (slashMenuOpen) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSlashKeyboardNav(true);
                    setSlashIndex((i) => Math.min(i + 1, filteredSlashCommands.length - 1));
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSlashKeyboardNav(true);
                    setSlashIndex((i) => Math.max(i - 1, 0));
                    return;
                  }
                  if (e.key === "Tab" || e.key === "Enter") {
                    e.preventDefault();
                    const cmd = filteredSlashCommands[slashIndex];
                    if (cmd) applySlashCommand(cmd);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setSlashMenuDismissed(true);
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onSubmit(e);
                }
              }}
            />

            <div className={styles.pillFooter}>
              <HoverTip
                as="button"
                className={styles.attachBtn}
                aria-label={t("common.attachNotImplemented")}
                disabled={composerLocked}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M12 5v14M5 12h14"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </HoverTip>

              <div className={styles.pillFooterEnd}>
                <ModelPicker
                  className={styles.composerModel}
                  model={model}
                  models={models}
                  params={stableParams}
                  paramValues={modelParamValues}
                  paramsLoading={paramsLoading}
                  loading={composerLocked}
                  disabled={composerLocked}
                  onOpen={() => {
                    if (!agentProvider) return;
                    void api.warmModelParams(agentProvider);
                    const cached = useAppStore.getState().modelsCatalog;
                    const stale =
                      !cached ||
                      cached.provider !== agentProvider ||
                      (cached.modelParams?.length ?? 0) === 0 ||
                      usesCloudModelCatalog(agentProvider);
                    void ensureModels(agentProvider, { force: stale });
                    if (model) {
                      void api.getModelParams(agentProvider, model, {
                        sessionId: activeSession?.id,
                      }).then((res) => {
                        if (!res.modelParams?.length) return;
                        paramsCacheRef.current.set(model, res.modelParams);
                        setStableParams((prev) => (prev.length ? prev : res.modelParams));
                      });
                    }
                  }}
                  onChange={(v) => void onModelChange(v)}
                  onParamsOpen={(v) => loadParamsForModel(v)}
                  onParamsChange={(next) => void onParamsChange(next)}
                />

                {modeSwitcher.length > 0 ? (
                  <OptionPicker
                    className={`${styles.composerMode} ${styles.composerModeMobile}`}
                    variant="compact"
                    placement="up"
                    menuTitle={t("modes.label")}
                    value={
                      modeSwitcher.some((m) => m.value === sessionMode)
                        ? sessionMode
                        : modeSwitcher[0]?.value ?? "agent"
                    }
                    disabled={composerLocked}
                    onChange={(v) => void onModeChange(v)}
                    options={modeSwitcher.map((m) => ({
                      value: m.value,
                      label: modeLabel(m.value, m.name),
                    }))}
                  />
                ) : null}

                {streaming ? (
                  <button
                    type="button"
                    className={styles.stopBtn}
                    title={t("common.stop")}
                    aria-label={t("common.stop")}
                    onClick={() => void cancelPrompt()}
                  >
                    <svg className={styles.stopIcon} width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <rect x="4" y="4" width="16" height="16" rx="2.5" />
                    </svg>
                  </button>
                ) : (
                  <button
                    type="submit"
                    className={styles.sendBtn}
                    disabled={composerLocked || !text.trim()}
                    title={
                      agentMissing
                        ? t("common.connectAgentFirst")
                        : composerLocked
                          ? t("common.loadingModels")
                          : t("common.send")
                    }
                    aria-label={t("common.send")}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                      <path
                        d="M12 19V5M12 5l-6 6M12 5l6 6"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </form>

      {folderPicker && (
        <CreateSessionFolderPicker
          x={folderPicker.x}
          y={folderPicker.y}
          defaultCwd={settings.defaultCwd ?? ""}
          recentCwds={recentCwds}
          onClose={() => setFolderPicker(null)}
          onConfirm={async (cwd) => {
            setFolderPicker(null);
            await createSession(cwd);
            if (shouldAutoFocusComposer()) focusComposer();
          }}
        />
      )}
      </div>

      <PlanTabButton
        visible={Boolean(activePlan) && !planPanelOpen}
        open={planPanelOpen}
        pending={planPending}
        onClick={() => setPlanPanelOpen(true)}
      />
      <PlanSidePanel
        plan={activePlan}
        open={planPanelOpen}
        pending={planPending}
        onClose={() => setPlanPanelOpen(false)}
        onAccept={
          planPending
            ? () => void answerQuestion({ outcome: { outcome: "accepted" } })
            : undefined
        }
        onReject={
          planPending
            ? () =>
                void answerQuestion({
                  outcome: { outcome: "rejected", reason: "rejected by user" },
                })
            : undefined
        }
      />
    </div>
  );
}
