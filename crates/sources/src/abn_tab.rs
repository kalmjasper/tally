//! ABN AMRO Excel TXT: eight tab-separated columns, without a header.

use serde_json::json;

use crate::parse::{collapse_whitespace, disambiguate, fingerprint, non_empty, parse_cents, parse_date};
use crate::{NormalizedMutation, SourceError};

pub const ID: &str = "abn_tab";
const KEY_PREFIX: &str = "abn_tab:v1:";
const TAGS: [&str; 8] = ["TRTP", "IBAN", "BIC", "NAME", "REMI", "EREF", "CSID", "MARF"];
const COLUMN: usize = 32;

pub fn parse(bytes: &[u8]) -> Result<Vec<NormalizedMutation>, SourceError> {
    let text = std::str::from_utf8(bytes).map_err(|_| SourceError::NotUtf8)?;
    let mut rows = Vec::new();
    let mut account = None;
    for (index, line) in text.trim_start_matches('\u{feff}').lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let invalid = |message: String| SourceError::InvalidRow { line: index as u64 + 1, message };
        let fields: Vec<_> = line.split('\t').map(str::trim).collect();
        let [number, currency, date, opening, closing, value_date, amount, info] = fields[..] else {
            return Err(invalid("expected eight ABN AMRO TAB columns".into()));
        };
        if number.len() != 9 || !number.bytes().all(|b| b.is_ascii_digit()) || currency != "EUR" {
            return Err(invalid("expected a nine-digit ABN AMRO account number and EUR".into()));
        }
        if *account.get_or_insert(number) != number {
            return Err(invalid("expected transactions from one account".into()));
        }
        let booked_on = parse_date(date, "%Y%m%d").map_err(invalid)?;
        let value_on = parse_date(value_date, "%Y%m%d").map_err(invalid)?;
        let amount_cents = parse_cents(amount).map_err(invalid)?;
        let opening_cents = parse_cents(opening).map_err(invalid)?;
        let closing_cents = parse_cents(closing).map_err(invalid)?;
        if opening_cents.checked_add(amount_cents) != Some(closing_cents) {
            return Err(invalid("the amount does not reconcile with the opening and closing balance".into()));
        }

        let clean = collapse_whitespace(info);
        let (name, iban, description) = if info.starts_with('/') {
            (tagged_value(info, "NAME"), tagged_value(info, "IBAN"), tagged_value(info, "REMI"))
        } else if clean.starts_with("SEPA") {
            (label(&clean, "Naam:"), label(&clean, "IBAN:"), label(&clean, "Omschrijving:"))
        } else if info.starts_with("BEA,") || info.starts_with("eCom,") {
            (card_merchant(info), None, Some(clean.clone()))
        } else {
            (None, None, None)
        };
        // A balance transition can recur on the same day, so retain the statement detail as well.
        let key = fingerprint(&[
            number,
            &booked_on.to_string(),
            &value_on.to_string(),
            &opening_cents.to_string(),
            &closing_cents.to_string(),
            &amount_cents.to_string(),
            &clean,
        ]);
        let description = description.or_else(|| name.clone()).unwrap_or(clean);
        rows.push(NormalizedMutation {
            key: format!("{KEY_PREFIX}{key}"),
            booked_on,
            amount_cents,
            counterparty_name: name,
            counterparty_iban: iban,
            description,
            raw: json!({
                "account": number,
                "currency": currency,
                "booking_date": date,
                "opening_balance": opening,
                "closing_balance": closing,
                "value_date": value_date,
                "amount": amount,
                "AddtlNtryInf": info,
            }),
        });
    }
    if rows.is_empty() {
        return Err(SourceError::InvalidRow { line: 1, message: "empty ABN AMRO TAB export".into() });
    }
    disambiguate(&mut rows);
    Ok(rows)
}

fn label(info: &str, name: &str) -> Option<String> {
    let tail = info.split_once(name)?.1.trim_start();
    let end = [" IBAN:", " BIC:", " Naam:", " Omschrijving:", " Kenmerk:", " Machtiging:", " Incassant ID:"]
        .iter()
        .filter_map(|label| tail.find(label))
        .min()
        .unwrap_or(tail.len());
    non_empty(tail[..end].trim())
}

