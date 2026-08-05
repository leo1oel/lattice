import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import {
  atom,
  createPresenceStateDerivation,
  createTLSchemaFromUtils,
  createTLStore,
  defaultBindingUtils,
  defaultShapeUtils,
  parseTldrawJsonFile,
  react,
  type TLInstancePresence,
  type TLRecord,
  type TLSchema,
  type TLStore,
  type TLUser,
  type TLUserId,
} from "tldraw";

/**
 * Board files share the text-file sync pipeline: the server only ever sees a
 * Y.Doc, so a board doc keeps two structures —
 *   - "content" (Y.Text): the raw .tldr bytes written at import time. The
 *     server cannot parse tldraw JSON, so this is the only state a fresh
 *     import has. It is a historical artifact once records are seeded.
 *   - "records" (Y.Map<TLRecord>): the live editing structure. This is the
 *     authoritative state for open boards.
 *
 * There is deliberately NO live records→content mirror: machine-generated
 * full-document patches from multiple peers into a shared Y.Text can corrupt
 * under concurrent same-record edits. Instead readers call boardDocContent,
 * which serializes records on demand and falls back to the imported text.
 */
export const BOARD_CONTENT_KEY = "content";
export const BOARD_RECORDS_KEY = "records";

/** Transaction origin for local store edits pushed into the Y.Doc. */
export const BOARD_LOCAL_ORIGIN = "tldraw-local";
/** Transaction origin for the one-time seed from imported content. */
export const BOARD_SEED_ORIGIN = "tldraw-seed";

const TLDRAW_FILE_FORMAT_VERSION = 1;

let cachedSchema: TLSchema | null = null;

export function getBoardSchema(): TLSchema {
  if (!cachedSchema) {
    cachedSchema = createTLSchemaFromUtils({
      shapeUtils: [...defaultShapeUtils],
      bindingUtils: [...defaultBindingUtils],
    }) as TLSchema;
  }
  return cachedSchema;
}

/** Records in tldraw's "document" scope — everything that belongs in a .tldr file. */
const DOCUMENT_TYPE_NAMES = new Set(["asset", "binding", "document", "page", "shape"]);

export function isBoardDocumentRecord(record: TLRecord): boolean {
  return DOCUMENT_TYPE_NAMES.has(record.typeName);
}

/** Drop asset records no shape references (mirrors tldraw's own save behavior). */
export function pruneUnusedAssets(records: TLRecord[]): TLRecord[] {
  const used = new Set<string>();
  for (const record of records) {
    if (record.typeName === "shape" && "assetId" in record.props && record.props.assetId) {
      used.add(record.props.assetId as string);
    }
  }
  return records.filter((record) => record.typeName !== "asset" || used.has(record.id));
}

/**
 * Headless .tldr serialization (serializeTldrawJson needs an Editor). Unlike
 * tldraw's save path we keep asset srcs as-is — base64 inlining would breach
 * the sync doc size limits; assets belong to the binary pipeline.
 */
export function serializeBoard(records: TLRecord[], schema: TLSchema = getBoardSchema()): string {
  const documentRecords = pruneUnusedAssets(records.filter(isBoardDocumentRecord));
  // Sort by id so repeated serializations of equal state are byte-identical.
  documentRecords.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify({
    tldrawFileFormatVersion: TLDRAW_FILE_FORMAT_VERSION,
    schema: schema.serialize(),
    records: documentRecords,
  });
}

/** Parse .tldr JSON into migrated document records; null when invalid/empty. */
export function parseBoardRecords(json: string, schema: TLSchema = getBoardSchema()): TLRecord[] | null {
  const trimmed = json.trim();
  if (!trimmed) return null;
  const result = parseTldrawJsonFile({ json: trimmed, schema });
  if (!result.ok) return null;
  return result.value.allRecords().filter(isBoardDocumentRecord);
}

