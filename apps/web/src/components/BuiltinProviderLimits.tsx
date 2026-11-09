import { useEffect, useRef, useState } from "react";
import type { BuiltinHeaderConfig, BuiltinLimitMeter } from "@acpio/shared";
import { normalizeBuiltinKeyList } from "@acpio/shared";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import styles from "./BuiltinProviderLimits.module.css";

/** The bucket names worth a translation; anything else shows as it came. */
const METER_LABELS: Record<string, string> = {
  balance: "settings.builtinSpendBalance",
  credits: "settings.builtinSpendCredits",
  rolling: "settings.builtinSpendRolling",
  weekly: "settings.builtinSpendWeekly",
  monthly: "settings.builtinSpendMonthly",
};

function amount(value: number, unit: string | undefined): string {
  const text = value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return unit ? `${text} ${unit}` : text;
}

/** A reset moment in the reader's own clock; an unparsable one is shown raw. */
function moment(value: string): string {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? value : at.toLocaleString();
}

/** What one key answered when it was asked — a quota is a moment, not a state. */
interface KeySnapshot {
  meters: BuiltinLimitMeter[];
  fetchedAt: string | null;
  error: string | null;
}

/**
 * What a key has left, read from the provider itself (Settings → Built-in
 * agent → Providers → the spend row). A snapshot, not a chart: it is read when
 * the key is first looked at, on demand after that, and it says when it was
 * read — a quota is true for a moment, and this row never pretends otherwise.
 *
 * Limits are per key, so a pool gets a picker: every key keeps its own
 * snapshot, and switching to a key reads it the first time.
 *
 * Only a provider of a known kind renders this at all: an endpoint we know
 * nothing about has no limits API to ask, so it gets no row (see
 * `hasBuiltinProviderLimits`).
 */
export function BuiltinProviderLimits({
  kind,
  endpointUrl,
  apiKeys,
  headers,
  open,
}: {
  kind: string;
  endpointUrl: string;
  /** The provider's key pool, in the order its key fields show them. */
  apiKeys: string[];
  headers?: BuiltinHeaderConfig[];
  /** The card is unfolded: nothing is asked for a provider nobody is looking at. */
  open: boolean;
}) {
  const t = useT();
  const pool = normalizeBuiltinKeyList(apiKeys);
  const [snapshots, setSnapshots] = useState<Record<string, KeySnapshot>>({});
  const [picked, setPicked] = useState("");
  const [loadingKey, setLoadingKey] = useState<string | null>(null);

  // The picked key while it is still in the pool, the first one otherwise: a
  // key deleted from the list must not leave the row pointing at nothing.
  const shown = pool.includes(picked) ? picked : (pool[0] ?? "");
  const snapshot = snapshots[shown];
  const loading = loadingKey === shown;

  const load = async (apiKey: string) => {
    setLoadingKey(apiKey);
    let next: KeySnapshot;
    try {
      const res = await api.builtinLimits({ kind, url: endpointUrl, apiKey, headers });
      next = res.ok
        ? { meters: res.meters, fetchedAt: res.fetchedAt, error: null }
        : { meters: [], fetchedAt: null, error: res.error };
    } catch (err) {
      next = {
        meters: [],
        fetchedAt: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    setSnapshots((prev) => ({ ...prev, [apiKey]: next }));
    setLoadingKey((current) => (current === apiKey ? null : current));
  };

  /**
   * Read once, when the card is first unfolded — the endpoint and the keys may
   * still be typing, and a refresh is one click away after that.
   */
  const autoRead = useRef(false);
  useEffect(() => {
    if (!open || autoRead.current || !endpointUrl.trim()) return;
    autoRead.current = true;
    void load(pool[0] ?? "");
  }, [open, endpointUrl]);

  const pick = (apiKey: string) => {
    setPicked(apiKey);
    if (!snapshots[apiKey]) void load(apiKey);
  };

  return (
    <div className={styles.limits}>
      {/* One key needs no picker; a pool does — each key has its own quota and
          the row shows one of them at a time. */}
      {pool.length > 1 ? (
        <div className={styles.keys} role="group" aria-label={t("settings.builtinSpendTitle")}>
          {pool.map((apiKey, index) => {
            const on = apiKey === shown;
            return (
              <button
                key={apiKey}
                type="button"
                className={`${styles.key}${on ? ` ${styles.keyOn}` : ""}`}
                aria-pressed={on}
                onClick={() => pick(apiKey)}
              >
                {t("settings.builtinSpendKey", { n: index + 1 })}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className={styles.toolbar}>
        <span className={styles.stamp}>
          {snapshot?.fetchedAt
            ? t("settings.builtinSpendFetchedAt", { time: moment(snapshot.fetchedAt) })
            : ""}
        </span>
        <button
          type="button"
          className={styles.btn}
          onClick={() => void load(shown)}
          disabled={loading}
        >
          {loading ? t("settings.builtinSpendLoading") : t("settings.builtinSpendRefresh")}
        </button>
      </div>

      {snapshot?.error ? <p className={styles.error}>{snapshot.error}</p> : null}
      {snapshot && !snapshot.error && !loading && snapshot.meters.length === 0 ? (
        <p className={styles.note}>{t("settings.builtinSpendEmpty")}</p>
      ) : null}

      {(snapshot?.meters ?? []).map((meter, index) => {
        // A pair of amounts and a percent are both a bar; a lone amount (a
        // wallet) is a number with nothing to compare it to.
        const spent =
          meter.percent ??
          (meter.used !== undefined && meter.total
            ? Math.min(100, Math.max(0, (meter.used / meter.total) * 100))
            : undefined);
        const value =
          meter.used !== undefined && meter.total !== undefined
            ? t("settings.builtinSpendUsedOf", {
                used: amount(meter.used, meter.unit),
                total: amount(meter.total, meter.unit),
              })
            : meter.amount !== undefined
              ? amount(meter.amount, meter.unit)
              : meter.percent !== undefined
                ? `${meter.percent}%`
                : "";
        const label = METER_LABELS[meter.key] ? t(METER_LABELS[meter.key]) : meter.key;
        return (
          <div key={`${meter.key}-${index}`} className={styles.meter}>
            <div className={styles.head}>
              <span className={styles.name}>{label}</span>
              <span className={styles.value}>{value}</span>
            </div>
            {spent !== undefined ? (
              <div
                className={styles.bar}
                role="progressbar"
                aria-valuenow={Math.round(spent)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={label}
              >
                <span
                  className={`${styles.fill}${spent >= 100 ? ` ${styles.fillFull}` : ""}`}
                  style={{ width: `${spent}%` }}
                />
              </div>
            ) : null}
            <div className={styles.meta}>
              {/* The provider's own word marks a bucket that is done. */}
              {meter.status && meter.status !== "ok" ? (
                <span className={styles.status}>{meter.status}</span>
              ) : null}
              {meter.resetsAt ? (
                <span>{t("settings.builtinSpendResets", { time: moment(meter.resetsAt) })}</span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
