/**
 * What the project tree shows: the app's `FileNode` snapshot translated into
 * Pierre's path list, the opt-in hidden-files view, and the Git decorations.
 */
import { useEffect, useMemo, useState } from "react";
import { useLatestRef } from "../hooks/use-latest-ref";
import { invoke } from "@tauri-apps/api/core";
import type { GitStatusEntry } from "@pierre/trees";
import type { FileNode, GitFileStatus } from "../app-types";
import { fromPierrePath, toPierreDirectoryPath } from "./navigator-drag";
import { onProjectFilesChanged } from "./project-files-changed";

/**
 * The Rust scanner only emits "directory"; "folder" survives because the App
 * test fixtures (outside this directory) still build trees with it.
 */
export const isDirectoryNode = (node: FileNode) => node.kind === "directory" || node.kind === "folder";

/** Pierre addresses a directory with a trailing slash and a file without. */
export function treePath(path: string, directory: boolean): string {
  return directory ? toPierreDirectoryPath(path) : path;
}

export function parentDirectory(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

type ProjectTreeEntries = {
  directoryPaths: string[];
  /** Keyed by Pierre path. */
  nodes: Map<string, FileNode>;
  paths: string[];
};

function projectTreeEntries(files: readonly FileNode[]): ProjectTreeEntries {
  const directories = new Set<string>();
  const nodes = new Map<string, FileNode>();
  const paths: string[] = [];
  const visit = (node: FileNode) => {
    const directory = isDirectoryNode(node);
    const path = treePath(node.path, directory);
    const segments = fromPierrePath(path).split("/");
    const directorySegmentCount = directory ? segments.length : segments.length - 1;
    for (let index = 1; index <= directorySegmentCount; index += 1) {
      directories.add(`${segments.slice(0, index).join("/")}/`);
    }
    nodes.set(path, node);
    paths.push(path);
    node.children.forEach(visit);
  };
  files.forEach(visit);
  return { directoryPaths: [...directories], nodes, paths };
}

function hideTemplateFiles(files: FileNode[]): FileNode[] {
  return files.filter((file) => isDirectoryNode(file) || !/\.(sty|bst)$/i.test(file.name))
    .map((file) => isDirectoryNode(file) ? { ...file, children: hideTemplateFiles(file.children) } : file);
}

/** Stored without Pierre's trailing slash; returned in the form the tree wants back. */
export function readExpandedDirectories(key: string): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(stored)
      ? [...new Set(stored.filter((path): path is string => typeof path === "string"))].map(toPierreDirectoryPath)
      : [];
  } catch {
    return [];
  }
}

const PIERRE_GIT_STATUSES = new Set(["added", "deleted", "ignored", "modified", "renamed", "untracked"]);

/** Backend-only states map conservatively onto Pierre's decorations. */
export function toPierreGitStatus(files: readonly GitFileStatus[]): GitStatusEntry[] {
  return files.map(({ path, status }) => ({
    path,
    status: (PIERRE_GIT_STATUSES.has(status) ? status : status === "copied" ? "added" : "modified") as GitStatusEntry["status"],
  }));
}

const SHOW_HIDDEN_FILES_KEY = "lattice:show-hidden-files";

/**
 * The default tree hides template support files. The remembered "show hidden
 * files" view asks the backend for its expanded listing instead, refreshed by
 * the file watcher and a slow poll for watcher-less hosts.
 */
export function useProjectTreeFiles(projectKey: string, files: FileNode[], onError: (message: string) => void) {
  const [showHidden, setShowHidden] = useState(() => {
    try { return localStorage.getItem(SHOW_HIDDEN_FILES_KEY) === "true"; }
    catch { return false; }
  });
  const [expandedTree, setExpandedTree] = useState<{ root: string; files: FileNode[] } | null>(null);
  const toggleHidden = () => {
    const next = !showHidden;
    setShowHidden(next);
    try { localStorage.setItem(SHOW_HIDDEN_FILES_KEY, String(next)); }
    catch { /* The toggle still works when storage is unavailable. */ }
  };
  const onErrorRef = useLatestRef(onError);
  useEffect(() => {
    if (!showHidden) return;
    let disposed = false;
    let generation = 0;
    const refresh = async () => {
      const request = ++generation;
      try {
        const files = await invoke<FileNode[]>("list_project_tree_with_hidden", { projectRoot: projectKey });
        if (!disposed && request === generation) setExpandedTree({ root: projectKey, files });
      } catch (error) {
        if (!disposed && request === generation) onErrorRef.current(String(error));
      }
    };
    void refresh();
    const stopListening = onProjectFilesChanged(projectKey, () => void refresh());
    // The fallback poll also supports watcher-less hosts.
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => { disposed = true; stopListening(); window.clearInterval(timer); };
  }, [showHidden, projectKey, files, onErrorRef]);
  const tree = useMemo(() => projectTreeEntries(showHidden
    ? (expandedTree?.root === projectKey ? expandedTree.files : files)
    : hideTemplateFiles(files)), [showHidden, expandedTree, projectKey, files]);
  return { showHidden, toggleHidden, tree };
}
