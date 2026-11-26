//! Statement parsers: bytes in, [`NormalizedMutation`]s out. No database access.
//!
//! Each parser accepts exactly the export format we have a real sample of (anonymized in
//! `tests/fixtures/`). If a bank changes its format, the [`SourceError::MissingColumn`] error
//! lists the headers it found; extend the parser then.

pub mod abn_tab;
pub mod amex_csv;
pub mod ing_csv;
mod parse;
pub mod revolut_csv;

pub use jiff::civil::Date;

/// One statement line, normalized. The account comes from the upload, not from the row.
#[derive(Debug, Clone, PartialEq)]
pub struct NormalizedMutation {
    /// `"{parser}:v{n}:{key}"`. Stays the same when the row shows up again in an overlapping export.
    pub key: String,
    /// The bank's booking date.
    pub booked_on: Date,
    /// Signed cents from this account's point of view. Negative means money left the account.
    pub amount_cents: i64,
    pub counterparty_name: Option<String>,
    pub counterparty_iban: Option<String>,
    pub description: String,
    /// The original row, header -> value.
    pub raw: serde_json::Value,
}

#[derive(Debug, thiserror::Error)]
pub enum SourceError {
    #[error("the file is not UTF-8 text")]
    NotUtf8,
    #[error("could not read the file as CSV: {0}")]
    Csv(#[from] csv::Error),
    #[error("missing column {column:?} (found: {found})")]
    MissingColumn { column: &'static str, found: String },
    #[error("line {line}: {message}")]
    InvalidRow { line: u64, message: String },
}
