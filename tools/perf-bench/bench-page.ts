/**
 * The performance benchmark's page: the real app, answered by an in-memory
 * backend that holds the deterministic fixture project (scripts/perf-fixture.mjs).
 *
 * Installing `__TAURI_INTERNALS__` before the app loads makes
 * src/platform/browser-runtime.ts stand aside, exactly as it does inside the
 * Tauri webview, so every `invoke` lands in `answer` below. Commands the
 * benchmark does not model resolve to `null`; `window.__latticeBench.unhandled`
 * lists them, which is where to look when a new startup command appears.
 *
 * The counters (React commits, DOM mutations, long tasks) are not here: the
 * driver injects them before any page script runs, so the same probe also
 * measures the real app. See scripts/perf-bench.mjs.
 */
import { perfFixture, type PerfFixtureSizes } from "../../scripts/perf-fixture.mjs";
import type { FileNode, ProjectSnapshot } from "../../src/app-types";
// app-settings has no side effects (its imports are type-only), so importing
// its keys here runs no app code before the mock backend below is installed.
import {
  APPEARANCE_KEY, BUILD_PREFERENCES_KEY, THEME_PREFERENCE_KEY, TUTORIAL_SEEN_KEY, type InterfaceLanguage, type ThemePreference,
} from "../../src/settings/app-settings";

type Callback = (payload: unknown) => void;
type Args = Record<string, unknown> | undefined;

const ROOT = "/bench/lattice-perf-fixture";

const params = new URLSearchParams(location.search);
const sizes: Partial<PerfFixtureSizes> = {};
for (const key of ["largeMarkdownBytes", "chapterBytes", "chapters", "longTexBytes", "notes", "codeBlocks", "pdfPages", "logLines"] as const) {
  const value = Number(params.get(key));
  if (Number.isFinite(value) && value > 0) sizes[key] = value;
}
const fixture = perfFixture(sizes);
const files = fixture.files;

function kindOf(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "tex") return "tex";
  if (extension === "md") return "markdown";
  if (extension === "bib") return "bib";
  if (extension === "pdf") return "figure";
  return "text";
}

function fileTree(): FileNode[] {
  const root: FileNode = { name: "", path: "", kind: "directory", contentKind: "directory", children: [] };
  const directories = new Map<string, FileNode>([["", root]]);
  const directory = (path: string): FileNode => {
    const existing = directories.get(path);
    if (existing) return existing;
    const slash = path.lastIndexOf("/");
    const node: FileNode = {
      name: path.slice(slash + 1), path, kind: "directory", contentKind: "directory", children: [],
    };
    directory(slash < 0 ? "" : path.slice(0, slash)).children.push(node);
    directories.set(path, node);
    return node;
  };
  for (const [path, content] of files) {
    const slash = path.lastIndexOf("/");
    directory(slash < 0 ? "" : path.slice(0, slash)).children.push({
      name: path.slice(slash + 1),
      path,
      kind: kindOf(path),
      contentKind: typeof content === "string" ? "text" : "binary",
      size: content.length,
      children: [],
    });
  }
  const sort = (nodes: FileNode[]) => {
    nodes.sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.path.localeCompare(b.path));
    nodes.forEach((node) => sort(node.children));
  };
  sort(root.children);
  return root.children;
}

function snapshot(): ProjectSnapshot {
  return {
    root: ROOT,
    manifest: {
      schemaVersion: 1,
      projectId: "lattice-perf-fixture",
      name: "Lattice perf fixture",
      rootDocuments: [{ path: "main.tex", name: "Main", isDefault: true }],
      primaryBibliography: "references.bib",
      trusted: true,
    },
    files: fileTree(),
  };
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function pathArg(args: Args): string {
  const path = args?.path;
  if (typeof path !== "string") throw new Error("missing path");
  return path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1) : path;
}

/** A library Paper with both a full text and a blog, so its panel carries the Blog / Paper switch. */
const BENCH_PAPERS = [
  {
    arxivId: "1706.03762v7", title: "Attention Is All You Need", citationKey: "vaswani2017attention", hasFullText: true, hasBlog: true,
    authors: "Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob and Jones, Llion and Gomez, Aidan N. and Kaiser, Lukasz and Polosukhin, Illia",
  },
];

/**
 * `?papers=library`: the rows a real library mixes — a long title, a captured
 * webpage, a citation with only a DOI, and an advisory citation-health notice.
 * Everything but the first paper is fictional.
 */