/// The merchant of a card payment: the second 32-character column, without the `,PAS123` suffix.
fn card_merchant(info: &str) -> Option<String> {
    let column: String = info.chars().skip(COLUMN).take(COLUMN).collect();
    let merchant = match column.trim_end().rsplit_once(",PAS") {
        Some((name, suffix)) if !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit()) => name,
        _ => &column,
    };
    non_empty(&collapse_whitespace(merchant))
}

/// A value may contain slashes, so a field runs up to the next known tag.
fn tagged_value(info: &str, tag: &str) -> Option<String> {
    let start = info.find(&format!("/{tag}/"))? + tag.len() + 2;
    let rest = &info[start..];
    let end = TAGS.iter().filter_map(|next| rest.find(&format!("/{next}/"))).min().unwrap_or(rest.len());
    non_empty(&collapse_whitespace(&rest[..end]))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../tests/fixtures/abn.tab");

    #[test]
    fn reads_card_and_sepa_rows() {
        let rows = parse(FIXTURE.as_bytes()).unwrap();
        assert_eq!(rows.len(), 2);
        let card = &rows[0];
        assert_eq!(card.counterparty_name.as_deref(), Some("Versmarkt 1425"));
        assert_eq!(card.amount_cents, -379);
        assert_eq!(card.booked_on, jiff::civil::date(2026, 11, 1));
        assert_eq!(card.raw["opening_balance"], "1000,00");
        assert!(card.description.contains("NR:CT000001"));

        let transfer = &rows[1];
        assert_eq!(transfer.amount_cents, 2900);
        assert_eq!(transfer.counterparty_name.as_deref(), Some("Voorbeeld"));
        assert_eq!(transfer.counterparty_iban.as_deref(), Some("NL11ABNA0123456789"));
        assert_eq!(transfer.description, "Tikkie ID 12345678 1234, tripel etentje");
        assert_eq!(parse(FIXTURE.lines().nth(1).unwrap().as_bytes()).unwrap()[0].key, transfer.key);
    }

    #[test]
    fn overlapping_exports_keep_distinct_payments_with_the_same_balance_transition() {
        let first = FIXTURE.lines().next().unwrap();
        let second = first.replace("Versmarkt 1425", "Marktplein 234");
        let later = first.replacen("20261101", "20261102", 1);
        let full = parse(format!("{first}\n{second}\n{later}").as_bytes()).unwrap();
        for (i, line) in [first, &second, &later].into_iter().enumerate() {
            assert_eq!(parse(line.as_bytes()).unwrap()[0].key, full[i].key);
        }
        assert_ne!(full[0].key, full[1].key);
        assert_ne!(full[0].key, full[2].key);
    }

    #[test]
    fn reads_slash_tagged_fields() {
        let line = b"012345678\tEUR\t20261103\t100,00\t125,00\t20261103\t25,00\t/TRTP/Transfer/NAME/Example shop/REMI/ORDER/2/EREF/test";
        let row = &parse(line).unwrap()[0];
        assert_eq!(row.counterparty_name.as_deref(), Some("Example shop"));
        assert_eq!(row.description, "ORDER/2");
    }

    #[test]
    fn empty_tagged_name_falls_back_to_statement_detail() {
        let line = b"012345678\tEUR\t20261103\t100,00\t125,00\t20261103\t25,00\t/TRTP/Transfer/NAME//EREF/REF123";
        let row = &parse(line).unwrap()[0];
        assert_eq!(row.counterparty_name, None);
        assert_eq!(row.description, "/TRTP/Transfer/NAME//EREF/REF123");
    }

    #[test]
    fn rejects_invalid_statements() {
        for invalid in [
            "".to_owned(),
            "wrong\tcolumns".to_owned(),
            FIXTURE.replacen("EUR", "USD", 1),
            FIXTURE.replacen("012345678", "123456789", 1),
            FIXTURE.replacen("996,21", "995,21", 1),
            FIXTURE.replacen("20261101", "20261301", 1),
        ] {
            assert!(matches!(parse(invalid.as_bytes()), Err(SourceError::InvalidRow { .. })));
        }
        assert!(matches!(parse(&[0xff]), Err(SourceError::NotUtf8)));
    }
}
