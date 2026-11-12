/**
 * The open project, held in memory: its files by relative path (text as
 * strings, binaries as bytes) and the folders created in the page. The file
 * commands read and write it, so edits, new files and renames last for the
 * life of the page, as on disk.
 */
import type { FileNode, ProjectManifest, ProjectSnapshot } from "../../src/app-types";
import { NOT_HANDLED, type Args } from "./tauri-internals";

export type ProjectFiles = Map<string, string | Uint8Array>;
type Contents = { root: string; id: string; name: string; files: ProjectFiles };

/** The modification time every file reports: the pages never change one behind the app's back. */
export const MOCK_MTIME = 1_700_000_000_000;

/** Files shipped in a template folder (an `import.meta.glob` of it), keyed by their path under `folder/`. */
export function filesUnder(folder: string, globbed: Record<string, string>): Array<[string, string]> {
  return Object.entries(globbed).map(([path, value]) => [path.slice(path.indexOf(`/${folder}/`) + folder.length + 2), value]);
}

export class MockProject implements Contents {
  root: string;
  id: string;
  name: string;
  files: ProjectFiles;
  /** Folders created in the page; any other folder exists through the files in it. */
  readonly folders = new Set<string>();

  constructor(contents: Contents) {
    ({ root: this.root, id: this.id, name: this.name, files: this.files } = contents);
  }

  /** Opens another project in place of this one. */
  replace(contents: Contents) {
    ({ root: this.root, id: this.id, name: this.name, files: this.files } = contents);
    this.folders.clear();
  }

  /** A command's `path`, relative to the project whether it came absolute or not. */
  path(args: Args): string {
    const path = args?.path;
    if (typeof path !== "string") throw new Error("missing path");
    return this.relative(path);
  }

  private relative(path: string): string {
    return path === this.root ? "" : path.startsWith(`${this.root}/`) ? path.slice(this.root.length + 1) : path;
  }

  /** A text file's contents, or "" for a binary or missing one. */
  text(path: string): string {
    const content = this.files.get(path);
    return typeof content === "string" ? content : "";
  }

  snapshot(manifest: Omit<ProjectManifest, "schemaVersion" | "projectId" | "name">): ProjectSnapshot {
    return {
      root: this.root,
      manifest: { schemaVersion: 1, projectId: this.id, name: this.name, ...manifest },
      files: this.tree(),
    };
  }

