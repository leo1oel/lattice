/**
 * A localStorage-backed setting that every window shares.
 *
 * Each project opens in its own window, and all of them share one
 * localStorage. Storage is the one copy of the setting: a window renders what
 * it last read, hears another window's write through the `storage` event, and
 * re-reads storage before it writes, so it never writes back a copy that
 * another window has since changed.
 */
import { type SetStateAction, useSyncExternalStore } from "react";

export type SharedSetting<T> = {
  get(): T;
  subscribe(listener: () => void): () => void;
  set(action: SetStateAction<T>): void;
};

type Options<T> = {
  serialize?: (value: T) => string;
  /**
   * The value to write when a caller hands over a whole value it built from
   * `seen` (what this window rendered) and `stored` has moved on since. By
   * default the caller's value wins; a record keeps only the fields the caller
   * changed (see `changedFields`).
   */
  merge?: (stored: T, seen: T, next: T) => T;
};

/** Not yet read; distinct from `null`, which is a key storage does not hold. */
const UNREAD = Symbol("unread");

export function sharedSetting<T>(key: string, load: () => T, options: Options<T> = {}): SharedSetting<T> {
  const serialize = options.serialize ?? ((value: T) => JSON.stringify(value));
  const merge = options.merge ?? ((_stored: T, _seen: T, next: T) => next);
  const listeners = new Set<() => void>();
  // The stored text `value` was read from or written as. While storage cannot
  // be read, or a write to it failed, it stays at the text storage still holds,
  // so the choice made here lasts for this session.
  let raw: string | null | typeof UNREAD = UNREAD;
  let value: T;

  /** Re-reads storage; true when it changed since this window last read or wrote it. */
  const refresh = () => {
    let current: string | null;
    try {
      current = localStorage.getItem(key);
    } catch {
      current = raw === UNREAD ? null : raw;
    }
    if (current === raw) return false;
    raw = current;
    value = load();
    return true;
  };
  const notify = () => listeners.forEach((listener) => listener());
  // `key` is null when another window cleared storage.
  const onStorage = (event: StorageEvent) => {
    if ((event.key === key || event.key === null) && refresh()) notify();
  };

  return {
    // While someone listens, the value is kept current by writes here and by
    // storage events; otherwise (before the first render, in tests that seed
    // storage) storage is read again.
    get() {
      if (!listeners.size) refresh();
      return value;
    },
    subscribe(listener) {
      if (!listeners.size) {
        refresh();
        window.addEventListener("storage", onStorage);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) window.removeEventListener("storage", onStorage);
      };
    },
    set(action) {
      if (raw === UNREAD) refresh();
      const seen = value;
      // Another window's write whose event has not arrived yet.
      const moved = refresh();
      const next = typeof action === "function"
        ? (action as (current: T) => T)(value)
        : merge(value, seen, action);
      const text = serialize(next);
      if (text === raw) {
        if (moved) notify();
        return;
      }
      value = next;
      try {
        localStorage.setItem(key, text);
        raw = text;
      } catch {
        // The choice still applies in this window for the current session.
      }
      notify();
    },
  };
}

/** `stored` with each field `next` changed from `seen`, so a stale record never undoes another window's fields. */
export function changedFields<T extends object>(stored: T, seen: T, next: T): T {
  const merged = { ...stored };
  for (const field of Object.keys(next) as (keyof T)[]) {
    if (JSON.stringify(next[field]) !== JSON.stringify(seen[field])) merged[field] = next[field];
  }
  return merged;
}

/** The setting's current value in every window, and a setter that writes it for all of them. */
export function useSharedSetting<T>(setting: SharedSetting<T>) {
  return [useSyncExternalStore(setting.subscribe, setting.get), setting.set] as const;
}
