/**
 * Version tracking over the project in memory, as the backend's `git_*`
 * commands answer it (src-tauri/src/git.rs): a repository whose first version
 * is the project as the page opened it, and whose later ones are what the
 * writer saves or restores. Each version keeps its files whole, so the
 * timeline, Compare and the restores read real text.
 */
import type { MockProject } from "./project";
import { NOT_HANDLED, type Args } from "./tauri-internals";

type Tree = Map<string, string | Uint8Array>;
type FileKind = "added" | "modified" | "deleted";
type Version = { hash: string; shortHash: string; authorName: string; timestamp: string; message: string; files: Array<{ path: string; kind: FileKind }>; tree: Tree };

/** Written when tracking starts (git.rs `init`); the versions list shows it translated. */
const INITIALIZED = "Initialize version tracking";
/** Written before a restore overwrites the project (git.rs `restore_file`, `restore_project`). */
const AUTO_SAVED = "Auto-saved version";

/** Lattice's own state, which git.rs keeps out of every version. */
const internal = (path: string) => path === ".research" || path.startsWith(".research/");

/** A fixed-width hex id for the `index`th version, like a commit hash. */
function hashOf(index: number): string {
  return Array.from({ length: 5 }, (_, part) => ((index + 1) * 2654435761 + part * 40503 >>> 0).toString(16).padStart(8, "0")).join("");
}

/** How `to` differs from `from`, path by path, in path order. */
function changes(from: Tree, to: Tree): Array<{ path: string; kind: FileKind }> {
  const paths = [...new Set([...from.keys(), ...to.keys()])].filter((path) => !internal(path)).sort();
  return paths.flatMap((path): Array<{ path: string; kind: FileKind }> => {
    const before = from.get(path);
    const after = to.get(path);
    if (before === after) return [];
    return [{ path, kind: before === undefined ? "added" : after === undefined ? "deleted" : "modified" }];
  });
}

/** One side of a diff as git.rs reads it: the text, or nothing when the file is absent there. */
const textOf = (content: string | Uint8Array | undefined) => (typeof content === "string" ? content : null);

/**
 * The `git_*` commands' answers over `project`, or `NOT_HANDLED` for any
 * other. `author` names who saves versions; `now` dates them.
 */
export function versionsAnswer({ project, author = "Lattice", now = () => new Date() }: {
  project: MockProject;
  author?: string;
  now?: () => Date;
}): (command: string, args: Args) => unknown {
  const versions: Version[] = [];
  const snapshot = (): Tree => new Map([...project.files].filter(([path]) => !internal(path)));
  const head = () => versions.at(-1)!;

  function commit(message: string): string | null {
    const tree = snapshot();
    const files = versions.length ? changes(head().tree, tree) : [...tree.keys()].sort().map((path) => ({ path, kind: "added" as const }));
    if (!files.length) return null;
    const hash = hashOf(versions.length);
    versions.push({ hash, shortHash: hash.slice(0, 7), authorName: author, timestamp: now().toISOString(), message, files, tree });
    return hash;
  }
  commit(INITIALIZED);

  /** The version `rev` names (a hash, a short hash, or HEAD). */
  function version(rev: unknown): Version {
    const name = String(rev ?? "");
    const found = name === "HEAD" ? head() : versions.find((candidate) => candidate.hash === name || candidate.shortHash === name);
    if (!found) throw new Error(`Unknown revision: ${name}`);
    return found;
  }
  /** A side of a comparison: a version's files, or the project as it is now when `rev` is null. */
  const side = (rev: unknown): Tree => (rev == null ? snapshot() : version(rev).tree);

  function status() {
    const files = changes(head().tree, snapshot()).map(({ path, kind }) => ({
      path, status: kind === "added" ? "untracked" : kind, staged: false, unstaged: true,
    }));
    return { available: true, repository: true, branch: "main", remote: null, remoteUrl: null, upstream: null, ahead: 0, behind: 0, files };
  }

  return (command, args) => {
    switch (command) {
      case "git_status":
      case "git_init":
        return status();
      case "git_log":
        return versions.slice().reverse().slice(0, Number(args?.limit ?? 100))
          .map(({ tree: _tree, ...entry }) => entry);
      case "git_auto_commit": {
        const message = String(args?.message ?? "").trim();
        if (!message) throw new Error("Commit message cannot be empty.");
        return commit(message);
      }
      case "git_compare_files":
        return changes(side(args?.from), side(args?.to));
      case "git_compare_file": {
        const path = String(args?.path ?? "");
        const before = side(args?.from).get(String(args?.fromPath ?? path));
        const after = side(args?.to).get(path);
        if (before instanceof Uint8Array || after instanceof Uint8Array) return { before: null, after: null, binary: true };
        return { before: textOf(before), after: textOf(after), binary: false };
      }
      // What one version changed in a file: its parent's text beside its own.
      case "git_show_diff": {
        const at = version(args?.rev);
        const parent = versions[versions.indexOf(at) - 1];
        const path = String(args?.path ?? "");
        const after = at.tree.get(path);
        if (after instanceof Uint8Array) return { before: null, after: null, binary: true };
        return { before: textOf(parent?.tree.get(path)), after: textOf(after), binary: false };
      }
      case "git_restore_file": {
        const at = version(args?.rev);
        const path = String(args?.path ?? "");
        const content = at.tree.get(path);
        if (content === undefined) throw new Error(`${path} did not exist at revision ${at.shortHash}.`);
        commit(AUTO_SAVED);
        project.files.set(path, content);
        return null;
      }
      // Forward-only, as git.rs restores: the project saved as it is, then the
      // files as `rev` had them, committed as a new version.
      case "git_restore_project": {
        const at = version(args?.rev);
        commit(AUTO_SAVED);
        for (const path of [...project.files.keys()]) if (!internal(path) && head().tree.has(path) && !at.tree.has(path)) project.files.delete(path);
        for (const [path, content] of at.tree) project.files.set(path, content);
        return commit(`Restore project to ${at.shortHash}`) ?? head().hash;
      }
      default:
        return NOT_HANDLED;
    }
  };
}
