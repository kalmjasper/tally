import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";

import { isUncategorized, type CatIndex } from "../lib/categories";
import { addMonths, currentMonth, euros, money, monthLabel, monthRange, MONTHS_SHORT } from "../lib/format";
import { monthModel, monthsCovered, spendDelta, subcategorySeries, transferBreakdown, yearModel, type CategoryRow, type Series } from "../lib/overview";
import { useSheets } from "../sheets/context";
import { useAccountRoles, useCats, useTotals, useTransactions } from "../queries";
import { CategoryIcon, Empty, Segmented, Stepper } from "../ui/controls";
import { Icon } from "../ui/Icon";
import { YearChart } from "./YearChart";

export function Overview() {
  const search = useSearch({ from: "/" });
  const navigate = useNavigate({ from: "/" });
  const open = useSheets();
  const cats = useCats();
  const month = search.month ?? currentMonth();
  const mode = search.mode ?? "year";
  const year = Number(month.slice(0, 4));
  const step = (n: number) =>
    navigate({ search: (s) => ({ ...s, month: mode === "year" ? `${year + n}-${month.slice(5)}` : addMonths(month, n) }) });

  return (
    <div className="page grouped">
      <div className="ov">
        <div className="ov-title">
          <h1>{mode === "year" ? year : monthLabel(month)}</h1>
          <div className="spacer" />
          <Stepper onPrev={() => step(-1)} onNext={() => step(1)} label={mode} />
          <Segmented
            label="Overview period"
            value={mode}
            options={[{ value: "month", label: "Month" }, { value: "year", label: "Year" }]}
            onChange={(m) => navigate({ search: (s) => ({ ...s, mode: m === "month" ? "month" : undefined }) })}
          />
          <button className="btn" onClick={() => open({ kind: "import" })}><Icon name="import" />Import Statement</button>
        </div>
        {!cats ? null : mode === "month" ? <MonthView month={month} cats={cats} /> : <YearView year={year} cats={cats} />}
      </div>
    </div>
  );
}

function MonthView({ month, cats }: { month: string; cats: CatIndex }) {
  const navigate = useNavigate();
  const open = useSheets();
  const range = monthRange(month);
  const totals = useTotals(monthRange(addMonths(month, -1)).from, range.to).data;
  const txs = useTransactions(range).data;
  const roles = useAccountRoles();
  const model = useMemo(() => totals && monthModel(totals, cats, month), [totals, cats, month]);
  if (!model || !txs) return null;

  const toCategorize = txs.filter(isUncategorized);
  const transfers = transferBreakdown(txs);
  const barTotal = model.bar.reduce((s, b) => s + b.amount, 0);
  const openCategory = (id: number) => navigate({ to: "/transactions", search: { month, category: id } });

  if (txs.length === 0) {
    return (
      <div className="card">
        <Empty title={`Nothing in ${monthLabel(month)} yet`}>
          <p>Import an ING, AMEX, ABN AMRO or Revolut statement to see where your money went.</p>
          <div className="actions center">
            <button className="btn primary" onClick={() => open({ kind: "import" })}><Icon name="import" />Import Statement</button>
            {cats.ordered.length === 0 && <button className="btn" onClick={() => open({ kind: "categories" })}><Icon name="tag" />Set Up Categories</button>}
          </div>
        </Empty>
      </div>
    );
  }

  return (
    <>
      <div className="summary">
        <div><div className="l">Income</div><div className="v pos">{money(model.income, { plus: true })}</div></div>
        <div><div className="l">Spent</div><div className="v">{money(model.spent)}</div></div>
        <div><div className="l">Saved</div><div className="v">{money(model.saved, { plus: true })}</div></div>
        <button className={`todo ${toCategorize.length ? "" : "done"}`} onClick={() => navigate({ to: "/inbox" })}>
          <div>
            <div className="l">{toCategorize.length ? `To categorize · ${money(model.uncategorizedOut + model.uncategorizedIn)}` : "To categorize"}</div>
            <div className="v">{toCategorize.length ? `${toCategorize.length} transaction${toCategorize.length === 1 ? "" : "s"}` : "All done"}</div>
          </div>
          <Icon name="right" className="chev" />
        </button>
      </div>

      <div className="ov-grid">
        <div className="col-gap min0">
          {barTotal > 0 && (
            <div className="card storage">
              <div className="row1"><b>Where it went</b><span className="num">{money(barTotal)} spent</span></div>
              <div className="sbar" role="img" aria-label={model.bar.map((b) => `${b.label} ${Math.round((b.amount / barTotal) * 100)}%`).join(", ")}>
                {model.bar.map((b) => <i key={b.label} style={{ background: b.color, flexGrow: b.amount }} />)}
              </div>
              <div className="legend">
                {model.bar.map((b) => (
                  <span key={b.label}><i style={{ background: b.color }} />{b.label} {Math.round((b.amount / barTotal) * 100)}%</span>
                ))}
              </div>
            </div>
          )}
          <div className="group cat-list">
            {model.expenses.map((r) => (
              <CategoryRows key={r.cat.id} row={r} onOpen={openCategory} />
            ))}
            {model.uncategorizedOut < 0 && (
              <button className="grow" onClick={() => navigate({ to: "/transactions", search: { month, uncategorized: true } })}>
                <span className="ci md none"><Icon name="q" /></span>
                <span className="nm grow-1">Uncategorized</span>
                <span className="amt num">{money(model.uncategorizedOut)}</span>
                <span className="delta" style={{ visibility: "hidden" }} />
                <Icon name="right" className="chev" />
              </button>
            )}
            {model.expenses.length === 0 && model.uncategorizedOut >= 0 && <div className="grow muted">No spending this month.</div>}
          </div>
        </div>
        <div className="col-gap">
          <div className="aside-card">
            <div className="glabel">Not counted</div>
            {transfers.map((l) =>
              l.potId != null ? (
                <button className="line link" key={l.potId} onClick={() => navigate({ to: "/pots", search: { id: l.potId! } })}>
                  <span className="ci sm pot"><Icon name="jar" /></span>{roles?.name(l.potId) || "Pot"}
                  <span className={`amt num ${l.amount > 0 ? "pos" : ""}`}>{money(l.amount, { plus: true })}</span>
                </button>
              ) : (
                <div className="line" key="between">
                  <span className="ci sm xfer"><Icon name="swap" /></span>Between your accounts<span className="amt num">{money(l.amount)}</span>
                </div>
              ),
            )}
            {transfers.length === 0 && <div className="line muted">No transfers this month</div>}
            <p>Money moved between your own accounts and pots, such as the credit card bill or savings. It isn't spending or income.</p>
          </div>
          <div className="aside-card">
            <div className="glabel">Income</div>
            {model.incomes.map((r) => (
              <button className="line link" key={r.cat.id} onClick={() => openCategory(r.cat.id)}>
                <CategoryIcon cat={r.cat} size="sm" />{r.cat.name}<span className="amt num pos">{money(r.amount, { plus: true })}</span>
              </button>
            ))}
            {model.uncategorizedIn > 0 && (
              <div className="line"><span className="ci sm none"><Icon name="q" /></span>Uncategorized<span className="amt num pos">{money(model.uncategorizedIn, { plus: true })}</span></div>
            )}
            {model.incomes.length === 0 && model.uncategorizedIn <= 0 && <p>No income this month.</p>}
          </div>
        </div>
      </div>
    </>
  );
}

