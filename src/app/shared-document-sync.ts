import { invoke } from "@tauri-apps/api/core";
import type {
  OverleafAcceptedAction,
  OverleafAuthoritativeEntry,
  OverleafPreparedAction,
  OverleafPreparedSync,
  OverleafSyncResult,
} from "../app-types";
import type {
  CollabLocalMutationsV2,
  CollabMaterializeCallbacksV2,
  CollabProjectControllerV2,
  SideloadedTextBindingV2,
} from "../collab/collab-project-v2";
import {
  assertCollabWorkspaceLease,
  type CollabDiskWriteQueue,
  type CollabWorkspaceLease,
} from "../collab/collab-workspace-lease";
import type { OpenSlideMutation } from "../editor/presentation/open-slide-bridge";
import { diagnosticInvoke } from "../telemetry/diagnostic-request";
import { setWarning } from "./notify";

/**
 * Writes that must land in a live Lattice Share (Yjs v2) as well as on disk:
 * an Overleaf sync of a shared project, and Open Slide's own file edits. Both
 * three-way merge incoming text into the shared document rather than
 * overwriting a collaborator's concurrent edit.
 */

export type EditorWriteResult = {
  content: string;
  transactionId: string;
  externalChangesMerged: boolean;
  hadConflicts: boolean;
};

/** The disk side of a share: App's materialize callbacks, with the optional tree mutations present. */
export type SharedWorkspaceDisk = CollabMaterializeCallbacksV2
  & Required<Pick<CollabMaterializeCallbacksV2, "rename" | "delete">>;

export type SharedWorkspace = {
  controller: CollabProjectControllerV2;
  lease: CollabWorkspaceLease;
  disk: SharedWorkspaceDisk;
  projectRoot: string;
};

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();
const encodeText = (text: string) => bytesToBase64(textEncoder.encode(text));
const decodeText = (base64: string) => textDecoder.decode(base64ToBytes(base64));

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  pdf: "application/pdf",
};

function projectFileMimeType(path: string): string {
  return MIME_TYPES[path.split(".").at(-1)?.toLocaleLowerCase() ?? ""] ?? "application/octet-stream";
}

function localMutations(disk: SharedWorkspaceDisk): CollabLocalMutationsV2 {
  return {
    rename: disk.rename,
    delete: disk.delete,
    writeBinaryConflict: (path, bytes, root) => disk.writeBytes(path, bytes, root),
  };
}

type SharedDoc = SideloadedTextBindingV2["doc"];
type StructuredCodec = { content: (doc: SharedDoc) => string; replace: (doc: SharedDoc, source: string) => void };

/** Boards and spreadsheets keep structured Yjs state beside the content text; their codecs load on first use. */
const structuredCodecs: Record<"board" | "spreadsheet", () => Promise<StructuredCodec>> = {
  board: async () => {
    const { boardDocContent, replaceBoardDocFromSource } = await import("../editor/board/board-yjs-bridge");
    return { content: boardDocContent, replace: replaceBoardDocFromSource };
  },
  spreadsheet: async () => {
    const { spreadsheetDocContent, replaceSpreadsheetDocFromSource } = await import("../editor/spreadsheet/spreadsheet-yjs");
    return { content: spreadsheetDocContent, replace: replaceSpreadsheetDocFromSource };
  },
};

async function bindingContent(binding: SideloadedTextBindingV2, kind: OverleafAuthoritativeEntry["kind"]): Promise<string> {
  if (kind === "board" || kind === "spreadsheet") return (await structuredCodecs[kind]()).content(binding.doc);
  return binding.ytext.toString();
}

/** The share's live catalog entry for `path`, if it has one. */
function liveCatalogFile(controller: CollabProjectControllerV2, path: string) {
  return controller.catalogFiles().find((entry) => entry.path === path && entry.state === "live");
}

/** Upload `bytes` as `path`'s shared content; importing over a live path is an update, not a create. */
export async function publishSharedBinary(
  controller: CollabProjectControllerV2,
  path: string,
  bytes: Uint8Array,
  mimeType: string,
  mutations: CollabLocalMutationsV2,
): Promise<void> {
  if (!liveCatalogFile(controller, path)) await controller.create(path, "binary");
  await controller.replaceBinary(path, bytes, mimeType, mutations);
}

/** Put `bytes` in the share, then on disk. */
async function writeSharedBinary({ controller, disk, projectRoot }: SharedWorkspace, path: string, bytes: Uint8Array) {
  await publishSharedBinary(controller, path, bytes, projectFileMimeType(path), localMutations(disk));
  await disk.writeBytes(path, bytes, projectRoot);
}

async function withSideloadedText<T>(
  controller: CollabProjectControllerV2,
  path: string,
  bindingId: string,
  operation: (binding: SideloadedTextBindingV2) => Promise<T>,
): Promise<T> {
  const binding = await controller.openSideloadedText(path, bindingId);
  try {
    return await operation(binding);
  } finally {
    binding.release();
  }
}

