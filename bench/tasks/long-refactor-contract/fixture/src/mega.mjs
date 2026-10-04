// mega.mjs — config, backoff, errors and the client in one tangle.
// The pre-refactor state; see STRUCTURE.md.

export class ApiError extends Error {
  constructor(message, { status, attempts, cause } = {}) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "ApiError";
    this.status = status;
    this.attempts = attempts;
  }
}

export function resolveConfig(opts = {}) {
  const retries = opts.retries ?? 2;
  if (!Number.isInteger(retries) || retries < 0 || retries > 5) {
    throw new RangeError(`retries must be 0..5, got ${retries}`);
  }
  const baseUrl = opts.baseUrl ?? "";
  if (baseUrl && !baseUrl.startsWith("https://")) {
    throw new TypeError(`baseUrl must be https, got ${baseUrl}`);
  }
  const timeoutMs = opts.timeoutMs ?? 0;
  if (typeof timeoutMs !== "number" || Number.isNaN(timeoutMs)) {
    throw new TypeError(`timeoutMs must be a number, got ${timeoutMs}`);
  }
  return {
    retries,
    baseUrl,
    timeoutMs,
    fetchImpl: opts.fetchImpl ?? fetch,
    sleep: opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

const DELAYS_MS = [0, 50, 200];

/** Sleep before retrying after `attempt` (the 1-based attempt that failed). */
export function delayForAttempt(attempt) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError(`attempt must be >= 1, got ${attempt}`);
  return DELAYS_MS[Math.min(attempt - 1, DELAYS_MS.length - 1)];
}

export function createClient(opts = {}) {
  const cfg = resolveConfig(opts);
  return {
    async request(method, path, body) {
      const init = { method };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers = { "content-type": "application/json" };
      }
      let last;
      for (let attempt = 1; attempt <= cfg.retries + 1; attempt++) {
        if (attempt > 1) await cfg.sleep(delayForAttempt(attempt - 1));
        let res;
        try {
          res = await cfg.fetchImpl(cfg.baseUrl + path, init);
        } catch (err) {
          last = err; // network error: retryable
          continue;
        }
        if (res.status >= 500) {
          last = new Error(`upstream ${res.status}`);
          continue; // 5xx: retryable
        }
        if (res.status >= 400) {
          throw new ApiError(`http ${res.status}`, { status: res.status }); // 4xx: fail fast
        }
        const text = await res.text();
        return { status: res.status, data: text ? JSON.parse(text) : null };
      }
      throw new ApiError(`exhausted after ${cfg.retries + 1} attempts: ${last?.message ?? "unknown"}`, {
        attempts: cfg.retries + 1,
        cause: last,
      });
    },
    get(path) {
      return this.request("GET", path);
    },
    post(path, body) {
      return this.request("POST", path, body);
    },
  };
}