/**
 * One-time promotion of imported content into the live records map. Idempotent:
 * once any records exist (including via a concurrent peer's seed converging
 * through Y.Map keys), this is a no-op.
 */
export function seedBoardRecords(doc: Y.Doc, schema: TLSchema = getBoardSchema()): boolean {
  const yRecords = doc.getMap<TLRecord>(BOARD_RECORDS_KEY);
  if (yRecords.size > 0) return false;
  const records = parseBoardRecords(doc.getText(BOARD_CONTENT_KEY).toString(), schema);
  if (!records || records.length === 0) return false;
  doc.transact(() => {
    for (const record of records) yRecords.set(record.id, record);
  }, BOARD_SEED_ORIGIN);
  return true;
}

/** The .tldr text a reader (disk materialization, export) should persist. */
export function boardDocContent(doc: Y.Doc, schema: TLSchema = getBoardSchema()): string {
  const yRecords = doc.getMap<TLRecord>(BOARD_RECORDS_KEY);
  if (yRecords.size === 0) return doc.getText(BOARD_CONTENT_KEY).toString();
  const records: TLRecord[] = [];
  yRecords.forEach((record) => records.push(record));
  return serializeBoard(records, schema);
}

export type BoardBridge = {
  dispose(): void;
};

/**
 * Two-way binding between a tldraw store and a board Y.Doc. Ephemeral records
 * (camera, instance, presence) never leave the local store; remote edits enter
 * through mergeRemoteChanges so they stay out of the editor's undo history.
 */
export function attachBoardBridge(
  store: TLStore,
  doc: Y.Doc,
  options: { schema?: TLSchema } = {},
): BoardBridge {
  const schema = options.schema ?? getBoardSchema();
  const yRecords = doc.getMap<TLRecord>(BOARD_RECORDS_KEY);

  seedBoardRecords(doc, schema);

  // Pull the doc's record set into the store (remote-authoritative on attach).
  store.mergeRemoteChanges(() => {
    const incoming = new Map<string, TLRecord>();
    yRecords.forEach((record, id) => incoming.set(id, record));
    const toPut: TLRecord[] = [];
    const toRemove: TLRecord["id"][] = [];
    for (const record of store.allRecords()) {
      if (!isBoardDocumentRecord(record)) continue;
      const next = incoming.get(record.id);
      if (next === undefined) toRemove.push(record.id);
      else if (next !== record) toPut.push(next);
      incoming.delete(record.id);
    }
    for (const record of incoming.values()) toPut.push(record);
    if (toPut.length) store.put(toPut);
    if (toRemove.length) store.remove(toRemove);
  });

  // Local edits → Y.Doc. The scope filter keeps ephemeral records local.
  const unlisten = store.listen((entry) => {
    doc.transact(() => {
      for (const record of Object.values(entry.changes.added)) yRecords.set(record.id, record);
      for (const [, record] of Object.values(entry.changes.updated)) yRecords.set(record.id, record);
      for (const record of Object.values(entry.changes.removed)) yRecords.delete(record.id);
    }, BOARD_LOCAL_ORIGIN);
  }, { source: "user", scope: "document" });

  // Y.Doc → store (remote peers and the seed). Unknown records from newer
  // clients are skipped rather than crashing the editor (fail-closed).
  const observer = (event: Y.YMapEvent<TLRecord>, txn: Y.Transaction) => {
    if (txn.origin === BOARD_LOCAL_ORIGIN) return;
    store.mergeRemoteChanges(() => {
      for (const [id, change] of event.changes.keys) {
        try {
          if (change.action === "delete") store.remove([id as TLRecord["id"]]);
          else {
            const record = yRecords.get(id);
            if (record) store.put([record]);
          }
        } catch {
          // Record failed schema validation (e.g. from a newer app version) — skip it.
        }
      }
    });
  };
  yRecords.observe(observer);

  return {
    dispose() {
      yRecords.unobserve(observer);
      unlisten();
    },
  };
}

