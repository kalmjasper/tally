//! Integration tests on real Postgres, following the scenarios in docs/data-model/index.html.
//! All data enters through `import_file`, the only way transactions get in.

mod common;

use common::{amex, date, ing, ledger, tx};
use tally_core::*;

#[tokio::test]
async fn overlapping_imports_are_idempotent_and_undoable() {
    let l = ledger().await;
    let ing_account = l.create_account("ING").await.unwrap();
    let sep_oct = ing(&[
        ("20260915", "Albert Heijn", "Debit", "42,10"),
        ("20261003", "Coffee Bar", "Debit", "4,50"),
        ("20261003", "Coffee Bar", "Debit", "4,50"),
    ]);
    let oct_nov = ing(&[
        ("20261003", "Coffee Bar", "Debit", "4,50"),
        ("20261003", "Coffee Bar", "Debit", "4,50"),
        ("20261101", "Werkgever", "Credit", "3000,00"),
    ]);

    let first = l.import_file(ing_account.id, "ing_csv", Some("sep_oct.csv".into()), sep_oct).await.unwrap();
    assert_eq!((first.batch.inserted, first.batch.duplicates, first.already_imported), (3, 0, false));

    let second = l.import_file(ing_account.id, "ing_csv", None, oct_nov.clone()).await.unwrap();
    assert_eq!((second.batch.inserted, second.batch.duplicates), (1, 2), "the two identical coffees stay two rows");

    let again = l.import_file(ing_account.id, "ing_csv", None, oct_nov.clone()).await.unwrap();
    assert!(again.already_imported);
    assert_eq!(again.batch.id, second.batch.id);

    let other_account = l.create_account("Savings").await.unwrap();
    let wrong_account = l.import_file(other_account.id, "ing_csv", None, oct_nov).await;
    assert!(matches!(wrong_account, Err(Error::FailedPrecondition(_))));

    let all = TransactionFilter { account_id: Some(ing_account.id), ..Default::default() };
    assert_eq!(l.list_transactions(&all).await.unwrap().len(), 4);

    l.undo_batch(second.batch.id).await.unwrap();
    let rows = l.list_transactions(&all).await.unwrap();
    assert_eq!(rows.len(), 3, "October rows still belong to the first batch");
    assert!(rows.iter().all(|t| t.import_batch_id == first.batch.id));
    assert!(matches!(l.undo_batch(second.batch.id).await, Err(Error::NotFound(_))));
}

#[tokio::test]
async fn fixtures_import_and_the_amex_payment_is_suggested_as_transfer() {
    let l = ledger().await;
    let ing_account = l.create_account("ING").await.unwrap();
    let amex_account = l.create_account("AMEX").await.unwrap();
    let ing_file = include_bytes!("../../sources/tests/fixtures/ing.csv").to_vec();
    let amex_file = include_bytes!("../../sources/tests/fixtures/amex.csv").to_vec();
    assert_eq!(l.import_file(ing_account.id, "ing_csv", None, ing_file).await.unwrap().batch.inserted, 8);
    assert_eq!(l.import_file(amex_account.id, "amex_csv", None, amex_file).await.unwrap().batch.inserted, 7);

    let bill = tx(&l, "Incasso Amex").await;
    let payment = tx(&l, "BEDANKT VOOR UW BETALING").await;
    assert_eq!(
        l.suggest_transfers().await.unwrap(),
        [TransferSuggestion { outgoing_id: bill.id, incoming_id: payment.id }]
    );
}

#[tokio::test]
async fn bank_statement_imports_deduplicate_overlaps_and_can_be_undone() {
    let l = ledger().await;
    let statements = [
        ("abn_tab", include_str!("../../sources/tests/fixtures/abn.tab"), false, 2),
        ("revolut_csv", include_str!("../../sources/tests/fixtures/revolut.csv"), true, 6),
    ];
    for (source, statement, has_header, count) in statements {
        let account = l.create_account(source).await.unwrap();
        let mut lines = statement.lines();
        let mut subset = String::new();
        if has_header {
            subset.push_str(lines.next().unwrap());
            subset.push('\n');
        }
        subset.push_str(lines.next().unwrap());
        let first = l.import_file(account.id, source, None, subset.into_bytes()).await.unwrap();
        assert_eq!(first.batch.inserted, 1);

        let import = || l.import_file(account.id, source, None, statement.as_bytes().to_vec());
        let overlap = import().await.unwrap();
        assert_eq!((overlap.batch.inserted, overlap.batch.duplicates), (count - 1, 1));
        assert!(import().await.unwrap().already_imported);
        l.undo_batch(overlap.batch.id).await.unwrap();
        let filter = TransactionFilter { account_id: Some(account.id), ..Default::default() };
        let remaining = l.list_transactions(&filter).await.unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].import_batch_id, first.batch.id);
    }
}

