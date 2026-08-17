import fs from "node:fs/promises";
import path from "node:path";
import { toolDisplayTitle, type AppLocale, type AppSettings, type MessageDto, type SessionDetailDto } from "@acprocess/shared";
import { t } from "@acprocess/i18n";
import { REPO_ROOT } from "../db/client.js";
import { getSettings } from "./settings.js";
import { getSessionDetail } from "./sessions.js";

export type ExportFormat = "md" | "json";

/** Folder on the server where chat exports land unless settings.exportDir is set. */
export function defaultExportDir(): string {
  return path.join(REPO_ROOT, "exports");
}

export async function resolveExportDir(settings?: AppSettings): Promise<string> {
  const cfg = settings ?? (await getSettings());
  const raw = (cfg.exportDir || "").trim();
  if (!raw) return defaultExportDir();
  return path.resolve(raw);
}

/** Title → filesystem-safe file base (no path separators, no reserved chars). */
export function safeFileBase(title: string): string {
  const cleaned = title
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 80);
  return cleaned || "chat";
}

export function exportFileName(detail: SessionDetailDto, format: ExportFormat): string {
  const stamp = (detail.lastMessageAt || detail.createdAt || "").slice(0, 10);
  const ext = format === "md" ? "md" : "json";
  return `${safeFileBase(detail.title)}-${stamp}.${ext}`;
}

function formatDate(iso: string, locale: AppLocale): string {
  try {
    return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "ru-RU", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** Text payload field of a part, whatever the shape. */
function partText(part: MessageDto["parts"][number]): string {
  const payload = part.payload ?? {};
  return String(payload.text ?? payload.message ?? payload.summary ?? "").trim();
}

/** Tool call output: string or array of content blocks (mirrors the UI extractor). */
function toolOutputText(part: MessageDto["parts"][number]): string {
  const raw = (part.payload.raw ?? {}) as Record<string, unknown>;
  const rawOutput = (raw.rawOutput ?? {}) as Record<string, unknown>;
  const content = raw.content ?? rawOutput.content;
  let text = "";
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = (block ?? {}) as Record<string, unknown>;
      const inner = b.content as Record<string, unknown> | undefined;
      const part =
        typeof inner?.text === "string"
          ? inner.text
          : typeof b.text === "string"
            ? b.text
            : "";
      text += part;
    }
  } else if (typeof content === "string") {
    text = content;
  }
  return text.trim();
}

/** Structured text extraction for subagent results (mirrors the UI). */
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