function CategoryRows({ row, onOpen }: { row: CategoryRow; onOpen: (id: number) => void }) {
  const line = (r: CategoryRow, child: boolean) => {
    const delta = spendDelta(r.amount, r.prev);
    return (
      <button className={`grow ${child ? "child" : ""}`} key={r.cat.id} onClick={() => onOpen(r.cat.id)}>
        {!child && <CategoryIcon cat={r.cat} />}
        <span className="grow-1 min0">
          <span className="nm">{r.cat.name}</span>
          {r.received > 0 && r.spent < 0 && <span className="note">{money(-r.spent)} spent · {money(r.received)} paid back</span>}
        </span>
        <span className="amt num">{money(r.amount, { plus: true })}</span>
        <span className={`delta ${delta?.tone ?? ""}`} style={delta ? undefined : { visibility: "hidden" }}>{delta?.label ?? "–"}</span>
        <Icon name="right" className="chev" />
      </button>
    );
  };
  return (
    <>
      {line(row, false)}
      {row.children.filter((c) => c.amount !== 0).map((c) => line(c, true))}
    </>
  );
}

/** Hiding a series from the legend or table; the last visible one can't be hidden. */
const toggler = (set: Dispatch<SetStateAction<Set<string>>>, all: Series[]) => (key: string) =>
  set((h) => {
    const next = new Set(h);
    next.has(key) ? next.delete(key) : next.add(key);
    return next.size === all.length ? h : next;
  });
/** Showing one series alone, or everything again when it already is. */
const soloer = (set: Dispatch<SetStateAction<Set<string>>>, all: Series[]) => (key: string) =>
  set((h) => {
    const alone = h.size === all.length - 1 && !h.has(key);
    return alone ? new Set() : new Set(all.filter((s) => s.key !== key).map((s) => s.key));
  });

