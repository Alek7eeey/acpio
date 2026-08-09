import { Link } from "react-router-dom";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from "react";
import { migrateModelParamValues, usesCloudModelCatalog, type MessageDto, type MessagePartDto, type ModelParamDto, type SlashCommandDto } from "@acprocess/shared";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { useAppStore } from "../lib/store";
import { ModelPicker } from "../components/ModelPicker";
import { HoverTip } from "../components/HoverTip";
import { PermissionModal } from "../components/PermissionModal";
import { QuestionModal } from "../components/QuestionModal";
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
}: {
  message: MessageDto;
  slashCommands: SlashCommandDto[];
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

  if (isCommand && parsed) {
    const meta = slashCommands.find((c) => c.name.toLowerCase() === parsed.name.toLowerCase());
    return (
      <div className={styles.userCommand}>
        <div className={styles.userCommandHeader}>
          <span className={styles.userCommandBadge}>{t("common.command")}</span>
          <code className={styles.userCommandName}>/{parsed.name}</code>
        </div>
        {parsed.args ? (
          <p className={styles.userCommandArgs}>{parsed.args}</p>
        ) : meta?.description ? (
          <p className={styles.userCommandDesc}>{meta.description}</p>
        ) : null}
      </div>
    );
  }

  return (
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
}

function peelAnswerFromThought(thought: string): { thought: string; answer: string } {
  const trimmed = thought.trim();
  if (!trimmed) return { thought: "", answer: "" };
  const blocks = trimmed.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length < 2) return { thought: trimmed, answer: "" };
  const first = blocks[0];
  const rest = blocks.slice(1).join("\n\n");
  const meta =
    /^(the user|let me|i (need|should|will|think)|okay|ok[,.]|hmm|рассужд|пользователь)/i.test(
      first,
    ) ||
    (first.length < 280 && rest.length > first.length * 1.2);
  if (!meta || rest.length < 24) return { thought: trimmed, answer: "" };
  return { thought: first, answer: rest };
}

