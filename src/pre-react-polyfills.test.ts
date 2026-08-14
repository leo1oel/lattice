// @ts-expect-error no Node types in this browser-targeted project
import { readFileSync } from "node:fs";
// @ts-expect-error no Node types in this browser-targeted project
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const script = readFileSync("public/polyfills.js", "utf8");

function runPolyfills(protocol: string, userAgent: string): string {
  const context = createContext({
    console: { timeStamp: () => undefined },
    location: { protocol },
    navigator: { userAgent },
  });
  runInContext(script, context);
  return runInContext("typeof console.timeStamp", context) as string;
}

describe("pre-React WebKit compatibility", () => {
  it("disables React's unsafe development performance track in WebKit", () => {
    expect(runPolyfills("http:", "Mozilla/5.0 AppleWebKit/619.3.11 Safari/619.3.11"))
      .toBe("undefined");
  });

  it("leaves production and non-WebKit performance instrumentation alone", () => {
    expect(runPolyfills("tauri:", "Mozilla/5.0 AppleWebKit/619.3.11 Safari/619.3.11"))
      .toBe("function");
    expect(runPolyfills("http:", "Mozilla/5.0 Gecko/20100101 Firefox/142.0"))
      .toBe("function");
  });
});