#[tokio::test]
async fn unknown_source_and_bad_files_are_rejected() {
    let l = ledger().await;
    let account = l.create_account("ING").await.unwrap();
    assert!(matches!(l.import_file(account.id, "nope", None, vec![]).await, Err(Error::InvalidArgument(_))));
    let wrong_format = amex(&[("11/19/2026", "X", "1,00")]);
    assert!(matches!(l.import_file(account.id, "ing_csv", None, wrong_format).await, Err(Error::InvalidArgument(_))));
    assert!(l.list_batches(None).await.unwrap().is_empty(), "a failed import leaves nothing behind");
}

#[tokio::test]
async fn transfer_rules_and_reporting() {
    let l = ledger().await;
    let ing_account = l.create_account("ING").await.unwrap();
    let amex_account = l.create_account("AMEX").await.unwrap();
    let misc = l.create_category(None, "Misc", CategoryKind::Expense).await.unwrap();
    l.import_file(
        ing_account.id,
        "ing_csv",
        None,
        ing(&[("20261105", "American Express", "Debit", "842,17"), ("20261106", "Refund", "Credit", "842,17")]),
    )
    .await
    .unwrap();
    l.import_file(amex_account.id, "amex_csv", None, amex(&[("11/06/2026", "PAYMENT RECEIVED", "-842,17")]))
        .await
        .unwrap();
    let (pay, received, refund) =
        (tx(&l, "American Express").await, tx(&l, "PAYMENT RECEIVED").await, tx(&l, "Refund").await);
    l.set_splits(pay.id, vec![Split { category_id: misc.id, amount_cents: -84217 }]).await.unwrap();

    let suggestions = l.suggest_transfers().await.unwrap();
    assert!(suggestions.contains(&TransferSuggestion { outgoing_id: pay.id, incoming_id: received.id }));

    let same_account = l.create_group(LinkKind::Transfer, None, &[pay.id, refund.id], None).await;
    assert!(matches!(same_account, Err(Error::FailedPrecondition(_))));

    let group = l.create_group(LinkKind::Transfer, None, &[pay.id, received.id], None).await.unwrap();
    assert_eq!(group.transaction_ids, [pay.id, received.id]);
    assert!(l.get_transaction(pay.id).await.unwrap().splits.is_empty(), "transfer members lose their splits");
    let categorize = l.set_splits(pay.id, vec![Split { category_id: misc.id, amount_cents: -84217 }]).await;
    assert!(matches!(categorize, Err(Error::FailedPrecondition(_))));

    let totals = l.category_totals(date(2026, 11, 1), date(2026, 11, 30)).await.unwrap();
    assert_eq!(
        totals,
        vec![CategoryTotal {
            month: date(2026, 11, 1),
            target: TotalTarget::UncategorizedIn,
            amount_cents: 84217,
            spent_cents: 0,
            received_cents: 84217
        }],
        "only the unrelated refund remains"
    );

    l.delete_group(group.id).await.unwrap();
    assert_eq!(l.get_transaction(pay.id).await.unwrap().link_group_id, None);
}

#[tokio::test]
async fn dinner_with_reimbursements_nets_in_the_dinner_month() {
    let l = ledger().await;
    let account = l.create_account("ING").await.unwrap();
    let food = l.create_category(None, "Food", CategoryKind::Expense).await.unwrap();
    let dining = l.create_category(Some(food.id), "Dining out", CategoryKind::Expense).await.unwrap();
    l.import_file(
        account.id,
        "ing_csv",
        None,
        ing(&[
            ("20261114", "Restaurant De Kas", "Debit", "150,00"),
            ("20261115", "Anna", "Credit", "30,00"),
            ("20261115", "Bram", "Credit", "30,00"),
            ("20261202", "Carla", "Credit", "30,00"),
        ]),
    )
    .await
    .unwrap();
    let (dinner, anna, bram, carla) =
        (tx(&l, "De Kas").await, tx(&l, "Anna").await, tx(&l, "Bram").await, tx(&l, "Carla").await);

    // Reimbursements join before the dinner is categorized: their splits follow once it is.
    let group = l
        .create_group(LinkKind::Reimbursement, Some("Dinner De Kas".into()), &[dinner.id, anna.id, bram.id], None)
        .await
        .unwrap();
    assert!(l.get_transaction(anna.id).await.unwrap().splits.is_empty());
    l.set_splits(dinner.id, vec![Split { category_id: dining.id, amount_cents: -15000 }]).await.unwrap();
    assert_eq!(
        l.get_transaction(anna.id).await.unwrap().splits,
        [Split { category_id: dining.id, amount_cents: 3000 }]
    );

    // A later reimbursement gets its split as soon as it joins.
    l.update_group_members(group.id, &[carla.id], &[]).await.unwrap();
    assert_eq!(
        l.get_transaction(carla.id).await.unwrap().splits,
        [Split { category_id: dining.id, amount_cents: 3000 }]
    );

    let totals = l.category_totals(date(2026, 11, 1), date(2026, 12, 31)).await.unwrap();
    assert_eq!(
        totals,
        vec![CategoryTotal {
            month: date(2026, 11, 1),
            target: TotalTarget::Category(dining.id),
            amount_cents: -6000,
            spent_cents: -15000,
            received_cents: 9000
        }],
        "Carla's December payment counts in November"
    );
    let carla = l.get_transaction(carla.id).await.unwrap();
    assert_eq!((carla.link_kind, carla.link_title.as_deref()), (Some(LinkKind::Reimbursement), Some("Dinner De Kas")));
}