/** Create a standalone store preloaded from .tldr text (local editing, no Yjs). */
export function createBoardStore(json: string, schema: TLSchema = getBoardSchema()): TLStore {
  if (json.trim()) {
    const result = parseTldrawJsonFile({ json: json.trim(), schema });
    if (result.ok) return result.value;
  }
  return createTLStore({
    shapeUtils: [...defaultShapeUtils],
    bindingUtils: [...defaultBindingUtils],
  });
}

export type BoardPresenceUser = { id: string; name: string; color: string };

const BOARD_PRESENCE_FIELD = "boardPresence";
/** Awareness is shared with text carets; stay under MAX_AWARENESS_PER_MINUTE. */
const BOARD_PRESENCE_THROTTLE_MS = 100;

/**
 * Two-way binding between a tldraw store's presence scope and a y-protocols
 * Awareness channel. Presence never enters the Y.Doc — it is transient by
 * design. The local cursor/selection is derived from the store (throttled);
 * remote peers' presence records live in the store's presence scope, which is
 * what the editor renders as collaborator cursors.
 */
export function attachBoardPresence(
  store: TLStore,
  awareness: Awareness,
  user: BoardPresenceUser,
  options: { throttleMs?: number } = {},
): () => void {
  const throttleMs = options.throttleMs ?? BOARD_PRESENCE_THROTTLE_MS;
  const userId = (user.id.startsWith("user:") ? user.id : `user:${user.id}`) as TLUserId;
  const $user = atom<TLUser | null>("board-presence-user", {
    id: userId,
    typeName: "user",
    name: user.name,
    color: user.color,
    imageUrl: "",
    meta: {},
  } as TLUser);
  const derive = createPresenceStateDerivation($user)(store);

  let lastPublished: TLInstancePresence | null = null;
  let pending: TLInstancePresence | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const publishNow = () => {
    timer = null;
    if (pending === lastPublished) return;
    lastPublished = pending;
    awareness.setLocalStateField(BOARD_PRESENCE_FIELD, pending);
  };
  const stopReact = react("board-presence-publish", () => {
    pending = derive.get();
    // Nulls (e.g. page state missing) publish immediately so peers don't keep
    // a stale cursor; cursor moves are trailing-throttled.
    if (pending === null || throttleMs <= 0) publishNow();
    else if (timer == null) timer = setTimeout(publishNow, throttleMs);
  });

  // Remote peers → presence-scope records. Presence records from other
  // clients are authoritative per clientID and reclaimed on leave/timeout.
  const remotePresenceIds = new Map<number, TLInstancePresence["id"]>();
  const applyRemote = () => {
    const states = awareness.getStates();
    store.mergeRemoteChanges(() => {
      for (const [clientId, state] of states) {
        if (clientId === awareness.clientID) continue;
        const record = (state as Record<string, unknown>)[BOARD_PRESENCE_FIELD] as TLInstancePresence | null | undefined;
        if (record) {
          remotePresenceIds.set(clientId, record.id);
          try {
            store.put([record]);
          } catch {
            // Presence from a newer app version failing validation — skip it.
          }
        } else {
          const id = remotePresenceIds.get(clientId);
          if (id !== undefined) {
            remotePresenceIds.delete(clientId);
            store.remove([id]);
          }
        }
      }
      for (const [clientId, id] of [...remotePresenceIds]) {
        if (!states.has(clientId)) {
          remotePresenceIds.delete(clientId);
          store.remove([id]);
        }
      }
    });
  };
  awareness.on("change", applyRemote);
  applyRemote();

  return () => {
    stopReact();
    if (timer != null) clearTimeout(timer);
    awareness.off("change", applyRemote);
    awareness.setLocalStateField(BOARD_PRESENCE_FIELD, null);
    const ids = [...remotePresenceIds.values()];
    remotePresenceIds.clear();
    if (ids.length) store.mergeRemoteChanges(() => store.remove(ids));
  };
}
