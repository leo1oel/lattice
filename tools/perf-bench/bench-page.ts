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
import {
  THEME_TINTS, normalizeAccent, type ThemeTint, type Translucency,
} from "../../src/settings/theme-customization";

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

/**
 * The project the page has open: the fixture, until the Guided tutorial entry
 * opens the bundled sample (src-tauri/templates/tutorial), as the backend's
 * `open_tutorial_project` does, so the tour can be looked at here.
 */
const TUTORIAL_ROOT = "/bench/Lattice Tutorials/Understanding Attention";
const tutorialText = import.meta.glob<string>(
  ["../../src-tauri/templates/tutorial/**/*", "!**/*.png", "!**/*.pdf"],
  { query: "?raw", import: "default", eager: true },
);
const tutorialBinary = import.meta.glob<string>(
  ["../../src-tauri/templates/tutorial/**/*.png", "../../src-tauri/templates/tutorial/**/*.pdf"],
  { query: "?url", import: "default", eager: true },
);
const current = { root: ROOT, id: "lattice-perf-fixture", name: "Lattice perf fixture", files: fixture.files };

async function openTutorial(): Promise<ProjectSnapshot> {
  if (current.root !== TUTORIAL_ROOT) {
    const relative = (path: string) => path.slice(path.indexOf("/tutorial/") + "/tutorial/".length);
    const tutorialFiles = new Map<string, string | Uint8Array>(
      Object.entries(tutorialText).map(([path, text]) => [relative(path), text]),
    );
    for (const [path, url] of Object.entries(tutorialBinary)) {
      tutorialFiles.set(relative(path), new Uint8Array(await (await fetch(url)).arrayBuffer()));
    }
    Object.assign(current, { root: TUTORIAL_ROOT, id: "understanding-attention", name: "Understanding Attention", files: tutorialFiles });
  }
  return snapshot();
}

function kindOf(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "tex") return "tex";
  if (extension === "md") return "markdown";
  if (extension === "bib") return "bib";
  if (extension === "pdf" || extension === "png") return "figure";
  return "text";
}

/** Folders created in the page; any other folder exists through the files in it. */
const folders = new Set<string>();

/** Create and rename in the tree, so new, long and deeply nested names can be looked at. */
function createEntry(args: Args): string {
  const path = pathArg(args);
  if (current.files.has(path) || folders.has(path)) throw new Error(`${path} already exists.`);
  if (args?.kind === "folder") folders.add(path);
  else current.files.set(path, "");
  return path;
}

