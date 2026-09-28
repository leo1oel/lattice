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
 *
 * Edits to an existing record are stored as field-level patches keyed by
 * `recordId|generation|path`, so concurrent edits to independent fields of one
 * shape compose. A record's generation changes whenever it is (re)created, so
 * patches from an older incarnation are never applied to a new one.
 */
export const BOARD_CONTENT_KEY = "content";
export const BOARD_RECORDS_KEY = "records";
export const BOARD_RECORD_PATCHES_KEY = "recordPatches";
export const BOARD_RECORD_GENERATIONS_KEY = "recordGenerations";
const BOARD_META_KEY = "boardMeta";

/** Transaction origin for local store edits pushed into the Y.Doc. */
const BOARD_LOCAL_ORIGIN = "tldraw-local";
/** Transaction origin for the one-time seed from imported content. */
const BOARD_SEED_ORIGIN = "tldraw-seed";

const TLDRAW_FILE_FORMAT_VERSION = 1;
const BOARD_BRIDGE_FORMAT_VERSION = 1;
const PATCH_KEY_SEPARATOR = "|";
const LEGACY_RECORD_GENERATION = "legacy";
const DELETED_FIELD = { __latticeDeletedBoardField: true } as const;

type BoardMaps = {
  records: Y.Map<TLRecord>;
  generations: Y.Map<string>;
  patches: Y.Map<unknown>;
  meta: Y.Map<unknown>;
};

function boardMaps(doc: Y.Doc): BoardMaps {
  return {
    records: doc.getMap<TLRecord>(BOARD_RECORDS_KEY),
    generations: doc.getMap<string>(BOARD_RECORD_GENERATIONS_KEY),
    patches: doc.getMap<unknown>(BOARD_RECORD_PATCHES_KEY),
    meta: doc.getMap<unknown>(BOARD_META_KEY),
  };
}

const generationOf = (maps: BoardMaps, id: string) => maps.generations.get(id) ?? LEGACY_RECORD_GENERATION;

function stampBoardMeta(meta: Y.Map<unknown>, schema: TLSchema): void {
  meta.set("formatVersion", BOARD_BRIDGE_FORMAT_VERSION);
  meta.set("initialized", true);
  meta.set("schema", schema.serialize());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array);
}

function flattenRecord(value: unknown, path: string[] = [], output = new Map<string, unknown>()): Map<string, unknown> {
  if (isPlainObject(value) && Object.keys(value).length > 0) {
    for (const [key, child] of Object.entries(value)) flattenRecord(child, [...path, key], output);
  } else {
    output.set(path.map(encodeURIComponent).join("/"), value);
  }
  return output;
}

function recordPatchPrefix(recordId: string, generation: string): string {
  return `${encodeURIComponent(recordId)}${PATCH_KEY_SEPARATOR}${encodeURIComponent(generation)}${PATCH_KEY_SEPARATOR}`;
}

function patchRecordId(key: string): string | undefined {
  const separator = key.indexOf(PATCH_KEY_SEPARATOR);
  if (separator < 0) return undefined;
  try { return decodeURIComponent(key.slice(0, separator)); } catch { return undefined; }
}

function setRecordPath(record: Record<string, unknown>, encodedPath: string, value: unknown): void {
  const path = encodedPath.split("/").map(decodeURIComponent);
  if (path.some((segment) => segment === "__proto__" || segment === "prototype" || segment === "constructor")) {
    throw new Error("Unsafe collaborative board record path");
  }
  const key = path.pop()!;
  let parent = record;
  for (const segment of path) {
    if (!isPlainObject(parent[segment])) parent[segment] = {};
    parent = parent[segment] as Record<string, unknown>;
  }
  if (isPlainObject(value) && value.__latticeDeletedBoardField === true) delete parent[key];
  else parent[key] = value;
}

function recordWithPatches(maps: BoardMaps, id: string, record: TLRecord): TLRecord {
  const next = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
  const prefix = recordPatchPrefix(id, generationOf(maps, id));
  const applicable: Array<[string, unknown]> = [];
  maps.patches.forEach((value, key) => {
    if (key.startsWith(prefix)) applicable.push([key.slice(prefix.length), value]);
  });
  // Overlapping paths can survive when peers concurrently replace a subtree
  // with a scalar and edit one of its children. Apply shallow paths last so
  // the subtree replacement wins deterministically on every peer.
  applicable.sort(([a], [b]) => b.split("/").length - a.split("/").length || a.localeCompare(b));
  for (const [path, value] of applicable) setRecordPath(next, path, value);
  return next as unknown as TLRecord;
}

