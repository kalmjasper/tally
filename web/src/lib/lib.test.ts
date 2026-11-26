import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { Category, Total, Tx } from "../api";
import { indexCategories, OTHER_COLOR } from "./categories";
import { addMonths, money, monthRange, parseMoney } from "./format";
import { monthModel, monthsCovered, spendDelta, subcategorySeries, transferBreakdown, yearModel } from "./overview";
import { quickPicks } from "./picks";
import { groupRules, subcategoryLabel } from "./rules";
import { counterpartyKey, detectExport, suggestPattern, txSubtitle } from "./text";

const fixture = (name: string) => readFileSync(new URL(`../../../crates/sources/tests/fixtures/${name}`, import.meta.url), "utf8");

const tx = (over: Partial<Tx>): Tx => ({
  id: 1, accountId: 1, batchId: 1, date: "2026-11-15", amount: -1000, name: null, iban: null, description: "",
  groupId: null, linkKind: null, linkTitle: null, linkCounterAccountId: null, notes: null, splits: [], ruleId: null, ...over,
});

const CATS: Category[] = [
  { id: 1, parentId: null, name: "Housing", kind: "expense" },
  { id: 2, parentId: 1, name: "Rent", kind: "expense" },
  { id: 3, parentId: null, name: "Food", kind: "expense" },
  { id: 4, parentId: 3, name: "Dining out", kind: "expense" },
  { id: 5, parentId: null, name: "Income", kind: "income" },
  { id: 6, parentId: 5, name: "Salary", kind: "income" },
];

