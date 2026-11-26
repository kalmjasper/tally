import type { Category, CategoryKind, Tx } from "../api";
import type { IconName } from "../ui/Icon";

// Colors belong to top-level categories (children inherit them), assigned in creation order so a
// category keeps its color when others are added or hidden. Every expense category is its own
// chart series. The first sixteen get a hue (validated palette, see styles.css --s1..--s6,
// --s8..--s17: every neighbouring pair clears the color-blind and normal-vision checks in light and
// dark; pairs further apart can look alike, e.g. the two greens); any beyond sixteen are gray but
// still listed by name, never merged into "Other".

const ICON_COLORS = ["var(--blue)", "var(--green)", "var(--purple)", "var(--orange)", "var(--teal)", "var(--pink)", "var(--indigo)", "var(--yellow)", "var(--brown)"];
export const SERIES_COLORS = [
  "var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "var(--s6)",
  "var(--s8)", "var(--s9)", "var(--s10)", "var(--s11)",
  "var(--s12)", "var(--s13)", "var(--s14)", "var(--s15)", "var(--s16)", "var(--s17)",
];
export const OTHER_COLOR = "var(--s7)";
export const UNCATEGORIZED_COLOR = "var(--s0)";

const ICON_RULES: [RegExp, IconName][] = [
  [/grocer|boodschap|supermark/, "cart"],
  [/food|dining|restaurant|eten|lunch|caf[eé]|coffee|koffie|drinks|bar\b|takeaway|bezorg/, "fork"],
  [/utilit|energ|electric|stroom|water|internet|phone|telefoon/, "bolt"],
  [/rent|huur|hous|wonen|mortgage|hypotheek|home|thuis/, "house"],
  [/shop|cloth|kleding|winkel/, "bag"],
  [/travel|vakantie|holiday|reis|reizen|flight|vlucht|hotel/, "plane"],
  [/transport|train|trein|\bov\b|bus|car\b|auto|fuel|benzine|parking|parkeren|bike|fiets/, "tram"],
  [/subscri|abonnement|stream|netflix|spotify/, "tv"],
  [/fee|kosten|bank|interest|rente/, "card"],
  [/salar|salaris|income|inkomen|loon|wage|pay\b/, "case"],
  [/health|zorg|medic|doctor|huisarts|pharma|apotheek|sport|gym/, "heart"],
  [/gift|cadeau|present|donat/, "gift"],
  [/insur|verzeker/, "shield"],
  [/tax|belasting/, "doc"],
  [/kid|child|kinder|family|familie/, "people"],
];

export interface CatInfo {
  id: number;
  parentId: number | null;
  name: string;
  kind: CategoryKind;
  /** "Food › Dining out" */
  path: string;
  topId: number;
  depth: number;
  icon: IconName | null;
  letter: string;
  color: string;
  /** Chart series color of its top-level category. */
  series: string;
  fixed: boolean;
  ownFixed: boolean;
  fixedByParent: boolean;
  yearlyCost: boolean;
  ownYearlyCost: boolean;
  yearlyCostByParent: boolean;
}

export interface CatIndex {
  byId: Map<number, CatInfo>;
  /** Tree order: each top-level category followed by its descendants, alphabetical per level. */
  ordered: CatInfo[];
  tops: CatInfo[];
  /** Top-level expense categories in color order (creation order). */
  expenseTops: CatInfo[];
  /** Top id -> its own id plus every descendant id. */
  family: Map<number, Set<number>>;
}

const iconFor = (name: string): IconName | null => {
  const n = name.toLowerCase();
  return ICON_RULES.find(([re]) => re.test(n))?.[1] ?? null;
};

