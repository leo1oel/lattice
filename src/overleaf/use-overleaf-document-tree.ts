/**
 * The live channel's view of the project tree: which document id each path
 * is, every entity's id for the endpoints that take one, and the paths the
 * channel owns, which ordinary syncing must leave alone.
 */
import { useCallback, useRef, type RefObject } from "react";
import { useStoreSlice } from "../hooks/use-store-slice";
import type { OtDocument } from "./ot";
import type { OverleafConnectionState, OverleafConnectionStore } from "./overleaf-connection-store";
import type { DocEntry, EntityEntry } from "./overleaf-realtime-model";

/** `documents` is every document the connection holds, by id; the tree itself lives in `store`. */
export function useOverleafDocumentTree(documents: RefObject<Map<string, OtDocument>>, store: OverleafConnectionStore) {
  // Subscribed, not read: the tree can arrive from the connect call or from an
  // event, and either way the effect that joins the open document has to run
  // again once it does.
  const { docs, entities, livePaths } = useStoreSlice(store, treeFields);
  /** Current reverse lookup, so draining documents keep their project paths. */
  const pathsByDocId = useRef<Map<string, string>>(new Map());

  /** Publish the complete set of paths that ordinary syncing must not own. */
  const publishLivePaths = useCallback(() => {
    store.getState().publishLivePaths([...new Set(
      [...documents.current.keys()]
        .map((id) => pathsByDocId.current.get(id))
        .filter((path): path is string => Boolean(path)),
    )].sort());
  }, [documents, store]);

  /** Replace both directions of the live document tree without dropping held ids. */
  const noteDocumentTree = useCallback((entries: DocEntry[], entityEntries?: EntityEntry[]) => {
    store.getState().showDocumentTree(entries, entityEntries);
    const previous = pathsByDocId.current;
    const next = new Map(entries.map((doc) => [doc.id, doc.path]));
    // A tree event can remove a document while its final operation is still
    // awaiting an answer. Keep that id's last path so REST cannot take it over.
    // If the same id was renamed, `next` already contains the new path and wins.
    for (const id of documents.current.keys()) {
      const lastPath = previous.get(id);
      if (!next.has(id) && lastPath) next.set(id, lastPath);
    }
    pathsByDocId.current = next;
    publishLivePaths();
  }, [documents, publishLivePaths, store]);

  return { docs, entities, livePaths, pathsByDocId, publishLivePaths, noteDocumentTree };
}

const treeFields = ({ docs, entities, livePaths }: OverleafConnectionState) => ({ docs, entities, livePaths });
