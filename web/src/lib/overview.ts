import type { Total, Tx } from "../api";
import { UNCATEGORIZED_COLOR, type CatIndex, type CatInfo } from "./categories";
import { addMonths } from "./format";

// Turns CategoryTotals rows into what the overview shows. Pure functions, so they're unit-tested.

export interface Amounts {
  amount: number;
  spent: number;
  received: number;
}

const zero = (): Amounts => ({ amount: 0, spent: 0, received: 0 });
const add = (a: Amounts, t: Amounts) => {
  a.amount += t.amount;
  a.spent += t.spent;
  a.received += t.received;
};

export interface CategoryRow extends Amounts {
  cat: CatInfo;
  prev: number;
  children: CategoryRow[];
}

export interface MonthModel {
  income: number;
  /** Negative: expense categories plus uncategorized money going out. */
  spent: number;
  saved: number;
  uncategorizedOut: number;
  uncategorizedIn: number;
  expenses: CategoryRow[];
  incomes: CategoryRow[];
  bar: { label: string; color: string; amount: number }[];
  /** Net cost tagged Yearly cost, visible in totals but omitted from the spending bar. */
  yearlyCostTotal: number;
}

const ym = (key: string) => key.split("-").map(Number) as [number, number];

export function monthModel(totals: Total[], cats: CatIndex, month: string): MonthModel {
  const [y, m] = ym(month);
  const [py, pm] = ym(addMonths(month, -1));
  const own = new Map<number, Amounts>();
  const prevOwn = new Map<number, number>();
  const chartSpending = new Map<number, number>();
  let uncategorizedOut = 0;
  let uncategorizedIn = 0;
  let yearlyCostTotal = 0;
  for (const t of totals) {
    const isCur = t.year === y && t.month === m;
    const isPrev = t.year === py && t.month === pm;
    if (t.categoryId == null) {
      if (isCur && t.bucket === "out") uncategorizedOut += t.amount;
      if (isCur && t.bucket === "in") uncategorizedIn += t.amount;
      continue;
    }
    const cat = cats.byId.get(t.categoryId);
    if (!cat) continue;
    if (isCur) add(own.get(t.categoryId) ?? own.set(t.categoryId, zero()).get(t.categoryId)!, t);
    if (isCur && cat.kind === "expense" && cat.yearlyCost) yearlyCostTotal -= t.amount;
    if (isCur && cat.kind === "expense" && !cat.yearlyCost) {
      chartSpending.set(cat.topId, (chartSpending.get(cat.topId) ?? 0) + t.amount);
    }
    if (isPrev) prevOwn.set(t.categoryId, (prevOwn.get(t.categoryId) ?? 0) + t.amount);
  }

  const rows: CategoryRow[] = [];
  for (const top of cats.tops) {
    const family = cats.family.get(top.id)!;
    const row: CategoryRow = { cat: top, ...zero(), prev: 0, children: [] };
    for (const id of family) {
      const a = own.get(id);
      if (a) add(row, a);
      row.prev += prevOwn.get(id) ?? 0;
      if (id !== top.id && (a || prevOwn.has(id))) {
        row.children.push({ cat: cats.byId.get(id)!, ...(a ?? zero()), prev: prevOwn.get(id) ?? 0, children: [] });
      }
    }
    if (row.amount !== 0 || row.prev !== 0) rows.push(row);
  }
  const byAmount = (a: CategoryRow, b: CategoryRow) => a.amount - b.amount;
  for (const r of rows) r.children.sort(byAmount);
  const expenses = rows.filter((r) => r.cat.kind === "expense").sort(byAmount);
  const incomes = rows.filter((r) => r.cat.kind === "income").sort((a, b) => b.amount - a.amount);

  const income = incomes.reduce((s, r) => s + r.amount, 0);
  const spent = expenses.reduce((s, r) => s + r.amount, 0) + uncategorizedOut;

  const bar: MonthModel["bar"] = [...chartSpending]
    .filter(([, amount]) => amount < 0)
    .map(([id, amount]) => ({ label: cats.byId.get(id)!.name, color: cats.byId.get(id)!.series, amount: -amount }))
    .sort((a, b) => b.amount - a.amount);
  if (uncategorizedOut < 0) bar.push({ label: "Uncategorized", color: UNCATEGORIZED_COLOR, amount: -uncategorizedOut });

  return { income, spent, saved: income + spent + uncategorizedIn, uncategorizedOut, uncategorizedIn, expenses, incomes, bar, yearlyCostTotal };
}

