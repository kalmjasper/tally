// A made-up year of bank and credit-card exports (January to 22 November 2026) for screenshots
// and trying things out. Every name, IBAN and amount is invented. Seeded, so every run gives the
// same data and before/after screenshots line up.

let seed = 20261123;
const rnd = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (a) => a[Math.floor(rnd() * a.length)];
const between = (lo, hi) => Math.round((lo + rnd() * (hi - lo)) * 100); // cents
const LAST = new Date(Date.UTC(2026, 10, 22));

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const dmy = (d) => `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
const mdy = (d) => `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${d.getUTCFullYear()}`;
const day = (m, d) => new Date(Date.UTC(2026, m, d));
const euro = (c) => `${Math.floor(c / 100)},${pad(c % 100)}`;
const MONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

/**
 * Returns the two exports as CSV text (ING and the credit-card format) and the shared costs that
 * friends paid back, for fill.mjs to link.
 */
export function demoExports() {
  seed = 20261123;
  const OWN = "NL00DEMO0000000001";
  const ibans = new Map();
  const iban = (name) => {
    if (!ibans.has(name)) ibans.set(name, `NL${pad(10 + ibans.size)}DEMO${String(1000000000 + ibans.size * 7919).slice(0, 10)}`);
    return ibans.get(name);
  };
  const bank = []; // { d, name, iban, code, dir, cents, type, note }
  const card = []; // { d, desc, cents } (positive = charge)
  const shared = [];

  const terminal = (d, name, cents) => {
    const t = `${pad(8 + Math.floor(rnd() * 13))}:${pad(Math.floor(rnd() * 60))}`;
    bank.push({ d, name, iban: "", code: "BA", dir: "Debit", cents, type: "Payment terminal", note: `Apple Pay ${dmy(d)} ${t}` });
  };
  const sepa = (d, name, cents, description, dir = "Debit", code = "IC", type = "SEPA direct debit") =>
    bank.push({ d, name, iban: iban(name), code, dir, cents, type, note: `Name: ${name} Description: ${description} IBAN: ${iban(name)} Value date: ${dmy(d)}` });
  const transfer = (d, name, cents, description) => sepa(d, name, cents, description, "Debit", "GT", "Online Banking");
  const tikkie = (d, from, cents, what) =>
    bank.push({ d, name: "Tikkie", iban: iban("Tikkie"), code: "OV", dir: "Credit", cents, type: "Transfer",
      note: `Name: Tikkie Description: Tikkie ID 00000${Math.floor(rnd() * 1e6)} ${what} Van ${from} IBAN: ${iban("Tikkie")} Value date: ${dmy(d)}` });
  const share = (title, expense, paybacks) => shared.push({ title, expense, paybacks });

  for (let m = 0; m <= 10; m++) {
    const inMonth = (d) => d <= LAST;
    sepa(day(m, 1), "Kade Wonen B.V.", 115000, `Huur ${MONTHS[m]} 2026`, "Debit", "OV", "Transfer");
    sepa(day(m, 1), "Kosten betaalpakket", 340, `Betaalpakket ${MONTHS[m]}`);
    sepa(day(m, 3), "Polder Energie", m < 3 || m > 9 ? 12850 : m >= 5 && m <= 7 ? 7400 : 9650, `Termijnbedrag ${MONTHS[m]}`);
    if (m % 3 === 0) sepa(day(m, 5), "Duinwater", 6420, "Kwartaalnota water");
    sepa(day(m, 8), "Glasvezel Thuis", 4995, "Internet en tv");
    sepa(day(m, 12), "Zorgverzekeraar Zuid", 13840, "Premie zorgverzekering");
    sepa(day(m, 14), "FitClub Zuid", 3495, "Lidmaatschap");
    if (inMonth(day(m, 24))) sepa(day(m, 24), "Acme Software B.V.", m === 4 ? 341285 + 248000 : 341285, m === 4 ? "Salaris en vakantiegeld" : "Salaris", "Credit", "OV", "Transfer");
    if (inMonth(day(m, 25))) transfer(day(m, 25), "Savings Account", m === 4 ? 150000 : 40000, "Sparen");
    if (inMonth(day(m, 26))) transfer(day(m, 26), "Beleggen Plus", 25000, "Maandelijkse inleg");

    for (let d = 1; d <= 28; d++) {
      const date = day(m, d);
      if (!inMonth(date)) break;
      if (rnd() < 0.36) terminal(date, pick(["Versmarkt Oost Amsterdam", "Versmarkt Oost Amsterdam", "Buurtsuper De Linde", "Bakkerij Van Dam"]), between(6, 68));
      if (rnd() < 0.13) terminal(date, pick(["Pizzeria Napoli", "Lunchroom Het Plein", "Sushi Sora", "Cafe De Kade"]), between(12, 48));
      if (d === 2 || d === 17) terminal(date, "OV-Oplaadpunt Centraal", pick([2000, 3000]));
      if (rnd() < 0.05) terminal(date, "Apotheek Centrum", between(4, 22));
    }

    card.push({ d: day(m, 4), desc: "STREAMFLIX           AMSTERDAM", cents: 1399 });
    card.push({ d: day(m, 9), desc: "SOUNDWAVE MUSIC      STOCKHOLM", cents: 1099 });
    card.push({ d: day(m, 11), desc: "CLOUDBOX STORAGE     DUBLIN", cents: 299 });
    for (let i = 0; i < 2 + Math.floor(rnd() * 3); i++) {
      const d = day(m, 1 + Math.floor(rnd() * 27));
      if (inMonth(d)) card.push({ d, desc: pick(["WEBWINKEL BOLDER     UTRECHT", "WEBWINKEL BOLDER     UTRECHT", "BOEKHANDEL PAGINA    AMSTERDAM"]), cents: between(12, 95) });
    }
  }

  // Bigger moments, some shared with friends who pay their part back by Tikkie
  sepa(day(0, 28), "Gemeente Rivieren", 18700, "Jaarlijkse gemeentelijke heffing");
  sepa(day(3, 7), "Domein Atlas", 8900, "Jaarlijkse domeinverlenging");
  sepa(day(7, 20), "Fietsclub Jaarlidmaatschap", 12500, "Jaarlijkse contributie");
  card.push({ d: day(0, 18), desc: "SKYWAYS AIRLINES     AMSTERDAM", cents: 28900 });
  card.push({ d: day(1, 13), desc: "HOTEL ALPENBLICK     INNSBRUCK", cents: 64000 });
  tikkie(day(1, 16), "L. Jansen", 32000, "Skiweekend");
  share("Ski weekend", { card: "HOTEL ALPENBLICK", month: 1 }, [{ month: 1, amount: 32000 }]);
  card.push({ d: day(2, 21), desc: "GAMEHUB STORE        ONLINE", cents: 5999 });
  card.push({ d: day(3, 10), desc: "PODIUM NOORD TICKETS AMSTERDAM", cents: 7800 });
  tikkie(day(3, 11), "M. Visser", 3900, "Concert");
  share("Concert at Podium Noord", { card: "PODIUM NOORD", month: 3 }, [{ month: 3, amount: 3900 }]);
  card.push({ d: day(4, 6), desc: "ELEKTRO HUIS         ROTTERDAM", cents: 24900 });
  terminal(day(5, 13), "Cafe De Kade", 12400);
  for (const who of ["L. Jansen", "S. de Boer", "M. Visser"]) tikkie(day(5, 14), who, 3100, "Etentje");
  share("Dinner at Cafe De Kade", { bank: "Cafe De Kade", month: 5, amount: 12400 }, [{ month: 5, amount: 3100 }]);
  card.push({ d: day(6, 8), desc: "AGRITURISMO LA COLLINA SIENA", cents: 86000 });
  card.push({ d: day(6, 2), desc: "SKYWAYS AIRLINES     AMSTERDAM", cents: 34000 });
  tikkie(day(6, 12), "S. de Boer", 43000, "Toscane");
  share("Tuscany", { card: "AGRITURISMO", month: 6 }, [{ month: 6, amount: 43000 }]);
  card.push({ d: day(8, 19), desc: "RESTAURANT DE VIJF   AMSTERDAM", cents: 16800 });
  for (const who of ["L. Jansen", "S. de Boer", "M. Visser"]) tikkie(day(8, 20), who, 4200, "Verjaardagsdiner");
  share("Birthday dinner", { card: "RESTAURANT DE VIJF", month: 8 }, [{ month: 8, amount: 4200 }]);
  card.push({ d: day(9, 3), desc: "GAMEHUB STORE        ONLINE", cents: 6999 });
  sepa(day(9, 15), "Marktplein", 8500, "Verkoop fietsstoel", "Credit", "OV", "Transfer");
  // November: a few things still to sort out
  terminal(day(10, 18), "Fietsenmaker Spaak", 6450);
  terminal(day(10, 15), "Kapsalon Knip", 2800);
  terminal(day(10, 20), "Sushi Sora", 9600);
  for (const who of ["L. Jansen", "M. Visser"]) tikkie(day(10, 21), who, 3200, "Sushi");

  // The card bill: each month's charges paid from the bank on the 6th, received by the card on the 8th
  for (let m = 1; m <= 10; m++) {
    const total = card.filter((c) => c.d.getUTCMonth() === m - 1 && c.cents > 0).reduce((s, c) => s + c.cents, 0);
    sepa(day(m, 6), "Creditcard Betaling", total, "Incasso creditcard");
    card.push({ d: day(m, 8), desc: "HARTELIJK BEDANKT VOOR UW BETALING", cents: -total });
  }

  bank.sort((a, b) => b.d - a.d);
  card.sort((a, b) => b.d - a.d);
  const q = (s) => `"${s}"`;
  return {
    checking: [
      '"Date","Name / Description","Account","Counterparty","Code","Debit/credit","Amount (EUR)","Transaction type","Notifications"',
      ...bank.map((r) => [ymd(r.d), r.name, OWN, r.iban, r.code, r.dir, euro(r.cents), r.type, r.note].map(q).join(",")),
    ].join("\r\n") + "\r\n",
    card: [
      "Datum,Omschrijving,Bedrag",
      ...card.map((r) => `${mdy(r.d)},${r.desc},"${r.cents < 0 ? "-" : ""}${euro(Math.abs(r.cents))}"`),
    ].join("\r\n") + "\r\n",
    shared,
  };
}