describe("format", () => {
  it("formats and parses Dutch amounts", () => {
    expect(money(-101966)).toBe("−1.019,66");
    expect(money(2900, { plus: true })).toBe("+29,00");
    expect(parseMoney("19,50")).toBe(1950);
    expect(parseMoney("1.019,66")).toBe(101966);
    expect(parseMoney("8")).toBe(800);
    expect(parseMoney("abc")).toBeNull();
    expect(parseMoney("")).toBeNull();
  });

  it("does month arithmetic", () => {
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(monthRange("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });
});

describe("text", () => {
  it("recognises the real export formats", () => {
    expect(detectExport(fixture("ing.csv"))).toEqual({ source: "ing_csv", bank: "ING", rows: 8, from: "2026-11-01", to: "2026-11-19" });
    expect(detectExport(fixture("amex.csv"))).toEqual({ source: "amex_csv", bank: "American Express", rows: 7, from: "2026-10-28", to: "2026-11-19" });
    expect(detectExport(fixture("abn.tab"))).toEqual({ source: "abn_tab", bank: "ABN AMRO", rows: 2, from: "2026-11-01", to: "2026-11-03", account: "012345678" });
    expect(detectExport(fixture("abn.tab").replace("EUR", "USD"))).toBeNull();
    expect(detectExport(fixture("revolut.csv"))).toEqual({ source: "revolut_csv", bank: "Revolut", rows: 6, from: "2026-06-10", to: "2026-10-12" });
    const revolut = fixture("revolut.csv");
    expect(detectExport(revolut.replace("TicketKiosk", '"Ticket,\n""Kiosk"""'))).toEqual(detectExport(revolut));
    expect(detectExport(revolut.replace("State,Balance", "State,BalanceX"))).toBeNull();
    expect(detectExport("Datum;Bedrag\n1;2")).toBeNull();
  });

  it("shortens ING remittance text", () => {
    expect(txSubtitle(tx({ description: "Name: J. de Vries Description: Tripel date eten IBAN: NL22RABO0123456789 Value date: 15/11/2026" }))).toBe("Tripel date eten");
    expect(txSubtitle(tx({ description: "Card no: 1234 56** **** 7890 Date: 14/11/2026 Time: 21:40 Transaction: X1 Term: T1 Apple Pay Value date: 14/11/2026" }))).toBe("Apple Pay · 21:40");
    expect(txSubtitle(tx({ description: "Card no: 1234 Date: 14/11/2026 Time: 09:12 Transaction: X1 Term: T1 RRN: 99 Value date: 14/11/2026" }))).toBe("Cash withdrawal · 09:12");
    expect(txSubtitle(tx({ name: "BOL.COM UTRECHT", description: "BOL.COM UTRECHT" }))).toBe("");
  });

  it("matches counterparties across spellings", () => {
    expect(counterpartyKey(tx({ name: "ALBERT HEIJN 1234 AMSTERDAM" }))).toBe(counterpartyKey(tx({ name: "Albert Heijn 1234 Amsterdam NLD" })));
  });
});

describe("overview", () => {
  const cats = indexCategories(CATS);
  const total = (month: number, categoryId: number | null, amount: number, extra: Partial<Total> = {}): Total => ({
    year: 2026, month, categoryId, bucket: null, amount, spent: Math.min(amount, 0), received: Math.max(amount, 0), ...extra,
  });

  it("builds the month: income, spending, rows with children and deltas", () => {
    const totals = [
      total(10, 2, -115000), total(11, 2, -115000),
      total(10, 4, -5000), total(11, 4, -2900, { spent: -11600, received: 8700 }),
      total(11, 6, 300000),
      total(11, null, -18730, { bucket: "out" }),
    ];
    const m = monthModel(totals, cats, "2026-11");
    expect(m.income).toBe(300000);
    expect(m.spent).toBe(-115000 - 2900 - 18730);
    expect(m.saved).toBe(300000 - 115000 - 2900 - 18730);
    expect(m.expenses.map((r) => r.cat.name)).toEqual(["Housing", "Food"]);
    expect(m.expenses[1].children[0]).toMatchObject({ amount: -2900, spent: -11600, received: 8700, prev: -5000 });
    expect(m.bar.map((b) => b.label)).toEqual(["Housing", "Food", "Uncategorized"]);
  });

  it("counts months from the first activity in the report, including gaps", () => {
    const fromJune = [total(6, 2, -100000), total(9, 6, 300000), total(11, 3, -500)];
    expect(monthsCovered(fromJune, 2026, 10)).toBe(6); // June to November
    expect(monthsCovered(fromJune, 2026, 11)).toBe(7); // a past year counts up to December
    expect(monthsCovered([...fromJune, total(3, null, 200, { bucket: "in" })], 2026, 10)).toBe(9); // money in counts too
    expect(monthsCovered([...fromJune, total(4, 2, 0, { spent: -1000, received: 1000 })], 2026, 10)).toBe(8);
    expect(monthsCovered(fromJune, 2025, 11)).toBe(0); // nothing that year
    expect(monthsCovered(fromJune, 2026, 4)).toBe(0); // activity starts after May
    expect(monthsCovered(fromJune, 2026, -1)).toBe(0); // a year that hasn't started
  });

  it("describes spending changes", () => {
    expect(spendDelta(-39885, -35610)).toEqual({ label: "+12%", tone: "up" });
    expect(spendDelta(-13499, -16874)).toEqual({ label: "−20%", tone: "down" });
    expect(spendDelta(-2000, 0)).toEqual({ label: "new", tone: "flat" });
    expect(spendDelta(0, 0)).toBeNull();
  });

  it("builds the year: one series per top-level expense category, never folded into Other", () => {
    const many: Category[] = [...CATS, ...[7, 8, 9, 10, 11].map((id) => ({ id, parentId: null, name: `Cat ${id}`, kind: "expense" as const }))];
    const index = indexCategories(many);
    const y = yearModel([total(1, 2, -100000), total(3, 11, -500), total(2, 6, 300000), total(2, null, -700, { bucket: "out" })], index, 2026);
    expect(y.series.map((s) => s.name)).toEqual(["Housing", "Cat 11", "Uncategorized"]);
    expect(y.series[0].data[0]).toBe(100000);
    expect(y.series[1].color).toBe("var(--s8)"); // the seventh expense category gets the seventh hue
    const crowded = indexCategories([...many, ...[12, 13, 14, 15].map((id) => ({ id, parentId: null, name: `Cat ${id}`, kind: "expense" as const }))]);
    const eleventh = yearModel([total(1, 15, -100)], crowded, 2026).series[0];
    expect([eleventh.name, eleventh.color]).toEqual(["Cat 15", "var(--s12)"]); // the eleventh has its own hue too
    const packed = indexCategories([...many, ...[12, 13, 14, 15, 16, 17, 18, 19, 20, 21].map((id) => ({ id, parentId: null, name: `Cat ${id}`, kind: "expense" as const }))]);
    const far = yearModel([total(1, 21, -100)], packed, 2026).series[0];
    expect([far.name, far.color]).toEqual(["Cat 21", OTHER_COLOR]); // past the sixteen hues: gray, but still by name
    expect(y.income).toBe(300000);
    expect(y.spent).toBe(-101200);
  });
});

describe("quick picks", () => {
  const cats = indexCategories(CATS);
  it("prefers what was used for the same counterparty", () => {
    const history = [
      tx({ id: 10, name: "Restaurant De Kas", splits: [{ categoryId: 4, amount: -1000 }] }),
      tx({ id: 11, name: "Restaurant De Kas", splits: [{ categoryId: 4, amount: -1000 }] }),
      tx({ id: 12, name: "Woningstichting", splits: [{ categoryId: 2, amount: -1000 }] }),
    ];
    const picks = quickPicks(tx({ id: 1, name: "RESTAURANT DE KAS 12" }), history, cats);
    expect(picks[0]).toEqual({ categoryId: 4, here: 2 });
    expect(picks.map((p) => p.categoryId)).toContain(2);
  });
});

describe("transfers left out of the overview", () => {
  it("splits them into pots (net moved in) and transfers between accounts", () => {
    const lines = transferBreakdown([
      tx({ id: 1, amount: -101966, linkKind: "transfer" }),
      tx({ id: 2, amount: 101966, linkKind: "transfer" }),
      tx({ id: 3, amount: -100000, linkKind: "transfer", linkCounterAccountId: 7 }),
      tx({ id: 4, amount: 70000, linkKind: "transfer", linkCounterAccountId: 7 }),
      tx({ id: 5, amount: -20000, linkKind: "transfer", linkCounterAccountId: 8 }),
      tx({ id: 6, amount: -5000 }),
    ]);
    expect(lines).toEqual([
      { potId: 7, amount: 30000 },
      { potId: 8, amount: 20000 },
      { potId: null, amount: 101966 },
    ]);
  });
});

describe("rule patterns", () => {
  it("offers the stable start of a counterparty name", () => {
    expect(suggestPattern(tx({ name: "ALBERT HEIJN 1001 AMSTERDAM NLD" }))).toBe("albert heijn");
    expect(suggestPattern(tx({ name: "NS GROEP IZ NS REIZIGERS" }))).toBe("ns groep");
    expect(suggestPattern(tx({ name: "Tikkie" }))).toBe("tikkie");
    expect(suggestPattern(tx({ name: "BOL.COM               UTRECHT" }))).toBe("bol.com utrecht");
    expect(suggestPattern(tx({ name: "1234 PARKING" }))).toBe("1234");
  });
});

describe("rule groups", () => {
  const cats = indexCategories(CATS);
  const rule = (id: number, pattern: string, categoryId: number | null, potId: number | null = null, maxAmount: number | null = null) => ({
    id, pattern, categoryId, potId, direction: null, accountId: null, minAmount: null, maxAmount, labels: id,
  });
  const rules = [
    rule(1, "tikkie", 4, null, 1500),
    rule(2, "oranje", null, 9),
    rule(3, "albert heijn", 4),
    rule(4, "tikkie", 4),
    rule(5, "woningstichting", 2),
  ];
  const pot = (id: number) => (id === 9 ? "Savings" : "");

  it("groups by top-level category in tree order, pots last; subcategories, then patterns", () => {
    const groups = groupRules(rules, cats, pot);
    expect(groups.map((g) => g.title)).toEqual(["Food", "Housing", "Savings"]);
    expect(groups[0].rules.map((r) => [r.pattern, r.maxAmount])).toEqual([["albert heijn", null], ["tikkie", 1500], ["tikkie", null]]);
    expect(groups[0].labels).toBe(1 + 3 + 4);
    expect(subcategoryLabel(groups[1].rules[0], cats)).toBe("Rent");
  });

  it("filters by pattern or category", () => {
    expect(groupRules(rules, cats, pot, "tik").flatMap((g) => g.rules.map((r) => r.id))).toEqual([1, 4]);
    expect(groupRules(rules, cats, pot, "rent").map((g) => g.title)).toEqual(["Housing"]);
  });
});

describe("subcategory breakdown", () => {
  const cats = indexCategories([
    ...CATS,
    { id: 7, parentId: 3, name: "Groceries", kind: "expense" },
    { id: 8, parentId: 7, name: "Organic", kind: "expense" },
  ]);
  const t = (month: number, categoryId: number, amount: number): Total => ({
    year: 2026, month, categoryId, bucket: null, amount, spent: Math.max(-amount, 0), received: Math.max(amount, 0),
  });
  const totals = [t(1, 4, -3000), t(1, 7, -5000), t(1, 8, -1000), t(2, 4, -2000), t(2, 4, 500), t(2, 3, -700), t(1, 2, -90000)];

  it("splits a category over its direct subcategories, deeper ones counting toward theirs", () => {
    const series = subcategorySeries(totals, cats, 2026, 3);
    expect(series.map((s) => [s.name, s.data[0], s.data[1]])).toEqual([
      ["Dining out", 3000, 1500],
      ["Groceries", 6000, 0],
      ["No subcategory", 0, 700],
    ]);
    // Every bar still adds up to the category's spending.
    const food = yearModel(totals, cats, 2026).series.find((s) => s.name === "Food")!;
    expect(series.reduce((n, s) => n + s.data[0], 0)).toBe(food.data[0]);
    expect(series.reduce((n, s) => n + s.data[1], 0)).toBe(food.data[1]);
  });

  it("shows a category without subcategories as itself", () => {
    const series = subcategorySeries([t(1, 3, -1200)], indexCategories([{ id: 3, parentId: null, name: "Food", kind: "expense" }]), 2026, 3);
    expect(series.map((s) => [s.name, s.data[0]])).toEqual([["Food", 1200]]);
  });
});
