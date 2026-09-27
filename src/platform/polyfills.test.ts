import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";

const script = readFileSync("public/polyfills.js", "utf8");

type Insertable<K, V> = {
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
    const map = runInContext("new Map()", context) as Map<string, number> & Insertable<string, number>;
    expect(map.getOrInsert("a", 1)).toBe(1);
    expect(map.getOrInsert("a", 99)).toBe(1);

    let calls = 0;
    const compute = (value: number) => () => {
      calls += 1;
      return value;
    };
    expect(map.getOrInsertComputed("b", compute(2))).toBe(2);
    expect(map.getOrInsertComputed("b", compute(3))).toBe(2);
    expect(calls).toBe(1);
  });

  it("polyfills WeakMap getOrInsertComputed when missing", () => {
    const map = runInContext("new WeakMap()", context) as WeakMap<object, number> & Insertable<object, number>;
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

describe("pre-React WebKit compatibility", () => {
  const consoleTimeStampType = (protocol: string, userAgent: string) => {
    const context = createContext({
      console: { timeStamp: () => undefined },
      location: { protocol },
      navigator: { userAgent },
    });
    runInContext(script, context);
    return runInContext("typeof console.timeStamp", context) as string;
  };
  const webKit = "Mozilla/5.0 AppleWebKit/619.3.11 Safari/619.3.11";

  it("disables React's unsafe development performance track in WebKit", () => {
    expect(consoleTimeStampType("http:", webKit)).toBe("undefined");
  });

  it("leaves production and non-WebKit performance instrumentation alone", () => {
    expect(consoleTimeStampType("tauri:", webKit)).toBe("function");
    expect(consoleTimeStampType("http:", "Mozilla/5.0 Gecko/20100101 Firefox/142.0")).toBe("function");
  });
});