function subagentBody(part: MessageDto["parts"][number]): string {
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

function subagentTitle(part: MessageDto["parts"][number]): string {
  const raw = (part.payload.raw as Record<string, unknown> | undefined) ?? {};
  return (
    [part.payload.description, part.payload.title, raw.title, raw.description, raw.name, part.payload.subagentType]
      .map((v) => String(v ?? "").trim())
      .filter(Boolean)
      .find((v) => !/^(tool|task|subagent|агент|субагент)$/i.test(v)) ?? ""
  );
}

/** Longest backtick run + 1, at least 3 — keeps fences inside tool output safe. */
export function fenceFor(text: string): string {
  let longest = 0;
  let run = 0;
  for (const ch of text) {
    if (ch === "`") {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  }
  return "`".repeat(Math.max(longest + 1, 3));
}

const TOOL_OUTPUT_CAP = 20000;

function truncate(text: string, locale: AppLocale): string {
  if (text.length <= TOOL_OUTPUT_CAP) return text;
  return `${text.slice(0, TOOL_OUTPUT_CAP)}\n${t(locale, "export.outputTruncated")}`;
}

function roleLabel(role: MessageDto["role"], locale: AppLocale): string {
  if (role === "user") return t(locale, "export.user");
  if (role === "assistant") return t(locale, "export.assistant");
  return t(locale, "export.system");
}

function modeLabel(mode: string, locale: AppLocale): string {
  if (mode === "agent" || mode === "plan" || mode === "ask") {
    return t(locale, `modes.${mode}`);
  }
  return mode;
}

/** Render one message (role heading + parts in emission order) to Markdown. */
function renderMessageMarkdown(message: MessageDto, locale: AppLocale): string {
  const lines: string[] = [];
  lines.push(`## ${roleLabel(message.role, locale)} · ${formatDate(message.createdAt, locale)}`);
  lines.push("");

  for (const part of message.parts) {
    const payload = part.payload ?? {};
    switch (part.type) {
      case "text": {
        const text = String(payload.text ?? "");
        if (text.trim()) {
          lines.push(text.trimEnd(), "");
        }
        break;
      }
      case "thought": {
        const text = String(payload.text ?? "").trim();
        if (!text) break;
        lines.push(`**${t(locale, "export.thinking")}**`, "");
        lines.push(...text.split("\n").map((l) => `> ${l}`), "");
        break;
      }
      case "tool_call": {
        const raw = (payload.raw as Record<string, unknown> | undefined) ?? {};
        const title =
          toolDisplayTitle(
            String(payload.title ?? payload.description ?? ""),
            typeof raw.toolName === "string" ? raw.toolName : undefined,
            raw.rawInput ?? raw.input ?? raw.arguments,
          ) || t(locale, "export.tool");
        const output = truncate(toolOutputText(part), locale);
        lines.push(`**${t(locale, "export.tool")}: ${title}**`, "");
        if (output) {
          const fence = fenceFor(output);
          lines.push(`${fence}text`, output, fence, "");
        }
        break;
      }
      case "subagent": {
        const title = subagentTitle(part);
        const body = truncate(subagentBody(part), locale);
        lines.push(`**${t(locale, "export.subagent")}${title ? `: ${title}` : ""}**`, "");
        if (body) {
          lines.push(body, "");
        }
        break;
      }
      case "file": {
        const name = String(payload.name ?? "file");
        const filePath = String(payload.path ?? "").trim();
        lines.push(`**${t(locale, "export.file")}:** ${name}${filePath ? ` (\`${filePath}\`)` : ""}`, "");
        break;
      }
      case "error": {
        const text = String(payload.message ?? "").trim();
        if (text) {
          lines.push(`_${t(locale, "export.error")}: ${text.replace(/\n/g, " ")}_`, "");
        }
        break;
      }
      case "status": {
        const text = partText(part);
        if (text) {
          lines.push(`_${t(locale, "export.status")}: ${text.replace(/\n/g, " ")}_`, "");
        }
        break;
      }
      case "plan": {
        const name = String(payload.name ?? "").trim();
        const plan = String(payload.plan ?? "").trim();
        if (name || plan) {
          lines.push(`**${t(locale, "export.plan")}${name ? `: ${name}` : ""}**`, "");
          if (plan) lines.push(plan, "");
        }
        break;
      }
      case "todo": {
        const items = Array.isArray(payload.items) ? payload.items : [];
        const entries = items.map((item) => {
          const row = (item ?? {}) as Record<string, unknown>;
          const done = row.done === true || row.status === "completed";
          return `- [${done ? "x" : " "}] ${String(row.text ?? row.name ?? "").trim()}`;
        });
        if (entries.some(Boolean)) {
          lines.push(`**${t(locale, "export.todos")}**`, "", ...entries, "");
        }
        break;
      }
      case "question":
      case "permission": {
        const text = String(
          payload.text ?? payload.message ?? payload.question ?? payload.prompt ?? "",
        ).trim();
        const label = part.type === "question" ? t(locale, "export.question") : t(locale, "export.permission");
        if (text) {
          lines.push(`**${label}:** ${text.replace(/\n/g, " ")}`, "");
        }
        break;
      }
      default: {
        const text = partText(part);
        if (text) lines.push(text, "");
      }
    }
  }

  // Drop the trailing blank line of the last part; keep one between messages.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/** Human-readable Markdown transcript of the whole session. */
export function renderMarkdown(detail: SessionDetailDto, locale: AppLocale): string {
  const out: string[] = [];
  out.push(`# ${detail.title}`, "");
  out.push(`> ${t(locale, "export.meta")}: ${detail.provider} · ${modeLabel(detail.mode, locale)}`, "");
  if (detail.cwd?.trim()) {
    out.push(`> ${t(locale, "export.metaFolder")}: \`${detail.cwd}\``, "");
  }
  out.push(
    `> ${t(locale, "export.metaMessages")}: ${detail.messages.length} · ${t(locale, "export.metaExported")}: ${formatDate(new Date().toISOString(), locale)}`,
    "",
  );
  out.push("---", "");
  if (detail.messages.length === 0) {
    out.push(t(locale, "export.emptyMessage"), "");
  }
  for (const message of detail.messages) {
    out.push(renderMessageMarkdown(message, locale), "");
  }
  return out.join("\n").trimEnd() + "\n";
}

/** Machine-readable dump of the session: meta + every message with its parts. */
export function renderJson(detail: SessionDetailDto): string {
  const data = {
    format: "acprocess-chat",
    version: 1,
    exportedAt: new Date().toISOString(),
    session: {
      id: detail.id,
      title: detail.title,
      provider: detail.provider,
      mode: detail.mode,
      cwd: detail.cwd,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
      lastMessageAt: detail.lastMessageAt,
    },
    messages: detail.messages.map((m) => ({
      role: m.role,
      createdAt: m.createdAt,
      parts: m.parts.map((p) => ({
        type: p.type,
        order: p.order,
        createdAt: p.createdAt,
        payload: p.payload,
      })),
    })),
  };
  return JSON.stringify(data, null, 2) + "\n";
}

export async function buildExport(
  sessionId: string,
  format: ExportFormat,
): Promise<{ detail: SessionDetailDto; content: string; fileName: string } | null> {
  const detail = await getSessionDetail(sessionId);
  if (!detail) return null;
  const settings = await getSettings();
  const locale = settings.locale ?? "ru";
  const content = format === "json" ? renderJson(detail) : renderMarkdown(detail, locale);
  return { detail, content, fileName: exportFileName(detail, format) };
}

/**
 * Write the export into the server export dir (settings.exportDir override,
 * default REPO_ROOT/exports). Never overwrites: appends -2, -3, … when the
 * name is already taken.
 */
export async function saveExportToDisk(
  sessionId: string,
  format: ExportFormat,
  dir?: string,
): Promise<{ path: string; fileName: string }> {
  const built = await buildExport(sessionId, format);
  if (!built) throw new Error("Session not found");

  const targetDir = dir?.trim() ? path.resolve(dir.trim()) : await resolveExportDir();
  await fs.mkdir(targetDir, { recursive: true });

  const base = built.fileName.replace(/\.[^.]+$/, "");
  const ext = format === "md" ? "md" : "json";
  let fileName = `${base}.${ext}`;
  let filePath = path.join(targetDir, fileName);
  for (let i = 2; i <= 999; i += 1) {
    try {
      await fs.access(filePath);
    } catch {
      break; // free name
    }
    fileName = `${base}-${i}.${ext}`;
    filePath = path.join(targetDir, fileName);
  }

  await fs.writeFile(filePath, built.content, "utf8");
  return { path: filePath, fileName };
}
