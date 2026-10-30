// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { createSafari17Context } from "./check-webkit-compat.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const polyfills = readFileSync(path.join(repo, "public/polyfills.js"), "utf8");

let root;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** A dist directory with `files` under assets/ and `polyfillsSource` as polyfills.js; the check's output and exit status. */
function check(files, polyfillsSource = polyfills) {
  root = mkdtempSync(path.join(os.tmpdir(), "webkit-compat-"));
  mkdirSync(path.join(root, "assets"));
  writeFileSync(path.join(root, "polyfills.js"), polyfillsSource);
  for (const [name, source] of Object.entries(files)) writeFileSync(path.join(root, "assets", name), source);
  const result = spawnSync(process.execPath, [path.join(repo, "scripts/check-webkit-compat.mjs"), root], { encoding: "utf8" });
  return { status: result.status, output: result.stdout + result.stderr };
}

// Shaped like the built chunks: PDF.js's top-level `Iterator.prototype` (the
// #506 crash) in the window chunk, which imports from the app's chunk, and
// the same in the worker, which must bring its own polyfills.
const pdfjsTopLevel = "typeof Iterator.prototype.join!=`function`&&(Iterator.prototype.join=function(e){return[...this].join(e)});";
const reader = `import{uc as e}from"./app-a1.js";${pdfjsTopLevel}export const t=()=>Promise.try(e);`;
const fixture = (overrides = {}) => ({
  "app-a1.js": "export const uc=()=>1;",
  "pdf-reader-b2.js": reader,
  "pdf.worker-c3.js": `${polyfills}\n${pdfjsTopLevel}Promise.try(()=>new Map().keys().some(Boolean));`,
  ...overrides,
});

describe("check-webkit-compat on a build", () => {
  it("passes when the window and the worker install the built-ins first", () => {
    const { status, output } = check(fixture());
    expect(output).toContain("WebKit compatibility check passed");
    expect(status).toBe(0);
  });

  it("fails on the window chunk's top-level Iterator when polyfills.js lacks it", () => {
    const { status, output } = check(fixture(), "");
    expect(status).toBe(1);
    expect(output).toContain("pdf-reader-b2.js (after polyfills.js) failed to evaluate on Safari 17.0's built-ins: ReferenceError: Iterator is not defined");
  });

  it("fails on a worker chunk that does not carry the polyfills itself", () => {
    const { status, output } = check(fixture({ "pdf.worker-c3.js": pdfjsTopLevel }));
    expect(status).toBe(1);
    expect(output).toContain("pdf.worker-c3.js failed to evaluate on Safari 17.0's built-ins: ReferenceError: Iterator is not defined");
    expect(output).not.toContain("pdf-reader-b2.js (after");
  });

  it("fails on a newer built-in that only a call site reaches", () => {
    const { status, output } = check(fixture({ "papers-d4.js": "export const group=(e)=>Object.groupBy(e,String);" }));
    expect(status).toBe(1);
    expect(output).toContain("papers-d4.js uses Object.groupBy / Map.groupBy (Safari 17.4), which Safari 17.0 lacks and polyfills.js does not install");
  });

  it("names a missing PDF.js chunk rather than passing without it", () => {
    const { status, output } = check({ "app-a1.js": "export const uc=1;" });
    expect(status).toBe(1);
    expect(output).toContain("expected one PDF.js window (pdf-reader) chunk");
    expect(output).toContain("expected one PDF.js worker (pdf.worker) chunk");
  });
});

/** Runs `code` in a Safari 17.0-shaped context after public/polyfills.js. */
function run(code) {
  const context = createSafari17Context();
  vm.runInContext(polyfills, context);
  return vm.runInContext(code, context);
}
/** The name of the error `code` throws in that context (its classes are not the test's). */
const thrown = (code) => run(`(() => { try { ${code}; } catch (error) { return error.name; } return "nothing"; })()`);
/** JSON across the context boundary, so arrays and objects compare by value. */
const json = (code) => JSON.parse(run(`JSON.stringify(${code})`));

