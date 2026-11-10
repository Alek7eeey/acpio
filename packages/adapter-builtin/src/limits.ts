import type {
  BuiltinHeaderConfig,
  BuiltinLimitMeter,
  BuiltinProviderKind,
} from "@acpio/shared";
import { builtinProviderHeaders, normalizeBuiltinProviderKind } from "@acpio/shared";

/** Give up on a slow endpoint so the Settings row cannot hang forever. */
const FETCH_TIMEOUT_MS = 15_000;
/** A bucket list is a handful of rows; a runaway payload is not one. */
const MAX_METERS = 20;
const MAX_KEY_LENGTH = 40;

export type { BuiltinLimitMeter };

/** Why a limits fetch failed — mapped to a localized string by the route. */
export type BuiltinLimitsErrorCode =
  | "unsupported"
  | "noEndpoint"
  | "noKey"
  | "badUrl"
  | "unreachable"
  | "notJson"
  | "httpStatus"
  /** Every candidate was a 404: this address is not a limits API at all. */
  | "notFound"
  | "unexpected";

export type BuiltinLimitsResult =
  | {
      ok: true;
      kind: BuiltinProviderKind;
      meters: BuiltinLimitMeter[];
      /** When this snapshot was taken (ISO) — a limit is a moment, not a state. */
      fetchedAt: string;
    }
  | { ok: false; code: BuiltinLimitsErrorCode; detail?: string };

export interface BuiltinLimitsOptions {
  /** Extra headers from the provider row; override Accept/Authorization. */
  headers?: BuiltinHeaderConfig[];
  /** How long to wait for the answer; a pool probing before a request waits less. */
  timeoutMs?: number;
}

/**
 * Where one kind reports its limits, and how to read the answer: the URLs are
 * tried in order (only a 404 moves on), `parse` returns the meters of a
 * payload — `null` when it is not a limits answer at all.
 */
interface LimitSource {
  urls(base: URL): string[];
  parse(body: unknown): BuiltinLimitMeter[] | null;
}

const LIMIT_SOURCES: Record<Exclude<BuiltinProviderKind, "other">, LimitSource> = {
  /**
   * OpenCode Zen reports the subscription windows it meters: rolling, weekly,
   * monthly. `/usage` hangs off the inference base, and the plain Zen base
   * serves it a segment up under `go/` — hence the second candidate.
   */
  opencode: {
    urls: (base) => {
      const urls = [`${trimSlash(base.href)}/usage`];
      const pathname = trimSlash(base.pathname);
      const sibling = (path: string) => {
        const alt = new URL(base.href);
        alt.pathname = path;
        alt.search = "";
        if (!urls.includes(alt.href)) urls.push(alt.href);
      };
      // The plain Zen base (pay-as-you-go) serves /usage one segment up, under
      // go/ — that is where the metered windows live.
      if (/\/zen\/v1$/.test(pathname)) sibling(pathname.replace(/\/zen\/v1$/, "/zen/go/v1/usage"));
      // The base the OpenCode CLI talks to nests an extra openai/ segment, and
      // its /usage sits on the sibling /v1 — the rule its model list follows too.
      if (/\/openai\/v1$/.test(pathname)) sibling(pathname.replace(/\/openai\/v1$/, "/v1/usage"));
      return urls;
    },
    parse: (body) => {
      const usage = record(record(body)?.usage);
      if (!usage) return null;
      const meters: BuiltinLimitMeter[] = [];
      for (const [key, raw] of Object.entries(usage)) {
        const row = record(raw);
        if (!row) continue;
        const percent = percentOf(row.percent);
        const status = text(row.status);
        if (percent === undefined && status === undefined) continue;
        meters.push({
          key: clip(key),
          ...(percent !== undefined ? { percent } : {}),
          ...(text(row.resetsAt) ? { resetsAt: text(row.resetsAt) as string } : {}),
          ...(status ? { status } : {}),
        });
      }
      return meters;
    },
  },
  /** DeepSeek reports the wallet, not a quota: one balance per currency. */
  deepseek: {
    urls: (base) => [`${base.origin}/user/balance`],
    parse: (body) => {
      const root = record(body);
      const infos = Array.isArray(root?.balance_infos) ? root.balance_infos : null;
      if (!infos) return null;
      const meters: BuiltinLimitMeter[] = [];
      for (const raw of infos) {
        const row = record(raw);
        if (!row) continue;
        const amount = number(row.total_balance);
        meters.push({
          key: "balance",
          ...(amount !== undefined ? { amount } : {}),
          ...(text(row?.currency) ? { unit: (text(row?.currency) as string).toUpperCase() } : {}),
        });
      }
      return meters;
    },
  },
  /**
   * OpenRouter answers with the key's own budget: `limit` is the whole of it
   * (`null` for an unlimited key), `usage` what has been spent.
   */
  openrouter: {
    urls: (base) => [`${base.origin}/api/v1/key`],
    parse: (body) => {
      const data = record(record(body)?.data);
      if (!data) return null;
      const limit = number(data.limit);
      const usage = number(data.usage);
      if (limit === undefined && usage === undefined) return null;
      return [
        {
          key: "credits",
          ...(usage !== undefined && limit !== undefined
            ? { used: usage, total: limit }
            : usage !== undefined
              ? { amount: usage }
              : { total: limit as number }),
          unit: "USD",
        },
      ];
    },
  },
  /** Moonshot (Kimi) reports one available balance, no currency field. */
  moonshot: {
    urls: (base) => [`${base.origin}/v1/users/me/balance`],
    parse: (body) => {
      const data = record(record(body)?.data);
      if (!data) return null;
      const amount = number(data.available_balance);
      if (amount === undefined) return null;
      return [{ key: "balance", amount }];
    },
  },
};