export function indexCategories(list: Category[]): CatIndex {
  const raw = new Map(list.map((c) => [c.id, c]));
  const topOf = (c: Category): Category => {
    let cur = c;
    for (let i = 0; cur.parentId != null && raw.has(cur.parentId) && i < 20; i++) cur = raw.get(cur.parentId)!;
    return cur;
  };
  const pathOf = (c: Category): string[] => {
    const names = [c.name];
    let cur = c;
    for (let i = 0; cur.parentId != null && raw.has(cur.parentId) && i < 20; i++) {
      cur = raw.get(cur.parentId)!;
      names.unshift(cur.name);
    }
    return names;
  };

  const tops = list.filter((c) => c.parentId == null || !raw.has(c.parentId));
  const taggedAbove = (c: Category, tag: "fixed" | "yearlyCost"): boolean => {
    let cur = c;
    for (let i = 0; cur.parentId != null && raw.has(cur.parentId) && i < 20; i++) {
      cur = raw.get(cur.parentId)!;
      if (cur[tag]) return true;
    }
    return false;
  };
  const expenseTops = tops.filter((c) => c.kind === "expense").sort((a, b) => a.id - b.id);
  const style = new Map<number, { color: string; series: string; icon: IconName | null }>();
  expenseTops.forEach((c, i) =>
    style.set(c.id, {
      color: ICON_COLORS[i % ICON_COLORS.length],
      series: SERIES_COLORS[i] ?? OTHER_COLOR,
      icon: iconFor(c.name),
    }),
  );
  for (const c of tops.filter((t) => t.kind === "income")) {
    style.set(c.id, { color: "var(--indigo)", series: OTHER_COLOR, icon: iconFor(c.name) ?? "case" });
  }

  const byId = new Map<number, CatInfo>();
  for (const c of list) {
    const top = topOf(c);
    const path = pathOf(c);
    const s = style.get(top.id)!;
    byId.set(c.id, {
      id: c.id,
      parentId: c.parentId,
      name: c.name,
      kind: c.kind,
      path: path.join(" › "),
      topId: top.id,
      depth: path.length - 1,
      icon: iconFor(c.name) ?? s.icon,
      letter: c.name.trim().charAt(0).toUpperCase() || "?",
      color: s.color,
      series: s.series,
      fixed: !!c.fixed || taggedAbove(c, "fixed"),
      ownFixed: !!c.fixed,
      fixedByParent: taggedAbove(c, "fixed"),
      yearlyCost: !!c.yearlyCost || taggedAbove(c, "yearlyCost"),
      ownYearlyCost: !!c.yearlyCost,
      yearlyCostByParent: taggedAbove(c, "yearlyCost"),
    });
  }

  const childrenOf = (id: number | null) =>
    [...byId.values()]
      .filter((c) => (id == null ? c.depth === 0 : c.parentId === id))
      .sort((a, b) => a.name.localeCompare(b.name));
  const ordered: CatInfo[] = [];
  const family = new Map<number, Set<number>>();
  const walk = (c: CatInfo, top: number) => {
    ordered.push(c);
    family.get(top)!.add(c.id);
    for (const child of childrenOf(c.id)) walk(child, top);
  };
  for (const t of childrenOf(null)) {
    family.set(t.id, new Set());
    walk(t, t.id);
  }
  return {
    byId,
    ordered,
    tops: ordered.filter((c) => c.depth === 0),
    expenseTops: expenseTops.map((c) => byId.get(c.id)!),
    family,
  };
}

/** How a transaction looks in a list: its category, or a state. */
export type TxVisual =
  | { kind: "category"; cat: CatInfo }
  | { kind: "split" }
  | { kind: "transfer" }
  | { kind: "none" };

export function txVisual(tx: Tx, cats: CatIndex): TxVisual {
  if (tx.linkKind === "transfer") return { kind: "transfer" };
  if (tx.splits.length > 1) return { kind: "split" };
  const cat = tx.splits[0] && cats.byId.get(tx.splits[0].categoryId);
  return cat ? { kind: "category", cat } : { kind: "none" };
}

export const isUncategorized = (tx: Tx) => tx.splits.length === 0 && tx.linkKind !== "transfer";

/** Starter tree, created in this order so it gets the first of the validated chart colors. */
export const STARTER_CATEGORIES: { name: string; kind: CategoryKind; children?: string[] }[] = [
  { name: "Housing", kind: "expense", children: ["Rent", "Utilities"] },
  { name: "Food", kind: "expense", children: ["Groceries", "Dining out"] },
  { name: "Shopping", kind: "expense" },
  { name: "Travel", kind: "expense" },
  { name: "Transport", kind: "expense" },
  { name: "Subscriptions", kind: "expense" },
  { name: "Health", kind: "expense" },
  { name: "Fees", kind: "expense" },
  { name: "Income", kind: "income", children: ["Salary", "Other income"] },
];
