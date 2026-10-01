import { useRef } from "react";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { msg } from "@lingui/core/macro";
import { absoluteProjectPath } from "../app-utils";
import { i18n } from "../i18n";
import { notifyCopied } from "../telemetry/app-notify";
import type { FileNode } from "../app-types";
import { fromPierrePath, normalizePointerDraggedPaths } from "./navigator-drag";
import { isDirectoryNode, parentDirectory } from "./project-tree-files";
import type { ProjectTreeModel } from "./project-tree-pointer-drag";

type ClipboardContext = {
  projectKey: string;
  nodes: ReadonlyMap<string, FileNode>;
  onCopyEntries: (paths: string[], targetDirectory: string) => Promise<string[]>;
  onPasteImage: (targetDirectory: string) => void;
  onError: (message: string) => void;
};

/**
 * Command-C puts the selected files' absolute paths on the clipboard. Command-V
 * copies those files into the selected directory while the clipboard still
 * holds exactly that text, and otherwise pastes a clipboard image as a figure.
 */
export function useProjectTreeClipboard(model: ProjectTreeModel, current: () => ClipboardContext) {
  const copiedEntriesRef = useRef<Promise<{ projectKey: string; paths: string[]; text: string }> | null>(null);
  const copy = () => {
    const paths = normalizePointerDraggedPaths(model.getSelectedPaths()).map(fromPierrePath);
    if (!paths.length) return;
    const { projectKey } = current();
    const text = paths.map((path) => absoluteProjectPath(projectKey, path)).join("\n");
    const copied = writeText(text).then(() => ({ projectKey, paths, text }));
    copiedEntriesRef.current = copied;
    const count = paths.length;
    void copied.then(
      () => notifyCopied(count === 1 ? i18n._(msg`Path copied`) : i18n._(msg`${count} paths copied`)),
      (reason) => {
        if (copiedEntriesRef.current === copied) copiedEntriesRef.current = null;
        current().onError(String(reason));
      },
    );
  };
  const paste = async () => {
    const selectedPath = model.getSelectedPaths().at(-1) ?? "";
    const selectedNode = current().nodes.get(selectedPath);
    const targetDirectory = selectedNode && isDirectoryNode(selectedNode)
      ? fromPierrePath(selectedPath)
      : parentDirectory(fromPierrePath(selectedPath));
    const { projectKey } = current();
    const copied = await copiedEntriesRef.current?.catch(() => null);
    if (copied?.projectKey === projectKey) {
      // A later copy in an editor or another app must supersede our file selection.
      const text = await readText().catch(() => null);
      if (current().projectKey !== projectKey) return;
      if (text === copied.text) {
        await current().onCopyEntries(copied.paths, targetDirectory);
        return;
      }
    }
    if (current().projectKey === projectKey) current().onPasteImage(targetDirectory);
  };
  return { copy, paste };
}