/** Delete this incarnation's patches, or only those overlapping `path` when given. */
function clearRecordPatches(maps: BoardMaps, recordId: string, path?: string): void {
  const prefix = recordPatchPrefix(recordId, generationOf(maps, recordId));
  for (const key of maps.patches.keys()) {
    if (!key.startsWith(prefix)) continue;
    const existing = key.slice(prefix.length);
    if (path === undefined || existing === path || existing.startsWith(`${path}/`) || path.startsWith(`${existing}/`)) {
      maps.patches.delete(key);
    }
  }
}

function writeRecordPatches(maps: BoardMaps, before: TLRecord, after: TLRecord): void {
  const prefix = recordPatchPrefix(after.id, generationOf(maps, after.id));
  const writePatch = (path: string, value: unknown) => {
    clearRecordPatches(maps, after.id, path);
    maps.patches.set(prefix + path, value);
  };
  const previous = flattenRecord(before);
  const next = flattenRecord(after);
  for (const [path, value] of next) {
    if (JSON.stringify(previous.get(path)) !== JSON.stringify(value)) writePatch(path, value);
  }
  for (const path of previous.keys()) {
    if (next.has(path)) continue;
    // A scalar/empty-object path can become descendants (or vice versa). The
    // surviving related path already replaces that subtree, so a tombstone
    // would make application order matter and could erase the new value.
    const replacedAsSubtree = [...next.keys()].some((candidate) =>
      candidate.startsWith(`${path}/`) || path.startsWith(`${candidate}/`));
    if (!replacedAsSubtree) writePatch(path, DELETED_FIELD);
  }
}

/** (Re)create a record under a fresh generation, dropping any older incarnation's patches. */
function addRecord(maps: BoardMaps, record: TLRecord): void {
  clearRecordPatches(maps, record.id);
  maps.generations.set(record.id, crypto.randomUUID());
  maps.records.set(record.id, record);
}

function forgetRecord(maps: BoardMaps, id: string): void {
  maps.records.delete(id);
  clearRecordPatches(maps, id);
  maps.generations.delete(id);
}

const createEmptyStore = () => createTLStore({
  shapeUtils: [...defaultShapeUtils],
  bindingUtils: [...defaultBindingUtils],
});

let cachedSchema: TLSchema | null = null;

function getBoardSchema(): TLSchema {
  cachedSchema ??= createTLSchemaFromUtils({
    shapeUtils: [...defaultShapeUtils],
    bindingUtils: [...defaultBindingUtils],
  }) as TLSchema;
  return cachedSchema;
}

/** Records in tldraw's "document" scope — everything that belongs in a .tldr file. */
const DOCUMENT_TYPE_NAMES = new Set(["asset", "binding", "document", "page", "shape"]);
const isBoardDocumentRecord = (record: TLRecord) => DOCUMENT_TYPE_NAMES.has(record.typeName);

/** A store loaded from .tldr text (migrated to `schema`); null when invalid or empty. */
function parseBoardStore(json: string, schema: TLSchema): TLStore | null {
  const trimmed = json.trim();
  if (!trimmed) return null;
  const result = parseTldrawJsonFile({ json: trimmed, schema });
  return result.ok ? result.value : null;
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
  // Validate before claiming that these records conform to the current schema.
  // Shared rooms may contain malformed or newer-client data that must not be
  // materialized into a deceptively valid-looking .tldr file.
  createEmptyStore().put(documentRecords);
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
  return parseBoardStore(json, schema)?.allRecords().filter(isBoardDocumentRecord) ?? null;
}

/**
 * One-time promotion of imported content into the live records map. Idempotent:
 * once any records exist (including via a concurrent peer's seed converging
 * through Y.Map keys), this is a no-op.
 */
export function seedBoardRecords(doc: Y.Doc, schema: TLSchema = getBoardSchema()): boolean {
  const maps = boardMaps(doc);
  if (maps.records.size > 0) return false;
  const records = parseBoardRecords(doc.getText(BOARD_CONTENT_KEY).toString(), schema);
  if (!records?.length) return false;
  doc.transact(() => {
    for (const record of records) maps.records.set(record.id, record);
    stampBoardMeta(maps.meta, schema);
  }, BOARD_SEED_ORIGIN);
  return true;
}

