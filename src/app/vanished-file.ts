/**
 * What happens once the open file has left its path behind the editor (see
 * vanished-file-wait.ts; this module loads only then, off the startup path).
 */
import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { toMessage } from "../app-utils";
import { i18n } from "../i18n";
import { notifyError, notifyInfo, notifySuccess, notifyWarning } from "../telemetry/app-notify";
import type { EditorWriteResult } from "./open-slide-writes";
import { readDiskVersion, UNREAD_DISK_VERSION } from "./read-document";
import { writeSourceCopy } from "./save-source-copy";
import { isVanished, type DocumentStore, type VanishedFile } from "./use-document-store";
import type { DocumentTreeChanges } from "./use-document-tree-changes";
import { settleVanished, vanishedToastKey } from "./vanished-file-wait";

/** The open documents' state and commands, as of the call. */
export type VanishedContext = {
  store: DocumentStore;
  save: () => Promise<boolean>;
  tree: DocumentTreeChanges;
};

/**
 * How long a missing file is given to come back before it counts as gone: a
 * save that deletes the old file before writing the new one (some editors',
 * some sync tools') leaves the path empty for a moment.
 */
const VANISH_CONFIRM_MS = 1000;

const source = () => i18n._(msg`Save`);

/** The writer's choice about `vanished` is still open, and it is still the open file. */
const stillWaiting = ({ vanishedRef, fileRef, renderedRef }: DocumentStore, vanished: VanishedFile) => (
  vanishedRef.current === vanished && fileRef.current === vanished.path && renderedRef.current.project?.root === vanished.root
);

/** `destination`'s path inside the project at `root`, or null when it lies outside. */
const projectPathOf = (root: string, destination: string) => (
  destination.startsWith(`${root}/`) ? destination.slice(root.length + 1) : null
);

/**
 * The disk poll found the open file `path` missing; `fileId` is the file it
 * last saw there (read-document.ts `DiskVersion`). `isCurrent` turns false
 * once the poll that asked is over.
 */
export async function handleMissingFile(context: VanishedContext, path: string, fileId: string, isCurrent: () => boolean) {
  const { fileRef, textRef, savedRef, vanishedRef, renderedRef } = context.store;
  const stillOpen = () => isCurrent() && fileRef.current === path;
  const waiting = vanishedRef.current;
  if (waiting && isVanished(waiting, renderedRef.current.project?.root, path)) {
    // Edits undone back to the saved text leave nothing to keep.
    if (textRef.current === savedRef.current) {
      settleVanished(vanishedRef, waiting);
      await closeDeleted(context, path);
    }
    return;
  }
  await new Promise((resolve) => window.setTimeout(resolve, VANISH_CONFIRM_MS));
  const back = await invoke<{ exists: boolean }>("stat_project_file", { path }).catch(() => null);
  if (!stillOpen() || back?.exists !== false) return;
  const moved = await invoke<string | null>("find_moved_project_file", { fileId, text: savedRef.current })
    .catch(() => null);
  if (!stillOpen()) return;
  if (moved && moved !== path) {
    follow(context, path, moved);
    notifyInfo(source(), i18n._(msg`${path} was moved to ${moved}`), {
      detail: i18n._(msg`It was moved outside Lattice, and its tab followed it.`),
    });
  } else if (textRef.current === savedRef.current) {
    await closeDeleted(context, path);
  } else {
    hold(context, path);
  }
}

/** Carry the tab, its buffer and its history to `nextPath`. */
function follow({ store, tree }: VanishedContext, previousPath: string, nextPath: string) {
  tree.move([{ previousPath, nextPath }]);
  // The file may have landed on one already open in another tab.
  store.setTabs((tabs) => [...new Set(tabs)]);
  store.diskVersionRef.current = UNREAD_DISK_VERSION;
  void store.depsRef.current.refreshProject().catch(() => undefined);
}