function coalesceParts(parts: MessagePartDto[]): MessagePartDto[] {
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

  const hasText = out.some((p) => p.type === "text" && String(p.payload.text ?? "").trim());
  if (!hasText) {
    const thoughtIdx = out.findIndex((p) => p.type === "thought");
    if (thoughtIdx >= 0) {
      const thought = out[thoughtIdx];
      const peeled = peelAnswerFromThought(String(thought.payload.text ?? ""));
      if (peeled.answer) {
        out[thoughtIdx] = {
          ...thought,
          payload: { ...thought.payload, text: peeled.thought },
        };
        out.splice(thoughtIdx + 1, 0, {
          ...thought,
          id: `${thought.id}-peeled-answer`,
          type: "text",
          order: thought.order + 0.5,
          payload: { text: peeled.answer },
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
          <div className={styles.thoughtEmbeddedLabel}>
            {streaming && <span className={styles.pulseDot} />}
            {t("common.reasoning")}
          </div>
          {body}
        </div>
      );
    }
    // Standalone thoughts are folded into «Шаги»; keep a minimal fallback.
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

function isThoughtPart(part: MessagePartDto) {
  return part.type === "thought" && Boolean(String(part.payload.text ?? "").trim());
}

function StepsSpoiler({
  parts,
  streaming,
}: {
  parts: MessagePartDto[];
  streaming: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const thoughts = parts.filter(isThoughtPart);

  if (thoughts.length === 0) return null;

  return (
    <div
      className={`${styles.steps} ${open ? styles.stepsOpen : ""} ${
        streaming ? styles.stepsLive : ""
      }`}
    >
      <button
        type="button"
        tabIndex={-1}
        className={styles.partToggle}
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.thoughtLabel}>
          {streaming && <span className={styles.pulseDot} />}
          {t("common.steps")}
        </span>
        <span className={styles.thoughtChevron} aria-hidden>
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
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

function MessageActions({ text }: { text: string }) {
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
    <div className={styles.msgActions} aria-label={t("common.actions")}>
      <button
        type="button"
        className={styles.msgAction}
        title={copied ? t("common.copied") : t("common.copy")}
        aria-label={t("common.copy")}
        onClick={() => void copy()}
      >
        {copied ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M5 13l4 4L19 7"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
            <rect x="8" y="8" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.7" />
            <path
              d="M6 16V6a2 2 0 0 1 2-2h10"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
            />
          </svg>
        )}
      </button>
      <HoverTip as="button" className={styles.msgAction} aria-label={t("common.like")} text={t("common.soon")}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M7 11v9H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h2Zm0 0 4.2-7.2A2.2 2.2 0 0 1 13.2 3h.3a2 2 0 0 1 2 2.3L14.8 11H20a2 2 0 0 1 2 2.3l-1.1 5.2A3 3 0 0 1 18 21H7"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
      </HoverTip>
      <HoverTip as="button" className={styles.msgAction} aria-label={t("common.dislike")} text={t("common.soon")}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M17 13V4h2a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2Zm0 0-4.2 7.2A2.2 2.2 0 0 1 10.8 21h-.3a2 2 0 0 1-2-2.3L9.2 13H4a2 2 0 0 1-2-2.3L3.1 5.5A3 3 0 0 1 6 3h11"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
      </HoverTip>
      <HoverTip as="button" className={styles.msgAction} aria-label={t("common.share")} text={t("common.soon")}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M12 3v10M12 3l-3.5 3.5M12 3l3.5 3.5M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </HoverTip>
      <HoverTip as="button" className={styles.msgAction} aria-label={t("common.retry")} text={t("common.soon")}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M4 12a8 8 0 0 1 13.7-5.7L20 8M20 4v4h-4M20 12a8 8 0 0 1-13.7 5.7L4 16M4 20v-4h4"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </HoverTip>
      <HoverTip as="button" className={styles.msgAction} aria-label={t("common.more")} text={t("common.soon")}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="5" cy="12" r="1.5" fill="currentColor" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" />
          <circle cx="19" cy="12" r="1.5" fill="currentColor" />
        </svg>
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

function coalesceAssistantParts(parts: MessagePartDto[]): MessagePartDto[] {
  const coalesced = coalesceParts(parts);
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
}: {
  message: MessageDto;
  streaming: boolean;
}) {
  const parts = useMemo(
    () => coalesceAssistantParts(message.parts),
    [message.id, message.parts],
  );

  const thoughtParts = useMemo(
    () => parts.filter((p) => p.type === "thought" && Boolean(String(p.payload.text ?? "").trim())),
    [parts],
  );
  const mainParts = useMemo(
    () => parts.filter((p) => p.type === "text" || p.type === "error" || p.type === "subagent"),
    [parts],
  );
  const plain = useMemo(() => assistantPlainText(message), [message]);
  const thoughtsStreaming = streaming && mainParts.every((p) => p.type !== "text");

  return (
    <div className={styles.parts}>
      <StepsSpoiler parts={thoughtParts} streaming={thoughtsStreaming || (streaming && mainParts.length === 0)} />
      {mainParts.map((part, idx) => {
        const isLast = idx === mainParts.length - 1;
        return (
          <PartView
            key={part.id}
            part={part}
            streaming={
              streaming && isLast && (part.type === "text" || part.type === "subagent")
            }
          />
        );
      })}
      {!streaming && plain ? <MessageActions text={plain} /> : null}
    </div>
  );
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
  const [text, setText] = useState("");
  const [composerMultiline, setComposerMultiline] = useState(false);
  const [cursorPos, setCursorPos] = useState(0);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashKeyboardNav, setSlashKeyboardNav] = useState(false);
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);
  const [modelParamValues, setModelParamValues] = useState<Record<string, string>>(
    () => settings.defaultModelParams ?? {},
  );
  const [model, setModel] = useState(settings.defaultModel);
  const [folderPicker, setFolderPicker] = useState<{ x: number; y: number } | null>(null);
  const [paramsLoading, setParamsLoading] = useState(false);
  const [stableParams, setStableParams] = useState<ModelParamDto[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const userJustSentRef = useRef(false);
  const keepComposerFocus = useRef(false);
  const paramsCacheRef = useRef(new Map<string, ModelParamDto[]>());
  const streaming = activeSession?.status === "running" || activeSession?.status === "waiting";

  const setComposerMultilineIfNeeded = (next: boolean) => {
    setComposerMultiline((prev) => (prev === next ? prev : next));
  };

  const syncComposerSize = (el: HTMLTextAreaElement) => {
    const value = el.value;
    if (!value) {
      el.style.height = "auto";
      el.style.width = "";
      setComposerMultilineIfNeeded(false);
      return;
    }

    const hasNewline = value.includes("\n");
    const pill = el.parentElement;
    const pillW = pill?.clientWidth ?? el.clientWidth;

    el.style.height = "auto";
    el.style.width = "";

    if (hasNewline) {
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
      setComposerMultilineIfNeeded(true);
      return;
    }

    // Probe whether text still wraps if controls sit on the same row (~220px chrome).
    const narrowW = Math.max(120, pillW - 220);
    el.style.width = `${narrowW}px`;
    const narrowH = el.scrollHeight;
    el.style.width = "";

    const needsMultiline = narrowH > 48;
    setComposerMultilineIfNeeded(needsMultiline);

    if (needsMultiline) {
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    } else {
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    }
  };

  // Models / ACP only after the user explicitly connected an agent.
  const agentProvider = settings.connectedProvider ?? null;
  const agentMissing = !agentProvider;

  const catalog =
    agentProvider && modelsCatalog?.provider === agentProvider ? modelsCatalog : null;
  const models = catalog?.models ?? [];
  const modelParams = catalog?.modelParams ?? [];
  // Block typing while agent missing, or while models are loading with empty list.
  const composerLocked = agentMissing || (modelsLoading && models.length === 0);

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
    setComposerMultiline(insertion.includes("\n"));
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
      setComposerMultiline(false);
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
      setComposerMultiline(false);
      void cancelPrompt();
      return;
    }
    if (shouldAutoFocusComposer()) {
      keepComposerFocus.current = true;
    } else {
      keepComposerFocus.current = false;
    }
    userJustSentRef.current = true;
    setText("");
    setCursorPos(0);
    setComposerMultiline(false);
    setSlashMenuDismissed(true);
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
    }
    if (shouldAutoFocusComposer()) {
      focusComposer();
      void sendPrompt(value).finally(() => {
        requestAnimationFrame(focusComposer);
        window.setTimeout(focusComposer, 0);
        window.setTimeout(focusComposer, 100);
      });
    } else {
      textareaRef.current?.blur();
      void sendPrompt(value);
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
    syncComposerSize(el);
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
  const prevSessionIdRef = useRef<string | null>(null);

  const scrollThreadToEnd = () => {
    const thread = threadRef.current;
    const end = messageEndRef.current;
    if (!thread) return;
    thread.scrollTop = thread.scrollHeight;
    end?.scrollIntoView({ block: "end", behavior: "auto" });
  };

  useLayoutEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    const sessionChanged = activeSessionId !== prevSessionIdRef.current;
    if (sessionChanged) {
      prevSessionIdRef.current = activeSessionId;
      scrollThreadToEnd();
      requestAnimationFrame(() => {
        scrollThreadToEnd();
        requestAnimationFrame(scrollThreadToEnd);
      });
      userJustSentRef.current = false;
      if (!shouldAutoFocusComposer()) {
        textareaRef.current?.blur();
      } else if (keepComposerFocus.current) {
        focusComposer();
      }
      return;
    }
    const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
    if (userJustSentRef.current || nearBottom) {
      scrollThreadToEnd();
      userJustSentRef.current = false;
    }
    if (keepComposerFocus.current) focusComposer();
  }, [activeSessionId, lastMessageId, messageCount, activeSession?.status]);

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    const onFocusIn = (e: FocusEvent) => {
      if (!shouldAutoFocusComposer() || !keepComposerFocus.current) return;
      const target = e.target as Node | null;
      if (!target || target === textareaRef.current) return;
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

  const lastAssistantId = [...(activeSession?.messages ?? [])]
    .reverse()
    .find((m) => m.role === "assistant")?.id;

  return (
    <div className={styles.page}>
      <div className={styles.thread} ref={threadRef}>
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

        {activeSession?.messages.map((msg) => {
          const isLiveAssistant = streaming && msg.id === lastAssistantId;
          // Don't render an empty assistant shell — it caused a blank gap
          // between "Агент думает" and the first streamed tokens.
          if (
            msg.role === "assistant" &&
            !hasRenderableAssistantContent(msg.parts)
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
                <UserMessage message={msg} slashCommands={slashCommands} />
              ) : (
                <AssistantParts message={msg} streaming={!!isLiveAssistant} />
              )}
            </article>
          );
        })}
        <div ref={messageEndRef} className={styles.threadEnd} aria-hidden />
      </div>

      {error && <div className={styles.banner}>{error}</div>}

      <form className={styles.composer} onSubmit={onSubmit}>
        <div className={styles.composerInner}>
          {agentMissing && (
            <div className={styles.typingBar} aria-live="polite">
              {t("common.connectAgentInSettings")}
            </div>
          )}
          {composerLocked && !agentMissing && (
            <div className={styles.typingBar} aria-live="polite">
              <span className={styles.modelsLoaderSpin} aria-hidden />
              <span>{t("common.loadingModels")}</span>
            </div>
          )}
          {activeSession?.status === "running" && (
            <div className={styles.typingBar} aria-live="polite">
              <span>{t("common.agentThinking")}</span>
              <span className={styles.typingDots} aria-hidden>
                <span />
                <span />
                <span />
              </span>
            </div>
          )}
          {activeSession?.status === "waiting" && (
            <div className={styles.typingBar}>{t("common.waitingInput")}</div>
          )}
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

                {streaming ? (
                  <button
                    type="button"
                    className={styles.stopBtn}
                    title={t("common.stop")}
                    aria-label={t("common.stop")}
                    onClick={() => void cancelPrompt()}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <rect x="6" y="6" width="12" height="12" rx="2" />
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

      <PermissionModal />
      <QuestionModal />
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
  );
}
