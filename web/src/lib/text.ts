import type { Source, Tx } from "../api";

/** The name to show for a transaction. */
export function txTitle(tx: Tx): string {
  return tx.name?.trim() || tx.description.trim() || "Transaction";
}

/**
 * A short second line from the bank's long remittance text:
 * ING transfers carry "Description: …", card payments "Card no: … Time: 21:40 …".
 */
export function txSubtitle(tx: Tx): string {
  const d = tx.description.replace(/\s+/g, " ").trim();
  const desc = d.match(/Description: (.*?)(?: (?:IBAN|Reference|Value date|Mandate ID|Creditor ID|Other party|Date\/time):|$)/);
  if (desc?.[1]) return desc[1];
  if (/^Card no:/.test(d)) {
    const time = d.match(/Time: (\d{2}:\d{2})/)?.[1];
    const what = / RRN:/.test(d) ? "Cash withdrawal" : / Apple Pay/.test(d) ? "Apple Pay" : "Card payment";
    return time ? `${what} · ${time}` : what;
  }
  // ABN AMRO card payments: "BEA, Apple Pay Versmarkt 1425,PAS123 NR:CT000001, 02.11.26/15:14 Amsterdam".
  const card = d.match(/^(BEA|eCom), /);
  if (card) {
    const time = d.match(/ \d{2}\.\d{2}\.\d{2}\/(\d{2})[:.](\d{2}) /);
    const what = / Apple Pay /.test(d) ? "Apple Pay" : card[1] === "eCom" ? "Online card payment" : "Card payment";
    return time ? `${what} · ${time[1]}:${time[2]}` : what;
  }
  const rest = d
    .replace(/ ?Value date: \S+$/, "")
    .replace(/^Name: .*? (?=IBAN:)/, "")
    .replace(/^IBAN: \S+ ?/, "")
    .trim();
  return rest === txTitle(tx) ? "" : rest;
}

/** Folds a counterparty name to what stays the same across payments: "ALBERT HEIJN 1234 AMSTERDAM" -> "albert heijn". */
export function counterpartyKey(tx: Tx): string {
  return txTitle(tx)
    .toLowerCase()
    .replace(/[^a-zÀ-ɏ ]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 1)
    .slice(0, 2)
    .join(" ");
}

export interface DetectedExport {
  source: Source;
  bank: string;
  rows: number;
  from: string | null;
  to: string | null;
  /** The ABN AMRO account number from a TAB export. */
  account?: string;
}

/** Recognises an ING, AMEX, ABN AMRO or Revolut export from its CSV header or TAB fields. */
export function detectExport(text: string): DetectedExport | null {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0] ?? "";
  if (header.includes("\t")) {
    const rows = lines.map((line) => line.split("\t").map((field) => field.trim()));
    const account = rows[0][0];
    if (!/^\d{9}$/.test(account) || rows.some((row) => row.length !== 8 || row[0] !== account || row[1] !== "EUR" || !/^\d{8}$/.test(row[2]))) return null;
    const dates = rows.map((row) => `${row[2].slice(0, 4)}-${row[2].slice(4, 6)}-${row[2].slice(6)}`).sort();
    return { source: "abn_tab", bank: "ABN AMRO", rows: rows.length, from: dates[0], to: dates[dates.length - 1], account };
  }
  // Dates are in the leading fields. Keep the first line of each CSV record so
  // a quoted, multiline description counts once and cannot supply a spurious date.
  let inQuotes = false;
  const records = lines.slice(1).filter((line) => {
    const startsRecord = !inQuotes;
    for (const char of line) {
      if (char === '"') inQuotes = !inQuotes;
    }
    return startsRecord;
  });
  let dates: string[];
  let source: Source;
  let bank: string;
  if (header.startsWith('"Date","Name / Description"')) {
    source = "ing_csv";
    bank = "ING";
    dates = records.map((l) => l.slice(1, 9)).filter((s) => /^\d{8}$/.test(s)).map((s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`);
  } else if (header.startsWith("Datum,Omschrijving,Bedrag")) {
    source = "amex_csv";
    bank = "American Express";
    dates = records
      .map((l) => l.split(",")[0].match(/^(\d{2})\/(\d{2})\/(\d{4})$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => `${m[3]}-${m[1]}-${m[2]}`);
  } else if (header === "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance") {
    source = "revolut_csv";
    bank = "Revolut";
    // The completed date is the fourth column; the three before it never contain a comma.
    dates = records.map((l) => l.split(",")[3]?.slice(0, 10) ?? "").filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
  } else {
    return null;
  }
  const sorted = [...dates].sort();
  return { source, bank, rows: records.length, from: sorted[0] ?? null, to: sorted[sorted.length - 1] ?? null };
}

/**
 * The pattern to offer for an "Always label…" rule: the name in lowercase, up to the first word
 * with a digit, at most two words. "ALBERT HEIJN 1001 AMSTERDAM" -> "albert heijn".
 */
export function suggestPattern(tx: Tx): string {
  const words = txTitle(tx).toLowerCase().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const w of words) {
    if (/\d/.test(w) || out.length === 2) break;
    out.push(w);
  }
  return out.join(" ") || words[0] || "";
}
