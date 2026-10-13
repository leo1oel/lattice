import { memo, Suspense, useDeferredValue, type ReactNode } from "react";

/**
 * Shows `children`, which hold a `React.lazy` screen, while `when` is true,
 * without React's reveal delay on the first open.
 *
 * Mounting a lazy component that suspends commits its Suspense fallback, and
 * React then holds the component back until 300 ms after that commit (its
 * reveal throttle), however fast the chunk arrives: a first open of Add
 * papers took 350 ms against 35 ms for the next. Here the boundary is always
 * mounted and the open renders deferred: a deferred render that suspends
 * leaves the screen as it was, so the content shows as soon as its chunk is
 * in. Closing is immediate. Settings and the history and comments drawers
 * get the same by opening in a transition (`useToolDrawers`).
 *
 * Closed, it does not re-render with its parent: what it would show is not
 * shown, so App's renders cost it nothing until it opens.
 */
export const LazyMount = memo(function LazyMount({ when, children }: { when: boolean; children: ReactNode }) {
  // Deferred from false, so a mount that is already open waits for the chunk too.
  const opened = useDeferredValue(when, false);
  return <Suspense fallback={null}>{when && opened ? children : null}</Suspense>;
}, (previous, next) => !previous.when && !next.when);