const LIBRARY_PAPERS = [
  ...BENCH_PAPERS,
  {
    arxivId: "2409.01234", title: "Grounded Visual Reasoning in Long Contexts with Sparse Multimodal Supervision", citationKey: "example2024grounded",
    authors: "Example, Ada and Sample, Grace", hasFullText: true, hasBlog: false,
    citationHealth: { kind: "expressionOfConcern", source: "publisher", date: "2025-03-14", checkedAt: "2026-10-01T00:00:00Z" },
  },
  {
    arxivId: "web-0123456789abcdef", url: "https://www.example.org/research/notes-on-sparse-retrieval", title: "Notes on sparse retrieval",
    citationKey: "notes2025sparse", hasFullText: true, hasBlog: false,
  },
  {
    arxivId: "", doi: "10.5555/example.2021.42", url: "https://doi.org/10.5555/example.2021.42", title: "A citation that only names its DOI",
    citationKey: "doe2021citation", authors: "Doe, Jane", hasFullText: false, hasBlog: false,
  },
];

const fullTextOnly = params.get("papers") === "fulltext";
const libraryPapers = params.get("papers") === "library";

const unhandled = new Set<string>();
const counts = new Map<string, number>();

/**
 * A successful build with a handful of warnings, the fixture's log and PDF.
 * `?build=clean` drops the warnings and `?build=failed` fails it, for looking
 * at the other results.
 */
function buildResult() {
  const outcome = params.get("build");
  const warnings = [
    { level: "warning", message: "There were undefined references.", file: "main.tex", line: 4 },
    { level: "warning", message: "Overfull \\hbox (4.2pt too wide) in paragraph", file: "chapters/ch01.tex", line: 12 },
  ];
  return {
    success: outcome !== "failed",
    hasPdf: true,
    log: fixture.buildLog,
    durationMs: 1_234,
    diagnostics: outcome === "clean" ? []
      : outcome === "failed" ? [{ level: "error", message: "Undefined control sequence.", file: "main.tex", line: 6 }]
        : warnings,
    rootDocument: "main.tex",
  };
}

function answer(command: string, args: Args): unknown {
  counts.set(command, (counts.get(command) ?? 0) + 1);
  switch (command) {
    case "initial_project":
    case "open_project":
    case "refresh_project":
    case "list_project_tree_with_hidden":
      return snapshot();
    case "read_project_file": {
      const content = files.get(pathArg(args));
      if (typeof content !== "string") throw new Error(`No such text file: ${pathArg(args)}`);
      return content;
    }
    case "write_project_file": {
      const contents = args?.contents ?? args?.content;
      if (typeof contents === "string") files.set(pathArg(args), contents);
      return null;
    }
    case "read_project_asset": {
      const path = pathArg(args);
      const content = files.get(path);
      if (!(content instanceof Uint8Array)) throw new Error(`No such asset: ${path}`);
      return { path, mimeType: "application/pdf", ranges: { length: content.byteLength, version: "bench" } };
    }
    case "read_project_asset_range": {
      const content = files.get(pathArg(args));
      if (!(content instanceof Uint8Array)) throw new Error(`No such asset: ${pathArg(args)}`);
      return copyBuffer(content.subarray(Number(args?.start), Number(args?.end)));
    }
    case "build_project":
      return buildResult();
    case "read_compiled_pdf":
      return copyBuffer(fixture.compiledPdf);
    case "stat_project_file":
      return { exists: files.has(pathArg(args)), mtimeMs: 1_700_000_000_000 };
    case "harper_lint":
    case "texlab_diagnostics":
      return [];
    case "count_project_words":
      return { text: 120_000, headers: 400, captions: 0, total: 120_400, source: "texcount" };
    case "overleaf_status":
      return { connected: false, email: null, name: null, host: "https://www.overleaf.com" };
    case "git_status":
      return { available: false, repository: false, branch: null, files: [] };
    case "list_unused_symbols":
      return { labels: [], citations: [] };
    case "plugin:window|scale_factor":
      return window.devicePixelRatio;
    case "plugin:window|inner_size":
    case "plugin:window|outer_size":
      return {
        width: Math.round(window.innerWidth * window.devicePixelRatio),
        height: Math.round(window.innerHeight * window.devicePixelRatio),
      };
    case "plugin:window|is_focused":
      return document.hasFocus();
    case "plugin:window|is_fullscreen":
    case "plugin:window|is_maximized":
      return false;
    // Papers only with `?papers=1` (or `?papers=fulltext`, a Paper without a
    // blog, or `?papers=library`): the budgeted scenarios run with an empty library.
    case "list_papers":
      if (libraryPapers) return LIBRARY_PAPERS;
      return params.has("papers") ? BENCH_PAPERS.map((paper) => ({ ...paper, hasBlog: !fullTextOnly })) : [];
    case "read_paper":
      return `## Abstract\n\n${"Paper content. ".repeat(40)}`;
    case "read_paper_blog_local":
      return fullTextOnly ? null : `## Overview\n\n${"Blog content. ".repeat(40)}`;
    case "synara_ensure_ready":
    case "run_doctor":
      // The agent runtime and the TeX toolchain check are outside the bench;
      // the app treats a failure as an environment that does not expose them.
      throw new Error(`${command} is not part of the performance bench.`);
    default:
      if (command.startsWith("list_")) return [];
      unhandled.add(command);
      return null;
  }
}

