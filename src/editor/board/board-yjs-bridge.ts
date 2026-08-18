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
export const BOARD_META_KEY = "boardMeta";
export const BOARD_RECORD_PATCHES_KEY = "recordPatches";
export const BOARD_RECORD_GENERATIONS_KEY = "recordGenerations";

/** Transaction origin for local store edits pushed into the Y.Doc. */
export const BOARD_LOCAL_ORIGIN = "tldraw-local";
/** Transaction origin for the one-time seed from imported content. */
export const BOARD_SEED_ORIGIN = "tldraw-seed";

const TLDRAW_FILE_FORMAT_VERSION = 1;
const BOARD_BRIDGE_FORMAT_VERSION = 1;
const PATCH_KEY_SEPARATOR = "|";
const LEGACY_RECORD_GENERATION = "legacy";
const DELETED_FIELD = { __latticeDeletedBoardField: true } as const;

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

function patchKey(recordId: string, generation: string, path: string): string {
  return [recordId, generation].map(encodeURIComponent).join(PATCH_KEY_SEPARATOR)
    + PATCH_KEY_SEPARATOR + path;
}

function patchRecordId(key: string): string | undefined {
  const separator = key.indexOf(PATCH_KEY_SEPARATOR);
  if (separator < 0) return undefined;
  try { return decodeURIComponent(key.slice(0, separator)); } catch { return undefined; }
}

function recordPatchPrefix(recordId: string, generation: string): string {
  return `${encodeURIComponent(recordId)}${PATCH_KEY_SEPARATOR}${encodeURIComponent(generation)}${PATCH_KEY_SEPARATOR}`;
}

function isDeletedField(value: unknown): boolean {
  return isPlainObject(value) && value.__latticeDeletedBoardField === true;
}

function setRecordPath(record: Record<string, unknown>, encodedPath: string, value: unknown): void {
  const path = encodedPath.split("/").map(decodeURIComponent);
  if (path.some((segment) => segment === "__proto__" || segment === "prototype" || segment === "constructor")) {
    throw new Error("Unsafe collaborative board record path");
  }
  let parent = record;
  for (let index = 0; index < path.length - 1; index++) {
    const key = path[index];
    if (!isPlainObject(parent[key])) parent[key] = {};
    parent = parent[key] as Record<string, unknown>;
  }
  const key = path[path.length - 1];
  if (isDeletedField(value)) delete parent[key];
  else parent[key] = value;
}

function recordWithPatches(
  record: TLRecord,
  recordId: string,
  generation: string,
  patches: Y.Map<unknown>,
): TLRecord {
  const next = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
  const prefix = recordPatchPrefix(recordId, generation);
  const applicable: Array<[string, unknown]> = [];
  patches.forEach((value, key) => {
    if (key.startsWith(prefix)) applicable.push([key.slice(prefix.length), value]);
  });
  // Overlapping paths can survive when peers concurrently replace a subtree
  // with a scalar and edit one of its children. Apply shallow paths last so
  // the subtree replacement wins deterministically on every peer.
  applicable.sort(([a], [b]) => b.split("/").length - a.split("/").length || a.localeCompare(b));
  for (const [path, value] of applicable) setRecordPath(next, path, value);
  return next as unknown as TLRecord;
}

function currentBoardRecords(
  yRecords: Y.Map<TLRecord>,
  generations: Y.Map<string>,
  patches: Y.Map<unknown>,
): TLRecord[] {
  const records: TLRecord[] = [];
  yRecords.forEach((record, id) => records.push(recordWithPatches(
    record,
    id,
    generations.get(id) ?? LEGACY_RECORD_GENERATION,
    patches,
  )));
  return records;
}

function clearRecordPatches(recordId: string, generation: string, patches: Y.Map<unknown>): void {
  const prefix = recordPatchPrefix(recordId, generation);
  for (const key of patches.keys()) if (key.startsWith(prefix)) patches.delete(key);
}