/** The .tldr text a reader (disk materialization, export) should persist. */
export function boardDocContent(doc: Y.Doc, schema: TLSchema = getBoardSchema()): string {
  if (boardMaps(doc).records.size === 0) return doc.getText(BOARD_CONTENT_KEY).toString();
  const records = migratedBoardRecords(doc, schema);
  if (!records) throw new Error("The collaborative board schema cannot be read by this tldraw version");
  return serializeBoard(records, schema);
}

/** Reconcile an external .tldr snapshot through the same field-level CRDT patches as the editor. */
export function replaceBoardDocFromSource(doc: Y.Doc, source: string, schema: TLSchema = getBoardSchema()): void {
  const incoming = parseBoardRecords(source, schema);
  if (!incoming) throw new Error("Invalid .tldr document");
  const maps = boardMaps(doc);
  const next = new Map<string, TLRecord>(incoming.map((record) => [record.id, record]));
  doc.transact(() => {
    for (const [id, current] of maps.records) {
      const replacement = next.get(id);
      next.delete(id);
      if (replacement) writeRecordPatches(maps, current, replacement);
      else forgetRecord(maps, id);
    }
    for (const record of next.values()) addRecord(maps, record);
    stampBoardMeta(maps.meta, schema);
  }, BOARD_LOCAL_ORIGIN);
}

function migratedBoardRecords(doc: Y.Doc, schema: TLSchema): TLRecord[] | null {
  const maps = boardMaps(doc);
  const records = [...maps.records].map(([id, record]) => recordWithPatches(maps, id, record));
  const version = maps.meta.get("formatVersion");
  if (version !== undefined && version !== BOARD_BRIDGE_FORMAT_VERSION) return null;
  const storedSchema = boardStoredSchema(doc);
  if (!isPlainObject(storedSchema)) return records;
  return parseBoardRecords(JSON.stringify({
    tldrawFileFormatVersion: TLDRAW_FILE_FORMAT_VERSION,
    schema: storedSchema,
    records,
  }), schema);
}

function boardStoredSchema(doc: Y.Doc): unknown {
  const metadataSchema = boardMaps(doc).meta.get("schema");
  if (isPlainObject(metadataSchema)) return metadataSchema;
  try { return (JSON.parse(doc.getText(BOARD_CONTENT_KEY).toString()) as { schema?: unknown }).schema; }
  catch { return undefined; }
}

/**
 * Make `records` the store's whole document scope as a remote change, leaving
 * ephemeral records (camera, instance, presence) alone.
 */
function replaceDocumentRecords(store: TLStore, records: TLRecord[]): void {
  const incoming = new Set(records.map((record) => record.id));
  store.mergeRemoteChanges(() => {
    const changed = records.filter((record) => store.get(record.id) !== record);
    const stale = store.allRecords()
      .filter((record) => isBoardDocumentRecord(record) && !incoming.has(record.id))
      .map((record) => record.id);
    if (changed.length) store.put(changed);
    if (stale.length) store.remove(stale);
  });
}

/**
 * Replace a store's document records from external .tldr text (v1 text sync,
 * disk reload, git pull). Returns false on invalid input.
 */
export function mergeExternalBoardSource(store: TLStore, source: string): boolean {
  const records = parseBoardRecords(source);
  if (records) replaceDocumentRecords(store, records);
  return records !== null;
}

/**
 * Two-way binding between a tldraw store and a board Y.Doc. Ephemeral records
 * (camera, instance, presence) never leave the local store; remote edits enter
 * through mergeRemoteChanges so they stay out of the editor's undo history.
 */