function renameEntry(args: Args): string {
  const path = pathArg(args);
  const name = String(args?.newName ?? "");
  const slash = path.lastIndexOf("/");
  const next = slash < 0 ? name : `${path.slice(0, slash)}/${name}`;
  const moved = (key: string) => (key === path ? next : key.startsWith(`${path}/`) ? next + key.slice(path.length) : key);
  for (const [key, content] of [...current.files]) {
    if (moved(key) === key) continue;
    current.files.delete(key);
    current.files.set(moved(key), content);
  }
  for (const key of [...folders]) {
    folders.delete(key);
    folders.add(moved(key));
  }
  return next;
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
  for (const path of folders) directory(path);
  for (const [path, content] of current.files) {
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
    root: current.root,
    manifest: {
      schemaVersion: 1,
      projectId: current.id,
      name: current.name,
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
  return path.startsWith(`${current.root}/`) ? path.slice(current.root.length + 1) : path;
}

/** A library Paper with both a full text and a blog, so its panel carries the Blog / Paper switch. */
const BENCH_PAPERS = [
  {
    arxivId: "1706.03762v7", title: "Attention Is All You Need", citationKey: "vaswani2017attention", year: "2017", hasFullText: true, hasBlog: true,
    authors: "Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob and Jones, Llion and Gomez, Aidan N. and Kaiser, Lukasz and Polosukhin, Illia",
  },
];

/**
 * `?papers=library`: the rows a real library mixes — a long title, a captured
 * webpage, a citation with only a DOI, an advisory citation-health notice, and
 * a Paper with a very long DOI and corporate author (perf-bench/layout-checks.mjs),
 * a retraction whose notice links out, and an arXiv preprint not yet fetched.
 * Everything but the first paper is fictional.
 */
const LIBRARY_PAPERS = [
  ...BENCH_PAPERS,
  {
    arxivId: "2409.01234", title: "Grounded Visual Reasoning in Long Contexts with Sparse Multimodal Supervision", citationKey: "example2024grounded", year: "2024",
    authors: "Example, Ada and Sample, Grace", hasFullText: true, hasBlog: false,
    citationHealth: { kind: "expressionOfConcern", source: "publisher", date: "2025-03-14", checkedAt: "2026-10-01T00:00:00Z" },
  },
  {
    arxivId: "web-0123456789abcdef", url: "https://www.example.org/research/notes-on-sparse-retrieval", title: "Notes on sparse retrieval",
    citationKey: "notes2025sparse", hasFullText: true, hasBlog: false,
  },
  {
    arxivId: "", doi: "10.5555/example.2021.42", url: "https://doi.org/10.5555/example.2021.42", title: "A citation that only names its DOI",
    citationKey: "doe2021citation", year: "2021", authors: "Doe, Jane", hasFullText: false, hasBlog: false,
  },
  {
    arxivId: "doi-10.5555-proceedings.2023.long-form", doi: "10.5555/proceedings.international-symposium-on-scholarly-communication.2023.volume-12.issue-4.part-b.supplementary-material.long-form-chapter-identifier.version-of-record",
    url: "https://publisher.example.org/content/proceedings-2023/long-form-chapter.pdf", title: "Reading the original of a paper with a very long DOI",
    citationKey: "consortium2023reading", year: "2023", authors: "{International Consortium for Long-Form Persistent Identifiers in Scholarly Communication and Research Infrastructure}", hasFullText: true, hasBlog: false,
  },
  {
    arxivId: "2311.04567", title: "Self-Correcting Language Models Through Iterative Retrieval-Augmented Verification", citationKey: "placeholder2023selfcorrecting", year: "2023",
    authors: "Placeholder, Kim and Instance, Lee and Demo, Sam", hasFullText: true, hasBlog: false,
    citationHealth: { kind: "retracted", source: "retraction-watch", date: "2024-06-02", link: "https://example.org/retraction-notice", checkedAt: "2026-10-01T00:00:00Z" },
  },
  {
    arxivId: "2502.07890", title: "Scaling Laws for Sparse Mixture-of-Experts Decoders", citationKey: "specimen2025scaling", year: "2025",
    authors: "Specimen, Ray and Mock, Ivy", hasFullText: false, hasBlog: false,
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

/**
 * Project search over the fixture: paths and lines holding every term, then each listed
 * Paper whose title does, shaped like the backend's hits (files first, papers
 * under `.research/papers/<key>/`), so Find in project can be looked at.
 */
function searchProject(query: string) {
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text: string) => terms.length > 0 && terms.every((term) => text.toLocaleLowerCase().includes(term));
  const hits: Array<Record<string, unknown>> = [];
  for (const [path, content] of current.files) {
    if (typeof content !== "string") continue;
    if (matches(path)) hits.push({ kind: "file", path, title: path.slice(path.lastIndexOf("/") + 1), snippet: path, line: 1, fileKind: path.split(".").pop() });
    content.split("\n").forEach((text, index) => {
      if (hits.length < 40 && matches(text)) {
        hits.push({ kind: "file", path, title: path.slice(path.lastIndexOf("/") + 1), snippet: text.trim().slice(0, 180), line: index + 1, fileKind: path.split(".").pop() });
      }
    });
  }
  const papers = libraryPapers ? LIBRARY_PAPERS : params.has("papers") ? BENCH_PAPERS : [];
  for (const paper of papers) {
    if (!paper.hasFullText || !matches(paper.title)) continue;
    const key = paper.arxivId || paper.citationKey;
    hits.push({ kind: "paper", path: `.research/papers/${key}/paper.md`, title: paper.title, snippet: paper.title, line: null, arxivId: paper.arxivId || null });
  }
  return hits;
}

/**
 * The agent's read-only text task (proofreading), answered after a short
 * pause with a few fixed spelling and agreement fixes, so the inline
 * proofread card can be looked at without a provider. A Polish prompt also
 * gets a few wordiness fixes. `?proofread=failed` fails the task,
 * `?proofread=unavailable` answers like a runtime that predates the route,
 * `?proofread=unsafe` also changes the first inline math and citation key
 * (which the card must hold back), and `?proofreadModel=<name>` reports that
 * model with the answer.
 */
const PROOFREAD_FIXES: Array<[RegExp, string]> = [
  [/\bteh\b/g, "the"],
  [/\bwich\b/g, "which"],
  [/\bbeleive\b/g, "believe"],
  [/\brecieves?\b/g, "receives"],
  [/\boccured\b/g, "occurred"],
  [/\bseperate\b/g, "separate"],
  [/\bachieve state of the art\b/g, "achieves state-of-the-art"],
  [/\ba ([aeiou])/g, "an $1"],
  [/ {2,}/g, " "],
  [/ ,/g, ","],
];
const POLISH_FIXES: Array<[RegExp, string]> = [
  [/\bIn this paper,? we show that\b/g, "This paper shows that"],
  [/\bin order to\b/g, "to"],
  [/\bdue to the fact that\b/g, "because"],
  [/\bvery important\b/g, "essential"],
  [/\ba lot of\b/g, "many"],
];
const UNSAFE_FIXES: Array<[RegExp, string]> = [
  [/\$([^$]+)\$/, "$\\hat{$1}$"],
  [/\\cite\{([^}]+)\}/, "\\cite{$1-2024}"],
];
const proofreadTasks = new Map<string, { text: string; ready: number }>();

function textTask(args: Args): unknown {
  const mode = params.get("proofread");
  const action = String(args?.action ?? "");
  if (action === "start") {
    if (mode === "unavailable") throw "agent_route_unavailable";
    const prompt = String(args?.prompt ?? "");
    const excerpt = /<excerpt>\n([\s\S]*)\n<\/excerpt>$/.exec(prompt)?.[1] ?? "";
    const fixes = [
      ...PROOFREAD_FIXES,
      ...prompt.startsWith("Polish") ? POLISH_FIXES : [],
      ...mode === "unsafe" ? UNSAFE_FIXES : [],
    ];
    const fixed = fixes.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), excerpt);
    const taskId = `text-task:${proofreadTasks.size + 1}`;
    proofreadTasks.set(taskId, { text: `Here is the proofread excerpt.\n<proofread>\n${fixed}\n</proofread>`, ready: performance.now() + 1_600 });
    return { taskId };
  }
  const task = proofreadTasks.get(String(args?.taskId ?? ""));
  if (!task) throw "Agent task not found.";
  if (action === "cancel") return { status: "running" };
  if (performance.now() < task.ready) return { status: "running" };
  if (mode === "failed") return { status: "failed", message: "Codex is not signed in." };
  const model = params.get("proofreadModel");
  return { status: "completed", text: task.text, ...model ? { model } : {} };
}