describe("public/polyfills.js on Safari 17.0's built-ins", () => {
  it("adds the Iterator global over the prototype every iterator already shares", () => {
    expect(run("typeof Iterator")).toBe("function");
    expect(run("Iterator.prototype === Object.getPrototypeOf(Object.getPrototypeOf([].values()))")).toBe(true);
    expect(thrown("new Iterator()")).toBe("TypeError");
    // PDF.js's own top-level addition then works on every iterator.
    expect(run(`${pdfjsTopLevel} new Map([[1, 2], [3, 4]]).keys().join("-")`)).toBe("1-3");
  });

  it("chains the lazy helpers and runs the eager ones", () => {
    expect(json("[1, 2, 3, 4, 5].values().filter((x) => x % 2).map((x, i) => [x, i]).toArray()")).toEqual([[1, 0], [3, 1], [5, 2]]);
    expect(json("new Set([1, 2, 3, 4]).values().drop(1).take(2).toArray()")).toEqual([2, 3]);
    expect(json("[[1, 2], [3]].values().flatMap((x) => x).toArray()")).toEqual([1, 2, 3]);
    expect(run("[1, 2, 3].values().reduce((sum, x) => sum + x)")).toBe(6);
    expect(run("[1, 2, 3].values().reduce((sum, x) => sum + x, 10)")).toBe(16);
    expect(run("new Map([['a', 1]]).values().some((x) => x === 1)")).toBe(true);
    expect(run("[1, 2].values().every((x) => x > 1)")).toBe(false);
    expect(run("new Map([[{ id: 2 }, 0]]).keys().find((x) => x.id === 2).id")).toBe(2);
    expect(json("(() => { const seen = []; [4, 5].values().forEach((x, i) => seen.push(x * i)); return seen; })()")).toEqual([0, 5]);
    expect(thrown("[].values().reduce((a, b) => a + b)")).toBe("TypeError");
    expect(thrown("[].values().take(-1)")).toBe("RangeError");
    expect(thrown("[1].values().flatMap(() => 'ab').next()")).toBe("TypeError");
  });

  it("closes the underlying iterator when a helper stops early, and not after it is exhausted", () => {
    const closes = (code) => run(`(() => {
      let closed = 0;
      function* source() { try { yield 1; yield 2; yield 3; } finally { closed++; } }
      ${code};
      return closed;
    })()`);
    expect(closes("source().find((x) => x === 2)")).toBe(1);
    expect(closes("source().some((x) => x === 1)")).toBe(1);
    expect(closes("for (const x of source().map((x) => x)) break")).toBe(1);
    expect(closes("source().take(1).toArray()")).toBe(1);
    expect(closes("try { source().filter(() => { throw new Error('x'); }).next(); } catch {}")).toBe(1);
    expect(closes("source().map((x) => x).toArray()")).toBe(1);
    expect(run("(() => { let closed = 0; const it = { next: () => ({ done: true }), return() { closed++; return {}; } }; Iterator.from(it).toArray(); return closed; })()")).toBe(0);
  });

  it("wraps a bare iterator in Iterator.from and returns a real one as is", () => {
    expect(json("Iterator.from({ i: 0, next() { return { done: this.i > 1, value: this.i++ }; } }).map((x) => x * 10).toArray()")).toEqual([0, 10]);
    expect(run("(() => { const it = [1].values(); return Iterator.from(it) === it; })()")).toBe(true);
    expect(json("Iterator.from('ab').toArray()")).toEqual(["a", "b"]);
  });

  it("adds Promise.withResolvers and Promise.try", async () => {
    expect(await run("(() => { const { promise, resolve } = Promise.withResolvers(); resolve(7); return promise; })()")).toBe(7);
    expect(await run("Promise.try((a, b) => a + b, 2, 3)")).toBe(5);
    await expect(run("Promise.try(() => { throw new Error('sync'); })")).rejects.toThrow("sync");
  });

  it("sums exactly in Math.sumPrecise", () => {
    expect(run("Math.sumPrecise([1e20, 0.1, -1e20])")).toBe(0.1);
    expect(run("Math.sumPrecise([0.1, 0.2, 0.3])")).toBe(0.6);
    expect(run("Math.sumPrecise([1, 2, 3].values())")).toBe(6);
    expect(Object.is(run("Math.sumPrecise([])"), -0)).toBe(true);
    expect(Object.is(run("Math.sumPrecise([-0, -0])"), -0)).toBe(true);
    expect(Object.is(run("Math.sumPrecise([-0, 0])"), 0)).toBe(true);
    expect(run("Math.sumPrecise([Infinity, 1])")).toBe(Infinity);
    expect(run("Math.sumPrecise([Infinity, -Infinity])")).toBeNaN();
    expect(run("Math.sumPrecise([Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE])")).toBe(Number.MAX_VALUE);
    expect(run("Math.sumPrecise([Number.MAX_VALUE, Number.MAX_VALUE])")).toBe(Infinity);
    expect(thrown("Math.sumPrecise([1, '2'])")).toBe("TypeError");
    expect(thrown("Math.sumPrecise('12')")).toBe("TypeError");
  });

  it("escapes every character RegExp.escape must", () => {
    expect(run("RegExp.escape('foo.bar')")).toBe("\\x66oo\\.bar");
    expect(run("RegExp.escape('(a)*[b]{c}|/$^\\\\?+')")).toBe("\\(a\\)\\*\\[b\\]\\{c\\}\\|\\/\\$\\^\\\\\\?\\+");
    expect(run("RegExp.escape('a-b, c\\n')")).toBe("\\x61\\x2db\\x2c\\x20c\\n");
    expect(run("RegExp.escape('\\u2028\\ud800😀')")).toBe("\\u2028\\ud800😀");
    const tricky = "1+1=2? (yes) [a-z] {x} | ^$ \\ /\t 😀";
    expect(run(`[new RegExp('^' + RegExp.escape(${JSON.stringify(tricky)}) + '$').test(${JSON.stringify(tricky)}),
      new RegExp('^' + RegExp.escape(${JSON.stringify(tricky)}) + '$', 'u').test(${JSON.stringify(tricky)})].join()`)).toBe("true,true");
  });

  it("encodes and decodes Uint8Array base64 and hex", () => {
    expect(json("Array.from(Uint8Array.fromBase64('SGVsbG8='))")).toEqual([72, 101, 108, 108, 111]);
    expect(json("Array.from(Uint8Array.fromBase64(' SGVs\\nbG8 '))")).toEqual([72, 101, 108, 108, 111]);
    expect(json("Array.from(Uint8Array.fromBase64('-_8', { alphabet: 'base64url' }))")).toEqual([251, 255]);
    expect(json("Array.from(Uint8Array.fromBase64('SGVsbG8', { lastChunkHandling: 'stop-before-partial' }))")).toEqual([72, 101, 108]);
    expect(thrown("Uint8Array.fromBase64('SGVsbG8', { lastChunkHandling: 'strict' })")).toBe("SyntaxError");
    expect(thrown("Uint8Array.fromBase64('SGVsbG9=', { lastChunkHandling: 'strict' })")).toBe("SyntaxError");
    expect(thrown("Uint8Array.fromBase64('SG*s')")).toBe("SyntaxError");
    expect(thrown("Uint8Array.fromBase64('S===')")).toBe("SyntaxError");
    expect(run("new Uint8Array([72, 101, 108, 108, 111]).toBase64()")).toBe("SGVsbG8=");
    expect(run("new Uint8Array([251, 255]).toBase64({ alphabet: 'base64url', omitPadding: true })")).toBe("-_8");
    expect(run("new Uint8Array([0, 15, 255]).toHex()")).toBe("000fff");
    expect(json("Array.from(Uint8Array.fromHex('000fFF'))")).toEqual([0, 15, 255]);
    expect(thrown("Uint8Array.fromHex('abc')")).toBe("SyntaxError");
    // Round trip every byte value.
    expect(run("(() => { const all = Uint8Array.from({ length: 256 }, (_, i) => i); const back = Uint8Array.fromBase64(all.toBase64()); return back.length === 256 && back.every((b, i) => b === i); })()")).toBe(true);
  });

  it("moves an ArrayBuffer to a fixed length, detaching the original", () => {
    expect(json(`(() => {
      const source = new Uint8Array([1, 2, 3, 4]).buffer;
      const shorter = source.transferToFixedLength(2);
      return [source.byteLength, Array.from(new Uint8Array(shorter))];
    })()`)).toEqual([0, [1, 2]]);
    expect(json("Array.from(new Uint8Array(new Uint8Array([5, 6]).buffer.transferToFixedLength(3)))")).toEqual([5, 6, 0]);
    expect(run("new ArrayBuffer(8).transferToFixedLength().byteLength")).toBe(8);
  });

  it("adds URL.parse, AbortSignal.any and bytes()", async () => {
    expect(run("URL.parse('https://example.com/a').pathname")).toBe("/a");
    expect(run("URL.parse('b', 'https://example.com/a/').href")).toBe("https://example.com/a/b");
    expect(run("URL.parse('not a url')")).toBeNull();
    expect(json(`(() => {
      const first = new AbortController();
      const second = new AbortController();
      const combined = AbortSignal.any([first.signal, second.signal]);
      const before = combined.aborted;
      second.abort("why");
      return [before, combined.aborted, combined.reason];
    })()`)).toEqual([false, true, "why"]);
    expect(run("(() => { const done = new AbortController(); done.abort('early'); return AbortSignal.any([done.signal]).reason; })()")).toBe("early");
    expect(Array.from(await run("new Response(new Uint8Array([1, 2])).bytes()"))).toEqual([1, 2]);
    expect(Array.from(await run("new Blob([new Uint8Array([3])]).bytes()"))).toEqual([3]);
  });

  it("iterates a ReadableStream with for await, cancelling it on an early exit", async () => {
    expect(await run(`(async () => {
      const stream = new ReadableStream({ start(c) { c.enqueue(1); c.enqueue(2); c.close(); } });
      const seen = [];
      for await (const chunk of stream) seen.push(chunk);
      return seen.join() + (stream.locked ? " locked" : "");
    })()`)).toBe("1,2");
    expect(await run(`(async () => {
      let cancelled = false;
      const stream = new ReadableStream({ pull(c) { c.enqueue(1); }, cancel() { cancelled = true; } });
      for await (const chunk of stream) break;
      return cancelled && !stream.locked;
    })()`)).toBe(true);
  });
});
