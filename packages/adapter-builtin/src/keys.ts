import {
  builtinProviderKeys,
  normalizeBuiltinKeyMode,
  type BuiltinProviderConfig,
} from "@acpio/shared";

/**
 * Several keys on one provider (Settings → Built-in agent → Providers): how they
 * are spent, and what "spent" means.
 *
 * The choice is made per HTTP request, so it covers every call this agent makes
 * — the turn loop, the digest pass, a subagent — without any of them knowing
 * keys exist. `rotate` takes the next key every time, which pools the quota and
 * spreads the request rate; `exhausted` stays on one key until the endpoint says
 * it is out, which keeps a conversation on one bill and one prompt cache.
 *
 * "Spent" is read from the response, not counted locally: no OpenAI-compatible
 * endpoint reports what is left of a key, and every one of them says what it
 * does about it — 401 (revoked), 402/403 (unpaid), 429 (rate or daily quota),
 * or a 4xx carrying the words for a quota in its body. A spent key is skipped
 * and the same request is retried on the next one, so a pool degrades into the
 * next key instead of into an error.
 *
 * The cursor lives in the process: it is shared by every session (one server,
 * one pool) and starts over on restart — `exhausted` then re-detects a dead key
 * on its first request, since the retry happens inside the same call.
 */

/** Where each provider's key cursor stands, by provider id. */
const cursors = new Map<string, number>();

/** Statuses an OpenAI-compatible endpoint uses for "this key cannot pay". */
const SPENT_STATUS = new Set([401, 402, 403, 429]);

/**
 * The same said in a body: providers disagree on the status for an exhausted
 * key (400 with `insufficient_quota`, 200-with-error relays and so on).
 */
const SPENT_BODY =
  /insufficient_quota|quota_exceeded|exceeded your (?:current )?quota|billing_hard_limit|credit balance|out of credits|no credits/i;

/** Forget every cursor — a test's clean slate, and nothing else calls it. */
export function resetProviderKeyCursors(): void {
  cursors.clear();
}

/** The cursor of one provider, wrapped into its key count. */
function cursorAt(providerId: string, count: number): number {
  const at = cursors.get(providerId) ?? 0;
  return count > 0 ? ((at % count) + count) % count : 0;
}

/** Move one provider's cursor to the next key. */
function advanceCursor(providerId: string, count: number): number {
  const next = count > 0 ? (cursorAt(providerId, count) + 1) % count : 0;
  cursors.set(providerId, next);
  return next;
}

/**
 * The key the next call goes out with. `rotate` consumes it — the following call
 * gets the next one; `exhausted` keeps handing out the same key until
 * {@link providerFetch} marks it spent. Empty when the provider has no keys (a
 * local endpoint).
 */
export function nextProviderKey(provider: BuiltinProviderConfig): string {
  const keys = builtinProviderKeys(provider);
  if (!keys.length) return "";
  const at = cursorAt(provider.id, keys.length);
  if (normalizeBuiltinKeyMode(provider.apiKeyMode) === "rotate") {
    advanceCursor(provider.id, keys.length);
  }
  return keys[at];
}

/** Whether this response says the key behind it cannot serve the request. */
function keySpent(response: Response): boolean {
  if (SPENT_STATUS.has(response.status)) return true;
  // Other 4xx: the body is the only place the reason lives. Only an error
  // response is read, and only a clone — the original still goes to the caller.
  return response.status >= 400 && response.status < 500;
}

/** The body text of an error response, without consuming the response itself. */
async function errorText(response: Response): Promise<string> {
  if (response.status >= 500 || response.status < 400) return "";
  try {
    return (await response.clone().text()).slice(0, 2000);
  } catch {
    return "";
  }
}

/**
 * A request body that can be sent once and only once (a stream has been read by
 * the first attempt) — retrying it would send an empty request.
 */
function bodyUnrepeatable(body: BodyInit | null | undefined): boolean {
  return typeof ReadableStream !== "undefined" && body instanceof ReadableStream;
}

/** The same request with this attempt's key in the Authorization header. */
function withKey(init: RequestInit | undefined, key: string): RequestInit {
  const headers = new Headers(init?.headers);
  if (key) headers.set("authorization", `Bearer ${key}`);
  return { ...init, headers };
}

/**
 * `fetch` for one provider's requests: puts a key from its list on every one of
 * them, and on the ones the endpoint refuses for lack of quota moves to the next
 * key and sends the same request again — at most once per key. When every key
 * has refused, the last response is returned as it came, so the turn reports the
 * endpoint's own error instead of inventing one.
 *
 * Left alone (the plain `fetch` comes back):
 * - no key at all — a local endpoint;
 * - the provider sets its own `Authorization` header: that is the credential,
 *   and a key list next to it has nothing to rotate;
 * - several keys and a body that cannot be sent twice (a stream).
 */
export function providerFetch(
  provider: BuiltinProviderConfig,
  base: typeof fetch = fetch,
): typeof fetch {
  const keys = builtinProviderKeys(provider);
  if (!keys.length) return base;
  const ownsAuth = (provider.headers ?? []).some(
    (row) => row.name.trim().toLowerCase() === "authorization",
  );
  if (ownsAuth) return base;
  const rotate = normalizeBuiltinKeyMode(provider.apiKeyMode) === "rotate";

  return async (input, init) => {
    const attempts = keys.length;
    for (let attempt = 0; ; attempt++) {
      const at = cursorAt(provider.id, attempts);
      const response = await base(input, withKey(init, keys[at]));
      // Rotate: this key is spent on this request, the next one takes the next
      // key — including the retry below, which reads the cursor again.
      if (rotate) advanceCursor(provider.id, attempts);
      if (!keySpent(response) || attempt + 1 >= attempts) return response;
      if (bodyUnrepeatable(init?.body)) return response;
      const text = await errorText(response);
      // A plain 4xx that says nothing about a quota is the request's fault, not
      // the key's: hand it back instead of spending every key on it.
      if (!SPENT_STATUS.has(response.status) && !SPENT_BODY.test(text)) return response;
      // Exhausted: the cursor only moves now, so every later request starts on
      // the key that answered while this one did not.
      if (!rotate) advanceCursor(provider.id, attempts);
    }
  };
}