function clearRelatedPatches(
  recordId: string,
  generation: string,
  path: string,
  patches: Y.Map<unknown>,
): void {
  const prefix = recordPatchPrefix(recordId, generation);
  for (const key of patches.keys()) {
    if (!key.startsWith(prefix)) continue;
    const existing = key.slice(prefix.length);
    if (existing === path || existing.startsWith(`${path}/`) || path.startsWith(`${existing}/`)) {
      patches.delete(key);
    }
  }
}

function writeRecordPatches(
  before: TLRecord,
  after: TLRecord,
  generation: string,
  patches: Y.Map<unknown>,
): void {
  const previous = flattenRecord(before);
  const next = flattenRecord(after);
  for (const [path, value] of next) {
    if (JSON.stringify(previous.get(path)) !== JSON.stringify(value)) {
      clearRelatedPatches(after.id, generation, path, patches);
      patches.set(patchKey(after.id, generation, path), value);
    }
  }
  for (const path of previous.keys()) {
    if (next.has(path)) continue;
    // A scalar/empty-object path can become descendants (or vice versa). The
    // surviving related path already replaces that subtree, so a tombstone
    // would make application order matter and could erase the new value.
    const replacedAsSubtree = [...next.keys()].some((candidate) =>
      candidate.startsWith(`${path}/`) || path.startsWith(`${candidate}/`));
    if (!replacedAsSubtree) {
      clearRelatedPatches(after.id, generation, path, patches);
      patches.set(patchKey(after.id, generation, path), DELETED_FIELD);
    }
  }
}

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
  // Validate before claiming that these records conform to the current schema.
  // Shared rooms may contain malformed or newer-client data that must not be
  // materialized into a deceptively valid-looking .tldr file.
  const validationStore = createTLStore({
    shapeUtils: [...defaultShapeUtils],
    bindingUtils: [...defaultBindingUtils],
  });
  validationStore.put(documentRecords);
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
    const meta = doc.getMap<unknown>(BOARD_META_KEY);
    meta.set("formatVersion", BOARD_BRIDGE_FORMAT_VERSION);
    meta.set("initialized", true);
    meta.set("schema", schema.serialize());
  }, BOARD_SEED_ORIGIN);
  return true;
}

/** The .tldr text a reader (disk materialization, export) should persist. */
export function boardDocContent(doc: Y.Doc, schema: TLSchema = getBoardSchema()): string {
  const yRecords = doc.getMap<TLRecord>(BOARD_RECORDS_KEY);
  if (yRecords.size === 0) return doc.getText(BOARD_CONTENT_KEY).toString();
  const records = migratedBoardRecords(doc, schema);
  if (!records) throw new Error("The collaborative board schema cannot be read by this tldraw version");
  return serializeBoard(records, schema);
}

