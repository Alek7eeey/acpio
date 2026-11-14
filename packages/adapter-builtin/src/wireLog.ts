import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The wire log: every request the built-in agent puts on the wire, recorded
 * whole — headers, body, the answer's status and the usage the provider
 * reported. It exists because the two questions a bill raises cannot be
 * answered from the transcript: *which* requests were sent, and *why* the
 * provider charged them in full while its cache should have served the prefix
 * (see the `prefixSame` field — the count of leading messages that match the
 * request before it).
 *
 * Off by default. Switched on by `ACPIO_WIRE_LOG=1` or by an `on` file in the
 * log folder, and re-read every few seconds so a running server can be turned
 * over without a restart. Full bodies are a second step: `ACPIO_WIRE_LOG=full`,
 * or the word `full` inside the `on` file, writes each request body to its own
 * file and names it in the line — hundreds of megabytes on a long chat, which
 * is why the line alone carries the hashes that spot a moving head, and why the
 * bodies are opt-in.
 */
export interface WireLogTarget {
  /** The chat these requests belong to — one log file per chat. */
  sessionId: string;
  /** The provider row the key came from. */
  providerId: string;
}

/**
 * Folder the dumps land in. The host names it — the server points it at the
 * install's `data/wire-log`, beside the database, whatever folder it was
 * started from — and `<cwd>/data/wire-log` is only the fallback for a host that
 * says nothing.
 */
export function wireLogDir(): string {
  const raw = (process.env.ACPIO_WIRE_LOG_DIR ?? "").trim();
  return raw || path.join(process.cwd(), "data", "wire-log");
}

const STATE_TTL_MS = 5_000;
let stateReadAt = 0;
let state: "off" | "summary" | "full" = "off";

/** Whether anything is recorded right now — the switch, re-read at most every 5s. */
export function wireLogState(): "off" | "summary" | "full" {
  const now = Date.now();
  if (now - stateReadAt < STATE_TTL_MS) return state;
  stateReadAt = now;
  const env = (process.env.ACPIO_WIRE_LOG ?? "").trim().toLowerCase();
  if (env === "full") state = "full";
  else if (env === "1" || env === "true" || env === "yes") state = "summary";
  else {
    try {
      // The switch file also names the mode: `full` in it writes every request
      // body, so a moving head can be read rather than guessed at — and it is
      // the one switch a running server can be turned over to without a restart.
      const flag = path.join(wireLogDir(), "on");
      if (!fs.existsSync(flag)) state = "off";
      else {
        const text = fs.readFileSync(flag, "utf8").trim().toLowerCase();
        state = text === "full" ? "full" : "summary";
      }
    } catch {
      state = "off";
    }
  }
  return state;
}

/** What the previous request of one chat looked like, for the prefix comparison. */
interface Previous {
  seq: number;
  /** One hash per message, chained: equal heads give equal prefixes. */
  chain: string[];
  system: string;
  tools: string;
  key: string;
}
const previous = new Map<string, Previous>();
const seqOf = new Map<string, number>();

function shortHash(value: string): string {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 10);
}

/** The `messages` array of an OpenAI-compatible body, whatever its wording. */
function bodyMessages(body: Record<string, unknown>): unknown[] {
  const messages = body.messages;
  return Array.isArray(messages) ? messages : [];
}

/** A per-message hash chain: comparing two chains names the first differing message. */
function chainOf(messages: unknown[]): string[] {
  const out: string[] = [];
  let acc = "";
  for (const message of messages) {
    acc = shortHash(acc + JSON.stringify(message));
    out.push(acc);
  }
  return out;
}

/** How many leading messages of two chains are identical. */
export function sharedPrefix(a: readonly string[], b: readonly string[]): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i += 1;
  return i;
}

/** One line of the log, written without ever throwing into the request path. */
function appendLine(file: string, line: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    /* a diagnostics write must never fail a chat */
  }
}

/** The key behind a request, as a fingerprint: enough to spot a switch, no secret. */
function keyFingerprint(init: RequestInit | undefined): string {
  const headers = new Headers(init?.headers);
  const auth = headers.get("authorization") ?? "";
  const key = auth.replace(/^Bearer\s+/i, "").trim();
  if (!key) return "";
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/** Headers as a plain object, with the authorization value replaced by its fingerprint. */
function headerRecord(init: RequestInit | undefined): Record<string, string> {
  const headers = new Headers(init?.headers);
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name] = name.toLowerCase() === "authorization" ? `Bearer <${keyFingerprint(init)}>` : value;
  });
  return out;
}

