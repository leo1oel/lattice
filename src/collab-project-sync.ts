import * as Y from "yjs";

export const COLLAB_META_KEY = "meta";
export const COLLAB_TEXTS_KEY = "texts";
export const COLLAB_BLOBS_KEY = "blobs";
export const COLLAB_LOCAL_ORIGIN = "lattice-local";
export const COLLAB_EDITOR_COMMENTS_PATH = ".research/editor-comments.json";
export const MAX_COLLAB_BLOB_BYTES = 15 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  "tex", "bib", "md", "txt", "sty", "cls", "bst", "json",
]);
const BLOB_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "pdf", "svg", "eps", "webp",
]);

export type SyncableKind = "text" | "blob";

export type SyncablePath = {
  path: string;
  kind: SyncableKind;
};

export type CollabProjectMeta = {
  schemaVersion: number;
  projectId: string;
  name: string;
  manifestJson: string;
  rootDocument?: string;
  /** Host-side figures skipped at seed (usually >15 MB). Guests should see a warning. */
  skippedBlobs?: string[];
};

type FileNodeLike = {
  path: string;
  kind?: string;
  children?: FileNodeLike[];
};

export function extensionOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Canonical key form for the shared texts/blobs maps. Seeds are stored via
 * `listSyncableProjectPaths` (which normalizes), so every direct map access
 * must normalize too — otherwise `"/main.tex"` or a Windows `"a\\b.tex"` keys a
 * *second* entry instead of hitting the seeded one (duplicate files on peers,
 * and deletes that silently match nothing).
 */
export function normalizeCollabPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function classifySyncablePath(path: string): SyncableKind | null {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) return null;
  if (
    normalized.startsWith(".research/history/")
    || normalized.startsWith(".research/sessions/")
    || normalized.startsWith(".research/omp-")
    || normalized.startsWith(".research/checkpoints/")
    || normalized.startsWith(".research/cache/")
    || normalized === ".research/pdf-annotations.json"
  ) {
    return null;
  }
  const ext = extensionOf(normalized);
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (BLOB_EXTENSIONS.has(ext)) return "blob";
  return null;
}

export function flattenFilePaths(nodes: FileNodeLike[]): string[] {
  const out: string[] = [];
  const visit = (list: FileNodeLike[]) => {
    for (const node of list) {
      if (node.children && node.children.length > 0) visit(node.children);
      else if (node.kind !== "directory") out.push(node.path.replace(/\\/g, "/"));
    }
  };
  visit(nodes);
  return out;
}