/**
 * Three-way merges `edited` (a change against `base`) into a shared text. A
 * concurrent edit moves the binding's version under the merge, so retry
 * against the new text a few times before giving up.
 */
async function mergeIntoSharedText(
  binding: SideloadedTextBindingV2,
  base: string,
  edited: string,
  path: string,
): Promise<{ content: string; hadConflicts: boolean }> {
  for (let attempt = 0; ; attempt += 1) {
    const version = binding.version;
    const merged = await invoke<{ content: string; hadConflicts: boolean }>("merge_project_text", {
      base,
      edited,
      current: binding.ytext.toString(),
    });
    try {
      binding.applyExternalText(merged.content, version);
      return { content: binding.ytext.toString(), hadConflicts: merged.hadConflicts };
    } catch {
      if (attempt === 3) throw new Error(`Could not merge concurrent edits to ${path}.`);
    }
  }
}

function catalogKindForNewPath(action: OverleafPreparedAction): OverleafAuthoritativeEntry["kind"] {
  const lower = action.path.toLocaleLowerCase("en-US");
  if (action.binary) return "binary";
  if (lower.endsWith(".tldr")) return "board";
  if (lower.endsWith(".lattice-sheet")) return "spreadsheet";
  return "text";
}

/**
 * Syncs a shared project with its Overleaf link. The share, not the disk, is
 * authoritative: the backend plans against the share's inventory, and every
 * incoming change is applied to the shared documents before it is written
 * locally. Anything that cannot be applied safely right now is deferred.
 */
export async function syncSharedProjectWithOverleaf(
  workspace: SharedWorkspace,
  commitOpenText: (path: string, content: string) => void,
  request: { observedRemoteVersion?: number | null; livePaths: readonly string[]; operationId: string },
): Promise<OverleafSyncResult> {
  const { controller, lease, disk, projectRoot } = workspace;
  await controller.settled();
  await controller.flush();
  await controller.refetchCatalog();
  assertCollabWorkspaceLease(lease);

  const inventory: OverleafAuthoritativeEntry[] = [];
  for (const file of controller.catalogFiles().filter((entry) => entry.state === "live")) {
    assertCollabWorkspaceLease(lease);
    const base64 = file.kind === "binary"
      ? bytesToBase64(await controller.downloadBinary(file.path))
      : await withSideloadedText(controller, file.path, `overleaf-inventory:${crypto.randomUUID()}`, async (binding) => (
        encodeText(await bindingContent(binding, file.kind))
      ));
    inventory.push({ path: file.path, kind: file.kind, base64 });
  }

  const prepared = await diagnosticInvoke<OverleafPreparedSync>("overleaf_prepare_sync", {
    projectRoot,
    authoritativeInventory: inventory,
    live: request.livePaths,
    observedRemoteVersion: request.observedRemoteVersion ?? null,
  }, { operationId: request.operationId });
  const acceptedActions: OverleafAcceptedAction[] = [];
  const acceptedPaths = new Set<string>();
  const deferred = new Set<string>();
  let concurrentTextConflicts = false;

  /** The accepted content for one planned action, or null to defer it. */
  const accept = async (action: OverleafPreparedAction): Promise<string | null> => {
    const file = liveCatalogFile(controller, action.path);
    // Catalog deletion and a Yjs edit cannot be one atomic operation. Keep
    // remote deletions pending while a Share is live rather than deleting a
    // peer's edit in the gap between an equality check and the tree update.
    if (action.kind === "delete") return null;
    const conflict = prepared.result.conflicts.find((item) => item.path === action.path);
    if (conflict && !acceptedPaths.has(conflict.localCopy)) return null;

    if (action.outgoing) {
      if (!file) return null;
      if (file.kind === "binary") return bytesToBase64(await controller.downloadBinary(action.path));
      return withSideloadedText(controller, action.path, `overleaf-outgoing:${action.actionId}`, async (binding) => (
        encodeText(await bindingContent(binding, file.kind))
      ));
    }

    const afterBase64 = action.afterBase64;
    if (!afterBase64) return null;
    if (action.kind === "create") {
      if (file) return null;
      const kind = catalogKindForNewPath(action);
      if (kind === "binary") {
        await writeSharedBinary(workspace, action.path, base64ToBytes(afterBase64));
      } else {
        const content = decodeText(afterBase64);
        await controller.create(action.path, kind, { seedText: content });
        await disk.writeText(action.path, content, projectRoot);
        commitOpenText(action.path, content);
      }
      return afterBase64;
    }

    if (!file || action.binary !== (file.kind === "binary")) return null;
    if (file.kind === "binary") {
      if (bytesToBase64(await controller.downloadBinary(action.path)) !== action.beforeBase64) return null;
      const replacement = base64ToBytes(afterBase64);
      await controller.replaceBinary(action.path, replacement, projectFileMimeType(action.path), localMutations(disk));
      await disk.writeBytes(action.path, replacement, projectRoot);
      return afterBase64;
    }

    const kind = file.kind;
    return withSideloadedText(controller, action.path, `overleaf-incoming:${action.actionId}`, async (binding) => {
      let canonical: string;
      if (kind === "text") {
        const merged = await mergeIntoSharedText(
          binding,
          action.beforeBase64 ? decodeText(action.beforeBase64) : "",
          decodeText(afterBase64),
          action.path,
        );
        canonical = merged.content;
        concurrentTextConflicts ||= merged.hadConflicts;
      } else {
        if (encodeText(await bindingContent(binding, kind)) !== action.beforeBase64) return null;
        try {
          const source = decodeText(afterBase64);
          const version = binding.version;
          const { replace } = await structuredCodecs[kind]();
          binding.applyExternalDocument((doc) => replace(doc, source), version);
        } catch {
          return null;
        }
        canonical = await bindingContent(binding, kind);
      }
      await disk.writeText(action.path, canonical, projectRoot);
      commitOpenText(action.path, canonical);
      return encodeText(canonical);
    });
  };

  for (const action of prepared.actions) {
    assertCollabWorkspaceLease(lease);
    const base64 = await accept(action);
    if (base64 === null) {
      deferred.add(action.path);
    } else {
      acceptedActions.push({ actionId: action.actionId, base64 });
      acceptedPaths.add(action.path);
    }
  }

  await controller.settled();
  await controller.flush();
  assertCollabWorkspaceLease(lease);
  const result = await diagnosticInvoke<OverleafSyncResult>("overleaf_commit_prepared_sync", {
    projectRoot,
    preparedPlanId: prepared.planId,
    acceptedActions,
  }, { operationId: request.operationId });
  if (concurrentTextConflicts) {
    setWarning("Overleaf and a Lattice collaborator changed the same lines; both versions were kept with conflict markers.", "Overleaf");
  } else if (deferred.size) {
    setWarning(`Overleaf changes were deferred while this Share was changing: ${[...deferred].join(", ")}.`, "Overleaf");
  }
  return result;
}

