import { beforeEach, describe, expect, it, vi } from "vitest";

type InsertableMap<K, V> = Map<K, V> & {
  getOrInsert: (key: K, defaultValue: V) => V;
  getOrInsertComputed: (key: K, callback: (key: K) => V) => V;
};

type InsertableWeakMap<K extends object, V> = WeakMap<K, V> & {
  getOrInsert: (key: K, defaultValue: V) => V;
  getOrInsertComputed: (key: K, callback: (key: K) => V) => V;
};

describe("Map/WeakMap getOrInsert polyfills", () => {
  beforeEach(async () => {
    for (const proto of [Map.prototype, WeakMap.prototype] as Array<{
      getOrInsert?: unknown;
      getOrInsertComputed?: unknown;
    }>) {
      delete proto.getOrInsert;
      delete proto.getOrInsertComputed;
    }
    vi.resetModules();
    await import("./polyfills");
  });

  it("polyfills Map getOrInsert and getOrInsertComputed when missing", () => {
    const map = new Map<string, number>() as InsertableMap<string, number>;
    expect(map.getOrInsert("a", 1)).toBe(1);
    expect(map.getOrInsert("a", 99)).toBe(1);

    let calls = 0;
    expect(
      map.getOrInsertComputed("b", () => {
        calls += 1;
        return 2;
      }),
    ).toBe(2);
    expect(
      map.getOrInsertComputed("b", () => {
        calls += 1;
        return 3;
      }),
    ).toBe(2);
    expect(calls).toBe(1);
  });

  it("polyfills WeakMap getOrInsertComputed when missing", () => {
    const map = new WeakMap<object, number>() as InsertableWeakMap<object, number>;
    const key = {};
    expect(map.getOrInsert(key, 1)).toBe(1);
    expect(map.getOrInsertComputed(key, () => 9)).toBe(1);
  });
});
