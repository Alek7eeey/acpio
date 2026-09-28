// Transparent OpenAI-compatible LLM proxy for the bench.
//
// Every agent is pointed at this proxy instead of the provider, so the wire is
// the source of truth: which parameters each harness sends, how big its system
// prompt and tool schemas are, how many model calls a task costs, how the
// prompt grows, and whether the client's self-reported tokens match the ones
// the server actually sent.
//
//   const proxy = new LlmProxy({ upstream, outDir, stamp });
//   await proxy.start();          // -> base URL to hand to every agent
//   proxy.setLabel({ agent, task, repeat });
//   proxy.stop();  proxy.write(); // -> bench/results/<stamp>.calls.jsonl
//
// Forwarding is byte-transparent except for `accept-encoding`, which is
// dropped so captured bodies are readable without decompression.
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Per-response capture ceiling: keep counting past it, stop storing text. */
const MAX_CAPTURE = 2 * 1024 * 1024;
/** Full request bodies are opt-in (`--proxy-dump`) and capped per call. */
const MAX_REQUEST_DUMP = 8 * 1024 * 1024;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function describeRequest(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const chars = {};
  for (const m of messages) {
    const text = typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
    const role = String(m?.role ?? "?");
    chars[role] = (chars[role] ?? 0) + text.length;
  }
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const params = {};
  for (const k of [
    "temperature",
    "top_p",
    "max_tokens",
    "max_completion_tokens",
    "tool_choice",
    "parallel_tool_calls",
    "reasoning_effort",
    "presence_penalty",
    "frequency_penalty",
    "seed",
  ]) {
    if (body?.[k] !== undefined) params[k] = body[k];
  }
  // `include_usage` is the difference between real token numbers and estimates.
  params.include_usage = body?.stream_options?.include_usage === true;
  params.stream = body?.stream === true;
  const system = messages.find((m) => m?.role === "system" || m?.role === "developer");
  return {
    model: body?.model ?? null,
    stream: body?.stream === true,
    messages: messages.length,
    chars,
    tools: tools.length,
    toolNames: tools.map((t) => t?.function?.name).filter(Boolean),
    toolsChars: tools.length ? JSON.stringify(tools).length : 0,
    params,
    systemHead: String(typeof system?.content === "string" ? system.content : "").slice(0, 160),
  };
}

/** Fold one SSE chunk into the response summary. */
function absorbChunk(acc, chunk) {
  if (chunk?.usage) {
    acc.usage = {
      prompt: num(chunk.usage.prompt_tokens),
      completion: num(chunk.usage.completion_tokens),
      total: num(chunk.usage.total_tokens),
      cached: num(
        chunk.usage.prompt_tokens_details?.cached_tokens ??
          chunk.usage.prompt_tokens_details?.cached ??
          chunk.usage.cached_tokens,
      ),
    };
  }
  // llama.cpp reports its prompt-cache hit next to `usage`, not inside it.
  if (acc.usage && chunk?.timings && typeof chunk.timings.cache_n === "number") {
    acc.usage.cached = num(chunk.timings.cache_n);
  }
  for (const choice of chunk?.choices ?? []) {
    if (choice?.finish_reason) acc.finishReason = choice.finish_reason;
    const delta = choice?.delta ?? {};
    if (typeof delta.content === "string") acc.textChars += delta.content.length;
    for (const call of delta.tool_calls ?? []) {
      const name = call?.function?.name;
      if (name && !acc.toolCalls.includes(name)) acc.toolCalls.push(name);
    }
  }
}

/** Parse an SSE body that arrived whole (used by tests and non-streaming paths). */
export function summarizeSse(text) {
  const acc = { finishReason: null, usage: null, toolCalls: [], textChars: 0 };
  for (const event of text.split(/\r?\n\r?\n/)) {
    for (const line of event.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        absorbChunk(acc, JSON.parse(payload));
      } catch {}
    }
  }
  return acc;
}

