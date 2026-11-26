use entity::categories;
use sea_orm::{ActiveModelTrait, EntityTrait, QueryOrder, Set};

use crate::accounts::required_name;
use crate::error::{Error, Result, not_found};
use crate::{Category, CategoryKind, Ledger};

impl Ledger {
    /// All categories as a flat list (parents before children is not guaranteed; build the tree from parent_id).
    pub async fn list_categories(&self) -> Result<Vec<Category>> {
        let rows = categories::Entity::find().order_by_asc(categories::Column::Name).all(&self.db).await?;
        Ok(rows.into_iter().map(to_domain).collect())
    }

    /// A child category must have the same kind as its parent.
    pub async fn create_category(&self, parent_id: Option<i64>, name: &str, kind: CategoryKind) -> Result<Category> {
        self.create_category_with_tags(parent_id, name, kind, false, false).await
    }

    /// Creates an expense category with its cost tags in one operation.
    pub async fn create_category_with_tags(
        &self,
        parent_id: Option<i64>,
        name: &str,
        kind: CategoryKind,
        fixed: bool,
        yearly_cost: bool,
    ) -> Result<Category> {
        ensure_expense_tags(kind, fixed, yearly_cost)?;
        if let Some(parent_id) = parent_id {
            let parent = self.find_category(parent_id).await?;
            ensure_same_kind(&parent, kind)?;
        }
        let model = categories::ActiveModel {
            parent_id: Set(parent_id),
            name: Set(required_name(name)?),
            kind: Set(kind),
            fixed: Set(fixed),
            yearly_cost: Set(yearly_cost),
            ..Default::default()
        }
        .insert(&self.db)
        .await?;
        Ok(to_domain(model))
    }

    /// Renames and/or moves a category. `parent_id: None` makes it top-level.
    pub async fn update_category(&self, id: i64, name: &str, parent_id: Option<i64>) -> Result<Category> {
        let current = self.find_category(id).await?;
        if let Some(parent_id) = parent_id {
            let parent = self.find_category(parent_id).await?;
            ensure_same_kind(&parent, current.kind)?;
            // Walk up from the new parent; reaching `id` means the move would create a cycle.
            let mut cursor = Some(parent);
            while let Some(c) = cursor {
                if c.id == id {
                    return Err(Error::InvalidArgument("a category can't be moved under itself".into()));
                }
                cursor = match c.parent_id {
                    Some(p) => Some(self.find_category(p).await?),
                    None => None,
                };
            }
        }
        let mut active: categories::ActiveModel = current.into();
        active.name = Set(required_name(name)?);
        active.parent_id = Set(parent_id);
        Ok(to_domain(active.update(&self.db).await?))
    }

    /// Tags apply to expense categories; descendants inherit their effect in the overview.
    pub async fn set_category_tags(&self, id: i64, fixed: bool, yearly_cost: bool) -> Result<Category> {
        let category = self.find_category(id).await?;
        ensure_expense_tags(category.kind, fixed, yearly_cost)?;
        let mut active: categories::ActiveModel = category.into();
        active.fixed = Set(fixed);
        active.yearly_cost = Set(yearly_cost);
        Ok(to_domain(active.update(&self.db).await?))
    }

    /// Refused (by the foreign keys) while the category has children or splits.
    pub async fn delete_category(&self, id: i64) -> Result<()> {
        let res = categories::Entity::delete_by_id(id).exec(&self.db).await?;
        if res.rows_affected == 0 {
            return Err(not_found("category", id));
        }
        Ok(())
    }

    async fn find_category(&self, id: i64) -> Result<categories::Model> {
        categories::Entity::find_by_id(id).one(&self.db).await?.ok_or_else(|| not_found("category", id))
    }
}

fn ensure_expense_tags(kind: CategoryKind, fixed: bool, yearly_cost: bool) -> Result<()> {
    if kind != CategoryKind::Expense && (fixed || yearly_cost) {
        return Err(Error::InvalidArgument("only expense categories can have cost tags".into()));
    }
    Ok(())
}

fn ensure_same_kind(parent: &categories::Model, kind: CategoryKind) -> Result<()> {
    if parent.kind != kind {
        return Err(Error::InvalidArgument(format!(
            "category kind must match its parent {:?} ({:?})",
            parent.name, parent.kind
        )));
    }
    Ok(())
}

fn to_domain(m: categories::Model) -> Category {
    Category { id: m.id, parent_id: m.parent_id, name: m.name, kind: m.kind, fixed: m.fixed, yearly_cost: m.yearly_cost }
}