function migratedBoardRecords(doc: Y.Doc, schema: TLSchema): TLRecord[] | null {
  const yRecords = doc.getMap<TLRecord>(BOARD_RECORDS_KEY);
  const generations = doc.getMap<string>(BOARD_RECORD_GENERATIONS_KEY);
  const patches = doc.getMap<unknown>(BOARD_RECORD_PATCHES_KEY);
  const records = currentBoardRecords(yRecords, generations, patches);
  const meta = doc.getMap<unknown>(BOARD_META_KEY);
  const version = meta.get("formatVersion");
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
  const metadataSchema = doc.getMap<unknown>(BOARD_META_KEY).get("schema");
  if (isPlainObject(metadataSchema)) return metadataSchema;
  try { return (JSON.parse(doc.getText(BOARD_CONTENT_KEY).toString()) as { schema?: unknown }).schema; }
  catch { return undefined; }
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
  options: { schema?: TLSchema; canWrite?: boolean | (() => boolean) } = {},
): BoardBridge {
  const schema = options.schema ?? getBoardSchema();
  const canWriteNow = typeof options.canWrite === "function"
    ? options.canWrite
    : () => options.canWrite !== false;
  const canWrite = canWriteNow();
  const yRecords = doc.getMap<TLRecord>(BOARD_RECORDS_KEY);
  const generations = doc.getMap<string>(BOARD_RECORD_GENERATIONS_KEY);
  const patches = doc.getMap<unknown>(BOARD_RECORD_PATCHES_KEY);
  const meta = doc.getMap<unknown>(BOARD_META_KEY);
  const currentSchema = schema.serialize();

  const version = meta.get("formatVersion");
  if (version !== undefined && version !== BOARD_BRIDGE_FORMAT_VERSION) {
    throw new Error(`Unsupported board collaboration format: ${String(version)}`);
  }

  if (canWrite) seedBoardRecords(doc, schema);
  const records = yRecords.size > 0 ? migratedBoardRecords(doc, schema) : null;
  if (yRecords.size > 0 && !records) {
    throw new Error("The collaborative board schema cannot be migrated by this tldraw version");
  }

  const storedSchema = boardStoredSchema(doc);
  const requiresMigration = isPlainObject(storedSchema)
    && JSON.stringify(storedSchema) !== JSON.stringify(currentSchema);
  if (canWrite && requiresMigration) {
    throw new Error("This collaborative board must be migrated before it can be edited");
  }
  if (canWrite && yRecords.size > 0 && !requiresMigration) {
    doc.transact(() => {
      meta.set("formatVersion", BOARD_BRIDGE_FORMAT_VERSION);
      meta.set("initialized", true);
      meta.set("schema", currentSchema);
    }, BOARD_SEED_ORIGIN);
  }

  // Pull the doc's record set into the store (remote-authoritative on attach).
  store.mergeRemoteChanges(() => {
    const incoming = new Map<string, TLRecord>();
    for (const record of records ?? []) incoming.set(record.id, record);
    // A read-only user must not seed the shared Y.Doc. They can still view an
    // imported board before a writer has promoted it into the records map.
    if (!incoming.size && !canWrite) {
      for (const record of parseBoardRecords(doc.getText(BOARD_CONTENT_KEY).toString(), schema) ?? []) {
        incoming.set(record.id, record);
      }
    }
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
      if (!canWriteNow()) return;
      doc.transact(() => {
        for (const record of Object.values(entry.changes.added)) {
          const previousGeneration = generations.get(record.id) ?? LEGACY_RECORD_GENERATION;
          clearRecordPatches(record.id, previousGeneration, patches);
          generations.set(record.id, crypto.randomUUID());
          yRecords.set(record.id, record);
        }
        for (const [before, after] of Object.values(entry.changes.updated)) {
          writeRecordPatches(
            before,
            after,
            generations.get(after.id) ?? LEGACY_RECORD_GENERATION,
            patches,
          );
        }
        for (const record of Object.values(entry.changes.removed)) {
          yRecords.delete(record.id);
          clearRecordPatches(
            record.id,
            generations.get(record.id) ?? LEGACY_RECORD_GENERATION,
            patches,
          );
          generations.delete(record.id);
        }
      }, BOARD_LOCAL_ORIGIN);
    }, { source: "user", scope: "document" });

  // Y.Doc → store (remote peers and the seed). Field patches use stable keys in
  // one shared map, so independent edits compose without replacing record maps.
  const applyChanged = (changed: Set<string>, txn: Y.Transaction) => {
    if (txn.origin === BOARD_LOCAL_ORIGIN) return;
    store.mergeRemoteChanges(() => {
      for (const id of changed) {
        try {
          const record = yRecords.get(id);
          if (record) store.put([recordWithPatches(
            record,
            id,
            generations.get(id) ?? LEGACY_RECORD_GENERATION,
            patches,
          )]);
          else store.remove([id as TLRecord["id"]]);
        } catch {
          // Record failed schema validation (e.g. from a newer app version) — skip it.
        }
      }
    });
  };
  const recordsObserver = (event: Y.YMapEvent<TLRecord>, txn: Y.Transaction) => {
    applyChanged(new Set(event.changes.keys.keys()), txn);
  };
  const patchesObserver = (event: Y.YMapEvent<unknown>, txn: Y.Transaction) => {
    const changed = new Set<string>();
    for (const key of event.changes.keys.keys()) {
      const id = patchRecordId(key);
      if (id) changed.add(id);
    }
    applyChanged(changed, txn);
  };
  yRecords.observe(recordsObserver);
  patches.observe(patchesObserver);

  return {
    dispose() {
      yRecords.unobserve(recordsObserver);
      patches.unobserve(patchesObserver);
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
