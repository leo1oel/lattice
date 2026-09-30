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

type Callback = (payload: unknown) => void;
type Args = Record<string, unknown> | undefined;

const ROOT = "/bench/lattice-perf-fixture";

const params = new URLSearchParams(location.search);
const sizes: Partial<PerfFixtureSizes> = {};
for (const key of ["largeMarkdownBytes", "chapterBytes", "chapters", "notes", "codeBlocks", "pdfPages", "logLines"] as const) {
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

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function pathArg(args: Args): string {
  const path = args?.path;
  if (typeof path !== "string") throw new Error("missing path");
  return path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1) : path;
}

const unhandled = new Set<string>();
const counts = new Map<string, number>();

/** A successful build with a handful of warnings, the fixture's log and PDF. */
function buildResult() {
  return {
    success: true,
    hasPdf: true,
    log: fixture.buildLog,
    durationMs: 1_234,
    diagnostics: [
      { level: "warning", message: "There were undefined references.", file: "main.tex", line: 4 },
      { level: "warning", message: "Overfull \\hbox (4.2pt too wide) in paragraph", file: "chapters/ch01.tex", line: 12 },
    ],
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
      return { path, mimeType: "application/pdf", base64: base64(content) };
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
    case "browser_access_enabled":
      return false;
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

// A first run lands on the onboarding tour and would auto-build; the bench
// measures a returning writer with manual builds instead.
if (!params.has("keepStorage")) {
  localStorage.clear();
  localStorage.setItem("lattice.tutorial-seen.v1", "1");
  localStorage.setItem("lattice.build-preferences.v2", JSON.stringify({ autoBuildMode: "manual" }));
  // Scenarios find controls by their English names, whatever the machine's locale.
  localStorage.setItem("lattice.appearance.v5", JSON.stringify({ interfaceLanguage: "en" }));
}

await import("../../src/main.tsx");
