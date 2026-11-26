import { Code, ConnectError } from "@connectrpc/connect";
import * as Popover from "@radix-ui/react-popover";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { api, errorMessage, type CategoryKind } from "../api";
import type { CatIndex } from "../lib/categories";
import { CategoryIcon } from "./controls";
import { Icon } from "./Icon";
import { useToast } from "./toast";

/**
 * A popover with a searchable category list; arrow keys and Enter work while typing. When nothing
 * matches the typed name exactly, the last option creates it, so categories can be made on the go.
 */
export function CategoryPicker({
  cats,
  onPick,
  children,
  open,
  onOpenChange,
  defaultKind = "expense",
  allowCreate = true,
  returnFocusAfterPick = true,
}: {
  cats: CatIndex;
  onPick: (categoryId: number) => void;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Kind for a new top-level category: income when the money comes in. */
  defaultKind?: CategoryKind;
  /** False for pickers that only choose, such as a filter. */
  allowCreate?: boolean;
  /** False when picking moves on to another picker, which should keep the focus. */
  returnFocusAfterPick?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [creating, setCreating] = useState(false);
  const [innerOpen, setInnerOpen] = useState(false);
  const isOpen = open ?? innerOpen;
  // Read when the popover has closed (Radix restores focus a tick later), so a ref, not state.
  const picked = useRef(false);
  const setOpen = (o: boolean) => {
    (onOpenChange ?? setInnerOpen)(o);
    if (!o) {
      setQuery("");
      setActive(0);
      setCreating(false);
    }
  };
  const q = query.trim();
  const items = useMemo(() => {
    const lower = q.toLowerCase();
    return lower ? cats.ordered.filter((c) => c.path.toLowerCase().includes(lower)) : cats.ordered;
  }, [cats, q]);
  const canCreate = allowCreate && q.length > 0 && !cats.ordered.some((c) => c.name.toLowerCase() === q.toLowerCase());
  const options = items.length + (canCreate ? 1 : 0);

  const pick = (id: number) => {
    picked.current = true;
    onPick(id);
    setOpen(false);
  };
  const choose = (i: number) => (i < items.length ? pick(items[i].id) : setCreating(true));
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, options - 1));
    else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
    else if (e.key === "Enter" && options > 0) choose(Math.min(active, options - 1));
    else return;
    e.preventDefault();
  };

  return (
    <Popover.Root
      open={isOpen}
      onOpenChange={(o) => {
        if (o) picked.current = false;
        setOpen(o);
      }}
    >
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="picker"
          sideOffset={6}
          align="start"
          collisionPadding={12}
          onCloseAutoFocus={(e) => {
            if (picked.current && !returnFocusAfterPick) e.preventDefault();
          }}
        >
          {creating ? (
            <NewCategoryForm cats={cats} initialName={q} defaultKind={defaultKind} onCancel={() => setCreating(false)} onCreated={pick} />
          ) : (
            <>
              <input
                className="field"
                autoFocus
                placeholder={allowCreate ? "Search or create a category" : "Search categories"}
                aria-label={allowCreate ? "Search or create a category" : "Search categories"}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onKey}
              />
              <div className="picker-list" role="listbox" aria-label="Categories">
                {items.map((c, i) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    key={c.id}
                    className={`picker-item ${i === active ? "active" : ""}`}
                    style={{ paddingLeft: 10 + (q ? 0 : c.depth * 18) }}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(c.id)}
                  >
                    <CategoryIcon cat={c} size="sm" />
                    <span>{q ? c.path : c.name}</span>
                  </button>
                ))}
                {canCreate && (
                  <button
                    type="button"
                    role="option"
                    aria-selected={active === items.length}
                    className={`picker-item create ${active === items.length ? "active" : ""}`}
                    onMouseEnter={() => setActive(items.length)}
                    onClick={() => setCreating(true)}
                  >
                    <span className="ci sm none"><Icon name="plus" /></span>
                    <span>Create "{q}"…</span>
                  </button>
                )}
                {options === 0 && <div className="picker-empty">{allowCreate ? "Type a name to find or create a category." : "No category matches."}</div>}
              </div>
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Name, place in the tree, kind and cost tags; picks it once created. */
function NewCategoryForm({
  cats,
  initialName,
  defaultKind,
  onCancel,
  onCreated,
}: {
  cats: CatIndex;
  initialName: string;
  defaultKind: CategoryKind;
  onCancel: () => void;
  onCreated: (id: number) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(initialName);
  const [parentId, setParentId] = useState<number | null>(null);
  const [kind, setKind] = useState<CategoryKind>(defaultKind);
  const [fixed, setFixed] = useState(false);
  const [yearlyCost, setYearlyCost] = useState(false);
  const [busy, setBusy] = useState(false);
  const parent = parentId != null ? cats.byId.get(parentId) : undefined;
  const effectiveKind = parent?.kind ?? kind;
  const canTag = effectiveKind === "expense";

  const create = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    try {
      const created = await api.createCategory(
        parentId, n, effectiveKind,
        canTag && !parent?.fixed && fixed,
        canTag && !parent?.yearlyCost && yearlyCost,
      );
      // Refresh the tree first so whoever receives the id can already show the new category.
      await qc.invalidateQueries({ queryKey: ["categories"] });
      toast(`${parent ? `${parent.path} › ` : ""}${n} created`);
      onCreated(created.id);
    } catch (e) {
      toast(
        e instanceof ConnectError && e.code === Code.FailedPrecondition ? `There's already a category called "${n}" there.` : errorMessage(e),
        "error",
      );
      setBusy(false);
    }
  };

  return (
    <form className="new-category" onSubmit={(e) => { e.preventDefault(); create(); }}>
      <div className="picker-head">New category</div>
      <input id="new-category-name" className="field" autoFocus aria-label="Name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <label className="new-category-row">
        <span>In</span>
        <select className="field" value={parentId ?? ""} onChange={(e) => setParentId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Top level</option>
          {cats.ordered.map((c) => (
            <option key={c.id} value={c.id}>{" ".repeat(c.depth)}{c.name}</option>
          ))}
        </select>
      </label>
      {parent ? (
        <div className="hint">{parent.kind === "income" ? "Income" : "Expense"}, like {parent.name}</div>
      ) : (
        <div className="seg kind" role="group" aria-label="Kind">
          {(["expense", "income"] as const).map((k) => (
            <button key={k} type="button" className={kind === k ? "on" : ""} aria-pressed={kind === k} onClick={() => setKind(k)}>
              {k === "expense" ? "Expense" : "Income"}
            </button>
          ))}
        </div>
      )}
      <div className="new-category-tags" role="group" aria-label="Tags for new category">
        <span>Tags</span>
        <button type="button" className="category-tag" aria-pressed={canTag && (!!parent?.fixed || fixed)}
          disabled={!canTag || !!parent?.fixed} aria-label={`Fixed cost${parent?.fixed ? ", inherited from parent" : ""}`}
          onClick={() => setFixed((v) => !v)}>Fixed{parent?.fixed && <small> · inherited</small>}</button>
        <button type="button" className="category-tag" aria-pressed={canTag && (!!parent?.yearlyCost || yearlyCost)}
          disabled={!canTag || !!parent?.yearlyCost} aria-label={`Yearly cost${parent?.yearlyCost ? ", inherited from parent" : ""}`}
          onClick={() => setYearlyCost((v) => !v)}>Yearly cost{parent?.yearlyCost && <small> · inherited</small>}</button>
      </div>
      <div className="new-category-btns">
        <button type="button" className="btn" onClick={onCancel}>Back</button>
        <button type="submit" className="btn primary" disabled={!name.trim() || busy}>Create</button>
      </div>
    </form>
  );
}
