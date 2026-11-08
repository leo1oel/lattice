/**
 * Choosing a Zotero collection in the Add papers sheet. The desktop app's
 * local API answers (src-tauri/src/zotero.rs); the chosen collection comes
 * back as BibTeX, one entry per item under the key the writer cites it by,
 * which the sheet reads like a pasted .bib, so what Papers already holds is
 * skipped as usual.
 */
import { useEffect, useReducer, type CSSProperties, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { Folder, Library } from "lucide-react";
import { Button } from "../components/ui/button";
import { InfinityLoader } from "../components/ui/activity-icons";
import { hostErrorMessage } from "../app-utils";
import { collectionTree, type ZoteroCollection, type ZoteroItem } from "./zotero";

/** zotero.rs's NOT_RUNNING and API_DISABLED. */
const NOT_RUNNING = "zotero-not-running";
const API_DISABLED = "zotero-local-api-disabled";

type PickerState = {
  collections: ZoteroCollection[] | null;
  error: string | null;
  /** Bumped by Try again, which lists the collections afresh. */
  attempt: number;
  /** The collection being read: "" for the whole library. */
  reading: string | null;
};

type PickerAction =
  | { type: "listed"; collections: ZoteroCollection[] }
  | { type: "failed"; error: string }
  | { type: "retry" }
  | { type: "read"; collection: string };

function pickerReducer(state: PickerState, action: PickerAction): PickerState {
  switch (action.type) {
    case "listed": return { ...state, collections: action.collections, error: null };
    case "failed": return { ...state, error: action.error, reading: null };
    case "retry": return { ...state, collections: null, error: null, attempt: state.attempt + 1 };
    case "read": return { ...state, reading: action.collection, error: null };
  }
}

export function ZoteroCollections(props: { onPick: (items: ZoteroItem[]) => void }) {
  const { t } = useLingui();
  const [{ collections, error, attempt, reading }, dispatch] = useReducer(pickerReducer, {
    collections: null, error: null, attempt: 0, reading: null,
  });

  useEffect(() => {
    let current = true;
    invoke<ZoteroCollection[]>("zotero_collections").then(
      (listed) => { if (current) dispatch({ type: "listed", collections: listed }); },
      (reason: unknown) => { if (current) dispatch({ type: "failed", error: hostErrorMessage(reason) }); },
    );
    return () => { current = false; };
  }, [attempt]);

  const read = (collection: string) => {
    if (reading !== null) return;
    dispatch({ type: "read", collection });
    invoke<ZoteroItem[]>("zotero_items", { collection: collection || null }).then(
      (items) => props.onPick(items),
      (reason: unknown) => dispatch({ type: "failed", error: hostErrorMessage(reason) }),
    );
  };

  const errorText = error === NOT_RUNNING
    ? t`Zotero isn't running. Open Zotero, then try again.`
    : error === API_DISABLED
      ? t`In Zotero, turn on Settings › Advanced › “Allow other applications on this computer to communicate with Zotero”.`
      : error;

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
      {errorText && (
        <div className="zotero-error" role="alert">
          <span>{errorText}</span>
          {!collections && <Button variant="secondary" size="compact" onClick={() => dispatch({ type: "retry" })}>{t`Try again`}</Button>}
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
