import { useInsertionEffect, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * A ref that always holds the latest committed value, for handlers and effects
 * that must not re-run when a callback's identity changes. Refreshed in a
 * layout effect rather than during render: every reader is an effect or a
 * handler, so they all run after it lands, and a render-phase write makes the
 * React Compiler skip the whole component.
 */
export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/**
 * `useLatestRef` for values a child reads while it commits. A child's layout
 * effects and ref callbacks run before its parent's layout effects, so a
 * CodeMirror view a child builds in one would read the previous commit's
 * value. React runs every insertion effect of a commit before any layout
 * effect, so this ref is already current when they run.
 */
export function useCommittedRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useInsertionEffect(() => {
    ref.current = value;
  });
  return ref;
}