#[tokio::test]
async fn mixed_trip_splits_pro_rata_and_can_be_edited() {
    let l = ledger().await;
    let account = l.create_account("ING").await.unwrap();
    let travel = l.create_category(None, "Travel", CategoryKind::Expense).await.unwrap();
    let dining = l.create_category(None, "Dining out", CategoryKind::Expense).await.unwrap();
    l.import_file(
        account.id,
        "ing_csv",
        None,
        ing(&[
            ("20261001", "KLM", "Debit", "300,00"),
            ("20261003", "Trattoria Roma", "Debit", "200,00"),
            ("20261005", "Anna", "Credit", "50,00"),
        ]),
    )
    .await
    .unwrap();
    let (flight, restaurant, anna) = (tx(&l, "KLM").await, tx(&l, "Trattoria").await, tx(&l, "Anna").await);
    l.set_splits(flight.id, vec![Split { category_id: travel.id, amount_cents: -30000 }]).await.unwrap();
    l.set_splits(restaurant.id, vec![Split { category_id: dining.id, amount_cents: -20000 }]).await.unwrap();

    l.create_group(LinkKind::Reimbursement, None, &[flight.id, restaurant.id, anna.id], None).await.unwrap();
    let mut default = l.get_transaction(anna.id).await.unwrap().splits;
    default.sort_by_key(|s| s.category_id);
    assert_eq!(
        default,
        [Split { category_id: travel.id, amount_cents: 3000 }, Split { category_id: dining.id, amount_cents: 2000 }]
    );

    l.set_splits(anna.id, vec![Split { category_id: dining.id, amount_cents: 5000 }]).await.unwrap();
    let totals = l.category_totals(date(2026, 10, 1), date(2026, 10, 31)).await.unwrap();
    let of = |id| totals.iter().find(|t| t.target == TotalTarget::Category(id)).unwrap().amount_cents;
    assert_eq!((of(travel.id), of(dining.id)), (-30000, -15000));
}

#[tokio::test]
async fn split_validation() {
    let l = ledger().await;
    let account = l.create_account("ING").await.unwrap();
    let groceries = l.create_category(None, "Groceries", CategoryKind::Expense).await.unwrap();
    let household = l.create_category(None, "Household", CategoryKind::Expense).await.unwrap();
    l.import_file(account.id, "ing_csv", None, ing(&[("20261114", "Albert Heijn", "Debit", "80,00")])).await.unwrap();
    let ah = tx(&l, "Albert Heijn").await;

    let wrong_sum = vec![Split { category_id: groceries.id, amount_cents: -7000 }];
    assert!(matches!(l.set_splits(ah.id, wrong_sum).await, Err(Error::InvalidArgument(_))));
    let zero = vec![
        Split { category_id: groceries.id, amount_cents: -8000 },
        Split { category_id: household.id, amount_cents: 0 },
    ];
    assert!(matches!(l.set_splits(ah.id, zero).await, Err(Error::InvalidArgument(_))));
    let unknown = vec![Split { category_id: 9999, amount_cents: -8000 }];
    assert!(matches!(l.set_splits(ah.id, unknown).await, Err(Error::NotFound(_))));

    let receipt = vec![
        Split { category_id: groceries.id, amount_cents: -6250 },
        Split { category_id: household.id, amount_cents: -1750 },
    ];
    assert_eq!(l.set_splits(ah.id, receipt.clone()).await.unwrap().splits, receipt);

    let filter = TransactionFilter { category_id: Some(household.id), ..Default::default() };
    assert_eq!(l.list_transactions(&filter).await.unwrap().len(), 1);
    let uncategorized = TransactionFilter { uncategorized_only: true, ..Default::default() };
    assert!(l.list_transactions(&uncategorized).await.unwrap().is_empty());

    assert!(l.set_splits(ah.id, vec![]).await.unwrap().splits.is_empty());
}

