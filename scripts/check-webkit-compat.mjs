#!/usr/bin/env node
/**
 * Proves the built bundles run on the oldest WKWebView Lattice supports:
 * macOS 14.0, whose WebKit is Safari 17.0's. Lattice renders in the system
 * WKWebView, so a dependency that calls a newer built-in breaks the app there
 * and nowhere a developer or CI looks: PDF.js 6 evaluated `Iterator.prototype`
 * at its top level and took every PDF preview down on macOS 14 (#506).
 *
 * Two checks, both against the built output in dist/assets:
 *
 * 1. The PDF.js window chunk (after public/polyfills.js, as index.html runs
 *    it) and the PDF.js worker chunk (alone: it must carry the polyfills
 *    itself) evaluate in a context with every built-in in MISSING_BUILTINS
 *    deleted. A ReferenceError or TypeError at module top level fails it.
 * 2. Every chunk is scanned for each of those built-ins; one the bundle uses
 *    must exist once the polyfills have run (the worker's, in its own
 *    context), or the call site throws when it is reached.
 *
 * A built-in that the bundles feature-detect (Float16Array, ImageDecoder,
 * Temporal) is not listed: the check would only force a needless polyfill.
 *
 * Node runs modules in a vm context only with --experimental-vm-modules; the
 * script re-runs itself with it.
 */
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const ITERATOR_HELPERS = ["map", "filter", "take", "drop", "flatMap", "reduce", "toArray", "forEach", "some", "every", "find"];

/**
 * Built-ins Safari 17.0 lacks. `strip` deletes it from a fresh context (run
 * there, so it touches only that context); `present` says whether it exists;
 * `used` finds a use of it in a minified chunk. Web API constructors come from
 * the host and are wrapped per context, so their entries name a member.
 */
