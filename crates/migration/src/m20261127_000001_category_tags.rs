//! Category tags are independent and default to off for existing data.

use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20261127_000001_category_tags"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "ALTER TABLE categories
                 ADD COLUMN fixed boolean NOT NULL DEFAULT false,
                 ADD COLUMN yearly_cost boolean NOT NULL DEFAULT false",
            )
            .await?;
        Ok(())
    }
}
