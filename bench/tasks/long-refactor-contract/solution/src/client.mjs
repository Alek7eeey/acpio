import { ApiError } from "./errors.mjs";
import { resolveConfig } from "./config.mjs";
import { delayForAttempt } from "./backoff.mjs";

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