export const MISSING_BUILTINS = [
  {
    name: "Iterator and its helpers (Safari 18.4)",
    strip: `
      delete globalThis.Iterator;
      const proto = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
      for (const key of ${JSON.stringify([...ITERATOR_HELPERS, "constructor"])}) delete proto[key];
    `,
    present: `
      typeof Iterator === "function" && typeof Iterator.from === "function" &&
      Iterator.prototype === Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())) &&
      ${JSON.stringify(ITERATOR_HELPERS)}.every((key) => typeof Iterator.prototype[key] === "function")
    `,
    // Helpers are called on whatever `.values()` returned, which no pattern
    // can follow through a minifier: any iterator method call counts.
    used: /\bIterator\b|\.(?:keys|values|entries)\(\)\.(?:map|filter|take|drop|flatMap|reduce|toArray|forEach|some|every|find)\(/,
  },
  { name: "Promise.withResolvers (Safari 17.4)", strip: "delete Promise.withResolvers", present: "typeof Promise.withResolvers === 'function'", used: /\bwithResolvers\b/ },
  { name: "Promise.try (Safari 18.2)", strip: "delete Promise.try", present: "typeof Promise.try === 'function'", used: /\bPromise\.try\b/ },
  { name: "Math.sumPrecise", strip: "delete Math.sumPrecise", present: "typeof Math.sumPrecise === 'function'", used: /\bsumPrecise\b/ },
  { name: "RegExp.escape (Safari 18.4)", strip: "delete RegExp.escape", present: "typeof RegExp.escape === 'function'", used: /\bRegExp\.escape\b/ },
  {
    name: "Map/WeakMap getOrInsert and getOrInsertComputed",
    strip: "for (const proto of [Map.prototype, WeakMap.prototype]) { delete proto.getOrInsert; delete proto.getOrInsertComputed; }",
    present: "[Map.prototype, WeakMap.prototype].every((proto) => typeof proto.getOrInsert === 'function' && typeof proto.getOrInsertComputed === 'function')",
    used: /\bgetOrInsert(?:Computed)?\b/,
  },
  {
    name: "Uint8Array base64 and hex (Safari 18.2)",
    strip: "delete Uint8Array.fromBase64; delete Uint8Array.fromHex; delete Uint8Array.prototype.toBase64; delete Uint8Array.prototype.toHex",
    present: "typeof Uint8Array.fromBase64 === 'function' && typeof Uint8Array.fromHex === 'function' && typeof Uint8Array.prototype.toBase64 === 'function' && typeof Uint8Array.prototype.toHex === 'function'",
    used: /\b(?:fromBase64|fromHex|toBase64|toHex)\b/,
  },
  {
    name: "Uint8Array.prototype.setFromBase64 / setFromHex (Safari 18.2)",
    strip: "delete Uint8Array.prototype.setFromBase64; delete Uint8Array.prototype.setFromHex",
    present: "typeof Uint8Array.prototype.setFromBase64 === 'function' && typeof Uint8Array.prototype.setFromHex === 'function'",
    used: /\bsetFrom(?:Base64|Hex)\b/,
  },
  {
    name: "ArrayBuffer.prototype.transferToFixedLength (Safari 17.4)",
    strip: "delete ArrayBuffer.prototype.transferToFixedLength",
    present: "typeof ArrayBuffer.prototype.transferToFixedLength === 'function'",
    used: /\btransferToFixedLength\b/,
  },
  {
    name: "ArrayBuffer.prototype.transfer (Safari 17.4)",
    strip: "delete ArrayBuffer.prototype.transfer",
    present: "typeof ArrayBuffer.prototype.transfer === 'function'",
    // Another object's `transfer` method matches too; that costs at most a
    // polyfill the build did not strictly need.
    used: /\.transfer\(/,
  },
  { name: "Object.groupBy / Map.groupBy (Safari 17.4)", strip: "delete Object.groupBy; delete Map.groupBy", present: "typeof Object.groupBy === 'function' && typeof Map.groupBy === 'function'", used: /\b(?:Object|Map)\.groupBy\b/ },
  { name: "Error.isError", strip: "delete Error.isError", present: "typeof Error.isError === 'function'", used: /\bError\.isError\b/ },
  { name: "URL.parse (Safari 18)", strip: "URL.parse = undefined", present: "typeof URL.parse === 'function'", used: /\bURL\.parse\b/ },
  { name: "AbortSignal.any (Safari 17.4)", strip: "AbortSignal.any = undefined", present: "typeof AbortSignal.any === 'function'", used: /\bAbortSignal\.any\b/ },
  {
    name: "Response/Request/Blob bytes() (Safari 18)",
    strip: "for (const C of [Response, Request, Blob]) C.prototype.bytes = undefined",
    present: "[Response, Request, Blob].every((C) => typeof C.prototype.bytes === 'function')",
    used: /\.bytes\(\)/,
  },
  {
    name: "ReadableStream async iteration",
    strip: "ReadableStream.prototype[Symbol.asyncIterator] = undefined; ReadableStream.prototype.values = undefined",
    present: "typeof ReadableStream.prototype[Symbol.asyncIterator] === 'function'",
    used: /\bfor await\b/,
  },
];

/** Web APIs a window or worker has and a bare vm context lacks; subclassed per context so stripping one leaves the host's alone. */
const WRAPPED_CLASSES = ["URL", "AbortSignal", "Response", "Request", "Blob", "ReadableStream"];
const SHARED_GLOBALS = [
  "AbortController", "atob", "btoa", "clearTimeout", "CompressionStream", "crypto", "DecompressionStream", "Event",
  "EventTarget", "Headers", "MessageChannel", "performance", "queueMicrotask", "setTimeout", "structuredClone",
  "TextDecoder", "TextEncoder", "TransformStream", "URLSearchParams", "WritableStream",
];

/** A fresh context shaped like Safari 17.0's globals: the host's Web APIs, every MISSING_BUILTINS entry deleted. */
export function createSafari17Context(extraGlobals = {}) {
  const globals = { console: { log() {}, info() {}, warn() {}, error() {}, debug() {} } };
  for (const name of SHARED_GLOBALS) globals[name] = globalThis[name];
  for (const name of WRAPPED_CLASSES) {
    // A named subclass: static and prototype members are shadowed on it.
    globals[name] = { [name]: class extends globalThis[name] {} }[name];
  }
  globals.navigator = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" };
  const context = vm.createContext(Object.assign(globals, extraGlobals));
  vm.runInContext("globalThis.globalThis = globalThis", context);
  for (const builtin of MISSING_BUILTINS) vm.runInContext(builtin.strip, context);
  return context;
}

/** The named imports of each module a minified chunk imports from: `import{a as b}from"./x.js"`. */
function importedNames(source) {
  const names = new Map();
  const pattern = /import\s*(?:\{([^}]*)\}\s*from\s*)?["']([^"']+)["']/g;
  for (const [, list = "", specifier] of source.matchAll(pattern)) {
    const set = names.get(specifier) ?? new Set();
    for (const entry of list.split(",")) {
      const name = entry.trim().split(/\s+as\s+/)[0];
      if (name) set.add(name);
    }
    names.set(specifier, set);
  }
  return names;
}

/** A value that stands in for anything a stubbed import is used as at top level. */
const stub = new Proxy(function stub() {}, {
  get: (_target, key) => (key === "then" ? undefined : key === Symbol.toPrimitive ? () => "" : stub),
  apply: () => stub,
  construct: () => stub,
});

/**
 * Evaluates `file` as a module in `context`. Its imports of sibling chunks are
 * stubbed when `stubImports` (the PDF.js window chunk imports the app's chunk,
 * which is not what this check is about) and otherwise loaded for real.
 */
async function evaluateModule(file, context, { stubImports }) {
  const modules = new Map();
  const load = async (target) => {
    if (modules.has(target)) return modules.get(target);
    const source = await readFile(target, "utf8");
    const module = new vm.SourceTextModule(source, {
      context,
      identifier: pathToFileURL(target).href,
      initializeImportMeta(meta) {
        meta.url = pathToFileURL(target).href;
      },
      importModuleDynamically: () => {
        throw new Error(`${path.basename(target)} imports a module dynamically while it evaluates`);
      },
    });
    modules.set(target, module);
    const names = importedNames(source);
    await module.link(async (specifier) => {
      const resolved = path.resolve(path.dirname(target), specifier);
      if (!stubImports) return load(resolved);
      const exportNames = [...(names.get(specifier) ?? [])];
      return new vm.SyntheticModule(exportNames, function () {
        for (const name of exportNames) this.setExport(name, stub);
      }, { context, identifier: `stub:${specifier}` });
    });
    return module;
  };
  const module = await load(file);
  await module.evaluate();
  return module;
}

function describe(error) {
  return error instanceof Error || (error && typeof error === "object" && "message" in error)
    ? `${error.name}: ${error.message}`
    : String(error);
}

/** The one asset matching `pattern`, or a problem saying why there is not. */
function single(files, pattern, label, problems) {
  const matches = files.filter((file) => pattern.test(file));
  if (matches.length !== 1) {
    problems.push(`expected one ${label} chunk matching ${pattern}, found ${matches.length ? matches.join(", ") : "none"}`);
    return null;
  }
  return matches[0];
}

/**
 * Runs both checks over `assetsDir`. Returns the problems found (empty when it
 * passes) and, for the report, the built-ins the chunks use.
 */
export async function checkWebKitCompat({ assetsDir, polyfillsPath }) {
  const problems = [];
  const files = (await readdir(assetsDir)).filter((file) => file.endsWith(".js")).sort();
  const polyfills = await readFile(polyfillsPath, "utf8");
  const reader = single(files, /^pdf-reader-[\w-]+\.js$/, "PDF.js window (pdf-reader)", problems);
  const worker = single(files, /^pdf\.worker-[\w-]+\.js$/, "PDF.js worker (pdf.worker)", problems);

  // The DOM PDF.js's viewer touches at its top level (it reads
  // `document.documentElement.style` and waits for an animation frame), as
  // stand-ins: the check is about JavaScript built-ins, not the DOM.
  const windowContext = createSafari17Context({
    document: stub,
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    cancelAnimationFrame: clearTimeout,
  });
  vm.runInContext(polyfills, windowContext, { filename: polyfillsPath });
  windowContext.window = windowContext;
  windowContext.self = windowContext;
  if (reader) {
    try {
      await evaluateModule(path.join(assetsDir, reader), windowContext, { stubImports: true });
    } catch (error) {
      problems.push(`${reader} (after ${path.basename(polyfillsPath)}) failed to evaluate on Safari 17.0's built-ins: ${describe(error)}`);
    }
  }
  const workerContext = createSafari17Context();
  if (worker) {
    try {
      await evaluateModule(path.join(assetsDir, worker), workerContext, { stubImports: false });
    } catch (error) {
      problems.push(`${worker} failed to evaluate on Safari 17.0's built-ins: ${describe(error)}`);
    }
  }

  const used = new Map();
  for (const file of files) {
    const source = await readFile(path.join(assetsDir, file), "utf8");
    const context = file === worker ? workerContext : windowContext;
    for (const builtin of MISSING_BUILTINS) {
      if (!builtin.used.test(source)) continue;
      used.set(builtin.name, [...(used.get(builtin.name) ?? []), file]);
      if (!vm.runInContext(builtin.present, context)) {
        problems.push(`${file} uses ${builtin.name}, which Safari 17.0 lacks and ${file === worker ? "the worker bundle" : path.basename(polyfillsPath)} does not install`);
      }
    }
  }
  return { problems, used };
}

async function main() {
  if (typeof vm.SourceTextModule !== "function") {
    const result = spawnSync(
      process.execPath,
      ["--experimental-vm-modules", "--no-warnings=ExperimentalWarning", ...process.argv.slice(1)],
      { stdio: "inherit" },
    );
    process.exitCode = result.status ?? 1;
    return;
  }
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args.length > 1) throw new Error("Usage: node scripts/check-webkit-compat.mjs [dist directory]");
  const dist = path.resolve(args[0] ?? "dist");
  const { problems, used } = await checkWebKitCompat({
    assetsDir: path.join(dist, "assets"),
    polyfillsPath: path.join(dist, "polyfills.js"),
  });
  if (problems.length) {
    throw new Error(`the build would fail on macOS 14 (Safari 17.0) WebKit:\n  ${problems.join("\n  ")}`);
  }
  console.log(`WebKit compatibility check passed: PDF.js window and worker evaluate on Safari 17.0's built-ins; polyfilled: ${[...used.keys()].join(", ")}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`check-webkit-compat: ${error.message}`);
    process.exitCode = 1;
  });
}
