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
