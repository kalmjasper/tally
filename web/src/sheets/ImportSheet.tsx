import { useNavigate } from "@tanstack/react-router";
import { useState, type DragEvent } from "react";

import { api, type ImportResult, type Source } from "../api";
import { shortDate } from "../lib/format";
import { detectExport, type DetectedExport } from "../lib/text";
import { useAccountRoles, useAction } from "../queries";
import { Icon } from "../ui/Icon";
import { Sheet } from "../ui/Sheet";

type Picked = { name: string; detected: null; problem?: string } | { name: string; detected: DetectedExport; content: Uint8Array };

const PROVIDERS: Record<Source, { hint: RegExp; name: string; label: string; format: string; logo: string }> = {
  ing_csv: { hint: /\bing\b/i, name: "ING Betaalrekening", label: "ING", format: "English CSV", logo: "/banks/ing.png" },
  amex_csv: { hint: /amex|american/i, name: "AMEX", label: "AMEX", format: "Dutch CSV", logo: "/banks/amex.png" },
  abn_tab: { hint: /abn/i, name: "ABN AMRO Betaalrekening", label: "ABN AMRO", format: "Excel TXT", logo: "/banks/abn-amro.png" },
  revolut_csv: { hint: /revolut/i, name: "Revolut", label: "Revolut", format: "English CSV", logo: "/banks/revolut.png" },
};

async function readExport(picked: FileList): Promise<Picked> {
  if (picked.length !== 1) {
    return { name: `${picked.length} files`, detected: null, problem: "Choose one statement export at a time." };
  }
  const { name, size } = picked[0];
  // The gRPC server accepts messages up to 4 MiB, including the file.
  if (size >= 4 * 1024 * 1024) {
    return { name, detected: null, problem: "This statement is too large. Export a shorter date range and try again." };
  }
  const content = new Uint8Array(await picked[0].arrayBuffer());
  const detected = detectExport(new TextDecoder().decode(content));
  return detected ? { name, content, detected } : { name, detected: null };
}

export function ImportSheet({ onClose }: { onClose: () => void }) {
  const roles = useAccountRoles();
  const navigate = useNavigate();
  const [file, setFile] = useState<Picked | null>(null);
  const [accountId, setAccountId] = useState<number | "new">("new");
  const [newName, setNewName] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [dragging, setDragging] = useState(false);
  const createAccount = useAction(api.createAccount);
  // A newly created account becomes a bank after its first successful import.
  const banks = roles?.banks ?? [];
  const created = createAccount.data;
  const accounts = created && !banks.some((a) => a.id === created.id) ? [...banks, created] : banks;
  const importFile = useAction(api.importFile, { onSuccess: setResult });
  const undo = useAction(api.undoBatch, { success: "Import undone", onSuccess: () => setResult(null) });

  async function pick(list: FileList | null | undefined) {
    if (!list?.length) return;
    const picked = await readExport(list);
    setFile(picked);
    setResult(null);
    const suggestion = picked.detected && PROVIDERS[picked.detected.source];
    const match = suggestion && accounts.find((a) => suggestion.hint.test(a.name));
    setAccountId(match?.id ?? "new");
    setNewName(suggestion?.name ?? "");
  }

  async function run() {
    if (!file?.detected) return;
    try {
      const id = accountId === "new" ? (await createAccount.mutateAsync([newName.trim()])).id : accountId;
      if (accountId === "new") setAccountId(id);
      importFile.mutate([id, file.detected.source, file.name, file.content]);
    } catch {
      // the toast already explains what went wrong
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    pick(e.dataTransfer.files);
  };
  const busy = createAccount.isPending || importFile.isPending;

  if (result) {
    const { batch, alreadyImported, autoLabelled } = result;
    const left = batch.inserted - autoLabelled;
    return (
      <Sheet
        wide
        title="Import Statement"
        subtitle={alreadyImported ? "This exact file was imported before; nothing changed." : file?.name}
        onClose={onClose}
        footer={
          <>
            {!alreadyImported && batch.inserted > 0 && (
              <button className="btn" disabled={undo.isPending} onClick={() => undo.mutate([batch.id])}>
                Undo Import
              </button>
            )}
            {left > 0 ? (
              <button className="btn primary" onClick={() => { onClose(); navigate({ to: "/inbox" }); }}>
                Categorize {left}
              </button>
            ) : (
              <button className="btn primary" onClick={onClose}>Done</button>
            )}
          </>
        }
      >
        <div className="stats three">
          <div><b className="num pos">{batch.inserted}</b><span>new transactions</span></div>
          <div><b className="num">{autoLabelled}</b><span>labelled by rules</span></div>
          <div><b className="num">{batch.duplicates}</b><span>already imported</span></div>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet
      wide
      title="Import Statement"
      subtitle="The bank is recognised from the file itself."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!file?.detected || busy || (accountId === "new" && !newName.trim())}
            onClick={run}
          >
            {busy ? "Importing…" : "Import"}
          </button>
        </>
      }
    >
      <label
        className={`drop ${dragging ? "over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {file ? <Icon name="doc" /> : (
          <span className="import-providers">
            {Object.values(PROVIDERS).map(({ label, format, logo }) => (
              <span className="import-provider" key={logo}>
                <img className="bank-logo" src={logo} alt="" />
                <strong>{label}</strong>
                <span>{format}</span>
              </span>
            ))}
          </span>
        )}
        <span>{file ? "Choose another export" : "Drop your statement here, or click to choose a file"}</span>
        <input id="import-file" type="file" accept=".csv,.tab,.txt,text/csv,text/plain" onChange={(e) => pick(e.target.files)} />
      </label>

      {file && !file.detected && (
        <p className="error-text">
          {file.problem ?? `${file.name} doesn't look like a supported statement. Use CSV for ING, AMEX and Revolut, or Excel TXT (.TAB) for one ABN AMRO account.`}
        </p>
      )}

      {file?.detected && (
        <>
          <div className="file">
            <img className="bank-logo" src={PROVIDERS[file.detected.source].logo} alt="" />
            <div className="min0">
              <div className="strong">{file.detected.bank} {file.detected.source === "abn_tab" ? "TAB" : "CSV"} export</div>
              <div className="meta">
                {file.detected.account && `Account ending in ${file.detected.account.slice(-4)} · `}
                {file.detected.rows} rows
                {file.detected.from && file.detected.to && ` · ${shortDate(file.detected.from)} – ${shortDate(file.detected.to)} ${file.detected.to.slice(0, 4)}`}
              </div>
            </div>
          </div>
          <div className="form-row">
            <label htmlFor="import-account">Account</label>
            <select
              id="import-account"
              className="field"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value === "new" ? "new" : Number(e.target.value))}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
              <option value="new">New account…</option>
            </select>
          </div>
          {accountId === "new" && (
            <div className="form-row">
              <label htmlFor="import-new-account">Name</label>
              <input id="import-new-account" className="field" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={PROVIDERS[file.detected.source].name} />
            </div>
          )}
        </>
      )}
    </Sheet>
  );
}
