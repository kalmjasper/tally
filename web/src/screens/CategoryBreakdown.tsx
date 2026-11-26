import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";

import { currentMonth, money, MONTHS_LONG } from "../lib/format";
import { costFilterTotals, monthsCovered, spendingShares, subcategorySeries, yearChartCosts, yearModel, type CostFilter } from "../lib/overview";
import { useCats, useTotals } from "../queries";
import { Empty, Segmented } from "../ui/controls";
import { Icon } from "../ui/Icon";
import { SharesCard } from "../ui/SharesCard";
import { YearChart } from "./YearChart";

/** A category's share of the selected year's monthly spending, broken down by subcategory. */
export function CategoryBreakdown() {
  const { categoryId } = useParams({ from: "/categories/$categoryId" });
  const { month: selectedMonth, costs: selectedCosts } = useSearch({ from: "/categories/$categoryId" });
  const navigate = useNavigate({ from: "/categories/$categoryId" });
  const costs: CostFilter = selectedCosts ?? "all";
  const month = selectedMonth ?? currentMonth();
  const year = Number(month.slice(0, 4));
  const cats = useCats();
  const totals = useTotals(`${year}-01-01`, `${year}-12-31`).data;

  if (!cats || !totals) return <div className="page grouped" />;

  const uncategorized = categoryId === "uncategorized";
  const category = uncategorized ? null : cats.byId.get(Number(categoryId));
  const valid = uncategorized || (category?.kind === "expense" && category.depth === 0);
  const back = <Link className="btn" to="/" search={{ month, costs: selectedCosts }}><Icon name="left" />Overview</Link>;
  if (!valid) {
    return <div className="page grouped"><div className="ov"><div className="ov-title">{back}</div><Empty title="Category not found" /></div></div>;
  }

  const chartTotals = yearChartCosts(totals, cats, year).chartTotals;
  const pieTotals = costFilterTotals(chartTotals, cats, costs);
  const now = currentMonth();
  const nowYear = Number(now.slice(0, 4));
  const lastMonth = year < nowYear ? 11 : year === nowYear ? Number(now.slice(5)) - 1 : -1;
  const monthsShown = lastMonth + 1;
  const forCategory = (rows: typeof chartTotals) => uncategorized
    ? yearModel(rows, cats, year).series.filter((s) => s.key === "uncategorized")
    : subcategorySeries(rows, cats, year, category!.id);
  const barSeries = forCategory(chartTotals);
  const barColors = new Map(barSeries.map((s) => [s.key, s.color]));
  const pieSeries = forCategory(pieTotals).map((s) => ({ ...s, color: barColors.get(s.key) ?? s.color }));
  const shares = spendingShares(pieSeries, monthsCovered(totals, year, lastMonth));
  const name = uncategorized ? "Uncategorized" : category!.name;

  return (
    <div className="page grouped">
      <div className="ov">
        <div className="ov-title">
          <h1>{name}</h1>
          <div className="spacer" />
          {back}
        </div>
        <p className="category-breakdown-sub">{year} · Monthly average spending · Net of reimbursements · Yearly costs excluded</p>
        <div className="card chart-card">
          <div className="chart-head"><b>{uncategorized ? "Uncategorized spending per month" : `${name} by subcategory per month`}</b><span>Click a month to see all category transactions, including yearly costs</span></div>
          {barSeries.length > 0 ? (
            <><YearChart series={barSeries} year={year} lastMonth={lastMonth} hidden={new Set()}
              what={uncategorized ? "uncategorized" : `on ${name} by subcategory`}
              onPickMonth={(index) => navigate({ to: "/transactions", search: {
                month: `${year}-${String(index + 1).padStart(2, "0")}`,
                ...(uncategorized ? { uncategorized: true } : { category: category!.id }),
              } })} />
              <table className="sr-only">
                <caption>{name} spending by subcategory and month in {year}, excluding yearly costs</caption>
                <thead><tr><th scope="col">Subcategory</th>{MONTHS_LONG.slice(0, monthsShown).map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
                <tbody>{barSeries.map((series) => <tr key={series.key}><th scope="row">{series.name}</th>{series.data.slice(0, monthsShown).map((amount, index) => <td key={index}>{money(amount)}</td>)}</tr>)}</tbody>
              </table></>
          ) : <Empty title="No spending in this view" />}
        </div>
        <SharesCard shares={shares} title={uncategorized ? "Share of positive uncategorized spending" : `Share of positive monthly average spend on ${name} by subcategory`}
          emptyMessage={`No ${costs === "all" ? "charted" : costs === "fixed" ? "fixed" : "non-fixed"} spending on ${name} in ${year}.`}
          hidden={new Set()}
          controls={<Segmented<CostFilter> label="Costs shown in the pie" value={costs}
            options={[{ value: "all", label: "All costs" }, { value: "fixed", label: "Fixed costs" }, { value: "nonfixed", label: "Non-fixed costs" }]}
            onChange={(value) => navigate({ search: (search) => ({ ...search, costs: value === "all" ? undefined : value }) })} />}
        />
      </div>
    </div>
  );
}
