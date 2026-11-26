import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";

import { isMonthKey } from "./lib/format";
import { Inbox } from "./screens/Inbox";
import { CategoryBreakdown } from "./screens/CategoryBreakdown";
import { Layout } from "./screens/Layout";
import { Overview } from "./screens/Overview";
import { Pots } from "./screens/Pots";
import { Transactions } from "./screens/Transactions";

// All view state lives in the URL, so every screen can be bookmarked and reloaded.

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);

export interface OverviewSearch {
  month?: string;
  /** The overview opens on the year; "month" shows one month. */
  mode?: "month";
  costs?: "fixed" | "nonfixed";
}

export interface TransactionsSearch {
  month?: string;
  account?: number;
  category?: number;
  uncategorized?: boolean;
  q?: string;
  tx?: number;
}

const rootRoute = createRootRoute({ component: Layout });

const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: (s: Record<string, unknown>): OverviewSearch => ({
    month: isMonthKey(s.month) ? s.month : undefined,
    mode: s.mode === "month" ? "month" : undefined,
    costs: s.costs === "fixed" || s.costs === "nonfixed" ? s.costs : undefined,
  }),
  component: Overview,
});

const transactionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/transactions",
  validateSearch: (s: Record<string, unknown>): TransactionsSearch => ({
    month: isMonthKey(s.month) ? s.month : undefined,
    account: num(s.account),
    category: num(s.category),
    uncategorized: s.uncategorized === true || s.uncategorized === "true" ? true : undefined,
    q: typeof s.q === "string" && s.q ? s.q : undefined,
    tx: num(s.tx),
  }),
  component: Transactions,
});

const categoryBreakdownRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/categories/$categoryId",
  validateSearch: (s: Record<string, unknown>): { month?: string; costs?: "fixed" | "nonfixed" } => ({
    month: isMonthKey(s.month) ? s.month : undefined,
    costs: s.costs === "fixed" || s.costs === "nonfixed" ? s.costs : undefined,
  }),
  component: CategoryBreakdown,
});

const inboxRoute = createRoute({ getParentRoute: () => rootRoute, path: "/inbox", component: Inbox });

const potsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pots",
  validateSearch: (s: Record<string, unknown>): { id?: number } => ({ id: num(s.id) }),
  component: Pots,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([overviewRoute, categoryBreakdownRoute, transactionsRoute, inboxRoute, potsRoute]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