// --- Tauri internals -----------------------------------------------------

const callbacks = new Map<number, Callback>();
const listeners = new Map<string, Set<number>>();
let nextCallback = 1;
let nextEvent = 1;
const eventIds = new Map<number, { event: string; handler: number }>();

function emit(event: string, payload: unknown) {
  for (const handler of listeners.get(event) ?? []) {
    callbacks.get(handler)?.({ event, id: 0, payload });
  }
}

async function invoke(command: string, args?: Args): Promise<unknown> {
  if (command === "plugin:event|listen") {
    const { event, handler } = args as { event: string; handler: number };
    const id = nextEvent++;
    eventIds.set(id, { event, handler });
    listeners.set(event, (listeners.get(event) ?? new Set()).add(handler));
    return id;
  }
  if (command === "plugin:event|unlisten") {
    const entry = eventIds.get((args as { eventId: number }).eventId);
    if (entry) {
      listeners.get(entry.event)?.delete(entry.handler);
      eventIds.delete((args as { eventId: number }).eventId);
    }
    return null;
  }
  if (command === "plugin:event|emit" || command === "plugin:event|emit_to") {
    const { event, payload } = args as { event: string; payload: unknown };
    emit(event, payload);
    return null;
  }
  return answer(command, args);
}

Object.assign(window, {
  __TAURI_INTERNALS__: {
    invoke,
    transformCallback: (callback?: Callback, once = false) => {
      const id = nextCallback++;
      callbacks.set(id, (payload) => {
        if (once) callbacks.delete(id);
        callback?.(payload);
      });
      return id;
    },
    unregisterCallback: (id: number) => callbacks.delete(id),
    runCallback: (id: number, payload: unknown) => callbacks.get(id)?.(payload),
    callbacks,
    convertFileSrc: (path: string) => path,
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main", windowLabel: "main" },
    },
    plugins: { path: { sep: "/", delimiter: ":" } },
  },
  __TAURI_EVENT_PLUGIN_INTERNALS__: {
    unregisterListener: (_event: string, id: number) => callbacks.delete(id),
  },
  __latticeBench: { root: ROOT, emit, unhandled, counts, fixtureSizes: sizes },
});

/** A query parameter restricted to `allowed`; anything else is reported and ignored. */
function choiceParam<T extends string>(name: string, allowed: readonly T[]): T | null {
  const value = params.get(name);
  if (value === null) return null;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  console.warn(`perf bench: ignoring ${name}=${value}; expected one of ${allowed.join(", ")}`);
  return null;
}

// `?theme=` and `?lang=` are for screenshots and QA (pnpm perf:bench --serve).
// The benchmark passes neither: it runs in the browser's own appearance
// ("system", light in headless Chrome) and in English, because scenarios find
// controls by their English names whatever the machine's locale.
const theme = choiceParam<ThemePreference>("theme", ["system", "light", "dark"]);
const lang = choiceParam<InterfaceLanguage>("lang", ["en", "zh-CN", "system"]);

// A first run lands on the onboarding tour and would auto-build; the bench
// measures a returning writer with manual builds instead.
if (!params.has("keepStorage")) {
  localStorage.clear();
  localStorage.setItem(TUTORIAL_SEEN_KEY, "1");
  localStorage.setItem(BUILD_PREFERENCES_KEY, JSON.stringify({ autoBuildMode: "manual" }));
  localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ interfaceLanguage: lang ?? "en" }));
} else if (lang) {
  // Over kept storage, change the language and keep the rest of the appearance.
  let stored: unknown = null;
  try {
    stored = JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? "null");
  } catch {
    // A corrupt entry is replaced, as the app itself would treat it as absent.
  }
  const appearance = stored && typeof stored === "object" ? stored : {};
  localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ ...appearance, interfaceLanguage: lang }));
}
// Stored raw, not as JSON (loadThemePreference).
if (theme) localStorage.setItem(THEME_PREFERENCE_KEY, theme);

await import("../../src/main.tsx");
