// Fills an empty Tally server with the made-up demo year, through the app's own api.ts:
// accounts and pots, categories, both imports, rules, card-bill transfers, costs friends paid back,
// and one split. November is left partly unsorted so To Categorize has something to show.
//
//   node demo/fill.mjs http://127.0.0.1:18080      (from web/; scripts/demo.sh runs it for you)
import { createServer } from "vite";
import { demoExports } from "./generate.mjs";

const origin = process.argv[2] ?? "http://127.0.0.1:18080";
globalThis.window = { location: { origin } }; // api.ts talks to window.location.origin

const vite = await createServer({
  root: new URL("..", import.meta.url).pathname,
  server: { middlewareMode: true, hmr: false },
  appType: "custom",
  logLevel: "error",
});
try {
  const { api } = await vite.ssrLoadModule("/src/api.ts");
  const { STARTER_CATEGORIES } = await vite.ssrLoadModule("/src/lib/categories.ts");
  const { checking, card, shared } = demoExports();
  const enc = new TextEncoder();

  if ((await api.listAccounts()).length > 0) throw new Error(`${origin} already has data; the demo needs an empty database`);
  const bank = await api.createAccount("Current account");
  const cc = await api.createAccount("Credit card");
  const savings = await api.createAccount("Savings");
  const invest = await api.createAccount("Investments");

  const cat = {};
  const tops = [...STARTER_CATEGORIES];
  tops.splice(tops.findIndex((t) => t.kind === "income"), 0, { name: "Leisure", kind: "expense", children: ["Going out", "Games"] });
  for (const top of tops) {
    const created = await api.createCategory(
      null, top.name, top.kind,
      top.name === "Housing" || top.name === "Subscriptions",
      top.name === "Travel",
    );
    cat[top.name] = created.id;
    for (const child of top.children ?? []) cat[child] = (await api.createCategory(created.id, child, top.kind)).id;
  }
  cat["Annual fees"] = (await api.createCategory(cat.Fees, "Annual fees", "expense", false, true)).id;

  await api.importFile(bank.id, "ing_csv", "checking.csv", enc.encode(checking));
  await api.importFile(cc.id, "amex_csv", "card.csv", enc.encode(card));

  const RULES = [
    ["kade wonen", "Rent"], ["polder energie", "Utilities"], ["duinwater", "Utilities"], ["glasvezel thuis", "Utilities"],
    ["versmarkt", "Groceries"], ["buurtsuper", "Groceries"], ["bakkerij", "Groceries"],
    ["pizzeria", "Dining out"], ["lunchroom", "Dining out"], ["sushi", "Dining out"], ["cafe de kade", "Dining out"], ["restaurant", "Dining out"],
    ["ov-oplaadpunt", "Transport"], ["streamflix", "Subscriptions"], ["soundwave", "Subscriptions"], ["cloudbox", "Subscriptions"],
    ["webwinkel", "Shopping"], ["boekhandel", "Shopping"], ["elektro huis", "Shopping"],
    ["hotel", "Travel"], ["skyways", "Travel"], ["agriturismo", "Travel"],
    ["zorgverzekeraar", "Health"], ["fitclub", "Health"], ["apotheek", "Health"], ["kosten betaalpakket", "Fees"],
    ["gemeente rivieren", "Annual fees"], ["domein atlas", "Annual fees"], ["fietsclub jaarlidmaatschap", "Annual fees"],
    ["podium noord", "Going out"], ["gamehub", "Games"],
    ["acme software", "Salary", "in"], ["marktplein", "Other income", "in"],
  ];
  for (const [pattern, name, direction = "out"] of RULES) await api.createRule({ pattern, categoryId: cat[name], direction }, true);
  await api.createRule({ pattern: "savings account", potId: savings.id, direction: null }, true);
  await api.createRule({ pattern: "beleggen plus", potId: invest.id, direction: null }, true);

  const all = await api.listTransactions({});
  const byId = new Map(all.map((t) => [t.id, t]));
  for (const s of await api.suggestTransfers()) {
    if (byId.get(s.outgoingId).date >= "2026-11-01") continue; // November's bill stays in To Categorize
    await api.createGroup("transfer", null, [s.outgoingId, s.incomingId]);
  }

  const month = (t) => Number(t.date.slice(5, 7)) - 1;
  for (const g of shared) {
    const e = g.expense;
    const expense = all.find((t) => month(t) === e.month && (e.card
      ? t.accountId === cc.id && t.description.startsWith(e.card)
      : t.accountId === bank.id && t.name === e.bank && t.amount === -e.amount));
    const paybacks = all.filter((t) => t.name === "Tikkie" && g.paybacks.some((p) => p.month === month(t) && p.amount === t.amount));
    await api.createGroup("reimbursement", g.title, [expense.id, ...paybacks.map((p) => p.id)]);
  }

  const tv = all.find((t) => t.description.startsWith("ELEKTRO HUIS"));
  await api.setSplits(tv.id, [{ categoryId: cat.Shopping, amount: -19900 }, { categoryId: cat.Games, amount: -5000 }]);

  console.log(`Demo data loaded: ${all.length} transactions, ${RULES.length + 2} rules.`);
} finally {
  await vite.close();
}
