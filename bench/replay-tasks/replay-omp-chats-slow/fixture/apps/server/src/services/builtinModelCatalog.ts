import type { DiscoveredBuiltinModel } from "@acpio/shared";
import { loadModelRegistry } from "./modelRegistry.js";

/** Give up on a slow endpoint so the Settings button cannot hang forever. */
const FETCH_TIMEOUT_MS = 15_000;
/** Upper bound on rows parsed out of a catalog (protects settings/UI size). */
const MAX_MODELS = 2_000;
const MAX_ID_LENGTH = 200;
const MAX_LABEL_LENGTH = 120;
const MAX_CONTEXT_WINDOW = 10_000_000;

/** Why a catalog fetch failed — mapped to a localized string by the route. */
export type BuiltinCatalogErrorCode =
  | "noEndpoint"
  | "badUrl"
  | "unreachable"
  | "notJson"
  | "notList"
  | "httpStatus";

export type BuiltinCatalogResult =
  | { ok: true; models: DiscoveredBuiltinModel[] }
  | { ok: false; code: BuiltinCatalogErrorCode; detail?: string };

export interface BuiltinCatalogOptions {
  /** Model registry URL for windows the endpoint does not report (tests/mirrors). */
  registryUrl?: string;
}

/** `GET {endpoint}/models` against an OpenAI-compatible endpoint. */
export async function fetchBuiltinModelCatalog(
  rawUrl: string,
  apiKey: string,
  opts: BuiltinCatalogOptions = {},
): Promise<BuiltinCatalogResult> {
  const base = rawUrl.trim().replace(/\/+$/, "");
  if (!base) return { ok: false, code: "noEndpoint" };

  let url: URL;
  try {
    url = new URL(/\/models$/.test(base) ? base : `${base}/models`);
  } catch {
    return { ok: false, code: "badUrl", detail: base };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, code: "badUrl", detail: base };
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  const key = apiKey.trim();
  if (key) headers.Authorization = `Bearer ${key}`;

  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    return { ok: false, code: "unreachable", detail: err instanceof Error ? err.message : String(err) };
  }
  if (!res.ok) return { ok: false, code: "httpStatus", detail: String(res.status) };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, code: "notJson" };
  }

  const rows = modelRows(body);
  if (!rows) return { ok: false, code: "notList" };

  const models: DiscoveredBuiltinModel[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (models.length >= MAX_MODELS) break;
    const id = stringField(row, ["id", "model"])?.slice(0, MAX_ID_LENGTH);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = stringField(row, ["name", "display_name", "displayName", "title"]);
    const contextWindow = contextWindowField(row);
    models.push({
      id,
      ...(label && label !== id ? { label: label.slice(0, MAX_LABEL_LENGTH) } : {}),
      ...(contextWindow ? { contextWindow } : {}),
    });
  }
  // Most OpenAI-compatible endpoints list bare `id/object/created` rows with
  // no window at all. Fill those from the model registry — matched against
  // this endpoint's base URL first (the vendor's own limits), then by id
  // across the registry. A window the endpoint itself reported always wins;
  // an unavailable registry leaves the row exactly as bare as it was.
  if (models.some((m) => !m.contextWindow)) {
    const registry = await loadModelRegistry(opts.registryUrl);
    if (registry) {
      for (const model of models) {
        if (model.contextWindow) continue;
        const window = registry.contextFor(base, model.id) ?? registry.contextOf(model.id);
        if (window) model.contextWindow = Math.min(window, MAX_CONTEXT_WINDOW);
      }
    }
  }
  return { ok: true, models };
}

/** The row array of an OpenAI (`data`), plain-array or `models` payload. */
function modelRows(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return null;
  const data = (body as Record<string, unknown>).data;
  if (Array.isArray(data)) return data;
  const models = (body as Record<string, unknown>).models;
  if (Array.isArray(models)) return models;
  return null;
}

function stringField(row: unknown, keys: string[]): string | undefined {
  if (!row || typeof row !== "object") return undefined;
  const rec = row as Record<string, unknown>;
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** Context window from the fields OpenAI-compatible APIs actually report. */
function contextWindowField(row: unknown): number | undefined {
  if (!row || typeof row !== "object") return undefined;
  const rec = row as Record<string, unknown>;
  for (const key of ["context_length", "max_context_length", "context_window", "contextWindow"]) {
    const raw = Number(rec[key]);
    if (!Number.isFinite(raw) || raw <= 0) continue;
    return Math.min(Math.round(raw), MAX_CONTEXT_WINDOW) || undefined;
  }
  return undefined;
}