export class LlmProxy {
  constructor({ upstream, outDir, stamp, dump = false, verbose = false }) {
    const url = new URL(upstream);
    this.origin = url.origin;
    // The client-facing base keeps the provider's path (`/v1`), so requests
    // arrive as `/v1/chat/completions` and forward unchanged.
    this.prefix = url.pathname.replace(/\/+$/, "");
    this.outDir = outDir;
    this.stamp = stamp;
    this.dump = dump;
    this.verbose = verbose;
    this.port = 0;
    this.calls = [];
    this.label = { agent: null, task: null, repeat: 0 };
    this.t0 = Date.now();
    this.server = createServer((req, res) => {
      this.#handle(req, res).catch((err) => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        res.end(`proxy error: ${err.message}`);
      });
    });
  }

  get base() {
    return `http://127.0.0.1:${this.port}${this.prefix}`;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.port = this.server.address().port;
        resolve(this.base);
      });
    });
  }

  setLabel(label) {
    this.label = { ...label };
  }

  stop() {
    this.server.close();
  }

  write() {
    mkdirSync(this.outDir, { recursive: true });
    const file = path.join(this.outDir, `${this.stamp}.calls.jsonl`);
    writeFileSync(file, this.calls.map((c) => JSON.stringify(c)).join("\n") + "\n");
    return file;
  }

  /** Roll the raw calls up per agent/task for the report and the console. */
  summary() {
    const groups = new Map();
    for (const call of this.calls) {
      const key = `${call.label.agent}\u0000${call.label.task}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(call);
    }
    return [...groups.entries()].map(([key, calls]) => {
      const [agent, task] = key.split("\u0000");
      const prompts = calls.map((c) => c.response.usage?.prompt).filter((v) => typeof v === "number");
      const cached = calls
        .map((c) => c.response.usage?.cached)
        .filter((v) => typeof v === "number");
      const first = calls[0];
      const last = calls[calls.length - 1];
      return {
        agent,
        task,
        repeats: new Set(calls.map((c) => c.label.repeat)).size,
        calls: calls.length,
        errors: calls.filter((c) => c.status >= 400).length,
        usageCalls: prompts.length,
        promptTokensFirst: prompts.length ? prompts[0] : null,
        promptTokensLast: prompts.length ? prompts[prompts.length - 1] : null,
        cachedTokens: cached.length ? cached.reduce((n, v) => n + v, 0) : null,
        cachedTokensLast: cached.length ? cached[cached.length - 1] : null,
        systemChars: first?.request.chars.system ?? 0,
        tools: first?.request.tools ?? 0,
        toolsChars: first?.request.toolsChars ?? 0,
        params: first?.request.params ?? {},
        grownChars: last && first ? (last.request.chars.assistant ?? 0) - (first.request.chars.assistant ?? 0) : 0,
      };
    });
  }

  async #handle(req, res) {
    const target = this.origin + req.url;
    const chunks = [];
    let requestBytes = 0;
    for await (const chunk of req) {
      requestBytes += chunk.length;
      if (requestBytes <= MAX_REQUEST_DUMP) chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks);
    let body = null;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {}

    const call = {
      n: this.calls.length + 1,
      tMs: Date.now() - this.t0,
      label: { ...this.label },
      method: req.method,
      url: req.url,
      requestBytes,
      request: body ? describeRequest(body) : null,
      status: 0,
      ms: 0,
      response: { finishReason: null, usage: null, toolCalls: [], textChars: 0, error: null, truncated: false },
    };
    this.calls.push(call);

    const headers = { ...req.headers };
    delete headers.host;
    delete headers["content-length"];
    delete headers["accept-encoding"]; // keep bodies readable for capture
    headers["content-length"] = String(rawBody.length);

    const started = Date.now();
    await new Promise((resolve) => {
      const upstreamReq = httpRequest(target, { method: req.method, headers }, (upstreamRes) => {
        call.status = upstreamRes.statusCode ?? 0;
        res.writeHead(call.status, upstreamRes.headers);
        // The client may vanish mid-stream (timeout kill, Ctrl-C). Writing to a
        // dead socket throws inside a stream handler, which would take the whole
        // proxy - and the run - down with it.
        res.on("error", () => {});
        const isSse = String(upstreamRes.headers["content-type"] ?? "").includes("text/event-stream");
        let captured = "";
        let pending = "";
        upstreamRes.on("data", (chunk) => {
          if (res.destroyed || res.writableEnded) {
            upstreamRes.destroy();
            return;
          }
          res.write(chunk); // pass through first: the client never waits on us
          if (captured.length < MAX_CAPTURE) {
            captured += chunk.toString("utf8");
          } else {
            call.response.truncated = true;
          }
          if (!isSse) return;
          pending += chunk.toString("utf8");
          let cut;
          while ((cut = pending.search(/\r?\n\r?\n/)) >= 0) {
            const event = pending.slice(0, cut);
            pending = pending.slice(cut + (pending[cut] === "\r" ? 4 : 2));
            for (const line of event.split(/\r?\n/)) {
              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trim();
              if (!payload || payload === "[DONE]") continue;
              try {
                absorbChunk(call.response, JSON.parse(payload));
              } catch {}
            }
          }
        });
        upstreamRes.on("end", () => {
          if (!isSse) {
            try {
              const json = JSON.parse(captured);
              call.response.usage = json.usage
                ? {
                    prompt: num(json.usage.prompt_tokens),
                    completion: num(json.usage.completion_tokens),
                    total: num(json.usage.total_tokens),
                    cached: num(
                      json.usage.prompt_tokens_details?.cached_tokens ??
                        json.timings?.cache_n,
                    ),
                  }
                : null;
              call.response.finishReason = json.choices?.[0]?.finish_reason ?? null;
              call.response.toolCalls = (json.choices?.[0]?.message?.tool_calls ?? [])
                .map((c) => c?.function?.name)
                .filter(Boolean);
              call.response.textChars = String(json.choices?.[0]?.message?.content ?? "").length;
            } catch {}
          }
          if (call.status >= 400) call.response.error = captured.slice(0, 300);
          call.ms = Date.now() - started;
          res.end();
          this.#log(call, rawBody);
          resolve();
        });
        upstreamRes.on("error", () => {
          call.response.error = "upstream stream error";
          call.ms = Date.now() - started;
          res.end();
          resolve();
        });
      });
      upstreamReq.on("error", (err) => {
        call.status = 502;
        call.response.error = err.message;
        call.ms = Date.now() - started;
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        res.end(`proxy: ${err.message}`);
        resolve();
      });
      req.on("aborted", () => upstreamReq.destroy());
      upstreamReq.end(rawBody);
    });
  }

  #log(call, rawBody) {
    if (this.dump) {
      const dir = path.join(this.outDir, `${this.stamp}.calls`);
      mkdirSync(dir, { recursive: true });
      const name = `${String(call.n).padStart(3, "0")}-${call.label.agent ?? "?"}-${call.request?.model ?? "?"}.json`;
      writeFileSync(path.join(dir, name), JSON.stringify({ meta: call, body: JSON.parse(rawBody.toString("utf8").slice(0, MAX_REQUEST_DUMP) || "null") }, null, 2));
    }
    if (this.verbose) {
      const r = call.request;
      console.log(
        `  [proxy] #${call.n} ${call.label.agent}/${call.label.task} ${call.status} ${call.ms}ms ` +
          `msgs=${r?.messages ?? "?"} sysChars=${r?.chars?.system ?? 0} tools=${r?.tools ?? 0} ` +
          `in=${call.response.usage?.prompt ?? "-"} out=${call.response.usage?.completion ?? "-"} ` +
          `cached=${call.response.usage?.cached ?? "-"} ` +
          `finish=${call.response.finishReason ?? "-"} calls=[${call.response.toolCalls.join(",")}]`,
      );
    }
  }
}
