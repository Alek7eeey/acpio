import {
  builtinProviderKeys,
  normalizeBuiltinKeyMode,
  type BuiltinKeyMode,
  type BuiltinProviderConfig,
} from "@acpio/shared";
import { builtinKeySpentPercent, fetchBuiltinProviderLimits } from "./limits.js";

/**
 * Several keys on one provider (Settings → Built-in agent → Providers): how they
 * are spent, and what "spent" means.
 *
 * The choice is made per HTTP request, so it covers every call this agent makes
 * — the turn loop, the digest pass, a subagent — without any of them knowing
 * keys exist. `rotate` takes the next key every time, which pools the quota and
 * spreads the request rate; `exhausted` stays on one key until the endpoint says
 * it is out, which keeps a conversation on one bill and one prompt cache;
 * `smart` sends each request to the key whose quota is least spent.
 *
 * "Spent" is read two ways, and both feed one rule — a key at 100 % gets no
 * requests and answers no error:
 *
 * - from the vendor (`limits.ts`), once a minute per key: a provider that
 *   reports its quota is asked what is left, so a spent key is stepped over
 *   before the request goes out. A vendor that reports a wallet instead of a
 *   quota has no percent to compare and says so (`null`) — then the pool is
 *   ordered by its mode alone.
 * - from the response: 401 (revoked), 402/403 (unpaid), 429 (rate or daily
 *   quota), or a 4xx carrying the words for a quota in its body. Such a key is
 *   left out of the pool for a while and the same request is retried on the
 *   next one, so a pool degrades into the next key instead of into an error.
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

/** A vendor's own reading is trusted this long: a quota does not move by the second. */
const SPEND_READING_TTL_MS = 60_000;

/** A key the endpoint refused is left alone this long — a window resets, an account does not. */
const REFUSED_KEY_TTL_MS = 10 * 60_000;

/**
 * A probe stands in front of the request it decides, so it gives up early: an
 * unreadable usage API must not become the turn's latency.
 */
const SPEND_PROBE_TIMEOUT_MS = 2_500;

/**
 * What a vendor says a key has spent: a percent 0…100, or `null` when it says
 * nothing (an unknown vendor, a wallet balance, a failed read). Handed to
 * {@link providerFetch} so a test decides it without an endpoint.
 */
export type KeySpendProbe = (
  provider: BuiltinProviderConfig,
  apiKey: string,
) => Promise<number | null>;

/** The real probe: the same limits answer the Settings spend row shows. */
const spendFromVendor: KeySpendProbe = async (provider, apiKey) => {
  const res = await fetchBuiltinProviderLimits(provider.url, apiKey, provider.kind, {
    headers: provider.headers,
    timeoutMs: SPEND_PROBE_TIMEOUT_MS,
  });
  return res.ok ? builtinKeySpentPercent(res.meters) : null;
};

/** What a key had spent last time it was read, until the reading goes stale. */
const spendReadings = new Map<string, { spent: number | null; until: number }>();

/** Readings being taken right now, so one pool does not ask about a key twice. */
const pendingReadings = new Map<string, Promise<number | null>>();

