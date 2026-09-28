/**
 * Mirrors the live shared documents of a v2 project onto its materialized
 * workspace on disk. Yjs sync keeps each file's Y.Doc current; an observer per
 * text-family file writes the converged state back, debounced and
 * single-flight, so peers' edits land in the local project.
 */
import type * as Y from "yjs";
import type { CatalogFileV2 } from "../../protocol/collab-v2";
import { EDITOR_COMMENTS_PATH } from "../editor/comments/editor-comment-data";
import { isPaperLibraryPath } from "../papers/paper-link";
import type { CollabMaterializeCallbacksV2, CollabMaterializeLeaseV2 } from "./collab-project-v2";

/**
 * A text-family file in its on-disk form. Boards, spreadsheets and the editor
 * comments document keep their live state in structured Y types beside the
 * "content" text (which only ever held the import), so they serialize the
 * converged Y.Doc instead. Those serializers load lazily to keep editor
 * dependencies out of startup.
 */
export async function serializeCollabFileV2(file: Pick<CatalogFileV2, "kind" | "path">, doc: Y.Doc): Promise<string> {
  if (file.kind === "board") return (await import("../editor/board/board-yjs-bridge")).boardDocContent(doc);
  if (file.kind === "spreadsheet") return (await import("../editor/spreadsheet/spreadsheet-yjs")).spreadsheetDocContent(doc);
  if (file.path === EDITOR_COMMENTS_PATH) return (await import("./collab-comments")).collabCommentsContent(doc);
  return doc.getText("content").toString();
}

/** What the mirror needs from its controller: the catalog, per-file write ordering, and the workspace lease. */
export type DiskMirrorHostV2 = {
  fileById(fileId: string): CatalogFileV2 | undefined;
  enqueueFile<T>(fileId: string, mutation: () => Promise<T>): Promise<T>;
  checkLease(lease: CollabMaterializeLeaseV2): void;
  report(error: unknown, fileId: string): void;
};

type Observer = { flush(): Promise<void>; detach(): void };

export class CollabDiskMirrorV2 {
  private readonly observers = new Map<string, Observer>();
  /** Writes still running, including those whose observer was detached mid-write. */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly host: DiskMirrorHostV2) {}

  /** Start mirroring a synced file; a no-op while one is already attached. */
  attach(file: CatalogFileV2, doc: Y.Doc, lease: CollabMaterializeLeaseV2, callbacks: CollabMaterializeCallbacksV2): void {
    if (this.observers.has(file.fileId) || isPaperLibraryPath(file.path)) return;
    const { fileId, documentEpoch } = file;
    const write = async () => {
      if (!lease.isCurrent()) return;
      await this.host.enqueueFile(fileId, async () => {
        this.host.checkLease(lease);
        const current = this.host.fileById(fileId);
        if (!current || current.state !== "live" || current.documentEpoch !== documentEpoch) return this.detach(fileId);
        await callbacks.writeText(current.path, await serializeCollabFileV2(current, doc), lease.projectRoot);
        this.host.checkLease(lease);
      });
    };
    // Structured documents change outside the content text, and a local edit
    // to them must reach disk too, so they watch every doc update. Plain text
    // only needs remote edits: local ones were written by the editor itself.
    const structured = file.kind === "board" || file.kind === "spreadsheet" || file.path === EDITOR_COMMENTS_PATH;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: Promise<void> | undefined;
    let dirty = false;
    const start = () => {
      if (pending) { dirty = true; return; }
      dirty = false;
      const tracked: Promise<void> = write().catch((error) => this.host.report(error, fileId)).finally(() => {
        this.inFlight.delete(tracked);
        pending = undefined;
        if (dirty) schedule();
      });
      pending = tracked;
      this.inFlight.add(tracked);
    };
    // Coalesce bursts into one latest-state write.
    const schedule = () => {
      dirty = true;
      clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; start(); }, structured ? 250 : 100);
    };
    let unobserve: () => void;
    if (structured) {
      doc.on("update", schedule);
      unobserve = () => doc.off("update", schedule);
    } else {
      const text = doc.getText("content");
      const observer = (_event: Y.YTextEvent, transaction: Y.Transaction) => { if (!transaction.local) schedule(); };
      text.observe(observer);
      unobserve = () => text.unobserve(observer);
    }
    // Initial sync completed before this observer existed: persist the
    // already-converged state even if no later update wakes it.
    schedule();
    this.observers.set(fileId, {
      flush: async () => {
        while (timer !== undefined || pending || dirty) {
          if (timer !== undefined || !pending) { clearTimeout(timer); timer = undefined; start(); }
          await pending;
        }
      },
      detach: () => {
        unobserve();
        clearTimeout(timer);
        timer = undefined;
        dirty = false;
      },
    });
  }

  detach(fileId: string): void {
    this.observers.get(fileId)?.detach();
    this.observers.delete(fileId);
  }

  /** Detach every observer whose file `keep` no longer vouches for. */
  retain(keep: (fileId: string) => boolean): void {
    for (const fileId of [...this.observers.keys()]) if (!keep(fileId)) this.detach(fileId);
  }

  /** Settle every scheduled and running write, including writes those writes schedule. */
  async flush(): Promise<void> {
    for (;;) {
      const observers = [...this.observers.values()];
      await Promise.all(observers.map((observer) => observer.flush()));
      await Promise.all([...this.inFlight]);
      if (this.inFlight.size === 0 && [...this.observers.values()].every((observer) => observers.includes(observer))) return;
    }
  }

  detachAll(): void {
    for (const fileId of [...this.observers.keys()]) this.detach(fileId);
  }
}