  tree(): FileNode[] {
    const root: FileNode = { name: "", path: "", kind: "directory", contentKind: "directory", children: [] };
    const directories = new Map<string, FileNode>([["", root]]);
    const directory = (path: string): FileNode => {
      const existing = directories.get(path);
      if (existing) return existing;
      const slash = path.lastIndexOf("/");
      const node: FileNode = {
        name: path.slice(slash + 1), path, kind: "directory", contentKind: "directory", children: [],
      };
      directory(slash < 0 ? "" : path.slice(0, slash)).children.push(node);
      directories.set(path, node);
      return node;
    };
    for (const path of this.folders) directory(path);
    for (const [path, content] of this.files) {
      // The paper cache is out of the tree, as the backend leaves it out.
      if (path.startsWith(".research/")) continue;
      const slash = path.lastIndexOf("/");
      directory(slash < 0 ? "" : path.slice(0, slash)).children.push({
        name: path.slice(slash + 1),
        path,
        kind: kindOf(path),
        contentKind: typeof content === "string" ? "text" : "binary",
        size: content.length,
        children: [],
      });
    }
    const sort = (nodes: FileNode[]) => {
      nodes.sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.path.localeCompare(b.path));
      nodes.forEach((node) => sort(node.children));
    };
    sort(root.children);
    return root.children;
  }

  /** Whether a file or folder is at `path`. */
  taken(path: string): boolean {
    return this.files.has(path) || this.folders.has(path) || [...this.files.keys()].some((file) => file.startsWith(`${path}/`));
  }

  create(args: Args): string {
    const path = this.path(args);
    if (this.files.has(path) || this.folders.has(path)) throw new Error(`${path} already exists.`);
    if (args?.kind === "folder") this.folders.add(path);
    else this.files.set(path, "");
    return path;
  }

  rename(args: Args): string {
    const path = this.path(args);
    const name = String(args?.newName ?? "");
    const slash = path.lastIndexOf("/");
    return this.relocate(path, slash < 0 ? name : `${path.slice(0, slash)}/${name}`);
  }

  /** Moves an entry into another folder ("" for the project's top), keeping its name. */
  move(args: Args): string {
    const path = this.path(args);
    const target = this.relative(String(args?.targetDirectory ?? "")).replace(/^\/+|\/+$/g, "");
    const name = path.slice(path.lastIndexOf("/") + 1);
    const next = target ? `${target}/${name}` : name;
    if (next !== path && this.taken(next)) throw new Error(`${next} already exists.`);
    return this.relocate(path, next);
  }

  /** Deletes a file, or a folder with everything in it. */
  delete(args: Args): null {
    const path = this.path(args);
    const inside = (key: string) => key === path || key.startsWith(`${path}/`);
    for (const key of [...this.files.keys()]) if (inside(key)) this.files.delete(key);
    for (const key of [...this.folders]) if (inside(key)) this.folders.delete(key);
    return null;
  }

  private relocate(path: string, next: string): string {
    const moved = (key: string) => (key === path ? next : key.startsWith(`${path}/`) ? next + key.slice(path.length) : key);
    for (const [key, content] of [...this.files]) {
      if (moved(key) === key) continue;
      this.files.delete(key);
      this.files.set(moved(key), content);
    }
    for (const key of [...this.folders]) {
      this.folders.delete(key);
      this.folders.add(moved(key));
    }
    return next;
  }

  /**
   * Find in project over the text files: paths and lines holding every term,
   * shaped like the backend's hits. A page adds its library's Papers after them.
   */
  search(query: string, matches = termMatcher(query)): Array<Record<string, unknown>> {
    const hits: Array<Record<string, unknown>> = [];
    for (const [path, content] of this.files) {
      if (typeof content !== "string") continue;
      const title = path.slice(path.lastIndexOf("/") + 1);
      const fileKind = path.split(".").pop();
      if (matches(path)) hits.push({ kind: "file", path, title, snippet: path, line: 1, fileKind });
      content.split("\n").forEach((text, index) => {
        if (hits.length < 40 && matches(text)) {
          hits.push({ kind: "file", path, title, snippet: text.trim().slice(0, 180), line: index + 1, fileKind });
        }
      });
    }
    return hits;
  }

  /** The answer to a file command, or `NOT_HANDLED` for any other. */
  answer(command: string, args: Args): unknown {
    switch (command) {
      case "read_project_file": {
        const content = this.files.get(this.path(args));
        if (typeof content !== "string") throw new Error(`No such text file: ${this.path(args)}`);
        return content;
      }
      case "write_project_file": {
        const contents = args?.contents ?? args?.content;
        if (typeof contents === "string") this.files.set(this.path(args), contents);
        return null;
      }
      case "read_project_asset": {
        const path = this.path(args);
        const content = this.files.get(path);
        if (!(content instanceof Uint8Array)) throw new Error(`No such asset: ${path}`);
        // As src-tauri/lattice-core/src/project/assets.rs answers: a PDF is read a range at
        // a time, a figure arrives inline and is shown as an image.
        if (path.toLowerCase().endsWith(".pdf")) {
          return { path, mimeType: "application/pdf", ranges: { length: content.byteLength, version: "bench" } };
        }
        return { path, mimeType: "image/png", base64: base64Of(content) };
      }
      case "read_project_asset_range": {
        const content = this.files.get(this.path(args));
        if (!(content instanceof Uint8Array)) throw new Error(`No such asset: ${this.path(args)}`);
        return copyBuffer(content.subarray(Number(args?.start), Number(args?.end)));
      }
      case "stat_project_file":
        return { exists: this.files.has(this.path(args)), mtimeMs: MOCK_MTIME };
      case "create_project_entry":
        return this.create(args);
      case "rename_project_entry":
        return this.rename(args);
      case "move_project_entry":
        return this.move(args);
      case "delete_project_entry":
        return this.delete(args);
      default:
        return NOT_HANDLED;
    }
  }
}

/** Whether a text holds every whitespace-separated term of `query`, ignoring case. */
export function termMatcher(query: string): (text: string) => boolean {
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return (text) => terms.length > 0 && terms.every((term) => text.toLocaleLowerCase().includes(term));
}

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  // In slices: spreading a whole figure into one call overflows the stack.
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}

export function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function kindOf(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "tex") return "tex";
  if (extension === "md") return "markdown";
  if (extension === "bib") return "bib";
  if (extension === "pdf" || extension === "png") return "figure";
  return "text";
}
