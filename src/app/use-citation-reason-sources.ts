import { useEffect, useReducer } from "react";
import type { EditorComment } from "../editor/comments/editor-comment-data";

type Read = { projectRoot: string; paths: string; sources: Map<string, string | null> };

/**
 * `sourceFor`, extended with the saved text of each file an open citation
 * reason sits on that `sourceFor` has not read this session, so the
 * Annotations panel can tell whether its cite is still there. A file that
 * cannot be read is null (gone); one not read yet is undefined. The files
 * are read again for each `revision` of the project's tree, and the last
 * texts stand until the new ones arrive.
 */
export function useCitationReasonSources(
  projectRoot: string,
  reasons: readonly EditorComment[],
  sourceFor: (path: string) => string | undefined,
  readSource: (path: string) => Promise<string | null>,
  revision: unknown,
): (path: string) => string | null | undefined {
  const paths = [...new Set(reasons.flatMap((reason) => (
    !reason.resolved && sourceFor(reason.path) === undefined ? [reason.path] : []
  )))].sort().join("\n");
  const [read, setRead] = useReducer((_current: Read | null, next: Read) => next, null);
  useEffect(() => {
    if (!paths) return;
    let disposed = false;
    const list = paths.split("\n");
    void Promise.all(list.map((path) => readSource(path).catch(() => null))).then((texts) => {
      if (disposed) return;
      setRead({ projectRoot, paths, sources: new Map(list.map((path, index) => [path, texts[index] ?? null])) });
    });
    return () => { disposed = true; };
  }, [paths, projectRoot, readSource, revision]);
  const sources = read && read.projectRoot === projectRoot && read.paths === paths ? read.sources : null;
  return (path) => sourceFor(path) ?? sources?.get(path);
}
