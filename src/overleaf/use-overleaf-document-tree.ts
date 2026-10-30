/**
 * The live channel's view of the project tree: which document id each path
 * is, every entity's id for the endpoints that take one, and the paths the
 * channel owns, which ordinary syncing must leave alone.
 */
import { useCallback, useRef, useState, type RefObject } from "react";
import type { OtDocument } from "./ot";
import type { DocEntry, EntityEntry } from "./overleaf-realtime-model";

/** `documents` is every document the connection holds, by id. */
export function useOverleafDocumentTree(documents: RefObject<Map<string, OtDocument>>) {
  // State, not a ref: the tree can arrive from the connect call or from an
  // event, and either way the effect that joins the open document has to run
  // again once it does.
  const [docs, setDocs] = useState<Map<string, string>>(new Map());
  const [entities, setEntities] = useState<Map<string, { id: string; kind: string }>>(new Map());
  const [livePaths, setLivePaths] = useState<string[]>([]);
  /** Current reverse lookup, so draining documents keep their project paths. */
  const pathsByDocId = useRef<Map<string, string>>(new Map());

  /** Publish the complete set of paths that ordinary syncing must not own. */
  const publishLivePaths = useCallback(() => {
    const next = [...new Set(
      [...documents.current.keys()]
        .map((id) => pathsByDocId.current.get(id))
        .filter((path): path is string => Boolean(path)),
    )].sort();
    setLivePaths((current) => (
      current.length === next.length && current.every((path, index) => path === next[index]) ? current : next
    ));
  }, [documents]);

  /** Replace both directions of the live document tree without dropping held ids. */
  const noteDocumentTree = useCallback((entries: DocEntry[], entityEntries?: EntityEntry[]) => {
    setDocs(new Map(entries.map((doc) => [doc.path, doc.id])));
    setEntities(new Map((entityEntries ?? []).map((entity) => [entity.path, { id: entity.id, kind: entity.kind }])));
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
  }, [documents, publishLivePaths]);

  return { docs, entities, livePaths, pathsByDocId, publishLivePaths, noteDocumentTree };
}