/** Forget every cursor and every reading — a test's clean slate, and nothing else calls it. */
export function resetProviderKeyCursors(): void {
  cursors.clear();
  spendReadings.clear();
  pendingReadings.clear();
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

function readingId(providerId: string, apiKey: string): string {
  return `${providerId}\u0000${apiKey}`;
}

/** A reading still worth trusting, or `undefined` when there is none. */
function cachedSpend(providerId: string, apiKey: string): number | null | undefined {
  const reading = spendReadings.get(readingId(providerId, apiKey));
  return reading && reading.until > Date.now() ? reading.spent : undefined;
}

/** Whatever is known about a key right now, without asking anyone. */
function knownSpend(providerId: string, apiKey: string): number | null {
  return cachedSpend(providerId, apiKey) ?? null;
}

/** Ask the vendor what this key has spent: once per TTL, never twice at a time. */
async function readSpend(
  provider: BuiltinProviderConfig,
  apiKey: string,
  probe: KeySpendProbe,
): Promise<number | null> {
  const cached = cachedSpend(provider.id, apiKey);
  if (cached !== undefined) return cached;
  const id = readingId(provider.id, apiKey);
  const running = pendingReadings.get(id);
  if (running) return running;
  const reading = (async () => {
    let spent: number | null = null;
    try {
      spent = await probe(provider, apiKey);
    } catch {
      // A probe that fails says "unknown", never "broken": the request goes out.
      spent = null;
    }
    spendReadings.set(id, { spent, until: Date.now() + SPEND_READING_TTL_MS });
    return spent;
  })().finally(() => pendingReadings.delete(id));
  pendingReadings.set(id, reading);
  return reading;
}

/** The endpoint refused this key: keep it out of the pool instead of knocking again. */
function refuseKey(providerId: string, apiKey: string): void {
  spendReadings.set(readingId(providerId, apiKey), {
    spent: 100,
    until: Date.now() + REFUSED_KEY_TTL_MS,
  });
}

/** A key whose quota is gone serves nothing until it resets. */
function atLimit(spent: number | null): boolean {
  return spent !== null && spent >= 100;
}

/**
 * The keys one request may try, best first: the mode's order with the keys at
 * 100 % left out. When every key is out the order is returned as it is — the
 * endpoint's own answer is better than an invented error.
 */
function attemptOrder(
  provider: BuiltinProviderConfig,
  spends: readonly (number | null)[],
  mode: BuiltinKeyMode,
): number[] {
  const count = spends.length;
  const start = cursorAt(provider.id, count);
  const rotated = Array.from({ length: count }, (_, step) => (start + step) % count);
  const usable = rotated.filter((at) => !atLimit(spends[at] ?? null));
  const pool = usable.length ? usable : rotated;
  if (mode !== "smart") return pool;
  // Least spent first; a key nobody reports on goes last (100 is worse than any
  // reading), and the rotation order breaks every tie, so equal keys take turns.
  return [...pool].sort((a, b) => (spends[a] ?? 100) - (spends[b] ?? 100));
}

/**
 * The key the next call goes out with, for a call made outside the pool wrapper
 * (a chat title, the catalog probe). `rotate` consumes it — the following call
 * gets the next one; `exhausted` keeps handing out the same key until
 * {@link providerFetch} marks it spent; `smart` hands out the least spent one.
 * A key at 100 % is never handed out while another one is left. Empty when the
 * provider has no keys (a local endpoint). Only readings already taken are used:
 * this call must not wait for a network probe.
 */
export function nextProviderKey(provider: BuiltinProviderConfig): string {
  const keys = builtinProviderKeys(provider);
  if (!keys.length) return "";
  const mode = normalizeBuiltinKeyMode(provider.apiKeyMode);
  const order = attemptOrder(
    provider,
    keys.map((key) => knownSpend(provider.id, key)),
    mode,
  );
  const at = order[0] ?? 0;
  // Rotate consumes the key it handed out, and smart consumes it as a tie-break:
  // keys with the same reading take turns. Exhausted stays on the one it chose.
  if (mode !== "exhausted") advanceCursor(provider.id, keys.length);
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
 * The pool order comes from `attemptOrder`: the mode picks it, and a key the
 * vendor says is at 100 % is not in it — so a spent key is stepped over before
 * the request goes out, not after it fails.
 *
 * Left alone (the plain `fetch` comes back):
 * - no key at all — a local endpoint;
 * - the provider sets its own `Authorization` header: that is the credential,
 *   and a key list next to it has nothing to rotate;
 * - several keys and a body that cannot be sent twice (a stream).
 *
 * `probe` reads what a vendor says is left on a key; the default asks the
 * provider's own usage API, and a test passes its own.
 */
export function providerFetch(
  provider: BuiltinProviderConfig,
  base: typeof fetch = fetch,
  probe: KeySpendProbe = spendFromVendor,
): typeof fetch {
  const keys = builtinProviderKeys(provider);
  if (!keys.length) return base;
  const ownsAuth = (provider.headers ?? []).some(
    (row) => row.name.trim().toLowerCase() === "authorization",
  );
  if (ownsAuth) return base;
  const mode = normalizeBuiltinKeyMode(provider.apiKeyMode);

  return async (input, init) => {
    // What is left on each key, one round trip per key per minute at most; a
    // vendor that reports nothing (an endpoint of an unknown kind, a wallet)
    // answers "unknown" and the pool is ordered by its mode alone.
    const spends = await Promise.all(keys.map((key) => readSpend(provider, key, probe)));
    const order = attemptOrder(provider, spends, mode);
    for (let attempt = 0; ; attempt++) {
      const at = order[attempt] ?? order[0] ?? 0;
      const response = await base(input, withKey(init, keys[at]));
      // Rotate is consumption: the next request starts on the next key. Smart
      // consumes it as a tie-break, so keys with the same reading take turns;
      // exhausted stays on the key it chose until the endpoint refuses it.
      if (mode !== "exhausted") advanceCursor(provider.id, keys.length);
      if (!keySpent(response)) return response;
      if (attempt + 1 >= order.length) return response;
      if (bodyUnrepeatable(init?.body)) return response;
      const text = await errorText(response);
      // A plain 4xx that says nothing about a quota is the request's fault, not
      // the key's: hand it back instead of spending every key on it.
      if (!SPENT_STATUS.has(response.status) && !SPENT_BODY.test(text)) return response;
      // This key cannot pay: keep it out of the pool and start the next request
      // after it, so the caller sees the answer instead of the quota error.
      refuseKey(provider.id, keys[at]);
      cursors.set(provider.id, (at + 1) % keys.length);
    }
  };
}
