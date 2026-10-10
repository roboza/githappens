import s from './Insights.module.css';

/**
 * Small hand-rolled SVG charts for Insights (no chart library). Colors come from theme tokens; every
 * mark has a <title> tooltip and every chart an accessible label + data table fallback via aria.
 */

const W = 520;
const H = 180;
const PAD = { l: 40, r: 10, t: 10, b: 28 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

const fmt = (v: number): string =>
  v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1).replace(/\.0$/, '') : String(+v.toFixed(2));

function YAxis({ max, unit }: { max: number; unit?: string }) {
  const ticks = [0, max / 2, max];
  return (
    <g className={s.axis}>
      {ticks.map((t) => {
        const y = PAD.t + (H - PAD.t - PAD.b) * (1 - t / max);
        return (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y} y2={y} className={s.grid} />
            <text x={PAD.l - 6} y={y + 4} textAnchor="end">
              {fmt(t)}
              {unit && t === max ? unit : ''}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function XLabels({ labels }: { labels: string[] }) {
  const step = Math.max(1, Math.ceil(labels.length / 8));
  const bw = (W - PAD.l - PAD.r) / Math.max(1, labels.length);
  return (
    <g className={s.axis}>
      {labels.map((l, i) =>
        i % step === 0 ? (
          <text key={l + i} x={PAD.l + bw * i + bw / 2} y={H - 8} textAnchor="middle">
            {l}
          </text>
        ) : null,
      )}
    </g>
  );
}

const shortWeek = (w: string): string => w.replace(/^\d{4}-/, '');

/** Vertical bars (throughput per week, size distribution). */
export function BarChart({
  data,
  label,
  unit,
  shortLabels = false,
}: {
  data: Array<{ label: string; value: number }>;
  label: string;
  unit?: string;
  shortLabels?: boolean;
}) {
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const bw = (W - PAD.l - PAD.r) / Math.max(1, data.length);
  const ih = H - PAD.t - PAD.b;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={s.chart} role="img" aria-label={label}>
      <YAxis max={max} {...(unit ? { unit } : {})} />
      {data.map((d, i) => {
        const h = (d.value / max) * ih;
        return (
          <rect
            key={d.label + i}
            className={s.bar}
            x={PAD.l + bw * i + bw * 0.15}
            width={Math.max(1, bw * 0.7)}
            y={PAD.t + ih - h}
            height={h}
            rx={2}
          >
            <title>{`${d.label}: ${fmt(d.value)}${unit ?? ''}`}</title>
          </rect>
        );
      })}
      <XLabels labels={data.map((d) => (shortLabels ? shortWeek(d.label) : d.label))} />
    </svg>
  );
}

/** Line with points; null values break the line (no data that week). */
export function LineChart({
  data,
  label,
  unit,
}: {
  data: Array<{ label: string; value: number | null }>;
  label: string;
  unit?: string;
}) {
  const max = niceMax(Math.max(0, ...data.map((d) => d.value ?? 0)));
  const bw = (W - PAD.l - PAD.r) / Math.max(1, data.length);
  const ih = H - PAD.t - PAD.b;
  const pts = data.map((d, i) => ({
    ...d,
    x: PAD.l + bw * i + bw / 2,
    y: d.value === null ? null : PAD.t + ih - (d.value / max) * ih,
  }));
  const segments: string[] = [];
  let cur = '';
  for (const p of pts) {
    if (p.y === null) {
      if (cur) segments.push(cur);
      cur = '';
    } else cur += `${cur ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  }
  if (cur) segments.push(cur);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={s.chart} role="img" aria-label={label}>
      <YAxis max={max} {...(unit ? { unit } : {})} />
      {segments.map((d) => (
        <path key={d} d={d} className={s.line} />
      ))}
      {pts.map((p, i) =>
        p.y === null ? null : (
          <circle key={i} cx={p.x} cy={p.y} r={3} className={s.point}>
            <title>{`${p.label}: ${fmt(p.value!)}${unit ?? ''}`}</title>
          </circle>
        ),
      )}
      <XLabels labels={data.map((d) => shortWeek(d.label))} />
    </svg>
  );
}

/** Horizontal bars (review load per reviewer). */
export function HBarChart({ data, label }: { data: Array<{ label: string; value: number }>; label: string }) {
  const rows = data.slice(0, 10);
  const rowH = 22;
  const h = Math.max(rowH, rows.length * rowH) + 8;
  const max = niceMax(Math.max(0, ...rows.map((r) => r.value)));
  const lw = 120;
  return (
    <svg viewBox={`0 0 ${W} ${h}`} className={s.chart} role="img" aria-label={label}>
      {rows.map((r, i) => {
        const w = ((W - lw - 40) * r.value) / max;
        const y = 4 + i * rowH;
        return (
          <g key={r.label}>
            <text x={lw - 6} y={y + 14} textAnchor="end" className={s.axisText}>
              {r.label.length > 16 ? `${r.label.slice(0, 15)}…` : r.label}
            </text>
            <rect x={lw} y={y + 3} width={Math.max(1, w)} height={rowH - 8} rx={2} className={s.bar}>
              <title>{`${r.label}: ${r.value}`}</title>
            </rect>
            <text x={lw + w + 4} y={y + 14} className={s.axisText}>
              {r.value}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
