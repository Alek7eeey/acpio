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
import { request as httpsRequest } from "node:https";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
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
  constructor({ upstream, outDir, stamp, dump = false, verbose = false, sessionHeader = null }) {
    const url = new URL(upstream);
    this.origin = url.origin;
    // http.request cannot speak TLS: an https upstream throws
    // ERR_INVALID_PROTOCOL synchronously and every call 502s.
    this.transport = url.protocol === "https:" ? httpsRequest : httpRequest;
    // The client-facing base keeps the provider's path (`/v1`), so requests
    // arrive as `/v1/chat/completions` and forward unchanged.
    this.prefix = url.pathname.replace(/\/+$/, "");
    this.outDir = outDir;
    this.stamp = stamp;
    this.dump = dump;
    this.verbose = verbose;
    // Some gateways (opencode zen) refuse requests without a session header.
    // Injected per agent/task/repeat: every run gets a stable routing key and
    // one agent's cache slot is never thrashed by another's.
    this.sessionHeader = sessionHeader;
    this.port = 0;
    this.calls = [];
    // Incremental capture: every completed call is appended as it finishes, so
    // a killed runner (timeout, Ctrl-C, crash) keeps the wire it already saw —
    // write() at the end is then just an ordered rewrite of the same data.
    this.callsFile = path.join(this.outDir, `${this.stamp}.calls.jsonl`);
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
    writeFileSync(this.callsFile, this.calls.map((c) => JSON.stringify(c)).join("\n") + "\n");
    return this.callsFile;
  }

  /** Roll the raw calls up per agent/task/repeat for the report and the console. */
  summary() {
    const groups = new Map();
    for (const call of this.calls) {
      const key = `${call.label.agent}\u0000${call.label.task}\u0000${call.label.repeat}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(call);
    }
    return [...groups.entries()].map(([key, calls]) => {
      const [agent, task, repeat] = key.split("\u0000");
      const prompts = calls.map((c) => c.response.usage?.prompt).filter((v) => typeof v === "number");
      const completions = calls
        .map((c) => c.response.usage?.completion)
        .filter((v) => typeof v === "number");
      const cached = calls
        .map((c) => c.response.usage?.cached)
        .filter((v) => typeof v === "number");
      const first = calls[0];
      const last = calls[calls.length - 1];
      // A call with an unparseable body (e.g. a 404 on an auxiliary GET)
      // carries request: null — those are wire events, not crash material.
      const req = (c) => c.request ?? { chars: {}, tools: 0, toolsChars: 0, params: {} };
      const sum = (arr) => (arr.length ? arr.reduce((n, v) => n + v, 0) : null);
      return {
        agent,
        task,
        repeat: Number(repeat),
        calls: calls.length,
        errors: calls.filter((c) => c.status >= 400).length,
        usageCalls: prompts.length,
        promptTokens: sum(prompts),
        completionTokens: sum(completions),
        promptTokensFirst: prompts.length ? prompts[0] : null,
        promptTokensLast: prompts.length ? prompts[prompts.length - 1] : null,
        cachedTokens: sum(cached),
        cachedTokensLast: cached.length ? cached[cached.length - 1] : null,
        systemChars: req(first).chars.system ?? 0,
        tools: req(first).tools ?? 0,
        toolsChars: req(first).toolsChars ?? 0,
        params: req(first).params ?? {},
        grownChars: last && first ? (req(last).chars.assistant ?? 0) - (req(first).chars.assistant ?? 0) : 0,
      };
    });
  }

  async #handle(req, res) {
    // Per-request labeling: the caller may encode the label in the path
    // (`/_lbl/<agent>/<task>/<repeat>/…`) — with concurrent rollouts a shared
    // mutable `this.label` would attribute calls to whichever rollout set it
    // last. The prefix is stripped before forwarding; the session header (if
    // enabled) is derived from the same per-request label.
    let label = this.label;
    let url = req.url;
    // The label segment sits after the client-facing prefix (the base URL
    // already carries the upstream path, e.g. /zen/go/v1/_lbl/<agent>/…).
    const m = /\/_lbl\/([^/]+)\/([^/]+)\/([^/]+)(?=\/)/.exec(req.url);
    if (m) {
      label = { agent: decodeURIComponent(m[1]), task: decodeURIComponent(m[2]), repeat: Number(m[3]) || 0 };
      url = req.url.replace(m[0], "");
    }
    const target = this.origin + url;
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
      label: { ...label },
      method: req.method,
      url,
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
    // Session identity is the agent's job, not the proxy's: who started the
    // conversation decides what "a conversation" is. We only record which
    // requests carry the gateway's session header and where it came from.
    call.sessionHeaderSource =
      headers[this.sessionHeader ?? ""] === undefined
        ? null
        : String(headers[this.sessionHeader]).startsWith("acpio-bench-")
          ? "proxy"
          : "client";
    headers["content-length"] = String(rawBody.length);

    const started = Date.now();
    await new Promise((resolve) => {
      const upstreamReq = this.transport(target, { method: req.method, headers }, (upstreamRes) => {
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
          this.#log(call, rawBody);
          resolve();
        });
      });
      upstreamReq.on("error", (err) => {
        call.status = 502;
        call.response.error = err.message;
        call.ms = Date.now() - started;
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        res.end(`proxy: ${err.message}`);
        // A request that died before the upstream answered is still a wire
        // event: the client retries it and otherwise it is invisible, making
        // the call count (and every per-call stat) silently wrong.
        this.#log(call, rawBody);
        resolve();
      });
      req.on("aborted", () => upstreamReq.destroy());
      upstreamReq.end(rawBody);
    });
  }

  #log(call, rawBody) {
    // Persist first: the caller may be killed the moment this resolves.
    try {
      mkdirSync(this.outDir, { recursive: true });
      appendFileSync(this.callsFile, JSON.stringify(call) + "\n");
    } catch {}
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
