import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";

const script = readFileSync("public/polyfills.js", "utf8");

type InsertableMap<K, V> = Map<K, V> & {
  getOrInsert: (key: K, defaultValue: V) => V;
  getOrInsertComputed: (key: K, callback: (key: K) => V) => V;
};

type InsertableWeakMap<K extends object, V> = WeakMap<K, V> & {
  getOrInsert: (key: K, defaultValue: V) => V;
  getOrInsertComputed: (key: K, callback: (key: K) => V) => V;
};

describe("Map/WeakMap getOrInsert polyfills", () => {
  let context: ReturnType<typeof createContext>;
  beforeEach(() => {
    context = createContext({});
    runInContext(`
      for (const proto of [Map.prototype, WeakMap.prototype]) {
        delete proto.getOrInsert;
        delete proto.getOrInsertComputed;
      }
    `, context);
    runInContext(script, context);
  });

  it("polyfills Map getOrInsert and getOrInsertComputed when missing", () => {
    const map = runInContext("new Map()", context) as InsertableMap<string, number>;
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
    const map = runInContext("new WeakMap()", context) as InsertableWeakMap<object, number>;
    const key = {};
    expect(map.getOrInsert(key, 1)).toBe(1);
    expect(map.getOrInsertComputed(key, () => 9)).toBe(1);
  });

  it("preserves existing implementations on both prototypes", () => {
    runInContext(`
      globalThis.existing = [Map.prototype, WeakMap.prototype].flatMap(
        (proto) => [proto.getOrInsert, proto.getOrInsertComputed],
      );
    `, context);
    runInContext(script, context);
    expect(runInContext(`
      [Map.prototype, WeakMap.prototype].flatMap(
        (proto) => [proto.getOrInsert, proto.getOrInsertComputed],
      ).every((method, index) => method === existing[index])
    `, context)).toBe(true);
  });

  it("loads the compatibility script before the application module", () => {
    const html = readFileSync("index.html", "utf8");
    expect(html).toMatch(/<script src="\/polyfills\.js"><\/script>\s*<script type="module" src="\/src\/main\.tsx">/);
  });
});