function answer(command: string, args: Args): unknown {
  counts.set(command, (counts.get(command) ?? 0) + 1);
  switch (command) {
    // `?welcome=1` starts on the welcome screen, as a launch with no project does.
    case "initial_project":
      return params.has("welcome") ? null : snapshot();
    case "open_project":
    case "refresh_project":
    case "list_project_tree_with_hidden":
      return snapshot();
    case "open_tutorial_project":
      return openTutorial();
    case "read_project_file": {
      const content = current.files.get(pathArg(args));
      if (typeof content !== "string") throw new Error(`No such text file: ${pathArg(args)}`);
      return content;
    }
    case "write_project_file": {
      const contents = args?.contents ?? args?.content;
      if (typeof contents === "string") current.files.set(pathArg(args), contents);
      return null;
    }
    case "read_project_asset": {
      const path = pathArg(args);
      const content = current.files.get(path);
      if (!(content instanceof Uint8Array)) throw new Error(`No such asset: ${path}`);
      return { path, mimeType: path.endsWith(".png") ? "image/png" : "application/pdf", ranges: { length: content.byteLength, version: "bench" } };
    }
    case "read_project_asset_range": {
      const content = current.files.get(pathArg(args));
      if (!(content instanceof Uint8Array)) throw new Error(`No such asset: ${pathArg(args)}`);
      return copyBuffer(content.subarray(Number(args?.start), Number(args?.end)));
    }
    case "build_project":
      return buildResult();
    case "read_compiled_pdf":
      return copyBuffer(fixture.compiledPdf);
    case "stat_project_file":
      return { exists: current.files.has(pathArg(args)), mtimeMs: 1_700_000_000_000 };
    case "search_project":
      return searchProject(String(args?.query ?? ""));
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
    case "set_window_material":
      return glass ? ((args?.material as { translucent?: boolean } | undefined)?.translucent ? "translucent" : "opaque") : "unsupported";
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
    case "synara_open_log_folder":
      return false;
    case "agent_text_task":
      return textTask(args);
    case "synara_ensure_ready":
    case "create_project_entry":
      return createEntry(args);
    case "rename_project_entry":
      return renameEntry(args);
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
// `?tint=`, `?accent=` (a preset or a hex colour without its #) and
// `?glass=subtle|strong` show the theme choices in Settings → Appearance. A
// browser has no vibrancy, so `?glass=` also answers set_window_material as a
// translucent macOS window would and paints a stand-in desktop behind the
// page: a wallpaper under a frosted wash, roughly what the under-window
// material looks like. Without it the page shows the opaque fallback a
// browser-hosted Lattice really gets.
const tint = choiceParam<ThemeTint>("tint", THEME_TINTS);
const accentParam = params.get("accent");
const accent = accentParam ? normalizeAccent(/^[0-9a-f]{6}$/i.test(accentParam) ? `#${accentParam}` : accentParam) : undefined;
const glass = choiceParam<Translucency>("glass", ["subtle", "strong"]);
const themeChoices = { ...(tint && { tint }), ...(accent && { accent }), ...(glass && { translucency: glass }) };
if (glass) {
  const style = document.head.appendChild(document.createElement("style"));
  style.textContent = `
    .bench-desktop { position: fixed; inset: 0; z-index: -1; overflow: hidden; }
    .bench-desktop::before { content: ""; position: absolute; inset: -120px; filter: blur(56px) saturate(1.5);
      background: radial-gradient(40% 50% at 18% 30%, #ff7a59, transparent), radial-gradient(45% 55% at 70% 20%, #6d5dfc, transparent),
        radial-gradient(50% 50% at 80% 85%, #00b3a4, transparent), radial-gradient(40% 40% at 25% 85%, #ffc94d, transparent), #3b4b7a; }
    .bench-desktop::after { content: ""; position: absolute; inset: 0; background: rgb(244 244 246 / 0.64); }
    :root[data-theme="dark"] .bench-desktop::after { background: rgb(30 30 32 / 0.68); }`;
  document.body.prepend(Object.assign(document.createElement("div"), { className: "bench-desktop" }));
}

// A first run lands on the onboarding tour and would auto-build; the bench
// measures a returning writer with manual builds instead.
if (!params.has("keepStorage")) {
  localStorage.clear();
  localStorage.setItem(TUTORIAL_SEEN_KEY, "1");
  localStorage.setItem(BUILD_PREFERENCES_KEY, JSON.stringify({ autoBuildMode: "manual" }));
  localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ interfaceLanguage: lang ?? "en", ...themeChoices }));
} else if (lang) {
  // Over kept storage, change the language (and any theme choice above) and
  // keep the rest of the appearance.
  let stored: unknown = null;
  try {
    stored = JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? "null");
  } catch {
    // A corrupt entry is replaced, as the app itself would treat it as absent.
  }
  const appearance = stored && typeof stored === "object" ? stored : {};
  localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ ...appearance, interfaceLanguage: lang, ...themeChoices }));
}
// Stored raw, not as JSON (loadThemePreference).
if (theme) localStorage.setItem(THEME_PREFERENCE_KEY, theme);

await import("../../src/main.tsx");
