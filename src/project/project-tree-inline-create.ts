/**
 * Inline creation in the project tree: a placeholder row is added to Pierre's
 * model and opened for renaming, and only a confirmed name reaches the backend.
 * Until then the path is an optimistic UI draft that must never leak out as a
 * file that does not exist.
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { fromPierrePath } from "./navigator-drag";
import { treePath } from "./project-tree-files";
import type { ProjectTreeModel } from "./project-tree-pointer-drag";

export type EntryKind = "file" | "folder" | "presentation";

type PendingCreation = { kind: EntryKind; extension?: string };

const isDirectoryDraft = (kind: EntryKind) => kind !== "file";

function removeDraft(model: ProjectTreeModel, modelPath: string, directory: boolean) {
  model.remove(modelPath, directory ? { recursive: true } : undefined);
}

/**
 * Pierre already shows `optimisticPath`. Follow the backend when it settled on
 * another name, and restore the real tree when it refused.
 */
export function settleTreePath(
  model: ProjectTreeModel,
  optimisticPath: string,
  actualPath: Promise<string>,
  resetTree: () => void,
) {
  void actualPath
    .then((path) => {
      if (path !== optimisticPath && model.getItem(optimisticPath) && !model.getItem(path)) {
        model.move(optimisticPath, path);
      }
    })
    .catch(resetTree);
}

export function useInlineCreation(
  model: ProjectTreeModel,
  options: {
    onCreateEntry: (path: string, kind: EntryKind) => Promise<string>;
    resetTree: () => void;
  },
) {
  const pendingRef = useRef(new Map<string, PendingCreation>());
  const cleanupTimersRef = useRef(new Map<string, number>());
  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    optionsRef.current = options;
  });

  const clear = useCallback((path: string) => {
    const normalizedPath = fromPierrePath(path);
    const pending = pendingRef.current.get(normalizedPath);
    if (!pending) return false;
    pendingRef.current.delete(normalizedPath);
    const directoryDraft = isDirectoryDraft(pending.kind);
    const modelPath = treePath(normalizedPath, directoryDraft);
    if (model.getItem(modelPath)) removeDraft(model, modelPath, directoryDraft);
    return true;
  }, [model]);

  const persist = useCallback((sourcePath: string, destinationPath: string, isFolder: boolean) => {
    const source = fromPierrePath(sourcePath);
    const pending = pendingRef.current.get(source);
    if (!pending) return false;
    pendingRef.current.delete(source);
    // Creation modes may pin an extension (e.g. boards → .tldr) so the inline
    // name stays extension-free; an explicit user-typed extension wins.
    let destination = fromPierrePath(destinationPath);
    if (pending.extension && !/\.[^./\\]+$/.test(destination.split("/").at(-1) ?? "")) {
      destination = `${destination}.${pending.extension}`;
    }
    const { onCreateEntry, resetTree } = optionsRef.current;
    if (pending.kind === "presentation") {
      void onCreateEntry(destination.replace(/^slides\//, ""), pending.kind).then(resetTree, resetTree);
    } else {
      settleTreePath(
        model,
        treePath(destination, isFolder),
        onCreateEntry(destination, pending.kind).then((created) => treePath(created, isFolder)),
        resetTree,
      );
    }
    return true;
  }, [model]);

  useEffect(
    () => model.onMutation("remove", (event) => {
      pendingRef.current.delete(fromPierrePath(event.path));
    }),
    [model],
  );

  useEffect(() => {
    const timers = cleanupTimersRef.current;
    const scheduleCleanup = () => {
      for (const path of pendingRef.current.keys()) {
        if (timers.has(path)) continue;
        timers.set(path, window.setTimeout(() => {
          timers.delete(path);
          if (!pendingRef.current.has(path)) return;
          const input = model.getFileTreeContainer()?.shadowRoot
            ?.querySelector<HTMLInputElement>("[data-item-rename-input]");
          const inputPath = input?.closest<HTMLElement>("[data-item-path]")?.dataset.itemPath;
          if (!input || !inputPath || fromPierrePath(inputPath) !== path) {
            // No input and no persistence callback means Pierre completed an
            // unchanged rename on blur. The path is still only an optimistic UI
            // draft, so remove it instead of exposing a non-existent file.
            clear(path);
            return;
          }
          if (input.dataset.latticePendingCreationBound === "true") return;
          input.dataset.latticePendingCreationBound = "true";
          input.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" || input.value.trim() !== (path.split("/").at(-1) ?? "")) return;
            // Pierre treats an unchanged rename as a no-op and therefore
            // skips onRename. Enter still means "create".
            const pending = pendingRef.current.get(path);
            if (pending) persist(path, path, isDirectoryDraft(pending.kind));
          }, { capture: true });
        }, 0));
      }
    };
    const unsubscribe = model.subscribe(scheduleCleanup);
    return () => {
      unsubscribe();
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, [clear, model, persist]);

  const begin = (targetDirectory: string, kind: EntryKind, extension?: string) => {
    // A context-menu click blurs any previous draft. Remove that draft before
    // choosing a placeholder so a canceled creation never leaks into the next
    // name as "untitled-2".
    for (const path of [...pendingRef.current.keys()]) clear(path);
    const directory = fromPierrePath(targetDirectory);
    const directoryDraft = isDirectoryDraft(kind);
    const placeholder = (suffix: number) => {
      const basename = suffix > 1 ? `untitled-${suffix}` : "untitled";
      return directory ? `${directory}/${basename}` : basename;
    };
    let suffix = 1;
    while (model.getItem(treePath(placeholder(suffix), directoryDraft))) suffix += 1;
    const placeholderPath = placeholder(suffix);
    const modelPath = treePath(placeholderPath, directoryDraft);
    model.add(modelPath);
    pendingRef.current.set(placeholderPath, { kind, extension });
    if (!model.startRenaming(modelPath, { removeIfCanceled: true })) {
      pendingRef.current.delete(placeholderPath);
      removeDraft(model, modelPath, directoryDraft);
    }
  };

  return { begin, clear, persist, isPending: (path: string) => pendingRef.current.has(path) };
}

/**
 * Header actions (e.g. "New board") request an inline creation through a
 * monotonically increasing signal; each new value starts one draft.
 */
export function useCreateRequest(request: number | undefined, start: () => void) {
  const handledRef = useRef(request ?? 0);
  const startRef = useRef(start);
  useLayoutEffect(() => {
    startRef.current = start;
  });
  useEffect(() => {
    if ((request ?? 0) === handledRef.current) return;
    handledRef.current = request ?? 0;
    startRef.current();
  }, [request]);
}
