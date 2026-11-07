import { useEffect, useRef, useState } from "react";
import type { BuiltinHeaderConfig, BuiltinLimitMeter } from "@acpio/shared";
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

/**
 * What one key has left, read from the provider itself (Settings → Built-in
 * agent → Providers → the spend row). A snapshot, not a chart: it is read when
 * the card is first opened, on demand after that, and it says when it was read
 * — a quota is true for a moment, and this row never pretends otherwise.
 *
 * Only a provider of a known kind renders this at all: an endpoint we know
 * nothing about has no limits API to ask, so it gets no row (see
 * `hasBuiltinProviderLimits`).
 */
export function BuiltinProviderLimits({
  kind,
  endpointUrl,
  apiKey,
  headers,
  open,
}: {
  kind: string;
  endpointUrl: string;
  /** The pool's first key — reading limits spends no tokens, so one is enough. */
  apiKey: string;
  headers?: BuiltinHeaderConfig[];
  /** The card is unfolded: nothing is asked for a provider nobody is looking at. */
  open: boolean;
}) {
  const t = useT();
  const [meters, setMeters] = useState<BuiltinLimitMeter[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.builtinLimits({ kind, url: endpointUrl, apiKey, headers });
      if (res.ok) {
        setMeters(res.meters);
        setFetchedAt(res.fetchedAt);
      } else {
        setMeters([]);
        setFetchedAt(null);
        setError(res.error);
      }
    } catch (err) {
      setMeters([]);
      setFetchedAt(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAsked(true);
      setLoading(false);
    }
  };

  /**
   * Read once, when the card is first unfolded — the endpoint and the key may
   * still be typing, and a refresh is one click away after that.
   */
  const autoFetched = useRef(false);
  useEffect(() => {
    if (!open || autoFetched.current || !endpointUrl.trim()) return;
    autoFetched.current = true;
    void load();
  }, [open, endpointUrl]);

  return (
    <div className={styles.limits}>
      <div className={styles.toolbar}>
        <span className={styles.stamp}>
          {fetchedAt ? t("settings.builtinSpendFetchedAt", { time: moment(fetchedAt) }) : ""}
        </span>
        <button type="button" className={styles.btn} onClick={() => void load()} disabled={loading}>
          {loading ? t("settings.builtinSpendLoading") : t("settings.builtinSpendRefresh")}
        </button>
      </div>

      {error ? <p className={styles.error}>{error}</p> : null}
      {!error && asked && !loading && meters.length === 0 ? (
        <p className={styles.note}>{t("settings.builtinSpendEmpty")}</p>
      ) : null}

      {meters.map((meter, index) => {
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
