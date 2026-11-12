/**
 * Cloning a Git repository into a new project folder: the backend's answers
 * (src-tauri/lattice-core/src/git/clone.rs) and the folder the clone lands in.
 */

/** How far a clone has come, as `clone_repository` reports it. */
export type CloneProgress = { stage: "connecting" | "receiving" | "resolving" | "checkout"; progress: number };

/** Why `clone_repository` did not produce a project; `detail` is git's own words. */
export type CloneError =
  | { kind: "invalidUrl" | "folderExists" | "noParent" | "gitMissing" | "cancelled" }
  | { kind: "auth" | "notFound" | "network" | "failed"; detail: string };

const CLONE_ERROR_KINDS = new Set(["invalidUrl", "folderExists", "noParent", "gitMissing", "cancelled", "auth", "notFound", "network", "failed"]);

/** The backend's refusal, or any other failure (a broken IPC call) as a plain failure. */
export function cloneError(reason: unknown): CloneError {
  if (typeof reason === "object" && reason !== null && CLONE_ERROR_KINDS.has(String((reason as { kind?: unknown }).kind))) {
    return reason as CloneError;
  }
  return { kind: "failed", detail: reason instanceof Error ? reason.message : String(reason) };
}

/**
 * The folder name git would pick for `url`, its last path part less `.git`;
 * empty while the URL names none.
 */
export function repositoryName(url: string): string {
  const trimmed = url.trim();
  const scheme = trimmed.indexOf("://");
  const path = scheme >= 0
    ? trimmed.slice(scheme + 3).split(/[?#]/)[0].replace(/^[^/]*/, "")
    : trimmed.slice(trimmed.indexOf(":") + 1);
  const last = path.replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  const name = last.replace(/\.git$/, "").trim();
  return name === "." || name === ".." ? "" : name;
}

/** `name` inside the folder `parent`. */
export function joinPath(parent: string, name: string): string {
  if (!parent) return name;
  return `${parent.replace(/\/+$/, "")}/${name}`;
}

/** The folder `path` sits in. */
export function parentFolder(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash > 0 ? trimmed.slice(0, slash) : slash === 0 ? "/" : "";
}
