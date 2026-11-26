use entity::{accounts, import_batches, transactions};
use sea_orm::sea_query::OnConflict;
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set, TransactionTrait};
use sha2::{Digest, Sha256};
use sources::NormalizedMutation;

use crate::error::{Error, Result, not_found};
use crate::time::{date_from_jiff, timestamp_to_jiff};
use crate::{ImportBatch, ImportOutcome, Ledger};

/// Rows per INSERT statement (10 bound columns each, well below Postgres' 65535 parameter limit).
const INSERT_CHUNK: usize = 1000;

impl Ledger {
    /// Imports one file into one account, idempotently, in one DB transaction.
    ///
    /// - The same file again (same sha256) returns the existing batch and changes nothing.
    /// - Rows whose `(account_id, import_key)` already exists are counted as duplicates and skipped.
    pub async fn import_file(
        &self,
        account_id: i64,
        source: &str,
        file_name: Option<String>,
        bytes: Vec<u8>,
    ) -> Result<ImportOutcome> {
        let parse = match source {
            sources::ing_csv::ID => sources::ing_csv::parse,
            sources::amex_csv::ID => sources::amex_csv::parse,
            sources::abn_tab::ID => sources::abn_tab::parse,
            sources::revolut_csv::ID => sources::revolut_csv::parse,
            _ => return Err(Error::InvalidArgument(format!("unknown source {source:?}"))),
        };
        let file_sha256 = hex::encode(Sha256::digest(&bytes));

        let txn = self.db.begin().await?;
        accounts::Entity::find_by_id(account_id).one(&txn).await?.ok_or_else(|| not_found("account", account_id))?;

        let existing = import_batches::Entity::find()
            .filter(import_batches::Column::FileSha256.eq(&file_sha256))
            .one(&txn)
            .await?;
        if let Some(batch) = existing {
            if batch.account_id != account_id {
                return Err(Error::FailedPrecondition(format!(
                    "this file was already imported into account #{} (batch #{})",
                    batch.account_id, batch.id
                )));
            }
            return Ok(ImportOutcome { batch: batch_to_domain(batch), already_imported: true, auto_labelled: 0 });
        }

        let rows = parse(&bytes)?;
        let batch = import_batches::ActiveModel {
            account_id: Set(account_id),
            source: Set(source.to_owned()),
            file_name: Set(file_name),
            file_sha256: Set(file_sha256),
            ..Default::default()
        }
        .insert(&txn)
        .await?;

        let mut inserted = 0u64;
        for chunk in rows.chunks(INSERT_CHUNK) {
            let models = chunk.iter().map(|row| new_row(account_id, batch.id, row));
            inserted += transactions::Entity::insert_many(models)
                .on_conflict(
                    OnConflict::columns([transactions::Column::AccountId, transactions::Column::ImportKey])
                        .do_nothing()
                        .to_owned(),
                )
                .exec_without_returning(&txn)
                .await?;
        }

        let auto_labelled = crate::rules::apply_rules(&txn, crate::rules::Scope::Batch(batch.id)).await?;
        let mut batch: import_batches::ActiveModel = batch.into();
        batch.inserted = Set(inserted as i32);
        batch.duplicates = Set((rows.len() as u64 - inserted) as i32);
        let batch = batch.update(&txn).await?;
        txn.commit().await?;
        tracing::info!(
            batch = batch.id,
            account_id,
            source,
            inserted,
            auto_labelled,
            total = rows.len(),
            "imported file"
        );
        Ok(ImportOutcome { batch: batch_to_domain(batch), already_imported: false, auto_labelled })
    }

    pub async fn list_batches(&self, account_id: Option<i64>) -> Result<Vec<ImportBatch>> {
        let mut query = import_batches::Entity::find().order_by_desc(import_batches::Column::ImportedAt);
        if let Some(account_id) = account_id {
            query = query.filter(import_batches::Column::AccountId.eq(account_id));
        }
        Ok(query.all(&self.db).await?.into_iter().map(batch_to_domain).collect())
    }

    /// Deletes a batch; the foreign keys cascade to its transactions and their splits.
    pub async fn undo_batch(&self, batch_id: i64) -> Result<()> {
        let res = import_batches::Entity::delete_by_id(batch_id).exec(&self.db).await?;
        if res.rows_affected == 0 {
            return Err(not_found("import batch", batch_id));
        }
        Ok(())
    }
}

fn new_row(account_id: i64, batch_id: i64, row: &NormalizedMutation) -> transactions::ActiveModel {
    transactions::ActiveModel {
        account_id: Set(account_id),
        import_batch_id: Set(batch_id),
        import_key: Set(row.key.clone()),
        booked_on: Set(date_from_jiff(row.booked_on)),
        amount_cents: Set(row.amount_cents),
        counterparty_name: Set(row.counterparty_name.clone()),
        counterparty_iban: Set(row.counterparty_iban.clone()),
        description: Set(row.description.clone()),
        raw: Set(row.raw.clone()),
        ..Default::default()
    }
}

fn batch_to_domain(m: import_batches::Model) -> ImportBatch {
    ImportBatch {
        id: m.id,
        account_id: m.account_id,
        source: m.source,
        file_name: m.file_name,
        inserted: m.inserted,
        duplicates: m.duplicates,
        imported_at: timestamp_to_jiff(m.imported_at),
    }
}
