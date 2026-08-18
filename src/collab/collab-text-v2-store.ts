import * as Y from "yjs";
import { isCatalogV2, isDurableAckV2, type CatalogV2, type DurableAckV2 } from "../../protocol/collab-v2";

export type TextNamespaceV2 = { deployment: string; projectInstanceId: string; fileId: string; documentEpoch: number };
export type OutboxEntryV2 = { id: string; update: Uint8Array; createdAt: number };
export type DurableTextRecordV2 = { key: string; namespace: TextNamespaceV2; snapshot: Uint8Array; outbox: OutboxEntryV2[]; ack?: DurableAckV2; quarantine?: { issues: string[]; observedAt: number } };

export class CollabTextStoreCorruptionErrorV2 extends Error {
  constructor(readonly record: DurableTextRecordV2, readonly issues: string[]) {
    super(`Collaboration recovery data is corrupt: ${issues.join(", ")}`);
  }
}

const DB_NAME = "lattice-collab-text-v2";
const STORE = "documents";
/** One record per unsent local update, so a keystroke never rewrites the snapshot record. */
const OUTBOX_STORE = "outbox";
const OUTBOX_DOC_INDEX = "byDoc";
const CATALOG_STORE = "catalogs";
const CATALOG_SNAPSHOT_VERSION = 1 as const;
const DB_VERSION = 3;

const EMPTY_SNAPSHOT = (() => { const doc = new Y.Doc(); const update = Y.encodeStateAsUpdate(doc); doc.destroy(); return update; })();

export function textNamespaceKey(namespace: TextNamespaceV2): string {
  return [namespace.deployment.replace(/\/$/, ""), namespace.projectInstanceId, namespace.fileId, namespace.documentEpoch].map(encodeURIComponent).join("|");
}

type StoredOutboxRecordV2 = { key: string; doc: string; entry: OutboxEntryV2 };
type StoredCatalogSnapshotV2 = {
  key: string;
  version: typeof CATALOG_SNAPSHOT_VERSION;
  deployment: string;
  projectInstanceId: string;
  catalog: CatalogV2;
};

function normalizedDeployment(deployment: string): string { return deployment.replace(/\/$/, ""); }
function catalogSnapshotKey(deployment: string, projectInstanceId: string): string {
  return [normalizedDeployment(deployment), projectInstanceId].map(encodeURIComponent).join("|");
}

export class CollabTextDurableStoreV2 {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly snapshotWrittenAt = new Map<string, number>();
  constructor(
    private readonly indexedDB: IDBFactory = globalThis.indexedDB,
    /** Minimum interval between snapshot record rewrites (remote merges arrive per keystroke). */
    private readonly snapshotThrottleMs = 2_000,
    private readonly clock: () => number = Date.now,
  ) {}

  async load(namespace: TextNamespaceV2): Promise<DurableTextRecordV2 | undefined> { const key = textNamespaceKey(namespace); return this.serial(key, () => this.readValidated(key, namespace)); }

  async persistLocal(namespace: TextNamespaceV2, doc: Y.Doc, entry: OutboxEntryV2): Promise<void> {
    const key = textNamespaceKey(namespace); await this.serial(key, async () => {
      if (await this.readOutboxEntry(key, entry.id)) return;
      if (!(await this.read(key))) {
        // Establish the document record once. Every later local update lives
        // only in the outbox and is (idempotently) applied on load, so the
        // multi-MB snapshot record is not rewritten per keystroke.
        await this.write({ key, namespace, snapshot: Y.encodeStateAsUpdate(doc), outbox: [] });
      }
      await this.writeOutboxEntry(key, entry);
    });
  }

  async persistSnapshot(namespace: TextNamespaceV2, doc: Y.Doc): Promise<void> {
    const key = textNamespaceKey(namespace);
    // Remote merges arrive per peer keystroke; a skipped snapshot only means a
    // slightly stale offline copy, which the server re-syncs on reconnect.
    const last = this.snapshotWrittenAt.get(key);
    const now = this.clock();
    if (last !== undefined && now - last < this.snapshotThrottleMs) return;
    this.snapshotWrittenAt.set(key, now);
    await this.serial(key, async () => { const prior = await this.read(key);
      await this.write({ key, namespace, snapshot: Y.encodeStateAsUpdate(doc), outbox: prior?.outbox ?? [], ack: prior?.ack });
    });
  }

  async recordAck(namespace: TextNamespaceV2, ack: DurableAckV2): Promise<void> {
    const key = textNamespaceKey(namespace); await this.serial(key, async () => { const prior = await this.read(key);
      if (prior) await this.write({ ...prior, ack });
    });
  }

