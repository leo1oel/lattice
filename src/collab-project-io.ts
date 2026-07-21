import { invoke } from "@tauri-apps/api/core";
import type * as Y from "yjs";
import {
  COLLAB_LOCAL_ORIGIN,
  COLLAB_EDITOR_COMMENTS_PATH,
  classifySyncablePath,
  collabBlobsMap,
  collabDocHasProject,
  collabTextsMap,
  ensureCollabText,
  estimateBase64Bytes,
  listSyncableProjectPaths,
  MAX_COLLAB_BLOB_BYTES,
  readCollabMeta,
  setCollabBlob,
  setCollabTextContent,
  writeCollabMeta,
  type CollabProjectMeta,
} from "./collab-project-sync";

const EMPTY_EDITOR_COMMENTS = '{\n  "schemaVersion": 1,\n  "comments": []\n}\n';

type FileNodeLike = {
  path: string;
  kind?: string;
  children?: FileNodeLike[];
};

type ManifestLike = {
  schemaVersion?: number;
  projectId: string;
  name: string;
  rootDocuments?: { path: string; isDefault?: boolean }[];
};

type AssetPreview = {
  path: string;
  mimeType: string;
  base64: string;
};

type PaperSummary = {
  arxivId: string;
};

export type SeedResult = {
  textCount: number;
  blobCount: number;
  skippedBlobs: string[];
};

export type MaterializeResult = {
  textCount: number;
  blobCount: number;
  rootDocument: string | null;
  skippedBlobs: string[];
};

async function readTextOptional(path: string): Promise<string | null> {
  try {
    return await invoke<string>("read_project_file", { path });
  } catch {
    return null;
  }
}

export async function seedCollabDocFromProject(
  doc: Y.Doc,
  options: {
    files: FileNodeLike[];
    manifest: ManifestLike;
    papers?: PaperSummary[];
  },
): Promise<SeedResult> {
  const paperIds = (options.papers ?? []).map((paper) => paper.arxivId);
  const syncable = listSyncableProjectPaths({ files: options.files, paperIds });
  const skippedBlobs: string[] = [];
  let textCount = 0;
  let blobCount = 0;

  const rootDocument = options.manifest.rootDocuments?.find((entry) => entry.path === "main.tex")?.path
    ?? options.manifest.rootDocuments?.find((entry) => entry.isDefault)?.path
    ?? options.manifest.rootDocuments?.[0]?.path
    ?? "main.tex";

  for (const entry of syncable) {
    if (entry.kind === "text") {
      let content = await readTextOptional(entry.path);
      if (content == null && entry.path === COLLAB_EDITOR_COMMENTS_PATH) {
        content = EMPTY_EDITOR_COMMENTS;
      }
      if (content == null) continue;
      const ytext = ensureCollabText(doc, entry.path);
      setCollabTextContent(ytext, content, COLLAB_LOCAL_ORIGIN);
      textCount += 1;
      continue;
    }
    try {
      const asset = await invoke<AssetPreview>("read_project_asset", { path: entry.path });
      if (estimateBase64Bytes(asset.base64) > MAX_COLLAB_BLOB_BYTES) {
        skippedBlobs.push(entry.path);
        continue;
      }
      setCollabBlob(doc, entry.path, asset.mimeType, asset.base64, COLLAB_LOCAL_ORIGIN);
      blobCount += 1;
    } catch {
      skippedBlobs.push(entry.path);
    }
  }

  const meta: CollabProjectMeta = {
    schemaVersion: options.manifest.schemaVersion ?? 1,
    projectId: options.manifest.projectId,
    name: options.manifest.name,
    manifestJson: JSON.stringify(options.manifest),
    rootDocument,
    skippedBlobs: skippedBlobs.length ? skippedBlobs : undefined,
  };
  writeCollabMeta(doc, meta, COLLAB_LOCAL_ORIGIN);

  return { textCount, blobCount, skippedBlobs };
}