/**
 * Writes one Open Slide edit, through the share when one is live, and returns
 * the canonical content that landed (a three-way merge may differ from what
 * Open Slide sent).
 */
export async function writeOpenSlideMutation(
  mutation: OpenSlideMutation,
  projectRoot: string,
  shared: (SharedWorkspace & { queue: CollabDiskWriteQueue }) | null,
  projectStillOpen: () => boolean,
): Promise<{ text?: string; base64?: string; hadConflicts: boolean }> {
  const { path } = mutation;
  if (mutation.kind === "delete") {
    if (shared && liveCatalogFile(shared.controller, path)) {
      await shared.controller.delete(path, localMutations(shared.disk));
      return { hadConflicts: false };
    }
    try {
      await invoke("delete_project_entry", { path, projectRoot });
    } catch (reason) {
      // The shadow watcher and native project watcher can report the same
      // unlink concurrently. A missing canonical file already satisfies
      // the requested delete, so acknowledge that echo instead of rolling
      // it back into Open Slide and showing an error.
      if (!projectStillOpen()) throw reason;
      const stat = await invoke<{ exists: boolean }>("stat_project_file", { path }).catch(() => null);
      if (stat?.exists !== false) throw reason;
    }
    return { hadConflicts: false };
  }

  if (mutation.text !== undefined) {
    const text = mutation.text;
    if (!shared) {
      const written = await invoke<EditorWriteResult>("write_project_file", {
        path,
        content: text,
        baseContent: mutation.kind === "write" ? mutation.previousText : undefined,
        projectRoot,
      });
      return { text: written.content, hadConflicts: written.hadConflicts };
    }
    const { controller, lease, queue } = shared;
    const write = (content: string, baseContent?: string) => queue.run(lease, path, () => (
      invoke<EditorWriteResult>("write_project_file", { path, content, baseContent, projectRoot })
    ));
    if (!controller.hasTextPath(path)) {
      await controller.create(path, "text", { seedText: text });
      await write(text);
      return { text, hadConflicts: false };
    }
    return withSideloadedText(controller, path, `open-slide:${mutation.id}:${crypto.randomUUID()}`, async (binding) => {
      const merged = await mergeIntoSharedText(binding, mutation.previousText ?? "", text, path);
      let hadConflicts = merged.hadConflicts;
      const written = await write(merged.content, mutation.previousText);
      hadConflicts ||= written.hadConflicts;
      if (written.content === merged.content) return { text: merged.content, hadConflicts };
      // The disk held edits the share had not seen: fold them in and rewrite.
      const remerged = await mergeIntoSharedText(binding, merged.content, written.content, path);
      hadConflicts ||= remerged.hadConflicts;
      return { text: (await write(remerged.content)).content, hadConflicts };
    });
  }

  if (mutation.base64 !== undefined) {
    if (shared) await writeSharedBinary(shared, path, base64ToBytes(mutation.base64));
    else await invoke("write_project_bytes", { path, base64Data: mutation.base64, projectRoot });
    return { base64: mutation.base64, hadConflicts: false };
  }

  throw new Error(`Open Slide sent an incomplete edit for ${path}.`);
}