#[tokio::test]
async fn category_tree_rules() {
    let l = ledger().await;
    let food = l.create_category(None, "Food", CategoryKind::Expense).await.unwrap();
    let dining = l.create_category(Some(food.id), "Dining out", CategoryKind::Expense).await.unwrap();

    let duplicate = l.create_category(None, "Food", CategoryKind::Expense).await;
    assert!(matches!(duplicate, Err(Error::FailedPrecondition(_))), "two top-level categories can't share a name");
    assert!(l.create_category(Some(dining.id), "Food", CategoryKind::Expense).await.is_ok());
    let wrong_kind = l.create_category(Some(food.id), "Salary", CategoryKind::Income).await;
    assert!(matches!(wrong_kind, Err(Error::InvalidArgument(_))));
    let cycle = l.update_category(food.id, "Food", Some(dining.id)).await;
    assert!(matches!(cycle, Err(Error::InvalidArgument(_))));
    assert!(matches!(l.delete_category(food.id).await, Err(Error::FailedPrecondition(_))), "has children");

    let moved = l.update_category(dining.id, "Restaurants", None).await.unwrap();
    assert_eq!((moved.parent_id, moved.name.as_str()), (None, "Restaurants"));
    l.delete_category(food.id).await.unwrap();
    assert!(matches!(l.delete_category(food.id).await, Err(Error::NotFound(_))));
}

#[tokio::test]
async fn search_and_notes() {
    let l = ledger().await;
    let account = l.create_account("ING").await.unwrap();
    l.import_file(
        account.id,
        "ing_csv",
        None,
        ing(&[("20261101", "Bakery 100%_1", "Debit", "1,00"), ("20261102", "Bakery 100%_2", "Debit", "1,00")]),
    )
    .await
    .unwrap();
    let all = l.list_transactions(&TransactionFilter::default()).await.unwrap();
    assert_eq!(all[0].booked_on, date(2026, 11, 2), "newest first");

    let found = tx(&l, "100%_2").await;
    let noted = l.set_notes(found.id, Some("birthday cake".into())).await.unwrap();
    assert_eq!(noted.notes.as_deref(), Some("birthday cake"));
    assert_eq!(l.set_notes(found.id, Some("  ".into())).await.unwrap().notes, None);
}

#[tokio::test]
async fn savings_pots_collect_one_sided_transfers() {
    let l = ledger().await;
    let ing_account = l.create_account("ING").await.unwrap();
    let savings = l.create_account("Savings").await.unwrap();
    let cash = l.create_account("Cash savings").await.unwrap();
    l.import_file(
        ing_account.id,
        "ing_csv",
        None,
        ing(&[
            ("20261003", "Naar Oranje Spaarrekening", "Debit", "1000,00"),
            ("20261017", "Van Oranje Spaarrekening", "Credit", "700,00"),
            ("20261020", "Geldautomaat", "Debit", "200,00"),
            ("20261021", "Restaurant", "Debit", "50,00"),
        ]),
    )
    .await
    .unwrap();
    let (deposit, withdrawal, atm, dinner) = (
        tx(&l, "Naar Oranje").await,
        tx(&l, "Van Oranje").await,
        tx(&l, "Geldautomaat").await,
        tx(&l, "Restaurant").await,
    );

    let group = l.create_group(LinkKind::Transfer, None, &[deposit.id], Some(savings.id)).await.unwrap();
    assert_eq!(group.counter_account_id, Some(savings.id));
    l.create_group(LinkKind::Transfer, None, &[withdrawal.id], Some(savings.id)).await.unwrap();
    l.create_group(LinkKind::Transfer, None, &[atm.id], Some(cash.id)).await.unwrap();

    let pot = TransactionFilter { counter_account_id: Some(savings.id), ..Default::default() };
    let moved = l.list_transactions(&pot).await.unwrap();
    assert_eq!(moved.len(), 2);
    assert_eq!(-moved.iter().map(|t| t.amount_cents).sum::<i64>(), 30000, "300 moved into savings");
    assert_eq!(l.get_transaction(atm.id).await.unwrap().link_counter_account_id, Some(cash.id));

    let not_a_transfer = l.create_group(LinkKind::Reimbursement, None, &[dinner.id], Some(savings.id)).await;
    assert!(matches!(not_a_transfer, Err(Error::InvalidArgument(_))));
    let same_account = l.create_group(LinkKind::Transfer, None, &[dinner.id], Some(ing_account.id)).await;
    assert!(matches!(same_account, Err(Error::FailedPrecondition(_))));

    let totals = l.category_totals(date(2026, 10, 1), date(2026, 10, 31)).await.unwrap();
    assert_eq!(totals.len(), 1, "money moved to pots is not spending");
    assert_eq!(totals[0].amount_cents, -5000);

    // Importing the real savings account later: pairing the deposit with its other side clears the pot.
    l.import_file(savings.id, "ing_csv", None, ing(&[("20261003", "Van ING", "Credit", "1000,00")])).await.unwrap();
    let other_side = tx(&l, "Van ING").await;
    let paired = l.update_group_members(group.id, &[other_side.id], &[]).await.unwrap();
    assert_eq!((paired.transaction_ids.len(), paired.counter_account_id), (2, None));
}

