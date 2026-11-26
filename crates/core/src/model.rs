//! Domain types returned by [`crate::Ledger`].

use jiff::{Timestamp, civil::Date};

use crate::{CategoryKind, LinkKind, RuleDirection};

#[derive(Debug, Clone, PartialEq)]
pub struct Account {
    pub id: i64,
    pub name: String,
    pub created_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Category {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub name: String,
    pub kind: CategoryKind,
    pub fixed: bool,
    pub yearly_cost: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImportBatch {
    pub id: i64,
    pub account_id: i64,
    pub source: String,
    pub file_name: Option<String>,
    pub inserted: i32,
    pub duplicates: i32,
    pub imported_at: Timestamp,
}

/// The result of a change to many transactions at once.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BulkOutcome {
    pub updated: u64,
    /// Transactions the change doesn't apply to, left as they were (e.g. transfers can't be categorized).
    pub skipped: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImportOutcome {
    pub batch: ImportBatch,
    /// The exact same file was imported before; nothing changed.
    pub already_imported: bool,
    /// New rows that rules labelled during this import.
    pub auto_labelled: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Split {
    pub category_id: i64,
    pub amount_cents: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Transaction {
    pub id: i64,
    pub account_id: i64,
    pub import_batch_id: i64,
    pub booked_on: Date,
    pub amount_cents: i64,
    pub counterparty_name: Option<String>,
    pub counterparty_iban: Option<String>,
    pub description: String,
    pub link_group_id: Option<i64>,
    pub link_kind: Option<LinkKind>,
    pub link_title: Option<String>,
    /// For a one-sided transfer: the account on its other side (a pot such as savings).
    pub link_counter_account_id: Option<i64>,
    pub notes: Option<String>,
    /// Empty means uncategorized.
    pub splits: Vec<Split>,
    /// Set when a rule labelled this transaction (rules always set one category for the full amount).
    pub rule_id: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct TransactionFilter {
    pub account_id: Option<i64>,
    /// Inclusive.
    pub booked_from: Option<Date>,
    /// Inclusive.
    pub booked_to: Option<Date>,
    pub category_id: Option<i64>,
    /// Only transactions without splits that aren't part of a transfer.
    pub uncategorized_only: bool,
    pub link_group_id: Option<i64>,
    /// Case-insensitive substring of the description or counterparty name.
    pub search: Option<String>,
    /// Only one-sided transfers whose other side is this account: a pot's activity.
    pub counter_account_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LinkGroup {
    pub id: i64,
    pub kind: LinkKind,
    pub title: Option<String>,
    pub transaction_ids: Vec<i64>,
    /// For a one-sided transfer: the account on its other side, which isn't imported.
    pub counter_account_id: Option<i64>,
    pub created_at: Timestamp,
}

/// Two unlinked transactions that look like one transfer between your accounts.
/// Nothing is stored until it's confirmed with `create_group`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransferSuggestion {
    pub outgoing_id: i64,
    pub incoming_id: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TotalTarget {
    Category(i64),
    UncategorizedIn,
    UncategorizedOut,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CategoryTotal {
    /// First day of the month.
    pub month: Date,
    pub target: TotalTarget,
    /// Net: `spent_cents + received_cents`.
    pub amount_cents: i64,
    /// Sum of the negative amounts (zero or less).
    pub spent_cents: i64,
    /// Sum of the positive amounts (zero or more).
    pub received_cents: i64,
}

/// What a rule does with a transaction it matches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleTarget {
    /// Label it with this category.
    Category(i64),
    /// Mark it as a transfer to (or from) this pot, an account you never import.
    Transfer(i64),
}

/// "Counterparty contains `pattern` -> target", optionally only for money out or in, or one account.
#[derive(Debug, Clone, PartialEq)]
pub struct Rule {
    pub id: i64,
    /// Lowercase, trimmed, single-spaced.
    pub pattern: String,
    pub target: RuleTarget,
    pub direction: Option<RuleDirection>,
    pub account_id: Option<i64>,
    /// Only amounts of at least / at most this size (cents, inclusive).
    pub min_amount_cents: Option<i64>,
    pub max_amount_cents: Option<i64>,
    /// How many labels this rule set (and still owns).
    pub labels: u64,
    pub created_at: Timestamp,
}

#[derive(Debug, Clone)]
pub struct NewRule {
    pub pattern: String,
    pub target: RuleTarget,
    pub direction: Option<RuleDirection>,
    pub account_id: Option<i64>,
    pub min_amount_cents: Option<i64>,
    pub max_amount_cents: Option<i64>,
}

/// What a rule matches, without its target: used to preview a rule before saving it.
#[derive(Debug, Clone, Default)]
pub struct RuleScope {
    pub pattern: String,
    pub direction: Option<RuleDirection>,
    pub account_id: Option<i64>,
    pub min_amount_cents: Option<i64>,
    pub max_amount_cents: Option<i64>,
}

/// What a rule would do with a transaction it matches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchState {
    /// Unlabelled and not linked: the rule labels it.
    WillLabel,
    /// The previewed rule already labelled it.
    LabelledByRule,
    /// Already categorized (by you or another rule) or linked: the rule leaves it alone.
    Handled,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RuleMatch {
    pub transaction: Transaction,
    pub state: MatchState,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RulePreview {
    pub will_label: u64,
    pub labelled_by_rule: u64,
    pub handled: u64,
    /// The matches, newest first (at most a few hundred; the counts cover all of them).
    pub matches: Vec<RuleMatch>,
}
