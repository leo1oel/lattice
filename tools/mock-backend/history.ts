/**
 * The project's activity history over the files in memory, as the backend
 * keeps it (src-tauri/lattice-core/src/project/history.rs): every save the editor makes is
 * an "Edit <path>" entry, saves of one file within 45 seconds of each other
 * fold into one, a citation the page adds is a "Cite <key>" entry, and an
 * entry can be put back file by file or deleted.
 */
import type { MockProject } from "./project";
import { NOT_HANDLED, type Args } from "./tauri-internals";

type Change = { path: string; before: string | null; after: string | null };
type Entry = {
  id: string; label: string; timestamp: string; actor: string; kind: string; source: string;
  undoOf: string | null; changes: Change[];
};

/** history.rs `EDIT_COALESCE_SECS`. */
const EDIT_COALESCE_MS = 45_000;

const textOf = (content: string | Uint8Array | undefined) => (typeof content === "string" ? content : null);

type HistoryAnswer = ((command: string, args: Args) => unknown) & {
  /** Append `bibtex` to the bibliography at `path`, as papers.rs cites a work. */
  cite: (path: string, key: string, bibtex: string) => void;
};

/**
 * The history commands' answers over `project`, or `NOT_HANDLED` for any
 * other. It answers `write_project_file` itself, so each save lands in the
 * history as the backend's does; `now` dates the entries.
 */
export function historyAnswer({ project, now = () => new Date() }: { project: MockProject; now?: () => Date }): HistoryAnswer {
  /** Newest first, as `list_history` reads them. */
  const entries: Entry[] = [];
  let count = 0;

  function record(label: string, changes: Change[], context: { actor?: string; kind: string; source: string; undoOf?: string }): Entry | null {
    const effective = changes.filter((change) => change.before !== change.after);
    if (!effective.length) return null;
    const at = now();
    const entry: Entry = {
      id: `${at.toISOString().replace(/[-:]/g, "")}-${++count}`, label, timestamp: at.toISOString(),
      actor: context.actor ?? "user", kind: context.kind, source: context.source, undoOf: context.undoOf ?? null, changes: effective,
    };
    entries.unshift(entry);
    return entry;
  }

  /** A save, folded into the last entry when that one saved the same file moments ago. */
  function edit(path: string, before: string | null, after: string | null): Entry | null {
    const label = `Edit ${path}`;
    const latest = entries[0];
    if (latest?.label === label && latest.changes.length === 1 && latest.kind === "edit"
      && now().getTime() - Date.parse(latest.timestamp) <= EDIT_COALESCE_MS) {
      if (latest.changes[0]!.before === after) {
        entries.shift();
        return null;
      }
      latest.changes[0]!.after = after;
      latest.timestamp = now().toISOString();
      return latest;
    }
    return record(label, [{ path, before, after }], { kind: "edit", source: "editor" });
  }

  const entry = (id: unknown) => {
    const found = entries.find((candidate) => candidate.id === id);
    if (!found) throw new Error("That history entry no longer exists.");
    return found;
  };

  const answer = (command: string, args: Args): unknown => {
    switch (command) {
      case "write_project_file": {
        const path = project.path(args);
        const before = textOf(project.files.get(path));
        project.answer(command, args);
        const after = textOf(project.files.get(path));
        const saved = edit(path, before, after);
        return { content: after ?? "", transactionId: saved?.id ?? "", externalChangesMerged: false, hadConflicts: false };
      }
      case "list_history":
        return entries.map(({ changes, ...item }) => ({ ...item, files: changes.map((change) => change.path) }));
      case "get_history_entry": {
        const { id, changes } = entry(args?.transactionId);
        return { id, changes };
      }
      // history.rs `revert`: put the entry's files back as a new entry, refusing any edited since.
      case "revert_history_file": {
        const source = entry(args?.transactionId);
        const only = args?.path == null ? null : String(args.path);
        const selected = source.changes.filter((change) => only === null || change.path === only);
        if (!selected.length) throw new Error("That file is not part of this history entry.");
        const inverse: Change[] = [];
        for (const change of selected) {
          const current = textOf(project.files.get(change.path));
          if (current === change.before) continue;
          if (current !== change.after) {
            throw new Error(`Cannot restore ${change.path} because it changed after this history entry. Review the newer changes first.`);
          }
          inverse.push({ path: change.path, before: current, after: change.before });
        }
        if (!inverse.length) throw new Error("The selected files are already at the requested state.");
        for (const change of inverse) {
          if (change.after === null) project.files.delete(change.path);
          else project.files.set(change.path, change.after);
        }
        const label = only === null ? `Restore ${source.label}` : `Restore ${only} from ${source.label}`;
        return record(label, inverse, { kind: "restore", source: "history", undoOf: source.id });
      }
      case "delete_history_entry":
        entries.splice(entries.indexOf(entry(args?.transactionId)), 1);
        return null;
      default:
        return NOT_HANDLED;
    }
  };

  return Object.assign(answer, {
    cite(path: string, key: string, bibtex: string) {
      const before = textOf(project.files.get(path));
      const after = `${before?.trimEnd() ?? ""}${before?.trim() ? "\n\n" : ""}${bibtex.trim()}\n`;
      project.files.set(path, after);
      record(`Cite ${key}`, [{ path, before, after }], { actor: "citation", kind: "citation", source: "citation" });
    },
  });
}
