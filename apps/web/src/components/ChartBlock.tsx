/**
 * A chart an agent draws as a fenced block:
 *
 * ```chart
 * { "type": "bar", "title": "Коммиты", "unit": "шт.",
 *   "data": [{ "label": "Пн", "value": 12 }, { "label": "Вт", "value": 9 }] }
 * ```
 *
 * A summary is often numbers the reader has to compare, and a list of them is
 * read one line at a time. The spec is JSON on purpose: the agent writes it as
 * easily as a table, and nothing here needs a charting dependency — the drawing
 * is SVG and HTML, so it fits whatever width the panel has.
 */
import styles from "./ChartBlock.module.css";

export type ChartPoint = {
  label: string;
  value: number;
};

export type ChartKind = "bar" | "line" | "pie";

export type ChartSpec = {
  type: ChartKind;
  title?: string;
  unit?: string;
  /** A pie with a hole in it — same thing, drawn as a ring. */
  donut?: boolean;
  data: ChartPoint[];
};

/** Soft tokens that stay apart in both themes. */
const PALETTE = [
  "#4f8cff",
  "#f59e0b",
  "#34d399",
  "#a78bfa",
  "#f472b6",
  "#22d3ee",
  "#fbbf24",
  "#fb7185",
];

const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

function formatValue(value: number, unit?: string) {
  const text = numberFormat.format(value);
  return unit ? `${text} ${unit}` : text;
}

function point(raw: unknown, index: number): ChartPoint | null {
  const labelOf = (value: unknown, fallback: string) => {
    const text = String(value ?? "").trim();
    return text || fallback;
  };
  const number = (value: unknown) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  if (Array.isArray(raw)) {
    const value = number(raw[1]);
    if (value == null) return null;
    return { label: labelOf(raw[0], String(index + 1)), value };
  }
  if (raw && typeof raw === "object") {
    const row = raw as Record<string, unknown>;
    const value = number(row.value ?? row.count ?? row.y ?? row.total);
    if (value == null) return null;
    return { label: labelOf(row.label ?? row.name ?? row.x, String(index + 1)), value };
  }
  return null;
}

/**
 * The spec of a `chart` fence, or null when the text is not one. Null is what
 * makes the block fall back to ordinary code: a half-written spec while the
 * agent streams still reads as text instead of an empty box.
 */
export function parseChartSpec(text: string): ChartSpec | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const list = Array.isArray(row.data) ? row.data : Array.isArray(row.values) ? row.values : [];
  const data = list
    .map((item, i) => point(item, i))
    .filter((item): item is ChartPoint => item !== null);
  if (!data.length) return null;
  const kind = String(row.type ?? "bar").trim().toLowerCase();
  const type: ChartKind = kind === "line" || kind === "pie" || kind === "donut" ? (kind === "donut" ? "pie" : kind) : "bar";
  const title = String(row.title ?? "").trim();
  const unit = String(row.unit ?? "").trim();
  return {
    type,
    donut: kind === "donut" || Boolean(row.donut),
    title: title || undefined,
    unit: unit || undefined,
    data,
  };
}

function toXy(points: ChartPoint[], width: number, height: number) {
  const padX = 10;
  const padTop = 16;
  const padBottom = 22;
  const values = points.map((p) => p.value);
  const max = Math.max(...values);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const plotH = height - padTop - padBottom;
  const step = points.length > 1 ? (width - padX * 2) / (points.length - 1) : 0;
  return points.map((p, i) => ({
    point: p,
    x: padX + step * i,
    y: padTop + plotH - ((p.value - min) / span) * plotH,
    baseY: padTop + plotH,
  }));
}

function LineChart({ spec }: { spec: ChartSpec }) {
  const width = 340;
  const height = 160;
  const nodes = toXy(spec.data, width, height);
  const path = nodes.map((n, i) => `${i ? "L" : "M"}${n.x.toFixed(1)} ${n.y.toFixed(1)}`).join(" ");
  const last = nodes[nodes.length - 1]!;
  const first = nodes[0]!;
  const area = `${path} L${last.x.toFixed(1)} ${last.baseY} L${first.x.toFixed(1)} ${first.baseY} Z`;
  // Every nth label only: a label per point turns into a smear in a narrow panel.
  const every = Math.max(1, Math.ceil(nodes.length / 6));
  return (
    <svg className={styles.svg} viewBox={`0 0 ${width} ${height}`} role="presentation" aria-hidden>
      <line
        x1={0}
        y1={height - 22}
        x2={width}
        y2={height - 22}
        className={styles.axis}
      />
      <path d={area} className={styles.area} />
      <path d={path} className={styles.line} />
      {nodes.map((n) => (
        <circle key={`${n.point.label}-${n.x}`} cx={n.x} cy={n.y} r="2.6" className={styles.dot} />
      ))}
      {nodes.map((n, i) =>
        i % every === 0 || i === nodes.length - 1 ? (
          <text
            key={`label-${n.point.label}-${i}`}
            x={n.x}
            y={height - 6}
            textAnchor={i === 0 ? "start" : i === nodes.length - 1 ? "end" : "middle"}
            className={styles.axisLabel}
          >
            {n.point.label.length > 12 ? `${n.point.label.slice(0, 11)}…` : n.point.label}
          </text>
        ) : null,
      )}
    </svg>
  );
}