#[tokio::test]
async fn rules_fill_blanks_on_creation_and_import() {
    let l = ledger().await;
    let account = l.create_account("ING").await.unwrap();
    let food = l.create_category(None, "Food", CategoryKind::Expense).await.unwrap();
    let groceries = l.create_category(Some(food.id), "Groceries", CategoryKind::Expense).await.unwrap();
    let dining = l.create_category(Some(food.id), "Dining out", CategoryKind::Expense).await.unwrap();
    l.import_file(
        account.id,
        "ing_csv",
        None,
        ing(&[
            ("20261101", "ALBERT HEIJN 1001 AMSTERDAM", "Debit", "42,10"),
            ("20261102", "Albert  Heijn 1001 Amsterdam NLD", "Debit", "12,00"),
            ("20261103", "AH to go Schiphol", "Debit", "4,50"),
            ("20261104", "Tikkie", "Debit", "12,50"),
            ("20261105", "Tikkie", "Credit", "30,00"),
            ("20261106", "Oranje Spaarrekening", "Debit", "100,00"),
        ]),
    )
    .await
    .unwrap();
    let all = l.list_transactions(&TransactionFilter::default()).await.unwrap();
    let find = |name: &str, amount: i64| {
        all.iter().find(|t| t.counterparty_name.as_deref() == Some(name) && t.amount_cents == amount).unwrap().id
    };
    let (ah1, ah2, to_go) = (
        find("ALBERT HEIJN 1001 AMSTERDAM", -4210),
        find("Albert Heijn 1001 Amsterdam NLD", -1200),
        find("AH to go Schiphol", -450),
    );
    let (tikkie_out, tikkie_in, savings) =
        (find("Tikkie", -1250), find("Tikkie", 3000), find("Oranje Spaarrekening", -10000));

    // Your own label stays; a linked transaction is never labelled.
    l.set_splits(ah2, vec![Split { category_id: dining.id, amount_cents: -1200 }]).await.unwrap();
    l.create_group(LinkKind::Transfer, None, &[savings], None).await.unwrap();

    let rule = |pattern: &str, category_id, direction| NewRule {
        pattern: pattern.into(),
        target: RuleTarget::Category(category_id),
        direction,
        account_id: None,
        min_amount_cents: None,
        max_amount_cents: None,
    };
    let preview =
        l.preview_rule(&RuleScope { pattern: "albert heijn".into(), ..Default::default() }, None).await.unwrap();
    assert_eq!((preview.will_label, preview.handled), (1, 1), "one to label; the one you labelled is left alone");
    let (ah_rule, labelled) = l.create_rule(rule("  Albert   HEIJN ", groceries.id, None), true).await.unwrap();
    assert_eq!((ah_rule.pattern.as_str(), labelled), ("albert heijn", 1));
    let t1 = l.get_transaction(ah1).await.unwrap();
    assert_eq!((t1.splits[0].category_id, t1.rule_id), (groceries.id, Some(ah_rule.id)));
    let t2 = l.get_transaction(ah2).await.unwrap();
    assert_eq!((t2.splits[0].category_id, t2.rule_id), (dining.id, None), "your own label wins");

    assert_eq!(l.create_rule(rule("ah to go", dining.id, None), true).await.unwrap().1, 1);
    assert_eq!(l.get_transaction(to_go).await.unwrap().splits[0].category_id, dining.id);
    let (tikkie_rule, n) = l.create_rule(rule("tikkie", dining.id, Some(RuleDirection::Out)), true).await.unwrap();
    assert_eq!(n, 1, "only the Tikkie you paid");
    assert!(l.get_transaction(tikkie_in).await.unwrap().splits.is_empty());
    assert_eq!(
        l.create_rule(rule("oranje", groceries.id, None), true).await.unwrap().1,
        0,
        "transfers are never labelled"
    );
    assert!(matches!(
        l.create_rule(rule("albert heijn", dining.id, None), true).await,
        Err(Error::FailedPrecondition(_))
    ));

    let rules = l.list_rules().await.unwrap();
    assert_eq!(
        rules.iter().map(|r| (r.pattern.as_str(), r.labels)).collect::<Vec<_>>(),
        [("ah to go", 1), ("albert heijn", 1), ("oranje", 0), ("tikkie", 1)]
    );

    // New imports are labelled as they come in.
    let next = l
        .import_file(account.id, "ing_csv", None, ing(&[("20261120", "ALBERT HEIJN 2002 UTRECHT", "Debit", "8,00")]))
        .await
        .unwrap();
    assert_eq!(next.auto_labelled, 1);

    // A rule's new category moves its own labels only.
    l.update_rule(ah_rule.id, rule("albert heijn", food.id, None)).await.unwrap();
    assert_eq!(l.get_transaction(ah1).await.unwrap().splits[0].category_id, food.id);
    assert_eq!(l.get_transaction(ah2).await.unwrap().splits[0].category_id, dining.id);

    // Changing a label by hand makes it yours; deleting a rule keeps its labels.
    assert_eq!(
        l.set_splits(ah1, vec![Split { category_id: groceries.id, amount_cents: -4210 }]).await.unwrap().rule_id,
        None
    );
    l.delete_rule(tikkie_rule.id).await.unwrap();
    let t = l.get_transaction(tikkie_out).await.unwrap();
    assert_eq!((t.splits[0].category_id, t.rule_id), (dining.id, None));
}