/** Close the tab of a deleted file with nothing unsaved, as Lattice's own delete does. */
async function closeDeleted({ tree }: VanishedContext, path: string) {
  await tree.remove([path]);
  notifyInfo(source(), i18n._(msg`${path} was deleted`), {
    detail: i18n._(msg`It was deleted outside Lattice and had no unsaved edits, so its tab closed.`),
  });
}

/** Hold the unsaved edits of `path` and offer the writer the ways out. */
function hold(context: VanishedContext, path: string) {
  const root = context.store.renderedRef.current.project?.root;
  if (!root) return;
  const vanished: VanishedFile = {
    root,
    path,
    recreate: false,
    announce: () => notifyWarning(source(), i18n._(msg`${path} is no longer on disk`), {
      detail: i18n._(msg`It was deleted or moved outside Lattice. Your unsaved edits are still open: recreate the file, save them elsewhere, or close its tab to discard them.`),
      primaryAction: { label: i18n._(msg`Recreate`), onClick: () => recreate(context, vanished) },
      secondaryAction: { label: i18n._(msg`Save As…`), onClick: () => saveElsewhere(context, vanished) },
      timeoutMs: 0,
      dedupeKey: vanishedToastKey(path),
    }),
  };
  context.store.vanishedRef.current = vanished;
  vanished.announce();
}

/** Write the edits back where the file was; a file that came back meanwhile is saved into, merging as usual. */
async function recreate({ store, save }: VanishedContext, vanished: VanishedFile) {
  const { vanishedRef, depsRef } = store;
  if (!stillWaiting(store, vanished)) return;
  const { path } = vanished;
  if (await readDiskVersion(path)) settleVanished(vanishedRef, vanished);
  else vanished.recreate = true;
  const saved = await save();
  vanished.recreate = false;
  if (!saved || vanishedRef.current === vanished) {
    vanished.announce();
    return;
  }
  settleVanished(vanishedRef, vanished);
  void depsRef.current.refreshProject().catch(() => undefined);
  notifySuccess(source(), i18n._(msg`Recreated ${path}`));
}

/** Ask where the edits go: into the project, the tab follows; outside it, a copy is written and the tab closes. */
async function saveElsewhere(context: VanishedContext, vanished: VanishedFile) {
  const { store, tree } = context;
  const { textRef, vanishedRef, depsRef } = store;
  if (!stillWaiting(store, vanished)) return;
  const { root } = vanished;
  const { path } = vanished;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const destination = await saveDialog({ title: i18n._(msg`Save ${name} As`), defaultPath: `${root}/${path}` })
    .catch(() => null);
  if (!stillWaiting(store, vanished)) return;
  // Cancelled: the choice is still open.
  if (!destination) {
    vanished.announce();
    return;
  }
  const nextPath = projectPathOf(root, destination);
  if (nextPath === path) {
    await recreate(context, vanished);
    return;
  }
  store.flush();
  const text = textRef.current;
  try {
    if (nextPath === null) {
      const written = await writeSourceCopy(destination, text);
      settleVanished(vanishedRef, vanished);
      await tree.remove([path]);
      notifySuccess(source(), i18n._(msg`Saved your edits to ${written}`), {
        detail: i18n._(msg`That file is outside this project, so the tab closed.`),
      });
      return;
    }
    const result = await invoke<EditorWriteResult>("write_project_file", { path: nextPath, content: text, projectRoot: root });
    settleVanished(vanishedRef, vanished);
    follow(context, path, nextPath);
    // What the buffer grew from is the base its next save merges against.
    if (!store.accept(nextPath, result.content, { text })) store.setSavedText(text);
    depsRef.current.onSaved(root, [nextPath]);
    notifySuccess(source(), i18n._(msg`Saved your edits as ${nextPath}`));
  } catch (reason) {
    notifyError(source(), i18n._(msg`Could not save ${name}`), { detail: toMessage(reason) });
    vanished.announce();
  }
}