export function listSyncableProjectPaths(options: {
  files: FileNodeLike[];
  paperIds?: string[];
}): SyncablePath[] {
  const seen = new Set<string>();
  const out: SyncablePath[] = [];
  const add = (path: string) => {
    const normalized = path.replace(/\\/g, "/");
    const kind = classifySyncablePath(normalized);
    if (!kind || seen.has(normalized)) return;
    seen.add(normalized);
    out.push({ path: normalized, kind });
  };

  for (const path of flattenFilePaths(options.files)) add(path);
  add(".research/project.json");
  add(".research/brief.md");
  add(COLLAB_EDITOR_COMMENTS_PATH);
  for (const arxivId of options.paperIds ?? []) {
    add(`.research/papers/${arxivId}/paper.md`);
    add(`.research/papers/${arxivId}/metadata.json`);
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export function collabMetaMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(COLLAB_META_KEY);
}

export function collabTextsMap(doc: Y.Doc): Y.Map<Y.Text> {
  return doc.getMap(COLLAB_TEXTS_KEY) as Y.Map<Y.Text>;
}

export function collabBlobsMap(doc: Y.Doc): Y.Map<Y.Map<string>> {
  return doc.getMap(COLLAB_BLOBS_KEY) as Y.Map<Y.Map<string>>;
}

export function collabDocHasProject(doc: Y.Doc): boolean {
  const meta = collabMetaMap(doc);
  return Boolean(meta.get("projectId") || meta.get("manifestJson"));
}

export function collabSyncedFileCount(doc: Y.Doc): number {
  return collabTextsMap(doc).size + collabBlobsMap(doc).size;
}

export function ensureCollabText(doc: Y.Doc, path: string): Y.Text {
  const key = normalizeCollabPath(path);
  const texts = collabTextsMap(doc);
  const existing = texts.get(key);
  if (existing) return existing;
  const ytext = new Y.Text();
  texts.set(key, ytext);
  return ytext;
}

export function setCollabTextContent(ytext: Y.Text, content: string, origin = COLLAB_LOCAL_ORIGIN): void {
  ytext.doc?.transact(() => {
    ytext.delete(0, ytext.length);
    if (content) ytext.insert(0, content);
  }, origin);
}

export function setCollabBlob(
  doc: Y.Doc,
  path: string,
  mime: string,
  base64: string,
  origin = COLLAB_LOCAL_ORIGIN,
): void {
  const key = normalizeCollabPath(path);
  const blobs = collabBlobsMap(doc);
  doc.transact(() => {
    // Always set a fresh inner map (rather than mutating an existing one in
    // place). `blobs.observe` is shallow: mutating the inner map on a re-export
    // fires no event, so peers keep the stale figure. Replacing the entry makes
    // every update a top-level key change the observer can see. Blobs are
    // last-writer-wins binaries, so losing inner-map history is fine.
    const entry = new Y.Map<string>();
    entry.set("mime", mime);
    entry.set("b64", base64);
    blobs.set(key, entry);
  }, origin);
}

export function removeCollabPath(doc: Y.Doc, path: string, origin = COLLAB_LOCAL_ORIGIN): void {
  const key = normalizeCollabPath(path);
  doc.transact(() => {
    collabTextsMap(doc).delete(key);
    collabBlobsMap(doc).delete(key);
  }, origin);
}

/** Move a shared text/blob path (and optional directory prefix) after a local rename. */
export function renameCollabPath(
  doc: Y.Doc,
  fromPath: string,
  toPath: string,
  origin = COLLAB_LOCAL_ORIGIN,
): void {
  const from = fromPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const to = toPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!from || !to || from === to) return;

  const texts = collabTextsMap(doc);
  const blobs = collabBlobsMap(doc);
  const textMoves: { from: string; to: string; content: string }[] = [];
  const blobMoves: { from: string; to: string; mime: string; b64: string }[] = [];

  texts.forEach((ytext, path) => {
    const next = rewritePathPrefix(path, from, to);
    if (next) textMoves.push({ from: path, to: next, content: ytext.toString() });
  });
  blobs.forEach((entry, path) => {
    const next = rewritePathPrefix(path, from, to);
    if (!next) return;
    blobMoves.push({
      from: path,
      to: next,
      mime: String(entry.get("mime") ?? "application/octet-stream"),
      b64: String(entry.get("b64") ?? ""),
    });
  });

  if (!textMoves.length && !blobMoves.length) return;

  doc.transact(() => {
    for (const move of textMoves) {
      texts.delete(move.from);
      setCollabTextContent(ensureCollabText(doc, move.to), move.content, origin);
    }
    for (const move of blobMoves) {
      blobs.delete(move.from);
      if (move.b64) setCollabBlob(doc, move.to, move.mime, move.b64, origin);
    }
  }, origin);
}

function rewritePathPrefix(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  const prefix = from.endsWith("/") ? from : `${from}/`;
  if (path.startsWith(prefix)) return `${to}/${path.slice(prefix.length)}`;
  return null;
}

/** Resolve when the host has published project meta (or time out). */
export function waitForCollabProject(
  doc: Y.Doc,
  options?: { timeoutMs?: number },
): Promise<void> {
  if (collabDocHasProject(doc)) return Promise.resolve();
  const timeoutMs = options?.timeoutMs ?? 90_000;
  return new Promise((resolve, reject) => {
    const meta = collabMetaMap(doc);
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      meta.unobserve(onChange);
      fn();
    };
    const onChange = () => {
      if (collabDocHasProject(doc)) finish(() => resolve());
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(
        "Timed out waiting for the host to Start sharing. Ask them to share, then Join again.",
      )));
    }, timeoutMs);
    meta.observe(onChange);
    onChange();
  });
}