/** Change in spending vs the previous month, as shown in the pill. */
export function spendDelta(cur: number, prev: number): { label: string; tone: "up" | "down" | "flat" } | null {
  const now = -cur;
  const before = -prev;
  if (before <= 0) return now > 0 ? { label: "new", tone: "flat" } : null;
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return { label: "±0%", tone: "flat" };
  return pct > 0 ? { label: `+${pct}%`, tone: "up" } : { label: `−${-pct}%`, tone: "down" };
}

export interface Series {
  key: string;
  name: string;
  color: string;
  /** Spending per month, January first, in cents (positive = money spent). */
  data: number[];
  /** Net spending included in the monthly average, or null when all activity was excluded. */
  averageTotal: number | null;
}

type Spending = Pick<Series, "data" | "averageTotal">;
const emptySpending = (): Spending => ({ data: Array(12).fill(0), averageTotal: null });

function addSpending(target: Spending, month: number, amount: number, excluded: boolean) {
  target.data[month] += amount;
  if (!excluded) target.averageTotal = (target.averageTotal ?? 0) + amount;
}

const hasSpending = (s: Spending) => s.data.some((n) => n !== 0) || (s.averageTotal ?? 0) !== 0;

export function monthlyAverage(series: Series[], months: number): number | null {
  if (months <= 0 || !series.some((s) => s.averageTotal != null)) return null;
  return series.reduce((sum, s) => sum + (s.averageTotal ?? 0), 0) / months;
}

export interface YearModel {
  series: Series[];
  income: number;
  spent: number;
  saved: number;
}

export function yearModel(totals: Total[], cats: CatIndex, year: number): YearModel {
  const series: Series[] = cats.expenseTops.map((c) => ({ key: `c${c.id}`, name: c.name, color: c.series, ...emptySpending() }));
  const uncategorized: Series = { key: "uncategorized", name: "Uncategorized", color: UNCATEGORIZED_COLOR, ...emptySpending() };
  let income = 0;
  let saved = 0;
  for (const t of totals) {
    if (t.year !== year) continue;
    saved += t.amount;
    const m = t.month - 1;
    if (t.categoryId == null) {
      if (t.bucket === "out") addSpending(uncategorized, m, -t.amount, false);
      continue;
    }
    const cat = cats.byId.get(t.categoryId);
    if (!cat) continue;
    if (cat.kind === "income") {
      income += t.amount;
      continue;
    }
    const slot = series.findIndex((s) => s.key === `c${cat.topId}`);
    if (slot >= 0) addSpending(series[slot], m, -t.amount, cat.yearlyCost);
  }
  const all = [...series, uncategorized].filter(hasSpending);
  const spent = -all.reduce((s, x) => s + x.data.reduce((a, b) => a + b, 0), 0);
  return { series: all, income, spent, saved };
}

/** The totals without the fixed costs: what's left is the spending you have a say in. */
export function withoutFixed(totals: Total[], cats: CatIndex): Total[] {
  return totals.filter((t) => t.categoryId == null || !cats.byId.get(t.categoryId)?.fixed);
}

export type CostFilter = "all" | "fixed" | "nonfixed";

/** Select the expense totals shown in a spending-share pie. Yearly exclusions happen first. */
export function costFilterTotals(totals: Total[], cats: CatIndex, filter: CostFilter): Total[] {
  if (filter === "all") return totals;
  if (filter === "nonfixed") return withoutFixed(totals, cats);
  return totals.filter((t) => t.categoryId != null && cats.byId.get(t.categoryId)?.fixed);
}

/** Separate the chart inputs from categories marked Yearly cost. Group inherited exclusions under the
 * category that carries the flag, so its children only count once. */
export function yearChartCosts(totals: Total[], cats: CatIndex, year: number) {
  const chartTotals: Total[] = [];
  const excluded = new Map<number, { cat: CatInfo; amount: number }>();
  for (const total of totals) {
    if (total.year !== year) continue;
    let cat = total.categoryId == null ? undefined : cats.byId.get(total.categoryId);
    if (cat?.kind !== "expense" || !cat.yearlyCost) {
      chartTotals.push(total);
      continue;
    }
    if (total.amount === 0 && total.spent === 0 && total.received === 0) continue;
    while (cat.yearlyCostByParent && cat.parentId != null) cat = cats.byId.get(cat.parentId)!;
    const cost = excluded.get(cat.id) ?? { cat, amount: 0 };
    cost.amount -= total.amount;
    excluded.set(cat.id, cost);
  }
  return { chartTotals, excludedCosts: [...excluded.values()].sort((a, b) => b.amount - a.amount || a.cat.path.localeCompare(b.cat.path)) };
}

export interface Share {
  key: string;
  name: string;
  color: string;
  /** Spent over the months covered, in cents (positive). */
  total: number;
  perMonth: number | null;
  /** Fraction of all spending, 0..1. */
  share: number;
}