/** Tokens the provider says it read, plus the object it said it in. */
function usageFromText(
  text: string,
): { numbers: Record<string, number>; raw: unknown } | null {
  const pick = (usage: unknown): { numbers: Record<string, number>; raw: unknown } | null => {
    const u = usage as Record<string, any> | undefined;
    if (!u || typeof u !== "object") return null;
    const cached = Number(u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? 0) || 0;
    const input = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
    const output = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
    if (!input && !output) return null;
    return { numbers: { input, cached, output }, raw: u };
  };
  const whole = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })();
  const direct = pick(whole?.usage);
  if (direct) return direct;
  // A stream: the usage rides the last `data:` chunks (or an `opencode` block).
  let found: { numbers: Record<string, number>; raw: unknown } | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = pick(JSON.parse(payload)?.usage);
      if (parsed) found = parsed;
    } catch {
      /* a partial chunk */
    }
  }
  return found;
}

/**
 * `fetch` that records what it sends and what it was charged, then hands the
 * untouched response back. The body is only read for the log when the switch
 * says so; the answer is read from a clone, so the caller keeps its stream.
 */
export function withWireLog(target: WireLogTarget, base: typeof fetch): typeof fetch {
  return async (input, init) => {
    if (wireLogState() === "off") return base(input, init);
    const started = Date.now();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url ?? "");
    const rawBody = typeof init?.body === "string" ? init.body : "";
    let body: Record<string, unknown> = {};
    try {
      body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    const messages = bodyMessages(body);
    const chain = chainOf(messages);
    const system = shortHash(JSON.stringify(body.system ?? ""));
    const tools = shortHash(JSON.stringify(body.tools ?? ""));
    const key = keyFingerprint(init);
    const chatKey = `${target.providerId}\u0000${target.sessionId}`;
    const before = previous.get(chatKey);
    const seq = (seqOf.get(chatKey) ?? 0) + 1;
    seqOf.set(chatKey, seq);
    previous.set(chatKey, { seq, chain, system, tools, key });

    const mode = wireLogState();
    // A body is megabytes: it rides its own file, and the line carries the name
    // so a reader never has to guess it. The line stays small enough to read
    // whole, which is what makes `prefixSame` usable.
    const bodyFile =
      mode === "full"
        ? `${target.sessionId.slice(0, 8)}/${String(seq).padStart(4, "0")}.req.json`
        : "";
    const file = path.join(wireLogDir(), `${target.sessionId.slice(0, 8)}.jsonl`);
    const entry: Record<string, unknown> = {
      ts: new Date(started).toISOString(),
      kind: "request",
      seq,
      sessionId: target.sessionId,
      provider: target.providerId,
      url,
      model: typeof body.model === "string" ? body.model : "",
      stream: body.stream === true,
      headers: headerRecord(init),
      key,
      keyChanged: before ? before.key !== key : false,
      messages: messages.length,
      /** Messages whose bytes match the previous request, from the head up. */
      prefixSame: before ? sharedPrefix(before.chain, chain) : null,
      prevMessages: before?.chain.length ?? null,
      system,
      tools,
      systemChanged: before ? before.system !== system : false,
      toolsChanged: before ? before.tools !== tools : false,
      bodyBytes: rawBody.length,
      ...(bodyFile ? { bodyFile } : {}),
    };
    appendLine(file, entry);
    if (bodyFile) {
      try {
        const bodyPath = path.join(wireLogDir(), bodyFile);
        fs.mkdirSync(path.dirname(bodyPath), { recursive: true });
        fs.writeFileSync(bodyPath, rawBody, "utf8");
      } catch {
        /* ignore */
      }
    }

    const response = await base(input, init);
    const ms = Date.now() - started;
    // The answer's usage rides a clone: the caller's stream stays untouched.
    void (async () => {
      let usage: Record<string, number> | null = null;
      let usageRaw: unknown = null;
      let text = "";
      try {
        text = await response.clone().text();
        const parsed = usageFromText(text);
        usage = parsed?.numbers ?? null;
        // The provider's own wording: an endpoint that reports its cache under
        // another name (`prompt_cache_hit_tokens`) reads as a 0 % miss until
        // this object says which field it actually sent.
        usageRaw = parsed?.raw ?? null;
      } catch {
        usage = null;
      }
      appendLine(file, {
        ts: new Date().toISOString(),
        kind: "response",
        seq,
        status: response.status,
        ms,
        usage,
        ...(usageRaw ? { usageRaw } : {}),
        contentLength: text.length,
        ...(response.status >= 400 ? { error: text.slice(0, 500) } : {}),
      });
    })();
    return response;
  };
}

/** Forget what the previous requests looked like — a test's clean slate. */
export function resetWireLogState(): void {
  previous.clear();
  seqOf.clear();
  stateReadAt = 0;
  state = "off";
}