export function writeCollabMeta(doc: Y.Doc, meta: CollabProjectMeta, origin = COLLAB_LOCAL_ORIGIN): void {
  const map = collabMetaMap(doc);
  doc.transact(() => {
    map.set("schemaVersion", meta.schemaVersion);
    map.set("projectId", meta.projectId);
    map.set("name", meta.name);
    map.set("manifestJson", meta.manifestJson);
    map.set("shareActive", true);
    map.delete("shareEndedAt");
    if (meta.rootDocument) map.set("rootDocument", meta.rootDocument);
    if (meta.skippedBlobs?.length) map.set("skippedBlobs", meta.skippedBlobs);
    else map.delete("skippedBlobs");
  }, origin);
}

/** Host share is active unless meta explicitly marks it ended. */
export function isCollabShareActive(doc: Y.Doc): boolean {
  const value = collabMetaMap(doc).get("shareActive");
  return value !== false && value !== 0;
}

/** Host ends the room for every guest (Overleaf-style: owner closes → collaborators leave). */
export function endCollabShare(doc: Y.Doc, origin = COLLAB_LOCAL_ORIGIN): void {
  const map = collabMetaMap(doc);
  doc.transact(() => {
    map.set("shareActive", false);
    map.set("shareEndedAt", Date.now());
  }, origin);
}

/** Observe meta until the host ends the share; fires at most once. */
export function observeCollabShareEnded(doc: Y.Doc, onEnded: () => void): () => void {
  const map = collabMetaMap(doc);
  let fired = false;
  const maybeFire = () => {
    if (fired || isCollabShareActive(doc)) return;
    fired = true;
    onEnded();
  };
  map.observe(maybeFire);
  maybeFire();
  return () => map.unobserve(maybeFire);
}

export function readCollabMeta(doc: Y.Doc): CollabProjectMeta | null {
  const map = collabMetaMap(doc);
  const projectId = String(map.get("projectId") ?? "");
  const manifestJson = String(map.get("manifestJson") ?? "");
  if (!projectId && !manifestJson) return null;
  const skippedRaw = map.get("skippedBlobs");
  const skippedBlobs = Array.isArray(skippedRaw)
    ? skippedRaw.map((entry) => String(entry)).filter(Boolean)
    : undefined;
  return {
    schemaVersion: Number(map.get("schemaVersion") ?? 1),
    projectId,
    name: String(map.get("name") ?? "Shared project"),
    manifestJson,
    rootDocument: map.get("rootDocument") ? String(map.get("rootDocument")) : undefined,
    skippedBlobs,
  };
}

/** Paths currently published in the shared doc (texts + blobs). */
export function listSharedCollabPaths(doc: Y.Doc): Set<string> {
  const shared = new Set<string>();
  collabTextsMap(doc).forEach((_value, path) => shared.add(path));
  collabBlobsMap(doc).forEach((_value, path) => shared.add(path));
  return shared;
}

export function estimateBase64Bytes(base64: string): number {
  const trimmed = base64.trim();
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding);
}

/** Pure helper used by tests: apply a text catalog onto a Y.Doc. */
export function seedTextsIntoDoc(
  doc: Y.Doc,
  files: Record<string, string>,
  origin = COLLAB_LOCAL_ORIGIN,
): void {
  doc.transact(() => {
    for (const [path, content] of Object.entries(files)) {
      const ytext = ensureCollabText(doc, path);
      setCollabTextContent(ytext, content, origin);
    }
  }, origin);
}

export function readTextsFromDoc(doc: Y.Doc): Record<string, string> {
  const out: Record<string, string> = {};
  collabTextsMap(doc).forEach((ytext, path) => {
    out[path] = ytext.toString();
  });
  return out;
}
