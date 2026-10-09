import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelMessage } from "ai";

/** One conversation as the agent keeps it — enough to resume after a restart. */
export interface BuiltinStoredSession {
  version: 1;
  cwd: string;
  modelId: string;
  messages: ModelMessage[];
}

/** Session ids become file names, so never trust one blindly. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Ids are used as file names and ACP parameters — same rule everywhere. */
export function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

function fileFor(stateDir: string, sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error(`Некорректный id сессии: ${sessionId}`);
  return join(stateDir, `${sessionId}.json`);
}

export function loadBuiltinSession(stateDir: string, sessionId: string): BuiltinStoredSession | undefined {
  try {
    const parsed = JSON.parse(readFileSync(fileFor(stateDir, sessionId), "utf8")) as Partial<BuiltinStoredSession>;
    if (parsed?.version !== 1 || !Array.isArray(parsed.messages)) return undefined;
    return {
      version: 1,
      cwd: String(parsed.cwd ?? ""),
      modelId: String(parsed.modelId ?? ""),
      messages: parsed.messages as ModelMessage[],
    };
  } catch {
    // Missing or corrupt file: start fresh instead of bricking the session.
    return undefined;
  }
}

/**
 * Copy of the history safe to store: image bytes survive only in the newest
 * user turn. The live history in memory is untouched, so the current turn keeps
 * every picture — this only stops one chat's JSON from growing by megabytes per
 * attached screenshot, forever. Older images were already in front of the model
 * when their turn ran; on restore they read as a text placeholder.
 */
function withoutOldImages(messages: ModelMessage[]): ModelMessage[] {
  let newestUser = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") {
      newestUser = i;
      break;
    }
  }
  return messages.map((m, i) => {
    if (m.role !== "user" || i === newestUser || !Array.isArray(m.content)) return m;
    const content = m.content.map((part) =>
      part.type === "file"
        ? { type: "text" as const, text: "[изображение из предыдущего сообщения — не сохранено]" }
        : part,
    );
    return content.some((part, n) => part !== m.content[n]) ? { ...m, content } : m;
  });
}

/** Atomic replace — a crash mid-write must not leave a half-parsed history. */
export function saveBuiltinSession(stateDir: string, sessionId: string, data: BuiltinStoredSession): void {
  const file = fileFor(stateDir, sessionId);
  mkdirSync(stateDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify({ ...data, messages: withoutOldImages(data.messages) }),
    "utf8",
  );
  renameSync(tmp, file);
}