#[tokio::test]
async fn transfer_rules_move_savings_and_investing_to_pots() {
    let l = ledger().await;
    let account = l.create_account("ING").await.unwrap();
    let savings = l.create_account("Savings").await.unwrap();
    let investing = l.create_account("Investments").await.unwrap();
    let groceries = l.create_category(None, "Groceries", CategoryKind::Expense).await.unwrap();
    l.import_file(
        account.id,
        "ing_csv",
        None,
        ing(&[
            ("20261003", "Oranje Spaarrekening", "Debit", "1000,00"),
            ("20261017", "Oranje Spaarrekening", "Credit", "700,00"),
            ("20261020", "Broker Bank AG", "Debit", "2500,00"),
            ("20261021", "Albert Heijn", "Debit", "40,00"),
        ]),
    )
    .await
    .unwrap();
    let rule = |pattern: &str, target| NewRule {
        pattern: pattern.into(),
        target,
        direction: None,
        account_id: None,
        min_amount_cents: None,
        max_amount_cents: None,
    };

    let (savings_rule, n) =
        l.create_rule(rule("oranje spaarrekening", RuleTarget::Transfer(savings.id)), true).await.unwrap();
    assert_eq!(n, 2, "money in and out of savings");
    let moved = l
        .list_transactions(&TransactionFilter { counter_account_id: Some(savings.id), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(moved.len(), 2);
    assert!(moved.iter().all(|t| t.link_kind == Some(LinkKind::Transfer) && t.rule_id == Some(savings_rule.id)));
    assert_eq!(l.create_rule(rule("broker", RuleTarget::Transfer(investing.id)), true).await.unwrap().1, 1);
    l.create_rule(rule("albert heijn", RuleTarget::Category(groceries.id)), true).await.unwrap();

    let totals = l.category_totals(date(2026, 10, 1), date(2026, 10, 31)).await.unwrap();
    assert_eq!(
        totals.iter().map(|t| t.amount_cents).sum::<i64>(),
        -4000,
        "only groceries count; savings and investing are transfers"
    );
    let rules = l.list_rules().await.unwrap();
    assert_eq!(rules.iter().find(|r| r.id == savings_rule.id).unwrap().labels, 2);

    // New savings rows are moved on import.
    let next = l
        .import_file(account.id, "ing_csv", None, ing(&[("20261101", "Oranje Spaarrekening", "Debit", "300,00")]))
        .await
        .unwrap();
    assert_eq!(next.auto_labelled, 1);

    // A new pot moves the rule's transfers; a rule can't send money to the account it watches.
    let other = l.create_account("Other savings").await.unwrap();
    l.update_rule(savings_rule.id, rule("oranje spaarrekening", RuleTarget::Transfer(other.id))).await.unwrap();
    let pot = TransactionFilter { counter_account_id: Some(other.id), ..Default::default() };
    assert_eq!(l.list_transactions(&pot).await.unwrap().len(), 3);
    let watching_itself = NewRule {
        pattern: "x".into(),
        target: RuleTarget::Transfer(account.id),
        direction: None,
        account_id: Some(account.id),
        min_amount_cents: None,
        max_amount_cents: None,
    };
    assert!(matches!(l.create_rule(watching_itself, true).await, Err(Error::InvalidArgument(_))));

    // Switching the rule to a category leaves its transfers as yours.
    l.update_rule(savings_rule.id, rule("oranje spaarrekening", RuleTarget::Category(groceries.id))).await.unwrap();
    let still = l.list_transactions(&pot).await.unwrap();
    assert_eq!((still.len(), still[0].rule_id), (3, None));
}

#[tokio::test]
async fn amount_ranges_and_coverage_preview() {
    let l = ledger().await;
    let account = l.create_account("ING").await.unwrap();
    let going_out = l.create_category(None, "Going out", CategoryKind::Expense).await.unwrap();
    let dining = l.create_category(None, "Dining out", CategoryKind::Expense).await.unwrap();
    l.import_file(
        account.id,
        "ing_csv",
        None,
        ing(&[
            ("20261101", "Tikkie bioscoop", "Debit", "12,50"),
            ("20261102", "Tikkie etentje", "Debit", "45,00"),
            ("20261103", "Tikkie borrel", "Debit", "8,00"),
            ("20261104", "Tikkie terug", "Credit", "20,00"),
        ]),
    )
    .await
    .unwrap();
    let rule = |category_id, min, max| NewRule {
        pattern: "tikkie".into(),
        target: RuleTarget::Category(category_id),
        direction: Some(RuleDirection::Out),
        account_id: None,
        min_amount_cents: min,
        max_amount_cents: max,
    };
    let small = RuleScope {
        pattern: "tikkie".into(),
        direction: Some(RuleDirection::Out),
        max_amount_cents: Some(1500),
        ..Default::default()
    };
    let preview = l.preview_rule(&small, None).await.unwrap();
    assert_eq!(preview.will_label, 2, "12,50 and 8,00; not 45,00 and not the incoming one");
    assert_eq!(preview.matches[0].state, MatchState::WillLabel);

    let (small_rule, n) = l.create_rule(rule(going_out.id, None, Some(1500)), true).await.unwrap();
    assert_eq!(n, 2);
    assert_eq!(
        l.create_rule(rule(dining.id, None, None), true).await.unwrap().1,
        1,
        "the rest goes to the rule without a range"
    );
    let after = l.preview_rule(&small, Some(small_rule.id)).await.unwrap();
    assert_eq!((after.will_label, after.labelled_by_rule, after.handled), (0, 2, 0));

    let bad = l.create_rule(rule(dining.id, Some(5000), Some(1000)), true).await;
    assert!(matches!(bad, Err(Error::InvalidArgument(_))));
}

#[tokio::test]
async fn bulk_categorize_and_mark_transfers() {
    let l = ledger().await;
    let account = l.create_account("ING").await.unwrap();
    let savings = l.create_account("Savings").await.unwrap();
    let food = l.create_category(None, "Food", CategoryKind::Expense).await.unwrap();
    l.import_file(
        account.id,
        "ing_csv",
        None,
        ing(&[
            ("20261003", "Bakker", "Debit", "4,50"),
            ("20261004", "Slager", "Debit", "12,00"),
            ("20261005", "Spaardoel vakantie", "Debit", "100,00"),
            ("20261006", "Spaardoel buffer", "Debit", "50,00"),
        ]),
    )
    .await
    .unwrap();
    let (bakker, slager, save1, save2) =
        (tx(&l, "Bakker").await, tx(&l, "Slager").await, tx(&l, "vakantie").await, tx(&l, "buffer").await);

    // Two savings deposits to the pot at once; doing it again skips them.
    let marked = l.mark_transfers(&[save1.id, save2.id], Some(savings.id)).await.unwrap();
    assert_eq!(marked, BulkOutcome { updated: 2, skipped: 0 });
    let again = l.mark_transfers(&[save1.id, bakker.id], Some(savings.id)).await.unwrap();
    assert_eq!(again, BulkOutcome { updated: 1, skipped: 1 }, "an already linked transaction is skipped");
    assert_eq!(l.get_transaction(save2.id).await.unwrap().link_counter_account_id, Some(savings.id));
    let own_account = l.mark_transfers(&[slager.id], Some(account.id)).await.unwrap();
    assert_eq!(own_account, BulkOutcome { updated: 0, skipped: 1 }, "a pot can't be the transaction's own account");

    // Categorize the lot: the transfers are skipped, the others get Food for their whole amount.
    let bakker_group = l.get_transaction(bakker.id).await.unwrap().link_group_id.unwrap();
    l.delete_group(bakker_group).await.unwrap();
    let labelled = l.set_category(&[bakker.id, slager.id, save1.id], Some(food.id)).await.unwrap();
    assert_eq!(labelled, BulkOutcome { updated: 2, skipped: 1 });
    let slager_now = l.get_transaction(slager.id).await.unwrap();
    assert_eq!(slager_now.splits, vec![Split { category_id: food.id, amount_cents: -1200 }]);

    // And clear them again.
    assert_eq!(l.set_category(&[bakker.id, slager.id], None).await.unwrap(), BulkOutcome { updated: 2, skipped: 0 });
    assert!(l.get_transaction(bakker.id).await.unwrap().splits.is_empty());

    let missing = l.set_category(&[bakker.id, 999_999], Some(food.id)).await;
    assert!(matches!(missing, Err(Error::NotFound(_))));
    let no_category = l.set_category(&[bakker.id], Some(999_999)).await;
    assert!(matches!(no_category, Err(Error::NotFound(_))));
}

#[tokio::test]
async fn reimbursement_groups_share_one_category() {
    let l = ledger().await;
    let account = l.create_account("ING").await.unwrap();
    let food = l.create_category(None, "Food", CategoryKind::Expense).await.unwrap();
    let dining = l.create_category(Some(food.id), "Dining out", CategoryKind::Expense).await.unwrap();
    let other = l.create_category(None, "Other income", CategoryKind::Income).await.unwrap();
    l.import_file(
        account.id,
        "ing_csv",
        None,
        ing(&[
            ("20261010", "Restaurant De Kas", "Debit", "60,00"),
            ("20261011", "Tikkie Anna", "Credit", "20,00"),
            ("20261012", "Tikkie Bob", "Credit", "20,00"),
        ]),
    )
    .await
    .unwrap();
    let (dinner, anna, bob) = (tx(&l, "Restaurant").await, tx(&l, "Anna").await, tx(&l, "Bob").await);
    let one = |category_id: i64, amount_cents: i64| vec![Split { category_id, amount_cents }];
    let splits = |id: i64| {
        let l = &l;
        async move { l.get_transaction(id).await.unwrap().splits }
    };

    // The dinner is labelled by a rule; Anna's Tikkie already has a category of its own.
    let rule = NewRule {
        pattern: "restaurant".into(),
        target: RuleTarget::Category(dining.id),
        direction: Some(RuleDirection::Out),
        account_id: None,
        min_amount_cents: None,
        max_amount_cents: None,
    };
    let (rule, _) = l.create_rule(rule.clone(), true).await.unwrap();
    l.set_splits(anna.id, one(other.id, 2000)).await.unwrap();

    // Linking: both Tikkies take the dinner's category, Anna's own is replaced.
    let group = l.create_group(LinkKind::Reimbursement, None, &[dinner.id, anna.id, bob.id], None).await.unwrap();
    assert_eq!(splits(anna.id).await, one(dining.id, 2000));
    assert_eq!(splits(bob.id).await, one(dining.id, 2000));

    // The rule moving the dinner moves the Tikkies along.
    l.update_rule(rule.id, NewRule { target: RuleTarget::Category(food.id), ..rule_scope(&rule) }).await.unwrap();
    assert_eq!(splits(dinner.id).await, one(food.id, -6000));
    assert_eq!(splits(bob.id).await, one(food.id, 2000));

    // Categorizing a Tikkie categorizes the group; clearing one clears the group.
    l.set_splits(anna.id, one(dining.id, 2000)).await.unwrap();
    assert_eq!(splits(dinner.id).await, one(dining.id, -6000));
    assert_eq!(splits(bob.id).await, one(dining.id, 2000));
    l.set_category(&[bob.id], None).await.unwrap();
    for id in [dinner.id, anna.id, bob.id] {
        assert!(splits(id).await.is_empty(), "#{id} is uncategorized with its group");
    }

    // Linking a categorized Tikkie to an uncategorized dinner: the dinner takes the Tikkie's category.
    l.delete_group(group.id).await.unwrap();
    l.set_splits(anna.id, one(dining.id, 2000)).await.unwrap();
    l.create_group(LinkKind::Reimbursement, None, &[dinner.id, anna.id, bob.id], None).await.unwrap();
    assert_eq!(splits(dinner.id).await, one(dining.id, -6000));
    assert_eq!(splits(bob.id).await, one(dining.id, 2000));

    // Already-linked payments can be linked elsewhere: Bob's Tikkie was for the pizza.
    l.import_file(account.id, "ing_csv", None, ing(&[("20261013", "Pizzeria Napoli", "Debit", "30,00")]))
        .await
        .unwrap();
    let pizza = tx(&l, "Pizzeria").await;
    l.set_splits(pizza.id, one(food.id, -3000)).await.unwrap();
    let pizza_group = l.create_group(LinkKind::Reimbursement, None, &[pizza.id, bob.id], None).await.unwrap();
    assert_eq!(splits(bob.id).await, one(food.id, 2000), "moved, and labelled like the pizza");
    let dinner_group = l.get_transaction(dinner.id).await.unwrap().link_group_id.unwrap();
    assert_eq!(l.get_group(dinner_group).await.unwrap().transaction_ids.len(), 2, "the dinner keeps Anna");
    // Moving Anna too leaves the dinner alone, so its group goes.
    l.update_group_members(pizza_group.id, &[anna.id], &[]).await.unwrap();
    assert_eq!(l.get_transaction(dinner.id).await.unwrap().link_group_id, None);
    assert!(matches!(l.get_group(dinner_group).await, Err(Error::NotFound(_))));
    // A transfer is not taken.
    l.mark_transfers(&[dinner.id], None).await.unwrap();
    let transfer = l.update_group_members(pizza_group.id, &[dinner.id], &[]).await;
    assert!(matches!(transfer, Err(Error::FailedPrecondition(_))));
}

fn rule_scope(rule: &Rule) -> NewRule {
    NewRule {
        pattern: rule.pattern.clone(),
        target: rule.target,
        direction: rule.direction,
        account_id: rule.account_id,
        min_amount_cents: rule.min_amount_cents,
        max_amount_cents: rule.max_amount_cents,
    }
}
