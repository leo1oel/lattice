import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { changedFields, sharedSetting } from "./shared-setting";

const KEY = "lattice.test-setting.v1";
type Pair = { left: string; right: string };
const loadPair = (): Pair => ({ left: "a", right: "b", ...JSON.parse(localStorage.getItem(KEY) ?? "{}") });

describe("sharedSetting", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("keeps a choice for the session when storage refuses the write", () => {
    const setting = sharedSetting(KEY, loadPair, { merge: changedFields });
    const stop = setting.subscribe(() => {});
    vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("quota"); });

    setting.set((current) => ({ ...current, left: "x" }));
    setting.set((current) => ({ ...current, right: "y" }));

    expect(setting.get()).toEqual({ left: "x", right: "y" });
    stop();
    expect(setting.get()).toEqual({ left: "x", right: "y" });
  });

  it("keeps a choice for the session when storage cannot be read", () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => { throw new Error("denied"); });
    const setting = sharedSetting(KEY, () => "default", { serialize: (value) => value });

    setting.set("chosen");

    expect(setting.get()).toBe("chosen");
  });

  it("tells listeners when another window clears storage, and not for other keys", () => {
    const setting = sharedSetting(KEY, loadPair);
    const listener = vi.fn();
    const stop = setting.subscribe(listener);
    setting.set({ left: "x", right: "y" });
    listener.mockClear();

    window.dispatchEvent(new StorageEvent("storage", { key: "lattice.other.v1" }));
    expect(listener).not.toHaveBeenCalled();

    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(listener).toHaveBeenCalledOnce();
    expect(setting.get()).toEqual({ left: "a", right: "b" });
    stop();
  });

  it("writes nothing and tells no one when a change leaves the value as stored", () => {
    const setting = sharedSetting(KEY, loadPair);
    const listener = vi.fn();
    const stop = setting.subscribe(listener);
    setting.set({ left: "x", right: "y" });
    listener.mockClear();
    const write = vi.spyOn(localStorage, "setItem");

    setting.set((current) => ({ ...current }));

    expect(write).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    stop();
  });
});