/**
 * Ask a provider what its key has left (Settings → Built-in agent →
 * Providers → its spend row). One endpoint per known kind, read into meters
 * the UI can draw without knowing the vendor; an endpoint of an unknown kind
 * has nothing to ask and says so.
 */
export async function fetchBuiltinProviderLimits(
  rawUrl: string,
  apiKey: string,
  rawKind: unknown,
  opts: BuiltinLimitsOptions = {},
): Promise<BuiltinLimitsResult> {
  const kind = normalizeBuiltinProviderKind(rawKind);
  if (kind === "other") return { ok: false, code: "unsupported" };
  const source = LIMIT_SOURCES[kind];

  const raw = rawUrl.trim();
  if (!raw) return { ok: false, code: "noEndpoint" };
  const key = apiKey.trim();
  // Every limits endpoint here is authenticated; a keyless local endpoint is
  // exactly the case the "other" kind is for.
  if (!key) return { ok: false, code: "noKey" };

  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    return { ok: false, code: "badUrl", detail: raw };
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    return { ok: false, code: "badUrl", detail: raw };
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  headers.Authorization = `Bearer ${key}`;
  // No session exists while the row is read, so placeholder rows are dropped.
  Object.assign(headers, builtinProviderHeaders(opts.headers));
  const timeout = opts.timeoutMs ?? FETCH_TIMEOUT_MS;

  let lastFailure: BuiltinLimitsResult & { ok: false } = { ok: false, code: "badUrl", detail: raw };
  /** The last URL tried — what a "no such route" answer names to the user. */
  let lastUrl = raw;
  for (const candidate of source.urls(base)) {
    lastUrl = candidate;
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
    } catch (err) {
      return {
        ok: false,
        code: "unreachable",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    if (!res.ok) {
      lastFailure = { ok: false, code: "httpStatus", detail: String(res.status) };
      // Only a missing route is worth another candidate; an auth or server
      // error would fail the same way on the sibling URL.
      if (res.status !== 404) return lastFailure;
      continue;
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, code: "notJson" };
    }
    const meters = source.parse(body);
    if (!meters) return { ok: false, code: "unexpected" };
    return {
      ok: true,
      kind,
      meters: meters.slice(0, MAX_METERS),
      fetchedAt: new Date().toISOString(),
    };
  }
  // Only 404s got here: the address answers, but nothing lives at /usage. That
  // is a wrong endpoint, not a wrong key — and the two need different advice.
  if (lastFailure.code === "httpStatus" && lastFailure.detail === "404") {
    return { ok: false, code: "notFound", detail: lastUrl };
  }
  return lastFailure;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * What a key has spent of its quota, as the one number a pool can compare: the
 * worst bucket the vendor reports — a percent, or `used` of `total` — clamped
 * to 0…100, and `null` when the vendor reports no quota at all (a wallet, an
 * endpoint of an unknown kind, a failed read). At 100 the key is spent: that is
 * the number both the skip rule and the smart mode compare.
 */
export function builtinKeySpentPercent(meters: BuiltinLimitMeter[]): number | null {
  let worst: number | null = null;
  for (const meter of meters) {
    const share =
      meter.percent ??
      (meter.used !== undefined && meter.total ? (meter.used / meter.total) * 100 : undefined);
    if (share === undefined) continue;
    // One decimal, same as the bar: 5.5 of 20 is 27.5 %, not 27.500000000000004.
    const spent = Math.round(Math.min(100, Math.max(0, share)) * 10) / 10;
    worst = worst === null ? spent : Math.max(worst, spent);
  }
  return worst;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A number the API sent as a number or a numeric string (`"110.00"`). */
function number(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** A percent as shown: clamped to the bar it becomes, one decimal at most. */
function percentOf(value: unknown): number | undefined {
  const parsed = number(value);
  if (parsed === undefined) return undefined;
  return Math.round(Math.min(100, Math.max(0, parsed)) * 10) / 10;
}

function clip(key: string): string {
  return key.trim().slice(0, MAX_KEY_LENGTH) || "limit";
}