function YearView({ year, cats }: { year: number; cats: CatIndex }) {
  const navigate = useNavigate({ from: "/" });
  const totals = useTotals(`${year}-01-01`, `${year}-12-31`).data;
  const model = useMemo(() => totals && yearModel(totals, cats, year), [totals, cats, year]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  // With one category left in view, the chart and table break it down by subcategory.
  const visibleTops = model?.series.filter((s) => !hidden.has(s.key)) ?? [];
  const drillId = visibleTops.length === 1 && /^c\d+$/.test(visibleTops[0].key) ? Number(visibleTops[0].key.slice(1)) : null;
  const subs = useMemo(
    () => (drillId != null && totals ? subcategorySeries(totals, cats, year, drillId) : null),
    [drillId, totals, cats, year],
  );
  const [hiddenSub, setHiddenSub] = useState<Set<string>>(new Set());
  useEffect(() => setHiddenSub(new Set()), [drillId]);
  if (!totals || !model) return null;

  const now = currentMonth();
  const nowYear = Number(now.slice(0, 4));
  const lastMonth = year < nowYear ? 11 : year === nowYear ? Number(now.slice(5)) - 1 : -1;
  const months = monthsCovered(totals, year, lastMonth);
  const drilled = drillId != null && subs != null ? cats.byId.get(drillId) : undefined;
  const series = drilled ? subs! : model.series;
  const shownHidden = drilled ? hiddenSub : hidden;
  const toggle = drilled ? toggler(setHiddenSub, series) : toggler(setHidden, series);
  const solo = drilled ? soloer(setHiddenSub, series) : soloer(setHidden, series);
  const monthTotal = (m: number) => series.reduce((sum, s) => sum + s.data[m], 0);
  const yearTotal = series.reduce((sum, s) => sum + s.data.reduce((a, b) => a + b, 0), 0);
  const pickMonth = (m: number) => navigate({ search: { month: `${year}-${String(m + 1).padStart(2, "0")}`, mode: "month" } });

  if (model.series.length === 0) {
    return <div className="card"><Empty title={`No spending in ${year}`}>Import statements covering {year} to see it month by month.</Empty></div>;
  }

  return (
    <>
      <div className="summary">
        <div><div className="l">Income</div><div className="v pos">{money(model.income, { plus: true })}</div></div>
        <div><div className="l">Spent</div><div className="v">{money(model.spent)}</div></div>
        <div><div className="l">Saved</div><div className="v">{money(model.saved, { plus: true })}</div></div>
        <div><div className="l">Average spent per month</div><div className="v">{months > 0 ? money(model.spent / months) : "–"}</div></div>
      </div>
      <div className="card chart-card">
        <div className="chart-head">
          <b>{drilled ? `${drilled.name} by subcategory per month` : "Spending by category per month"}</b>
          <span>Net of reimbursements · transfers left out · click a month to open it</span>
        </div>
        <div className="ltoggles" role="group" aria-label={drilled ? `Subcategories of ${drilled.name} shown in the chart` : "Categories shown in the chart"}>
          {drilled && (
            <button type="button" className="back" onClick={() => setHidden(new Set())}>
              <Icon name="left" />All categories
            </button>
          )}
          {series.map((s) => (
            <button key={s.key} type="button" aria-pressed={!shownHidden.has(s.key)} onClick={() => toggle(s.key)}>
              <i style={{ ["--k" as string]: s.color }} />{s.name}
            </button>
          ))}
          {shownHidden.size > 0 && (
            <button type="button" className="reset" onClick={() => (drilled ? setHiddenSub(new Set()) : setHidden(new Set()))}>Show all</button>
          )}
        </div>
        <YearChart
          series={series}
          year={year}
          lastMonth={lastMonth}
          hidden={shownHidden}
          onPickMonth={pickMonth}
          what={drilled ? `on ${drilled.name} by subcategory` : "by category"}
        />
      </div>
      <div className="card ytable-wrap">
        <table className="ytable">
          <caption>
            {drilled
              ? `Spent on ${drilled.name} per month in euros, by subcategory. Click one to plot it alone.`
              : "Spent per month in euros. Click a category to plot it alone and see its subcategories."}
          </caption>
          <thead>
            <tr>
              <th>{drilled ? "Subcategory" : "Category"}</th>
              {MONTHS_SHORT.map((m) => <th key={m}>{m}</th>)}
              <th>{year}</th>
              <th>Per month</th>
            </tr>
          </thead>
          <tbody>
            {series.map((s) => {
              const sum = s.data.reduce((a, b) => a + b, 0);
              return (
                <tr key={s.key} className={shownHidden.has(s.key) ? "off" : ""} onClick={() => solo(s.key)}>
                  <td><span className="key" style={{ ["--k" as string]: s.color }} />{s.name}</td>
                  {s.data.map((v, m) => <td key={m} className={m > lastMonth ? "future" : ""}>{m > lastMonth || v === 0 ? "–" : euros(v)}</td>)}
                  <td className="sum">{euros(sum)}</td>
                  <td>{months > 0 ? euros(sum / months) : "–"}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td>{drilled ? `Total ${drilled.name}` : "Total"}</td>
              {MONTHS_SHORT.map((m, i) => <td key={m} className={i > lastMonth ? "future" : ""}>{i > lastMonth ? "–" : euros(monthTotal(i))}</td>)}
              <td>{euros(yearTotal)}</td>
              <td>{months > 0 ? euros(yearTotal / months) : "–"}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}
