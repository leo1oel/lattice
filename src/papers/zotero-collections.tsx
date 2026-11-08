/**
 * Choosing a Zotero collection in the Add papers sheet. Lattice finds the
 * Zotero library itself and reads a copy of its database
 * (src-tauri/src/zotero.rs), so nothing needs turning on in Zotero and it
 * works whether or not Zotero is open; a library kept somewhere Lattice cannot
 * find is chosen by its folder. The chosen collection comes back as BibTeX,
 * one entry per item under the key the writer cites it by, which the sheet
 * reads like a pasted .bib, so what Papers already holds is skipped as usual.
 */
import { useEffect, useReducer, useRef, type CSSProperties, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Folder, Library } from "lucide-react";
import { Button } from "../components/ui/button";
import { InfinityLoader } from "../components/ui/activity-icons";
import { hostErrorMessage } from "../app-utils";
import { collectionTree, type ZoteroCollection, type ZoteroItem, type ZoteroLibrary } from "./zotero";

type PickerState = {
  collections: ZoteroCollection[] | null;
  /** The data folder the writer chose; null lets Lattice find it. */
  chosenDir: string | null;
  /** The data folder the collections came from. */
  dataDir: string | null;
  error: string | null;
  /** Bumped by Try again, which lists the collections afresh. */
  attempt: number;
  /** The collection being read: "" for the whole library. */
  reading: string | null;
};

type PickerAction =
  | { type: "listed"; library: ZoteroLibrary }
  | { type: "chose"; dir: string }
  | { type: "failed"; error: string }
  | { type: "retry" }
  | { type: "read"; collection: string };

function pickerReducer(state: PickerState, action: PickerAction): PickerState {
  switch (action.type) {
    case "listed": return { ...state, collections: action.library.collections, dataDir: action.library.dataDir, error: null };
    case "chose": return { ...state, chosenDir: action.dir, collections: null, error: null, attempt: state.attempt + 1 };
    case "failed": return { ...state, error: action.error, reading: null };
    case "retry": return { ...state, collections: null, error: null, attempt: state.attempt + 1 };
    case "read": return { ...state, reading: action.collection, error: null };
  }
}

export function ZoteroCollections(props: { onPick: (items: ZoteroItem[]) => void }) {
  const { t } = useLingui();
  const [{ collections, chosenDir, dataDir, error, attempt, reading }, dispatch] = useReducer(pickerReducer, {
    collections: null, chosenDir: null, dataDir: null, error: null, attempt: 0, reading: null,
  });

  useEffect(() => {
    let current = true;
    invoke<ZoteroLibrary>("zotero_library", { dataDir: chosenDir }).then(
      (library) => { if (current) dispatch({ type: "listed", library }); },
      (reason: unknown) => { if (current) dispatch({ type: "failed", error: hostErrorMessage(reason) }); },
    );
    return () => { current = false; };
  }, [attempt, chosenDir]);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const read = (collection: string) => {
    if (reading !== null) return;
    dispatch({ type: "read", collection });
    invoke<ZoteroItem[]>("zotero_items", { dataDir, collection: collection || null }).then(
      (items) => { if (mounted.current) props.onPick(items); },
      (reason: unknown) => { if (mounted.current) dispatch({ type: "failed", error: hostErrorMessage(reason) }); },
    );
  };

  const chooseFolder = async () => {
    const dir = await openDialog({ directory: true, title: t`Choose Zotero folder…` }).catch(() => null);
    if (typeof dir === "string" && mounted.current) dispatch({ type: "chose", dir });
  };

  const row = (key: string, name: string, items: number | null, depth: number, icon: ReactNode) => (
    <li key={key || "library"}>
      <button
        type="button"
        className="zotero-collection"
        style={{ "--zotero-depth": depth } as CSSProperties}
        disabled={reading !== null}
        aria-busy={reading === key || undefined}
        onClick={() => read(key)}
      >
        {icon}
        <span className="zotero-collection-name" title={name}>{name}</span>
        {reading === key
          ? <InfinityLoader size={12} />
          : items !== null && <span className="zotero-collection-count">{items.toLocaleString()}</span>}
      </button>
    </li>
  );

  return (
    <div className="zotero-collections">
      <span className="add-papers-section">{t`Zotero collections`}</span>
      {error && (
        <div className="zotero-error" role="alert">
          <span>{error}</span>
          {!collections && (
            <span className="zotero-error-actions">
              <Button variant="secondary" size="compact" onClick={() => dispatch({ type: "retry" })}>{t`Try again`}</Button>
              <Button variant="secondary" size="compact" onClick={() => void chooseFolder()}>{t`Choose Zotero folder…`}</Button>
            </span>
          )}
        </div>
      )}
      {!collections && !error && <div className="zotero-loading"><InfinityLoader size={16} /></div>}
      {collections && (
        <ol className="add-papers-rows zotero-collection-list" aria-label={t`Zotero collections`}>
          {row("", t`My Library`, null, 0, <Library size={14} aria-hidden="true" />)}
          {collectionTree(collections).map((collection) =>
            row(collection.key, collection.name, collection.items, collection.depth + 1, <Folder size={14} aria-hidden="true" />))}
        </ol>
      )}
    </div>
  );
}
