import { useEffect, useMemo, useRef, useState } from "react";
import type { BuiltinHeaderConfig, BuiltinModelConfig, DiscoveredBuiltinModel } from "@acpio/shared";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import styles from "./BuiltinModelsEditor.module.css";

/** Context window assumed when neither the settings row nor the API reports one. */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const MAX_CONTEXT_WINDOW = 10_000_000;

type EditorRow = {
  id: string;
  label: string;
  contextWindow: number;
  enabled: boolean;
  /** Written to settings — only then does removal have something to drop. */
  inSettings: boolean;
  /** Not advertised by the endpoint — a hand-added row (meaningful after a fetch). */
  custom: boolean;
};

/**
 * The window a row shows and saves: a window the user typed wins, then what
 * the sources reported for this model, then the assumption.
 */
function effectiveWindow(
  cfg: BuiltinModelConfig | undefined,
  found: DiscoveredBuiltinModel | undefined,
): number {
  if (cfg?.contextWindowEdited) return cfg.contextWindow;
  return found?.contextWindow ?? cfg?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * Settings → Built-in agent → Models: the endpoint's `GET /models` list plus
 * the rows kept in settings. Tick a row to offer that model in pickers, edit
 * its label/context window, search a long catalog, add models the API does
 * not advertise. Rows are form state — everything lands on Save like the rest
 * of this page (the fetch itself only reads the endpoint).
 */
export function BuiltinModelsEditor({
  endpointUrl,
  apiKey,
  headers,
  value,
  onChange,
}: {
  endpointUrl: string;
  apiKey: string;
  headers?: BuiltinHeaderConfig[];
  value: BuiltinModelConfig[];
  onChange: (next: BuiltinModelConfig[]) => void;
}) {
  const t = useT();
  const [catalog, setCatalog] = useState<DiscoveredBuiltinModel[]>([]);
  const [fetched, setFetched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  /**
   * Which rows the list shows. The endpoint's catalog can hold hundreds of
   * models while settings keep a handful — without this the configured rows
   * drown in the list they were picked from.
   */
  const [scope, setScope] = useState<"all" | "configured">("all");
  const [windowDraft, setWindowDraft] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ id: "", label: "", contextWindow: "" });

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.builtinModels({ url: endpointUrl, apiKey, headers });
      if (res.ok) {
        setCatalog(res.models);
        setFetched(true);
      } else {
        setError(res.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  /**
   * Fetch as soon as a non-empty endpoint is in the form — the settings it
   * reads may load after this component mounts. Runs on every URL change but
   * fetches only once: later endpoint edits are refreshed by the button, so
   * typing a URL cannot spam the API.
   */
  const autoFetched = useRef(false);
  useEffect(() => {
    if (autoFetched.current || !endpointUrl.trim()) return;
    autoFetched.current = true;
    void load();
  }, [endpointUrl]);

  /**
   * Adopt freshly fetched windows into rows the user never typed one for, so
   * the form saves what the sources now report; a typed override stays put.
   */
  useEffect(() => {
    if (!fetched) return;
    let changed = false;
    const next = value.map((row) => {
      if (row.contextWindowEdited) return row;
      const found = catalog.find((m) => m.id === row.id);
      if (!found?.contextWindow || found.contextWindow === row.contextWindow) return row;
      changed = true;
      return { ...row, contextWindow: found.contextWindow };
    });
    if (changed) onChange(next);
  }, [catalog, fetched, value, onChange]);

  const rows = useMemo<EditorRow[]>(() => {
    const valueById = new Map(value.map((m) => [m.id, m]));
    const catalogById = new Map(catalog.map((m) => [m.id, m]));
    const out: EditorRow[] = [];
    const seen = new Set<string>();
    const push = (id: string) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      const cfg = valueById.get(id);
      const found = catalogById.get(id);
      out.push({
        id,
        label: cfg?.label || found?.label || id,
        contextWindow: effectiveWindow(cfg, found),
        // Only rows written to settings are enabled; a catalog row nobody
        // ticked has never been offered to the agent.
        enabled: cfg ? cfg.enabled !== false : false,
        inSettings: cfg !== undefined,
        custom: fetched && !found,
      });
    };
    for (const m of catalog) push(m.id);
    for (const m of value) push(m.id);
    return out;
  }, [catalog, value, fetched]);

  /** Rows written to settings — the ones the scope switch isolates. */
  const configuredCount = useMemo(
    () => rows.reduce((n, r) => (r.inSettings ? n + 1 : n), 0),
    [rows],
  );

  const visible = useMemo(() => {
    const scoped = scope === "configured" ? rows.filter((r) => r.inSettings) : rows;
    const needle = query.trim().toLowerCase();
    if (!needle) return scoped;
    return scoped.filter(
      (r) => r.id.toLowerCase().includes(needle) || r.label.toLowerCase().includes(needle),
    );
  }, [rows, scope, query]);

  const enabledCount = rows.reduce((n, r) => (r.enabled ? n + 1 : n), 0);

  const clampWindow = (raw: number | undefined) => {
    if (!raw || !Number.isFinite(raw)) return undefined;
    return Math.min(Math.max(1, Math.round(raw)), MAX_CONTEXT_WINDOW);
  };

  /** Write one row (keeping its slot in the list) with the given edits. */
  const apply = (id: string, patch: Partial<BuiltinModelConfig>) => {
    const existing = value.find((m) => m.id === id);
    const found = catalog.find((m) => m.id === id);
    // A typed window becomes an override from now on; an untouched row follows
    // whatever the sources report (the fetch may be newer than settings).
    const edited = patch.contextWindowEdited === true || existing?.contextWindowEdited === true;
    const next: BuiltinModelConfig = {
      id,
      label: patch.label ?? existing?.label ?? found?.label ?? id,
      contextWindow:
        clampWindow(
          patch.contextWindow ??
            (edited ? existing?.contextWindow : found?.contextWindow ?? existing?.contextWindow),
        ) ?? DEFAULT_CONTEXT_WINDOW,
      // Always write the flag: presence alone used to mean "enabled", so a row
      // created by editing an untouched catalog row must say false explicitly.
      enabled: patch.enabled ?? (existing ? existing.enabled !== false : false),
      ...(edited ? { contextWindowEdited: true } : {}),
    };
    onChange(existing ? value.map((m) => (m.id === id ? next : m)) : [...value, next]);
  };

  const editWindow = (id: string, raw: string) => {
    setWindowDraft((prev) => ({ ...prev, [id]: raw }));
    const parsed = Math.round(Number(raw));
    if (Number.isFinite(parsed) && parsed >= 1) {
      apply(id, {
        contextWindow: Math.min(parsed, MAX_CONTEXT_WINDOW),
        contextWindowEdited: true,
      });
    }
  };

  /**
   * Not a `<form>`: this editor lives inside the settings form, and a nested
   * form is invalid HTML (the browser would split it and Enter would submit
   * the outer Save). Enter in a field adds the model instead.
   */
  const addModel = () => {
    const id = draft.id.trim().slice(0, 200);
    if (!id) return;
    const typedWindow = clampWindow(Math.round(Number(draft.contextWindow)));
    apply(id, {
      label: draft.label.trim().slice(0, 120) || undefined,
      contextWindow: typedWindow,
      enabled: true,
      ...(typedWindow !== undefined ? { contextWindowEdited: true } : {}),
    });
    setDraft({ id: "", label: "", contextWindow: "" });
    setAdding(false);
    // The new row must be visible, whatever was in the search box.
    setQuery("");
  };

  const addOnEnter = (e: { key: string }) => {
    if (e.key === "Enter") addModel();
  };

  return (
    <div className={styles.editor}>
      <div className={styles.toolbar}>
        <div
          className={styles.scope}
          role="group"
          aria-label={t("settings.builtinModelsScope")}
        >
          <button
            type="button"
            className={`${styles.scopeBtn}${scope === "all" ? ` ${styles.scopeBtnActive}` : ""}`}
            aria-pressed={scope === "all"}
            onClick={() => setScope("all")}
          >
            {t("settings.builtinModelsScopeAll", { count: rows.length })}
          </button>
          <button
            type="button"
            className={`${styles.scopeBtn}${
              scope === "configured" ? ` ${styles.scopeBtnActive}` : ""
            }`}
            aria-pressed={scope === "configured"}
            onClick={() => setScope("configured")}
          >
            {t("settings.builtinModelsScopeConfigured", { count: configuredCount })}
          </button>
        </div>
        <input
          type="search"
          className={styles.search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("settings.builtinModelsSearch")}
          aria-label={t("settings.builtinModelsSearch")}
        />
        <button
          type="button"
          className={styles.btn}
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? t("settings.builtinModelsFetching") : t("settings.builtinModelsFetch")}
        </button>
        <button
          type="button"
          className={styles.btn}
          onClick={() => setAdding((open) => !open)}
          aria-expanded={adding}
        >
          {t("settings.builtinModelsAdd")}
        </button>
      </div>

      {adding ? (
        <div className={styles.addForm}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t("settings.builtinModelsAddId")}</span>
            <input
              value={draft.id}
              onChange={(e) => setDraft((d) => ({ ...d, id: e.target.value }))}
              onKeyDown={addOnEnter}
              placeholder="gpt-5.2"
              spellCheck={false}
              autoFocus
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t("settings.builtinModelsAddLabel")}</span>
            <input
              value={draft.label}
              onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
              onKeyDown={addOnEnter}
              placeholder={t("settings.builtinModelsAddLabelHint")}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t("settings.builtinModelsAddContext")}</span>
            <input
              type="number"
              min={1}
              max={MAX_CONTEXT_WINDOW}
              value={draft.contextWindow}
              onChange={(e) => setDraft((d) => ({ ...d, contextWindow: e.target.value }))}
              onKeyDown={addOnEnter}
              placeholder={String(DEFAULT_CONTEXT_WINDOW)}
            />
          </label>
          <div className={styles.addActions}>
            <button
              type="button"
              className={styles.btnPrimary}
              onClick={addModel}
              disabled={!draft.id.trim()}
            >
              {t("settings.builtinModelsAddSubmit")}
            </button>
            <button type="button" className={styles.btn} onClick={() => setAdding(false)}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      ) : null}

      {error ? <p className={styles.error}>{error}</p> : null}

      <div className={styles.meta}>
        <span>
          {t("settings.builtinModelsCount", { enabled: enabledCount, total: rows.length })}
        </span>
        {query.trim() ? (
          <span>{t("settings.builtinModelsShown", { shown: visible.length })}</span>
        ) : null}
      </div>

      {rows.length === 0 && !loading && !error ? (
        <p className={styles.hint}>{t("settings.builtinModelsEmpty")}</p>
      ) : null}
      {rows.length > 0 && visible.length === 0 ? (
        <p className={styles.hint}>
          {!query.trim() && scope === "configured"
            ? t("settings.builtinModelsConfiguredEmpty")
            : t("settings.builtinModelsNoMatch")}
        </p>
      ) : null}
      {rows.length > 0 && enabledCount === 0 ? (
        <p className={styles.hint}>{t("settings.builtinModelsNoneEnabled")}</p>
      ) : null}

      {visible.length > 0 ? (
        <ul className={styles.list}>
          {visible.map((row) => (
            <li key={row.id} className={styles.row}>
              <label className={styles.check} title={row.id}>
                <input
                  type="checkbox"
                  checked={row.enabled}
                  onChange={(e) => apply(row.id, { enabled: e.target.checked })}
                />
                <span className={styles.id}>{row.id}</span>
                {row.custom ? (
                  <span className={styles.tag}>{t("settings.builtinModelsCustomTag")}</span>
                ) : null}
              </label>
              <input
                className={styles.labelInput}
                value={row.label}
                onChange={(e) => apply(row.id, { label: e.target.value })}
                placeholder={row.id}
                aria-label={`${t("settings.builtinModelsAddLabel")}: ${row.id}`}
              />
              <input
                type="number"
                min={1}
                max={MAX_CONTEXT_WINDOW}
                className={styles.windowInput}
                value={windowDraft[row.id] ?? String(row.contextWindow)}
                onChange={(e) => editWindow(row.id, e.target.value)}
                // Drop the raw draft so the stored value shows again when the
                // field was cleared or left half-typed.
                onBlur={() =>
                  setWindowDraft((prev) => {
                    if (!(row.id in prev)) return prev;
                    const next = { ...prev };
                    delete next[row.id];
                    return next;
                  })
                }
                aria-label={`${t("settings.builtinModelsAddContext")}: ${row.id}`}
              />
              {row.inSettings ? (
                <button
                  type="button"
                  className={styles.remove}
                  title={t("settings.builtinModelsRemove")}
                  aria-label={`${t("settings.builtinModelsRemove")}: ${row.id}`}
                  onClick={() => {
                    setWindowDraft((prev) => {
                      if (!(row.id in prev)) return prev;
                      const next = { ...prev };
                      delete next[row.id];
                      return next;
                    });
                    onChange(value.filter((m) => m.id !== row.id));
                  }}
                >
                  ×
                </button>
              ) : (
                <span aria-hidden />
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