function piePath(cx: number, cy: number, r: number, from: number, to: number) {
  const start = { x: cx + r * Math.cos(from), y: cy + r * Math.sin(from) };
  const end = { x: cx + r * Math.cos(to), y: cy + r * Math.sin(to) };
  // A slice that is the whole circle has no arc to draw: two half arcs do it.
  if (to - from >= Math.PI * 2 - 0.0001) {
    return `M${cx - r} ${cy} A${r} ${r} 0 1 0 ${cx + r} ${cy} A${r} ${r} 0 1 0 ${cx - r} ${cy} Z`;
  }
  const large = to - from > Math.PI ? 1 : 0;
  return `M${cx} ${cy} L${start.x.toFixed(2)} ${start.y.toFixed(2)} A${r} ${r} 0 ${large} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)} Z`;
}

function PieChart({ spec }: { spec: ChartSpec }) {
  const size = 132;
  const center = size / 2;
  const radius = center - 4;
  const total = spec.data.reduce((sum, p) => sum + Math.max(0, p.value), 0);
  if (total <= 0) return null;
  let angle = -Math.PI / 2;
  const slices = spec.data.map((p, i) => {
    const sweep = (Math.max(0, p.value) / total) * Math.PI * 2;
    const slice = { key: `${p.label}-${i}`, path: piePath(center, center, radius, angle, angle + sweep), fill: PALETTE[i % PALETTE.length] };
    angle += sweep;
    return slice;
  });
  return (
    <svg className={styles.pie} viewBox={`0 0 ${size} ${size}`} role="presentation" aria-hidden>
      {slices.map((slice) => (
        <path key={slice.key} d={slice.path} fill={slice.fill} />
      ))}
      {spec.donut ? (
        <circle cx={center} cy={center} r={radius * 0.58} className={styles.donutHole} />
      ) : null}
    </svg>
  );
}

function BarChart({ spec }: { spec: ChartSpec }) {
  const max = Math.max(...spec.data.map((p) => Math.abs(p.value)), 1);
  return (
    <ul className={styles.bars}>
      {spec.data.map((p, i) => (
        <li key={`${p.label}-${i}`} className={styles.barRow}>
          <span className={styles.barLabel} title={p.label}>
            {p.label}
          </span>
          <span className={styles.barTrack}>
            <span
              className={styles.barFill}
              style={{
                width: `${Math.max(2, (Math.abs(p.value) / max) * 100)}%`,
                background: PALETTE[i % PALETTE.length],
              }}
            />
          </span>
          <span className={styles.barValue}>{formatValue(p.value, spec.unit)}</span>
        </li>
      ))}
    </ul>
  );
}

function Legend({ spec }: { spec: ChartSpec }) {
  return (
    <ul className={styles.legend}>
      {spec.data.map((p, i) => (
        <li key={`${p.label}-${i}`} className={styles.legendRow}>
          <span className={styles.swatch} style={{ background: PALETTE[i % PALETTE.length] }} />
          <span className={styles.legendLabel}>{p.label}</span>
          <span className={styles.legendValue}>{formatValue(p.value, spec.unit)}</span>
        </li>
      ))}
    </ul>
  );
}

export function ChartBlock({ spec }: { spec: ChartSpec }) {
  return (
    <figure className={styles.figure} role="img" aria-label={spec.title ?? undefined}>
      {spec.title ? <figcaption className={styles.title}>{spec.title}</figcaption> : null}
      {spec.type === "bar" ? <BarChart spec={spec} /> : null}
      {spec.type === "line" ? <LineChart spec={spec} /> : null}
      {spec.type === "pie" ? (
        <div className={styles.pieWrap}>
          <PieChart spec={spec} />
          <Legend spec={spec} />
        </div>
      ) : null}
    </figure>
  );
}
