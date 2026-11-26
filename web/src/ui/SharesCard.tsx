import { useState, type ReactNode } from "react";

import { euros } from "../lib/format";
import { percent, type Share } from "../lib/overview";
import { Empty } from "./controls";

/** The SVG path of one pie slice, from `start` to `end` as fractions of the turn, clockwise from 12 o'clock. */
function slicePath(start: number, end: number, r: number): string {
  if (end - start >= 0.9999) return `M ${r} 0 A ${r} ${r} 0 1 1 ${r - 0.01} 0 Z`;
  const point = (f: number) => {
    const a = f * 2 * Math.PI - Math.PI / 2;
    return `${(r + r * Math.cos(a)).toFixed(3)} ${(r + r * Math.sin(a)).toFixed(3)}`;
  };
  return `M ${r} ${r} L ${point(start)} A ${r} ${r} 0 ${end - start > 0.5 ? 1 : 0} 1 ${point(end)} Z`;
}

/**
 * What part of the spending each category takes, as a pie with a legend that lists every
 * category's share and average per month (the thin slices are only readable there). Hovering a
 * slice or a legend row picks it out; clicking either opens a category or focuses a subcategory.
 */
export function SharesCard({ shares, title, emptyMessage, hidden, onPick, hint, controls }: {
  shares: Share[];
  title: string;
  emptyMessage?: string;
  hidden: Set<string>;
  onPick?: (key: string) => void;
  hint?: string;
  controls?: ReactNode;
}) {
  const [active, setActive] = useState<string | null>(null);
  if (shares.length === 0) {
    return <div className="card shares-card"><div className="chart-head"><b>{title}</b>{controls}</div><Empty title="No spending in this view">{emptyMessage}</Empty></div>;
  }
  const R = 100;
  let at = 0;
  const slices = shares.map((s) => {
    const slice = { ...s, start: at, end: at + s.share };
    at += s.share;
    return slice;
  });
  const focus = shares.find((s) => s.key === active);
  return (
    <div className="card shares-card">
      <div className="chart-head">
        <b>{title}</b>
        {controls}
      </div>
      <div className="pie-layout">
        <div className="pie-wrap">
          <svg
            className="pie"
            viewBox={`-2 -2 ${2 * R + 4} ${2 * R + 4}`}
            role="img"
            aria-label={shares.map((s) => `${s.name} ${percent(s.share)}`).join(", ")}
            onMouseLeave={() => setActive(null)}
          >
            {slices.map((s) => (
              <path
                key={s.key}
                d={slicePath(s.start, s.end, R)}
                style={{ fill: s.color }}
                className={[active && active !== s.key ? "dim" : "", hidden.has(s.key) ? "off" : ""].join(" ")}
                onMouseEnter={() => setActive(s.key)}
                onClick={() => { setActive(s.key); onPick?.(s.key); }}
              />
            ))}
          </svg>
          <div className="pie-focus" aria-live="polite">
            {focus ? (
              <><b>{focus.name}</b> {percent(focus.share)}{focus.perMonth != null && ` · ${euros(focus.perMonth)}/mo`}</>
            ) : (
              <span>{hint ?? "Hover or click a slice to inspect its share"}</span>
            )}
          </div>
        </div>
        <ul className="shares">
          {shares.map((s) => (
            <li key={s.key}>
              <button
                type="button"
                className={[hidden.has(s.key) ? "off" : "", active === s.key ? "on" : ""].join(" ")}
                onClick={() => { setActive(s.key); onPick?.(s.key); }}
                onMouseEnter={() => setActive(s.key)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(s.key)}
                onBlur={() => setActive(null)}
                title={`${s.name}: ${percent(s.share)} of spending, ${euros(s.total)} in total, ${s.perMonth != null ? `${euros(s.perMonth)} per month` : "excluded from the monthly average"}`}
              >
                <span className="nm"><span className="key" style={{ ["--k" as string]: s.color }} />{s.name}</span>
                <span className="pct num">{percent(s.share)}</span>
                <span className="pm num">{s.perMonth != null ? <>{euros(s.perMonth)}<small>/mo</small></> : "–"}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