  async compactAck(namespace: TextNamespaceV2, snapshot: Uint8Array, ack: DurableAckV2, stateVector: Uint8Array): Promise<OutboxEntryV2[]> {
    const key = textNamespaceKey(namespace);
    return this.serial(key, async () => {
      const db = await this.db();
      return new Promise<OutboxEntryV2[]>((resolve, reject) => {
        const tx = db.transaction([STORE, OUTBOX_STORE], "readwrite");
        const documents = tx.objectStore(STORE);
        const outbox = tx.objectStore(OUTBOX_STORE);
        const documentRequest = documents.get(key);
        const outboxRequest = outbox.index(OUTBOX_DOC_INDEX).getAll(key);
        let remaining: OutboxEntryV2[] = [];
        let prepared = false;
        const prepare = () => {
          if (prepared || documentRequest.readyState !== "done" || outboxRequest.readyState !== "done") return;
          prepared = true;
          const prior = documentRequest.result as DurableTextRecordV2 | undefined;
          const records = outboxRequest.result as StoredOutboxRecordV2[];
          remaining = records.map((record) => record.entry).filter((entry) => !updateCoveredByStateVector(entry.update, stateVector));
          documents.put({ ...(prior ?? { key, namespace, outbox: [] }), snapshot, ack });
          for (const record of records) if (updateCoveredByStateVector(record.entry.update, stateVector)) outbox.delete(record.key);
        };
        documentRequest.onsuccess = prepare;
        outboxRequest.onsuccess = prepare;
        tx.oncomplete = () => { db.close(); remaining.sort((a, b) => a.createdAt - b.createdAt); resolve(remaining); };
        tx.onerror = () => { db.close(); reject(tx.error); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      });
    });
  }

  async deleteCovered(namespace: TextNamespaceV2, stateVector: Uint8Array): Promise<OutboxEntryV2[]> {
    const key = textNamespaceKey(namespace); return this.serial(key, async () => {
      const entries = await this.readOutboxEntries(key);
      const remaining = entries.filter((entry) => !updateCoveredByStateVector(entry.update, stateVector));
      const covered = new Set(remaining.map((entry) => entry.id));
      await this.deleteOutboxEntries(key, entries.filter((entry) => !covered.has(entry.id)).map((entry) => entry.id));
      return remaining;
    });
  }

  async export(namespace: TextNamespaceV2): Promise<DurableTextRecordV2 | undefined> { const key = textNamespaceKey(namespace); return this.serial(key, () => this.readValidated(key, namespace)); }

  /** Persist only a catalog that has passed the wire validator and matches this durable identity. */
  async persistCatalog(deployment: string, projectInstanceId: string, catalog: CatalogV2): Promise<void> {
    if (!isCatalogV2(catalog) || catalog.projectInstanceId !== projectInstanceId) throw new Error("Invalid catalog snapshot");
    const key = catalogSnapshotKey(deployment, projectInstanceId);
    const value: StoredCatalogSnapshotV2 = {
      key,
      version: CATALOG_SNAPSHOT_VERSION,
      deployment: normalizedDeployment(deployment),
      projectInstanceId,
      catalog: structuredClone(catalog),
    };
    await this.serial(`catalog:${key}`, async () => {
      const db = await this.db();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(CATALOG_STORE, "readwrite");
        tx.objectStore(CATALOG_STORE).put(value);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      db.close();
    });
  }

  /** Invalid, stale-version, or differently bound records are indistinguishable from no cache. */
  async loadCatalog(deployment: string, projectInstanceId: string): Promise<CatalogV2 | undefined> {
    const key = catalogSnapshotKey(deployment, projectInstanceId);
    return this.serial(`catalog:${key}`, async () => {
      const db = await this.db();
      const raw = await new Promise<unknown>((resolve, reject) => {
        const request = db.transaction(CATALOG_STORE).objectStore(CATALOG_STORE).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }).finally(() => db.close());
      if (!raw || typeof raw !== "object") return undefined;
      const record = raw as Partial<StoredCatalogSnapshotV2>;
      if (record.key !== key || record.version !== CATALOG_SNAPSHOT_VERSION
        || record.deployment !== normalizedDeployment(deployment)
        || record.projectInstanceId !== projectInstanceId
        || !isCatalogV2(record.catalog)
        || record.catalog.projectInstanceId !== projectInstanceId) return undefined;
      return structuredClone(record.catalog);
    });
  }

  private async db(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = this.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" });
        if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
          const store = db.createObjectStore(OUTBOX_STORE, { keyPath: "key" });
          store.createIndex(OUTBOX_DOC_INDEX, "doc", { unique: false });
        }
        if (!db.objectStoreNames.contains(CATALOG_STORE)) db.createObjectStore(CATALOG_STORE, { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  protected async read(key: string): Promise<DurableTextRecordV2 | undefined> { const db = await this.db(); return new Promise((resolve, reject) => { const request = db.transaction(STORE).objectStore(STORE).get(key); request.onsuccess = () => { db.close(); resolve(request.result as DurableTextRecordV2 | undefined); }; request.onerror = () => { db.close(); reject(request.error); }; }); }
  protected async write(value: DurableTextRecordV2): Promise<void> { const db = await this.db(); await new Promise<void>((resolve, reject) => { const tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).put(value); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); }); db.close(); }

  private outboxKey(docKey: string, entryId: string): string { return `${docKey}|${entryId}`; }

  private async readOutboxEntry(docKey: string, entryId: string): Promise<OutboxEntryV2 | undefined> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = db.transaction(OUTBOX_STORE).objectStore(OUTBOX_STORE).get(this.outboxKey(docKey, entryId));
      request.onsuccess = () => { db.close(); resolve((request.result as StoredOutboxRecordV2 | undefined)?.entry); };
      request.onerror = () => { db.close(); reject(request.error); };
    });
  }

  private async readOutboxEntries(docKey: string): Promise<OutboxEntryV2[]> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = db.transaction(OUTBOX_STORE).objectStore(OUTBOX_STORE).index(OUTBOX_DOC_INDEX).getAll(docKey);
      request.onsuccess = () => {
        db.close();
        const entries = (request.result as StoredOutboxRecordV2[]).map((record) => record.entry);
        entries.sort((a, b) => a.createdAt - b.createdAt);
        resolve(entries);
      };
      request.onerror = () => { db.close(); reject(request.error); };
    });
  }

  private async writeOutboxEntry(docKey: string, entry: OutboxEntryV2): Promise<void> {
    const db = await this.db();
    await new Promise<void>((resolve, reject) => { const tx = db.transaction(OUTBOX_STORE, "readwrite"); tx.objectStore(OUTBOX_STORE).put({ key: this.outboxKey(docKey, entry.id), doc: docKey, entry } satisfies StoredOutboxRecordV2); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
    db.close();
  }

  private async deleteOutboxEntries(docKey: string, entryIds: string[]): Promise<void> {
    if (!entryIds.length) return;
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(OUTBOX_STORE, "readwrite");
      const store = tx.objectStore(OUTBOX_STORE);
      for (const id of entryIds) store.delete(this.outboxKey(docKey, id));
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    db.close();
  }

  private async readValidated(key: string, namespace: TextNamespaceV2): Promise<DurableTextRecordV2 | undefined> {
    const raw = await this.read(key);
    const stored = await this.readOutboxEntries(key);
    // Pre-split records carried their outbox inline; fold it in, then migrate.
    const legacy = raw?.outbox ?? [];
    const seen = new Set<string>();
    const entries = [...stored, ...legacy].filter((entry) => { if (!entry || seen.has(entry.id)) return false; seen.add(entry.id); return true; });
    if (!raw && !entries.length) return undefined;
    const record: DurableTextRecordV2 = raw
      ? { ...raw, outbox: entries }
      : { key, namespace, snapshot: EMPTY_SNAPSHOT, outbox: entries };

    const issues: string[] = [];
    try { if (record.key !== key || textNamespaceKey(record.namespace) !== key || textNamespaceKey(namespace) !== key) issues.push("namespace_mismatch"); }
    catch { issues.push("namespace_mismatch"); }
    if (!validSnapshot(record.snapshot)) issues.push("invalid_snapshot");
    if (record.outbox.some((entry) => !entry || typeof entry.id !== "string" || !Number.isFinite(entry.createdAt) || !validUpdate(entry.update))) issues.push("invalid_outbox_update");
    if (record.ack && !isDurableAckV2(record.ack)) issues.push("invalid_ack");
    if (record.quarantine?.issues.length) issues.push(...record.quarantine.issues);
    if (issues.length) throw new CollabTextStoreCorruptionErrorV2(record, [...new Set(issues)]);

    if (legacy.length) {
      for (const entry of legacy) await this.writeOutboxEntry(key, entry);
      await this.write({ ...record, outbox: [] });
    }
    return record;
  }

  private serial<T>(key: string, action: () => Promise<T>): Promise<T> { const prior = this.tails.get(key) ?? Promise.resolve(); const result = prior.then(action, action); this.tails.set(key, result.catch(() => undefined)); return result; }
}

export function updateCoveredByStateVector(update: Uint8Array, stateVector: Uint8Array): boolean {
  try { const needed = Y.parseUpdateMeta(update).to; const durable = Y.decodeStateVector(stateVector); for (const [client, clock] of needed) if ((durable.get(client) ?? 0) < clock) return false; return true; } catch { return false; }
}

function validUpdate(value: unknown): value is Uint8Array { if (!ArrayBuffer.isView(value) || (value as Uint8Array).BYTES_PER_ELEMENT !== 1) return false; try { Y.parseUpdateMeta(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)); return true; } catch { return false; } }
function validSnapshot(value: unknown): value is Uint8Array { if (!validUpdate(value)) return false; const doc = new Y.Doc(); try { Y.applyUpdate(doc, value); return true; } catch { return false; } finally { doc.destroy(); } }