export function attachBoardBridge(
  store: TLStore,
  doc: Y.Doc,
  options: { schema?: TLSchema; canWrite?: boolean | (() => boolean) } = {},
): () => void {
  const schema = options.schema ?? getBoardSchema();
  const canWriteNow = typeof options.canWrite === "function"
    ? options.canWrite
    : () => options.canWrite !== false;
  const canWrite = canWriteNow();
  const maps = boardMaps(doc);

  const version = maps.meta.get("formatVersion");
  if (version !== undefined && version !== BOARD_BRIDGE_FORMAT_VERSION) {
    throw new Error(`Unsupported board collaboration format: ${String(version)}`);
  }

  if (canWrite) seedBoardRecords(doc, schema);
  const records = maps.records.size > 0 ? migratedBoardRecords(doc, schema) : null;
  if (maps.records.size > 0 && !records) {
    throw new Error("The collaborative board schema cannot be migrated by this tldraw version");
  }

  const storedSchema = boardStoredSchema(doc);
  const requiresMigration = isPlainObject(storedSchema)
    && JSON.stringify(storedSchema) !== JSON.stringify(schema.serialize());
  if (canWrite && requiresMigration) {
    throw new Error("This collaborative board must be migrated before it can be edited");
  }
  if (canWrite && maps.records.size > 0) {
    doc.transact(() => stampBoardMeta(maps.meta, schema), BOARD_SEED_ORIGIN);
  }

  // Pull the doc's record set into the store (remote-authoritative on attach).
  // A read-only user must not seed the shared Y.Doc. They can still view an
  // imported board before a writer has promoted it into the records map.
  const incoming = records?.length || canWrite
    ? records ?? []
    : parseBoardRecords(doc.getText(BOARD_CONTENT_KEY).toString(), schema) ?? [];
  replaceDocumentRecords(store, incoming);

  // Local edits → Y.Doc. The scope filter keeps ephemeral records local.
  const unlisten = store.listen((entry) => {
    if (!canWriteNow()) return;
    doc.transact(() => {
      for (const record of Object.values(entry.changes.added)) addRecord(maps, record);
      for (const [before, after] of Object.values(entry.changes.updated)) writeRecordPatches(maps, before, after);
      for (const record of Object.values(entry.changes.removed)) forgetRecord(maps, record.id);
    }, BOARD_LOCAL_ORIGIN);
  }, { source: "user", scope: "document" });

  // Y.Doc → store (remote peers and the seed). Field patches use stable keys in
  // one shared map, so independent edits compose without replacing record maps.
  const applyChanged = (changed: Iterable<string | undefined>, txn: Y.Transaction) => {
    if (txn.origin === BOARD_LOCAL_ORIGIN) return;
    store.mergeRemoteChanges(() => {
      for (const id of new Set(changed)) {
        if (!id) continue;
        try {
          const record = maps.records.get(id);
          if (record) store.put([recordWithPatches(maps, id, record)]);
          else store.remove([id as TLRecord["id"]]);
        } catch {
          // Record failed schema validation (e.g. from a newer app version) — skip it.
        }
      }
    });
  };
  const recordsObserver = (event: Y.YMapEvent<TLRecord>, txn: Y.Transaction) => {
    applyChanged(event.changes.keys.keys(), txn);
  };
  const patchesObserver = (event: Y.YMapEvent<unknown>, txn: Y.Transaction) => {
    applyChanged([...event.changes.keys.keys()].map(patchRecordId), txn);
  };
  maps.records.observe(recordsObserver);
  maps.patches.observe(patchesObserver);

  return () => {
    maps.records.unobserve(recordsObserver);
    maps.patches.unobserve(patchesObserver);
    unlisten();
  };
}

/** Create a standalone store preloaded from .tldr text (local editing, no Yjs). */
export function createBoardStore(json: string, schema: TLSchema = getBoardSchema()): TLStore {
  return parseBoardStore(json, schema) ?? createEmptyStore();
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
  const $user = atom<TLUser | null>("board-presence-user", {
    id: (user.id.startsWith("user:") ? user.id : `user:${user.id}`) as TLUserId,
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
    else timer ??= setTimeout(publishNow, throttleMs);
  });

  // Remote peers → presence-scope records. Presence records from other
  // clients are authoritative per clientID and reclaimed on leave/timeout.
  const remotePresenceIds = new Map<number, TLInstancePresence["id"]>();
  const forgetPeer = (clientId: number) => {
    const id = remotePresenceIds.get(clientId);
    if (id === undefined) return;
    remotePresenceIds.delete(clientId);
    store.remove([id]);
  };
  const applyRemote = () => {
    const states = awareness.getStates();
    store.mergeRemoteChanges(() => {
      for (const [clientId, state] of states) {
        if (clientId === awareness.clientID) continue;
        const record = (state as Record<string, unknown>)[BOARD_PRESENCE_FIELD] as TLInstancePresence | null | undefined;
        if (!record) {
          forgetPeer(clientId);
          continue;
        }
        remotePresenceIds.set(clientId, record.id);
        try {
          store.put([record]);
        } catch {
          // Presence from a newer app version failing validation — skip it.
        }
      }
      for (const clientId of [...remotePresenceIds.keys()]) {
        if (!states.has(clientId)) forgetPeer(clientId);
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
