/**
 * State read from Overleaf that belongs to exactly one linked project.
 *
 * Overleaf reads answer late: switch projects while one is in flight and,
 * left alone, its answer lands in the next project — the old project's
 * comment threads replacing the new project's, its chat merged into the new
 * conversation. The backend's pinned-root checks cannot catch this; the
 * request was valid when it was made.
 *
 * So the state lives in a snapshot owned by one project, and every write goes
 * through the session that was current when its work began. A new project
 * starts from `initial` before it is ever drawn, and once the project changes,
 * the hook is disabled (`null`) or it unmounts, a write from the old session
 * goes nowhere. Within a session, only the newest read publishes — data,
 * loading flag and error alike.
 */
import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** Updates a project's snapshot; returning it unchanged skips the re-render. */
export type OverleafSnapshotUpdate<T> = (update: (current: T) => T) => void;

export type OverleafProjectSession<T> = {
  readonly projectRoot: string;
  /** Update this project's snapshot; nothing happens once the session has ended. */
  publish: OverleafSnapshotUpdate<T>;
  /**
   * Begin a read, which supersedes every earlier one: its publisher stops
   * working once the next read begins, so an older read never overwrites a
   * newer one's data, nor clears its loading or error state.
   */
  read: () => OverleafSnapshotUpdate<T>;
};

/**
 * `[snapshot, session]`: the current project's snapshot (`initial` with no
 * project), and the session for work starting now (`null` with no project).
 * `initial` must keep its identity across renders.
 */
export function useOverleafProjectSnapshot<T>(
  projectRoot: string | null,
  initial: T,
): [T, () => OverleafProjectSession<T> | null] {
  const [snapshot, setSnapshot] = useState({ projectRoot, value: initial });
  // Adjusting state while rendering (not in an effect) re-renders before
  // commit, so a new project never shows the previous one's snapshot.
  if (snapshot.projectRoot !== projectRoot) setSnapshot({ projectRoot, value: initial });

  const sessionRef = useRef<OverleafProjectSession<T> | null>(null);
  useLayoutEffect(() => {
    if (projectRoot === null) return;
    let reads = 0;
    const session: OverleafProjectSession<T> = {
      projectRoot,
      publish: (update) => {
        if (sessionRef.current !== session) return;
        // Between the render that switched projects and this session's
        // cleanup, the snapshot already belongs to the next project.
        setSnapshot((current) => {
          if (current.projectRoot !== projectRoot) return current;
          const value = update(current.value);
          return value === current.value ? current : { projectRoot, value };
        });
      },
      read: () => {
        const read = ++reads;
        return (update) => {
          if (reads === read) session.publish(update);
        };
      },
    };
    sessionRef.current = session;
    return () => {
      sessionRef.current = null;
    };
  }, [projectRoot]);

  const session = useCallback(() => sessionRef.current, []);
  return [snapshot.projectRoot === projectRoot ? snapshot.value : initial, session];
}
