import { useLayoutEffect, useState } from "react";
import type { StoreApi } from "zustand";
import { shallow } from "zustand/shallow";

/**
 * Zustand's `useStore(store, useShallow(select))`, for a store whose writes
 * belong to the same update as React state set beside them. `useStore`
 * renders every store write at sync priority, so a write in an async
 * continuation (an IPC answer) commits apart from the state set next to it,
 * and App renders once for each half. Mirroring the slice into React state
 * from the store's listener gives the write its caller's priority, so they
 * commit together, as when the slice was React state. `select` must keep
 * its identity (a module-level function).
 */
export function useStoreSlice<S, T>(store: StoreApi<S>, select: (state: S) => T): T {
  const [slice, setSlice] = useState(() => select(store.getState()));
  useLayoutEffect(() => {
    const update = (state: S) => {
      const next = select(state);
      setSlice((current) => (shallow(current, next) ? current : next));
    };
    // Writes between this render and the subscription.
    update(store.getState());
    return store.subscribe(update);
  }, [select, store]);
  return slice;
}
