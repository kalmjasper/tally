use tally_core::{Category, CategoryKind, Ledger};
use tonic::{Request, Response, Status};

use super::pb::{self, category_service_server::CategoryService};
use super::status;

pub struct Svc(pub Ledger);

#[tonic::async_trait]
impl CategoryService for Svc {
    async fn list_categories(
        &self,
        _: Request<pb::ListCategoriesRequest>,
    ) -> Result<Response<pb::ListCategoriesResponse>, Status> {
        let categories = self.0.list_categories().await.map_err(status)?;
        Ok(Response::new(pb::ListCategoriesResponse { categories: categories.into_iter().map(to_pb).collect() }))
    }

    async fn create_category(
        &self,
        req: Request<pb::CreateCategoryRequest>,
    ) -> Result<Response<pb::CreateCategoryResponse>, Status> {
        let req = req.into_inner();
        let kind = match pb::CategoryKind::try_from(req.kind) {
            Ok(pb::CategoryKind::Expense) => CategoryKind::Expense,
            Ok(pb::CategoryKind::Income) => CategoryKind::Income,
            Ok(pb::CategoryKind::Unspecified) | Err(_) => return Err(Status::invalid_argument("kind is required")),
        };
        let category = self.0.create_category_with_tags(req.parent_id, &req.name, kind, req.fixed, req.yearly_cost).await.map_err(status)?;
        Ok(Response::new(pb::CreateCategoryResponse { category: Some(to_pb(category)) }))
    }

    async fn update_category(
        &self,
        req: Request<pb::UpdateCategoryRequest>,
    ) -> Result<Response<pb::UpdateCategoryResponse>, Status> {
        let req = req.into_inner();
        let category = self.0.update_category(req.id, &req.name, req.parent_id).await.map_err(status)?;
        Ok(Response::new(pb::UpdateCategoryResponse { category: Some(to_pb(category)) }))
    }

    async fn set_category_tags(
        &self,
        req: Request<pb::SetCategoryTagsRequest>,
    ) -> Result<Response<pb::SetCategoryTagsResponse>, Status> {
        let req = req.into_inner();
        let category = self.0.set_category_tags(req.id, req.fixed, req.yearly_cost).await.map_err(status)?;
        Ok(Response::new(pb::SetCategoryTagsResponse { category: Some(to_pb(category)) }))
    }

    async fn delete_category(
        &self,
        req: Request<pb::DeleteCategoryRequest>,
    ) -> Result<Response<pb::DeleteCategoryResponse>, Status> {
        self.0.delete_category(req.into_inner().id).await.map_err(status)?;
        Ok(Response::new(pb::DeleteCategoryResponse {}))
    }
}

fn to_pb(c: Category) -> pb::Category {
    let kind = match c.kind {
        CategoryKind::Expense => pb::CategoryKind::Expense,
        CategoryKind::Income => pb::CategoryKind::Income,
    };
    pb::Category { id: c.id, parent_id: c.parent_id, name: c.name, kind: kind.into(), fixed: c.fixed, yearly_cost: c.yearly_cost }
}
