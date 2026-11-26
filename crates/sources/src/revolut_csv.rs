//! Revolut account statement (CSV, English):
//!
//! ```text
//! Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
//! Card Payment,Current,2026-06-09 23:59:01,2026-06-10 11:34:19,TicketKiosk,-13.10,0.00,EUR,COMPLETED,690.75
//! Topup,Current,2026-10-11 12:49:23,2026-10-11 12:49:24,Apple Pay top-up by *1234,300.00,0.00,EUR,COMPLETED,917.39
//! ```
//!
//! Amounts are signed with a decimal point; a fee comes off on top. The booking date is the day the
//! payment completed, usually the day after it was made.
//!
//! The sample only has completed rows in euros, so anything else is rejected rather than guessed
//! at: a pending row can still change, and would then be imported twice.
//!
//! Key: sha256(started | type | description | amount | fee). The start time is to the second, so
//! the key is unique in practice; identical rows get an occurrence suffix anyway.

use jiff::civil::DateTime;

use crate::parse::{collapse_whitespace, disambiguate, fingerprint, non_empty, parse_point_cents, read_csv};
use crate::{NormalizedMutation, SourceError};

pub const ID: &str = "revolut_csv";
const KEY_PREFIX: &str = "revolut_csv:v1:";

pub fn parse(bytes: &[u8]) -> Result<Vec<NormalizedMutation>, SourceError> {
    let table = read_csv(bytes)?;
    let [kind, _, started, completed, description, amount, fee, currency, state, _] = table.columns([
        "Type",
        "Product",
        "Started Date",
        "Completed Date",
        "Description",
        "Amount",
        "Fee",
        "Currency",
        "State",
        "Balance",
    ])?;

    let mut out = Vec::with_capacity(table.rows.len());
    for (line, cells) in &table.rows {
        let invalid = |message: String| SourceError::InvalidRow { line: *line, message };
        if cells[state] != "COMPLETED" {
            return Err(invalid(format!("expected a completed payment, got state {:?}", cells[state])));
        }
        if cells[currency] != "EUR" {
            return Err(invalid(format!("expected an amount in EUR, got {:?}", cells[currency])));
        }
        let timestamp = |value: &str| {
            DateTime::strptime("%Y-%m-%d %H:%M:%S", value)
                .map_err(|_| invalid(format!("invalid statement timestamp {value:?}")))
        };
        timestamp(&cells[started])?;
        let booked_on = timestamp(&cells[completed])?.date();
        let amount_cents = parse_point_cents(&cells[amount])
            .map_err(invalid)?
            .checked_sub(parse_point_cents(&cells[fee]).map_err(invalid)?)
            // Rules and transfer matching also need the positive magnitude of an expense.
            .filter(|net| *net != i64::MIN)
            .ok_or_else(|| invalid("amount after fee is out of range".into()))?;
        let description = collapse_whitespace(&cells[description]);
        let key = fingerprint(&[&cells[started], &cells[kind], &description, &cells[amount], &cells[fee]]);
        out.push(NormalizedMutation {
            key: format!("{KEY_PREFIX}{key}"),
            booked_on,
            amount_cents,
            counterparty_name: non_empty(&description),
            counterparty_iban: None,
            description,
            raw: table.raw(cells),
        });
    }
    disambiguate(&mut out);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &[u8] = include_bytes!("../tests/fixtures/revolut.csv");

    #[test]
    fn parses_the_real_format() {
        let rows = parse(FIXTURE).unwrap();
        assert_eq!(rows.len(), 6);

        let ticket = &rows[0];
        assert_eq!(ticket.booked_on, jiff::civil::date(2026, 6, 10), "the day it completed");
        assert_eq!(ticket.amount_cents, -1310);
        assert_eq!(ticket.counterparty_name.as_deref(), Some("TicketKiosk"));
        assert_eq!(ticket.counterparty_iban, None);
        assert_eq!(ticket.raw["Started Date"], "2026-06-09 23:59:01");

        let top_up = &rows[4];
        assert_eq!(top_up.amount_cents, 30000);
        assert_eq!(top_up.description, "Apple Pay top-up by *1234");
        assert!(rows.iter().all(|r| r.key.starts_with("revolut_csv:v1:")));
    }

    #[test]
    fn two_payments_to_one_merchant_in_the_same_minute_stay_two_rows() {
        let rows = parse(FIXTURE).unwrap();
        assert_ne!(rows[1].key, rows[2].key);
        assert_eq!(parse(FIXTURE).unwrap(), rows, "and the keys are the same in the next export");
    }

    #[test]
    fn a_fee_comes_off_on_top() {
        let text = std::str::from_utf8(FIXTURE).unwrap().replace("TicketKiosk,-13.10,0.00", "TicketKiosk,-13.10,0.25");
        assert_eq!(parse(text.as_bytes()).unwrap()[0].amount_cents, -1335);
    }

    #[test]
    fn rejects_malformed_timestamps_and_out_of_range_net_amounts() {
        let text = std::str::from_utf8(FIXTURE).unwrap();
        for (original, malformed) in [
            ("2026-06-09 23:59:01", ""),
            ("2026-06-10 11:34:19", "2026-06-10 29:00:00"),
            ("-13.10,0.00", "-92233720368547758.07,0.01"),
            ("-13.10,0.00", "-92233720368547758.07,0.02"),
        ] {
            let bad = text.replacen(original, malformed, 1);
            assert!(matches!(parse(bad.as_bytes()), Err(SourceError::InvalidRow { line: 2, .. })));
        }
    }

    #[test]
    fn requires_product_and_balance_headers() {
        let text = std::str::from_utf8(FIXTURE).unwrap();
        for column in ["Product", "Balance"] {
            let changed = text.replacen(column, "Unknown", 1);
            assert!(
                matches!(parse(changed.as_bytes()), Err(SourceError::MissingColumn { column: missing, .. }) if missing == column)
            );
        }
    }

    #[test]
    fn pending_rows_other_currencies_and_other_files_are_rejected() {
        let text = std::str::from_utf8(FIXTURE).unwrap();
        let err = |changed: String| parse(changed.as_bytes()).unwrap_err().to_string();
        assert_eq!(
            err(text.replacen("EUR,COMPLETED", "EUR,PENDING", 1)),
            "line 2: expected a completed payment, got state \"PENDING\""
        );
        assert_eq!(
            err(text.replacen("EUR,COMPLETED", "USD,COMPLETED", 1)),
            "line 2: expected an amount in EUR, got \"USD\""
        );
        assert!(err("Datum,Omschrijving,Bedrag\n".into()).starts_with("missing column \"Type\""));
    }
}
