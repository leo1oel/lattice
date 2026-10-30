import { useLayoutEffect, useReducer, useRef } from "react";
import type { StoreApi } from "zustand/vanilla";
import { shallow } from "zustand/vanilla/shallow";

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
  const [slice, setSlice] = useReducer(replaceSlice<T>, store, (initial) => select(initial.getState()));
  // The slice last handed to React. Comparing here rather than in the
  // reducer keeps an unchanged slice from queueing an update, which would
  // still run the component again.
  const latestRef = useRef(slice);
  useLayoutEffect(() => {
    const update = (state: S) => {
      const next = select(state);
      if (shallow(latestRef.current, next)) return;
      latestRef.current = next;
      setSlice(next);
    };
    // Writes between the first render and the subscription.
    update(store.getState());
    return store.subscribe(update);
  }, [select, store]);
  return slice;
}

const replaceSlice = <T,>(_current: T, next: T) => next;