export async function materializeCollabDocToProject(doc: Y.Doc): Promise<MaterializeResult> {
  if (!collabDocHasProject(doc)) {
    throw new Error("This share room has no project data yet. Ask the host to Start sharing first.");
  }

  let textCount = 0;
  let blobCount = 0;
  const texts = collabTextsMap(doc);
  const blobs = collabBlobsMap(doc);

  const textEntries: [string, string][] = [];
  texts.forEach((ytext, path) => {
    if (classifySyncablePath(path) !== "text") return;
    textEntries.push([path, ytext.toString()]);
  });

  for (const [path, content] of textEntries) {
    // Refuse to clobber a non-empty local file with an empty shared placeholder
    // (host used to publish empty main.tex before seeding from disk).
    if (content.length === 0) {
      const existing = await readTextOptional(path);
      if (existing && existing.length > 0) continue;
    }
    await invoke("write_project_file", { path, content });
    textCount += 1;
  }

  const blobPaths: string[] = [];
  blobs.forEach((_value, path) => blobPaths.push(path));
  for (const path of blobPaths) {
    const entry = blobs.get(path);
    if (!entry) continue;
    const base64 = String(entry.get("b64") ?? "");
    if (!base64) continue;
    if (estimateBase64Bytes(base64) > MAX_COLLAB_BLOB_BYTES) continue;
    await invoke("write_project_bytes", { path, base64Data: base64 });
    blobCount += 1;
  }

  const meta = readCollabMeta(doc);
  return {
    textCount,
    blobCount,
    rootDocument: meta?.rootDocument ?? null,
    skippedBlobs: meta?.skippedBlobs ?? [],
  };
}

export function pushLocalTextToCollab(doc: Y.Doc, path: string, content: string): void {
  if (classifySyncablePath(path) !== "text") return;
  const ytext = ensureCollabText(doc, path);
  const current = ytext.toString();
  if (current === content) return;
  // Never replace non-empty shared text with an empty local buffer.
  if (!content && current.length > 0) return;
  setCollabTextContent(ytext, content, COLLAB_LOCAL_ORIGIN);
}

export async function pushLocalBlobToCollab(doc: Y.Doc, path: string): Promise<void> {
  if (classifySyncablePath(path) !== "blob") return;
  const asset = await invoke<AssetPreview>("read_project_asset", { path });
  if (estimateBase64Bytes(asset.base64) > MAX_COLLAB_BLOB_BYTES) {
    throw new Error(`${path} is larger than 15 MB and cannot sync.`);
  }
  setCollabBlob(doc, path, asset.mimeType, asset.base64, COLLAB_LOCAL_ORIGIN);
}

export function attachCollabProjectObservers(
  doc: Y.Doc,
  handlers: {
    onRemoteText: (path: string, content: string) => void;
    onRemoteBlob: (path: string, mime: string, base64: string) => void;
    onRemoteDelete: (path: string) => void;
  },
): () => void {
  const texts = collabTextsMap(doc);
  const blobs = collabBlobsMap(doc);
  const textObservers = new Map<string, () => void>();

  const watchText = (path: string, ytext: Y.Text) => {
    if (textObservers.has(path)) return;
    const observer = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
      if (transaction.origin === COLLAB_LOCAL_ORIGIN) return;
      handlers.onRemoteText(path, ytext.toString());
    };
    ytext.observe(observer);
    textObservers.set(path, () => ytext.unobserve(observer));
  };

  texts.forEach((ytext, path) => watchText(path, ytext));

  const onTextsMap = (event: Y.YMapEvent<Y.Text>) => {
    if (event.transaction.origin === COLLAB_LOCAL_ORIGIN) return;
    event.changes.keys.forEach((change, path) => {
      if (change.action === "delete") {
        textObservers.get(path)?.();
        textObservers.delete(path);
        handlers.onRemoteDelete(path);
        return;
      }
      const ytext = texts.get(path);
      if (!ytext) return;
      watchText(path, ytext);
      handlers.onRemoteText(path, ytext.toString());
    });
  };

  const onBlobsMap = (event: Y.YMapEvent<Y.Map<string>>) => {
    if (event.transaction.origin === COLLAB_LOCAL_ORIGIN) return;
    event.changes.keys.forEach((change, path) => {
      if (change.action === "delete") {
        handlers.onRemoteDelete(path);
        return;
      }
      const entry = blobs.get(path);
      if (!entry) return;
      const mime = String(entry.get("mime") ?? "application/octet-stream");
      const base64 = String(entry.get("b64") ?? "");
      if (base64) handlers.onRemoteBlob(path, mime, base64);
    });
  };

  texts.observe(onTextsMap);
  blobs.observe(onBlobsMap);

  return () => {
    texts.unobserve(onTextsMap);
    blobs.unobserve(onBlobsMap);
    for (const stop of textObservers.values()) stop();
    textObservers.clear();
  };
}
