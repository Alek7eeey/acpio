# CONTRACT — public API of `flaky-client`

`src/index.mjs` is the public entry. Whatever the internal layout, it must keep
exporting:

- `createClient(opts)` — see below
- `ApiError` — Error subclass with `name: "ApiError"`, optional `status` and
  `attempts` fields, original error preserved as `cause`
- `resolveConfig(opts)` — validates and defaults options
- `delayForAttempt(attempt)` — backoff table lookup

## createClient

`createClient({ retries = 2, baseUrl = "", fetchImpl, sleep })` returns a
client with `request(method, path, body)`, `get(path)`, `post(path, body)`.

- `request` performs `fetchImpl(url, init)` where url = `baseUrl + path`; a
  JSON body is sent with `content-type: application/json` and no body means no
  `content-type` header. Success resolves `{ status, data }` (data = parsed
  JSON response body, or `null` for an empty body).
- **Retryable**: network errors (fetch throws) and `5xx` responses.
  **Not retryable**: `4xx` — fails immediately with `ApiError` carrying
  `status`.
- Up to `retries` retries (so `retries + 1` attempts total). Before each retry
  the client sleeps `delayForAttempt(attempt)` where `attempt` is the number
  of the attempt that just failed (1-based).
- Exhaustion throws `ApiError` with `attempts = retries + 1`, the last error
  as `cause`, and message starting with `exhausted after `.
- `fetchImpl` and `sleep` are injectable for tests; defaults are global
  `fetch` and a real `setTimeout` sleep.

## resolveConfig

- `retries`: integer 0..5, default 2; out of range → `RangeError`.
- `baseUrl`: when present must start with `https://`, else `TypeError`.
- `timeoutMs`: number, default 0 (meaning: no timeout is applied in this
  version).
- Returns `{ retries, baseUrl, timeoutMs, fetchImpl, sleep }`.

## delayForAttempt

Backoff table `[0, 50, 200]` ms; attempts beyond the table repeat the last
value: `delayForAttempt(1) = 0`, `(2) = 50`, `(3) = 200`, `(4) = 200`, …
