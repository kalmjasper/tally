import { useMemo, useRef, useState } from "react";

import { euros, money, MONTHS_LONG, MONTHS_SHORT } from "../lib/format";
import type { Series } from "../lib/overview";

const W = 880;
const H = 290;
const L = 46;
const R = 6;
const T = 22;
const B = 26;
const PLOT_H = H - T - B;
const BAND = (W - L - R) / 12;
const BAR_W = 24;

const niceStep = (max: number) => [100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000].find((s) => max / s <= 4) ?? 100000;

/**
 * Stacked columns of spending per month, one series per category (or subcategory). Hover or focus a
 * month for its breakdown; click it to open that month. Values in cents; the axis in euros.
 */
export function YearChart({
  series,
  year,
  lastMonth,
  hidden,
  onPickMonth,
  what = "by category",
}: {
  series: Series[];
  year: number;
  /** Index of the last month with data (0-11); later months show as empty. */
  lastMonth: number;
  hidden: Set<string>;
  onPickMonth: (monthIndex: number) => void;
  /** What the series are, for screen readers: "by category", "on Food by subcategory". */
  what?: string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [tipLeft, setTipLeft] = useState(0);
  const visible = useMemo(() => series.filter((s) => !hidden.has(s.key)), [series, hidden]);
  const totals = MONTHS_SHORT.map((_, m) => (m > lastMonth ? 0 : visible.reduce((sum, s) => sum + Math.max(s.data[m], 0), 0)));
  const maxEuros = Math.max(...totals) / 100;
  const step = niceStep(maxEuros);
  const top = Math.max(step, Math.ceil(maxEuros / step) * step);
  const y = (cents: number) => T + PLOT_H - (cents / 100 / top) * PLOT_H;
  const peak = totals.indexOf(Math.max(...totals));

  const show = (m: number) => {
    setHover(m);
    requestAnimationFrame(() => {
      const width = svgRef.current?.getBoundingClientRect().width ?? W;
      const tipW = tipRef.current?.offsetWidth ?? 220;
      const px = (L + BAND * m + BAND / 2) * (width / W);
      setTipLeft(px + 22 + tipW > width ? px - 22 - tipW : px + 22);
    });
  };

  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);

  return (
    <div className="chart-wrap">
      <svg
        ref={svgRef}
        className={`ychart ${hover != null ? "focus" : ""}`}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Spending per month in ${year} ${what}: ${visible.map((s) => s.name).join(", ")}.`}
      >
        {ticks.map((v) => (
          <g key={v}>
            <line className="grid" x1={L} x2={W - R} y1={y(v * 100)} y2={y(v * 100)} />
            <text x={L - 8} y={y(v * 100) + 4} textAnchor="end">{euros(v * 100)}</text>
          </g>
        ))}
        {MONTHS_SHORT.map((name, m) => {
          const cx = L + BAND * m + BAND / 2;
          const segs = visible.filter((s) => s.data[m] > 0);
          let cum = 0;
          return (
            <g key={name}>
              <text className={`mlabel ${m === lastMonth ? "now" : m > lastMonth ? "future" : ""}`} x={cx} y={H - 8} textAnchor="middle">{name}</text>
              {m <= lastMonth && (
                <g className={`col ${hover === m ? "hl" : ""}`}>
                  {segs.map((s, k) => {
                    const isTop = k === segs.length - 1;
                    const y0 = y(cum) - (k === 0 ? 0 : 1);
                    cum += s.data[m];
                    const y1 = y(cum) + (isTop ? 0 : 1);
                    const h = y0 - y1;
                    if (h < 1) return null; // too thin to draw; the tooltip carries it
                    const x = cx - BAR_W / 2;
                    const r = isTop ? Math.min(4, h) : 0;
                    const d = `M${x} ${y0}V${y1 + r}Q${x} ${y1} ${x + r} ${y1}H${x + BAR_W - r}Q${x + BAR_W} ${y1} ${x + BAR_W} ${y1 + r}V${y0}Z`;
                    return <path key={s.key} d={d} style={{ fill: s.color }} />;
                  })}
                </g>
              )}
              {m <= lastMonth && totals[m] > 0 && (m === lastMonth || m === peak) && (
                <text className="cap" x={cx} y={y(totals[m]) - 7} textAnchor="middle">{euros(totals[m])}</text>
              )}
              {m <= lastMonth && (
                <rect
                  className="hit"
                  x={cx - BAND / 2}
                  y={T - 14}
                  width={BAND}
                  height={PLOT_H + 14}
                  tabIndex={0}
                  role="button"
                  aria-label={`${MONTHS_LONG[m]}: ${money(-totals[m])} spent. Open this month.`}
                  onPointerEnter={() => show(m)}
                  onPointerLeave={() => setHover(null)}
                  onFocus={() => show(m)}
                  onBlur={() => setHover(null)}
                  onClick={() => onPickMonth(m)}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onPickMonth(m)}
                />
              )}
            </g>
          );
        })}
      </svg>
      {hover != null && (
        <div className="tip" ref={tipRef} style={{ left: tipLeft }}>
          <div className="t">
            <span>{MONTHS_LONG[hover]} {year}</span>
            <b className="num">{money(-totals[hover])}</b>
          </div>
          {[...visible].reverse().map((s) => (
            <div className="r" key={s.key}>
              <i style={{ background: s.color }} />
              <b>{s.data[hover] ? money(s.data[hover]) : "–"}</b>
              <span>{s.name}</span>
            </div>
          ))}
          <div className="tip-hint">Click to open {MONTHS_LONG[hover]}</div>
        </div>
      )}
    </div>
  );
}