/**
 * Each series' part of the spending over the months covered, largest first: its share of the
 * whole, and what that comes to per month on average. A series that took in more than it spent
 * (paid back in full and then some) has no part of the spending and is left out.
 */
export function spendingShares(series: Series[], months: number): Share[] {
  const totals = series.map((s) => ({ s, total: s.data.reduce((a, b) => a + b, 0) })).filter((x) => x.total > 0);
  const whole = totals.reduce((sum, x) => sum + x.total, 0);
  if (whole === 0 || months <= 0) return [];
  return totals
    .map(({ s, total }) => ({ key: s.key, name: s.name, color: s.color, total, perMonth: monthlyAverage([s], months), share: total / whole }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

/** "38%", or "<1%" for a share too small to round to one. */
export function percent(share: number): string {
  if (share > 0 && share < 0.005) return "<1%";
  return `${Math.round(share * 100)}%`;
}

/**
 * Count from the first month with activity in the report through `lastMonth` (zero-based).
 * Months without activity within that span still count.
 */
export function monthsCovered(totals: Total[], year: number, lastMonth: number): number {
  let firstMonth = lastMonth + 1;
  for (const t of totals) {
    if (t.year === year && (t.spent !== 0 || t.received !== 0)) {
      firstMonth = Math.min(firstMonth, t.month - 1);
    }
  }
  return lastMonth + 1 - firstMonth;
}

/**
 * One top-level expense category's spending per month, split over its direct subcategories
 * (deeper ones count toward theirs), each its own series colored in tree order (gray past the
 * palette, never merged). Money booked on the category itself is "No subcategory".
 */
export function subcategorySeries(totals: Total[], cats: CatIndex, year: number, topId: number): Series[] {
  const top = cats.byId.get(topId);
  if (!top) return [];
  const byChild = new Map<number, Spending>();
  const direct = emptySpending();
  for (const t of totals) {
    if (t.year !== year || t.categoryId == null) continue;
    let cat = cats.byId.get(t.categoryId);
    if (!cat || cat.topId !== topId || cat.kind !== "expense") continue;
    const excluded = cat.yearlyCost;
    while (cat.parentId != null && cat.parentId !== topId) cat = cats.byId.get(cat.parentId)!;
    let spending = direct;
    if (cat.id !== topId) {
      spending = byChild.get(cat.id) ?? emptySpending();
      byChild.set(cat.id, spending);
    }
    addSpending(spending, t.month - 1, -t.amount, excluded);
  }
  const children = [...byChild].filter(([, spending]) => hasSpending(spending));
  const treeIndex = new Map(cats.ordered.map((c, i) => [c.id, i]));
  // Use all direct siblings for shade positions so refunds and cost filters do not recolor a child.
  const siblings = cats.ordered.filter((c) => c.parentId === topId).sort((a, b) => a.id - b.id);
  // Move toward the theme's text color: the lightest shade stays legible on a dark card,
  // and the darkest shade stays legible on a light card.
  const shade = (percent: number) => `color-mix(in srgb, ${top.series} ${percent}%, var(--label))`;
  const series: Series[] = children
    .sort((a, b) => treeIndex.get(a[0])! - treeIndex.get(b[0])!)
    .map(([id, spending]) => {
      const position = siblings.findIndex((s) => s.id === id);
      const weight = siblings.length <= 1 ? 100 : 100 - Math.round(65 * position / (siblings.length - 1));
      return { key: `c${id}`, name: cats.byId.get(id)!.name, color: shade(weight), ...spending };
    });
  if (hasSpending(direct)) {
    series.push(
      children.length > 0
        ? { key: "self", name: "No subcategory", color: UNCATEGORIZED_COLOR, ...direct }
        : { key: "self", name: top.name, color: top.series, ...direct },
    );
  }
  return series;
}

export interface TransferLine {
  /** Null for transfers between accounts you import (or to an account you don't track). */
  potId: number | null;
  /** Between accounts: the money moved (positive). For a pot: net moved into it (negative if more came out). */
  amount: number;
}

/** What the overview leaves out: transfers, split by where they went. Pots first by amount, then the rest. */
export function transferBreakdown(txs: Tx[]): TransferLine[] {
  let between = 0;
  const pots = new Map<number, number>();
  for (const t of txs) {
    if (t.linkKind !== "transfer") continue;
    if (t.linkCounterAccountId != null) pots.set(t.linkCounterAccountId, (pots.get(t.linkCounterAccountId) ?? 0) - t.amount);
    else if (t.amount < 0) between -= t.amount;
  }
  const lines: TransferLine[] = [...pots].map(([potId, amount]) => ({ potId, amount })).sort((a, b) => b.amount - a.amount);
  if (between > 0) lines.push({ potId: null, amount: between });
  return lines;
}
