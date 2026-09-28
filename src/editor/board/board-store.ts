import {
  createTLSchemaFromUtils,
  createTLStore,
  defaultBindingUtils,
  defaultShapeUtils,
  parseTldrawJsonFile,
  type TLRecord,
  type TLSchema,
  type TLStore,
} from "tldraw";

/**
 * A board is a .tldr file edited through a standalone tldraw store: loaded
 * from the file's text, serialized back after edits, and replaced wholesale
 * when the file changes on disk.
 */

const TLDRAW_FILE_FORMAT_VERSION = 1;

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
 * tldraw's save path we keep asset srcs as-is rather than inlining them as
 * base64: the images stay project files beside the board.
 */
export function serializeBoard(records: TLRecord[], schema: TLSchema = getBoardSchema()): string {
  const documentRecords = pruneUnusedAssets(records.filter(isBoardDocumentRecord));
  // Validate before claiming that these records conform to the current schema.
  // A hand-edited or newer-client file may hold malformed records that must
  // not be materialized into a deceptively valid-looking .tldr file.
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
 * Replace a store's document records from external .tldr text (disk reload,
 * git pull, Overleaf sync). Returns false on invalid input.
 */
export function mergeExternalBoardSource(store: TLStore, source: string): boolean {
  const records = parseBoardRecords(source);
  if (records) replaceDocumentRecords(store, records);
  return records !== null;
}

/** Create a standalone store preloaded from .tldr text. */
export function createBoardStore(json: string, schema: TLSchema = getBoardSchema()): TLStore {
  return parseBoardStore(json, schema) ?? createEmptyStore();
}
