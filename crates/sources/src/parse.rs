//! Helpers shared by the parsers.

use std::collections::HashMap;

use jiff::civil::Date;
use sha2::{Digest, Sha256};

use crate::{NormalizedMutation, SourceError};

/// A comma-separated export with a header row.
pub(crate) struct Table {
    headers: Vec<String>,
    /// (line number, cells)
    pub rows: Vec<(u64, Vec<String>)>,
}

pub(crate) fn read_csv(bytes: &[u8]) -> Result<Table, SourceError> {
    let text = std::str::from_utf8(bytes).map_err(|_| SourceError::NotUtf8)?;
    let mut reader = csv::ReaderBuilder::new().trim(csv::Trim::All).from_reader(text.as_bytes());
    let headers = reader.headers()?.iter().map(str::to_owned).collect();
    let mut rows = Vec::new();
    for record in reader.records() {
        let record = record?;
        let line = record.position().map_or(0, |p| p.line());
        rows.push((line, record.iter().map(str::to_owned).collect()));
    }
    Ok(Table { headers, rows })
}

impl Table {
    /// The indexes of the given columns, by exact header name.
    pub fn columns<const N: usize>(&self, names: [&'static str; N]) -> Result<[usize; N], SourceError> {
        let mut out = [0; N];
        for (slot, name) in out.iter_mut().zip(names) {
            *slot = self
                .headers
                .iter()
                .position(|h| h == name)
                .ok_or_else(|| SourceError::MissingColumn { column: name, found: self.headers.join(", ") })?;
        }
        Ok(out)
    }

    /// The row as a JSON object, header -> value.
    pub fn raw(&self, cells: &[String]) -> serde_json::Value {
        let map = self.headers.iter().zip(cells).map(|(h, v)| (h.clone(), v.as_str().into())).collect();
        serde_json::Value::Object(map)
    }
}

/// Parses a Dutch-formatted amount like `1019,66`, `-12,47` or `12` into cents.
pub(crate) fn parse_cents(input: &str) -> Result<i64, String> {
    let (whole, fraction) = input.split_once(',').unwrap_or((input, "00"));
    cents_from_parts(whole, fraction).ok_or_else(|| format!("invalid amount {input:?}"))
}

/// Parses a signed amount with a decimal point and exactly two decimal places.
pub(crate) fn parse_point_cents(input: &str) -> Result<i64, String> {
    input
        .split_once('.')
        .and_then(|(whole, fraction)| cents_from_parts(whole, fraction))
        .ok_or_else(|| format!("invalid amount {input:?}"))
}

fn cents_from_parts(whole: &str, fraction: &str) -> Option<i64> {
    let magnitude = whole.strip_prefix('-').unwrap_or(whole);
    if !magnitude.bytes().all(|b| b.is_ascii_digit())
        || fraction.len() != 2
        || !fraction.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let cents = magnitude.parse::<i64>().ok()?.checked_mul(100)?.checked_add(fraction.parse().ok()?)?;
    Some(if whole.starts_with('-') { -cents } else { cents })
}

pub(crate) fn parse_date(input: &str, format: &str) -> Result<Date, String> {
    Date::strptime(format, input).map_err(|_| format!("invalid date {input:?}, expected {format}"))
}

/// Collapses runs of whitespace, so padding differences don't change a key.
pub(crate) fn collapse_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// sha256 over the parts, separated by a unit separator, as hex.
pub(crate) fn fingerprint(parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            hasher.update([0x1f]);
        }
        hasher.update(part.as_bytes());
    }
    hex::encode(hasher.finalize())
}

/// Makes keys unique within one file: the 2nd identical key gets `#1`, the 3rd `#2`, and so on.
/// Both real exports contain rows that appear twice verbatim (e.g. two identical coffees).
pub(crate) fn disambiguate(rows: &mut [NormalizedMutation]) {
    let mut seen: HashMap<String, usize> = HashMap::new();
    for row in rows {
        let n = seen.entry(row.key.clone()).or_insert(0);
        if *n > 0 {
            row.key = format!("{}#{}", row.key, n);
        }
        *n += 1;
    }
}

pub(crate) fn non_empty(s: &str) -> Option<String> {
    (!s.is_empty()).then(|| s.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amounts() {
        assert_eq!(parse_cents("1019,66"), Ok(101966));
        assert_eq!(parse_cents("-1019,66"), Ok(-101966));
        assert_eq!(parse_cents("9,99"), Ok(999));
        assert_eq!(parse_cents("12"), Ok(1200));
        for bad in ["", "-", "1.019,66", "12,5", "12,", "abc"] {
            assert!(parse_cents(bad).is_err(), "{bad:?} should be rejected");
        }
        assert_eq!(parse_point_cents("000000000001240.47"), Ok(124047));
        assert_eq!(parse_point_cents("-0.05"), Ok(-5));
        for bad in ["", "12", "12.5", "12,50", "--12.50", ".50"] {
            assert!(parse_point_cents(bad).is_err(), "{bad:?} should be rejected");
        }
    }
}
