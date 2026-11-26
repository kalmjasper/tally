//! The database schema, as an ordered list of migrations.
//!
//! This crate is the only place the schema is written by hand. After changing it, run
//! `generate-entities` to regenerate the `entity` crate from a freshly migrated database.

pub use sea_orm_migration::prelude::*;

mod m20261122_000001_init;
mod m20261123_000001_transfer_counter_account;
mod m20261124_000001_rules;
mod m20261125_000001_transfer_rules;
mod m20261126_000001_rule_amounts;
mod m20261127_000001_category_tags;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20261122_000001_init::Migration),
            Box::new(m20261123_000001_transfer_counter_account::Migration),
            Box::new(m20261124_000001_rules::Migration),
            Box::new(m20261125_000001_transfer_rules::Migration),
            Box::new(m20261126_000001_rule_amounts::Migration),
            Box::new(m20261127_000001_category_tags::Migration),
        ]
    }
}
