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
import { PLAYBOOK_FIXTURE, perfFixture, type PerfFixtureSizes } from "../../scripts/perf-fixture.mjs";
import { arxivAnswer } from "./bench-arxiv";
import { linkedLibraryAnswer, linkedLibraryBibliography } from "./bench-linked-library";
import { NOT_HANDLED, overleafAnswer } from "./bench-overleaf";
import type { FileNode, ProjectDeadline, ProjectSnapshot, SubmissionItem } from "../../src/app-types";
// app-settings has no side effects (its imports are type-only), so importing
// its keys here runs no app code before the mock backend below is installed.
import {
  APPEARANCE_KEY, BUILD_PREFERENCES_KEY, RECENT_PROJECTS_KEY, THEME_PREFERENCE_KEY, TUTORIAL_SEEN_KEY, type InterfaceLanguage, type ThemePreference,
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
 * A large project's libraries, each off unless asked for, so the budgeted
 * scenarios keep the fixture they were set on: `?paperCount=<n>` papers in
 * the library, `?bibEntries=<n>` entries in `references.bib` (the primary
 * bibliography), `?historyEntries=<n>` records in Lattice's own history and
 * `?gitVersions=<n>` versions in a git repository. Deterministic, like the
 * fixture.
 */
const scale = Object.fromEntries((["paperCount", "bibEntries", "historyEntries", "gitVersions"] as const).map((key) => {
  const value = Number(params.get(key));
  return [key, Number.isFinite(value) && value > 0 ? Math.floor(value) : 0];
})) as Record<"paperCount" | "bibEntries" | "historyEntries" | "gitVersions", number>;

const SCALE_WORDS = ["Sparse", "Attention", "Retrieval", "Long-Context", "Diffusion", "Alignment", "Scaling", "Graph", "Contrastive", "Multimodal", "Efficient", "Robust", "Causal", "Federated", "Neural"];
const SCALE_NAMES = ["Chen, Wei", "Garcia, Maria", "Smith, John", "Kumar, Priya", "Müller, Anna", "Tanaka, Hiro", "Okafor, Ngozi", "Dubois, Claire", "Ivanov, Petr", "Silva, Ana"];
const scaleTitle = (index: number) => `${SCALE_WORDS[index % 15]} ${SCALE_WORDS[(index * 7 + 3) % 15]} for ${SCALE_WORDS[(index * 11 + 5) % 15]} Models: Study ${index + 1}`;
const scaleAuthors = (index: number) => [0, 1, 2].slice(0, 1 + (index % 3)).map((offset) => SCALE_NAMES[(index + offset * 3) % 10]).join(" and ");
const scaleKey = (index: number) => `${SCALE_NAMES[index % 10].split(",")[0].toLowerCase().normalize("NFD").replace(/[^a-z]/g, "")}${2000 + (index % 26)}${SCALE_WORDS[(index * 7 + 3) % 15].toLowerCase().replace(/[^a-z]/g, "")}${index}`;

const linkedBibliography = linkedLibraryBibliography(params);
if (linkedBibliography) fixture.files.set("references.bib", linkedBibliography);

if (scale.bibEntries) {
  fixture.files.set("references.bib", Array.from({ length: scale.bibEntries }, (_, index) => {
    const article = index % 3 !== 2;
    return [
      `@${article ? "article" : "inproceedings"}{${scaleKey(index)},`,
      `  title = {${scaleTitle(index)}},`,
      `  author = {${scaleAuthors(index)}},`,
      `  year = {${2000 + (index % 26)}},`,
      article ? `  journal = {Journal of ${SCALE_WORDS[index % 15]} Research},` : `  booktitle = {Proceedings of the ${SCALE_WORDS[(index * 5) % 15]} Conference},`,
      `  volume = {${1 + (index % 40)}},`,
      `  pages = {${1 + index}--${12 + index}},`,
      index % 4 === 0 ? `  eprint = {${2100 + (index % 500)}.${String(10000 + index).slice(-5)}},` : `  doi = {10.5555/scale.${index}},`,
      "}",
    ].join("\n");
  }).join("\n\n"));
}

const SCALE_PAPERS = Array.from({ length: scale.paperCount }, (_, index) => ({
  arxivId: index % 5 === 4 ? "" : `${2100 + (index % 500)}.${String(10000 + index).slice(-5)}`,
  ...index % 5 === 4 ? { doi: `10.5555/scale.${index}`, url: `https://doi.org/10.5555/scale.${index}` } : {},
  title: scaleTitle(index), citationKey: scaleKey(index), year: String(2000 + (index % 26)), authors: scaleAuthors(index),
  hasFullText: index % 5 !== 4 && index % 3 !== 0, hasBlog: index % 7 === 0,
  ...index % 41 === 0 ? { citationHealth: { kind: "retracted", source: "retraction-watch", date: "2024-06-02", checkedAt: "2026-10-01T00:00:00Z" } } : {},
}));

/** The newest record an hour ago, one more every 37 minutes back. */
const scaleTime = (index: number) => new Date(Date.UTC(2026, 9, 12, 12) - index * 37 * 60_000).toISOString();
const SCALE_HISTORY = Array.from({ length: scale.historyEntries }, (_, index) => ({
  id: `scale-history-${index}`, label: index % 4 === 0 ? `Agent edit ${index}` : `Edit chapters/ch0${1 + (index % 8)}.tex`,
  timestamp: scaleTime(index), files: [`chapters/ch0${1 + (index % 8)}.tex`],
  actor: index % 4 === 0 ? "agent" : index % 9 === 0 ? "citation" : "user", kind: "edit", source: "editor",
}));
const SCALE_VERSIONS = Array.from({ length: scale.gitVersions }, (_, index) => {
  const hash = (index * 2654435761 >>> 0).toString(16).padStart(8, "0").repeat(5);
  return {
    hash, shortHash: hash.slice(0, 7), authorName: SCALE_NAMES[index % 10].split(", ").reverse().join(" "), timestamp: scaleTime(index * 2 + 1),
    message: index % 3 === 0 ? "Auto-saved" : `Revise section ${1 + (index % 30)}`,
    files: [{ path: `chapters/ch0${1 + (index % 8)}.tex`, kind: "modified" }],
  };
});

/**
 * `?versions=compare`: a paper's saved versions, for comparing two of them
 * (History → Compare…): named ones with automatic syncs between, one with a
 * long name. A compared file's older side is the open project's with three of
 * the tutorial's rewritten sentences put back, and `?export=failed` makes the
 * PDF with changes marked fail as it does without latexdiff.
 */
const COMPARE_VERSIONS = params.get("versions") === "compare"
  ? [
    ["Rebuttal draft", "You", "2026-08-01T09:12:00Z"],
    ["Overleaf sync", "Lattice", "2026-07-20T16:40:00Z"],
    ["Overleaf sync", "Lattice", "2026-07-20T11:05:00Z"],
    ["Camera-ready for NeurIPS 2026, after the area chair’s second round of comments", "Mina Park", "2026-06-02T18:30:00Z"],
    ["Submitted to NeurIPS", "You", "2026-05-15T21:58:00Z"],
  ].map(([message, authorName, timestamp], index) => {
    const hash = `c0ffee${index}`.padEnd(40, "0");
    return { hash, shortHash: hash.slice(0, 7), authorName, timestamp, message, files: [{ path: "main.tex", kind: "modified" }] };
  })
  : null;
const OLDER_SENTENCES: Array<[string, string]> = [
  ["a learned alignment mechanism that let a decoder retrieve different encoder states instead of compressing an entire source sentence into one fixed vector", "an alignment mechanism that let a decoder look at encoder states instead of compressing a source sentence into one vector"],
  ["Attention visualizations describe routing weights inside a model, not a causal explanation of the model's final prediction.", "Attention maps explain what the model attends to and why it made its prediction."],
  ["FlashAttention computes exact attention while tiling operations to reduce expensive transfers between levels of GPU memory", "FlashAttention is a faster approximation of attention for GPUs"],
];
const olderText = (text: string) => OLDER_SENTENCES.reduce((older, [now, before]) => older.replace(now, before), text);

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
// `?arxiv=long` names the project at length, for the export sheet's width checks.
if (params.get("arxiv") === "long") current.name = "Understanding Attention in Transformer Language Models: A Long Study";

/**
 * `?build=typo`: main.tex mistypes \citep as \cietp, the build fails on it
 * and also warns (an unresolved citation, an overfull line), so the
 * explained build error can be looked at. The tutorial's first \citep is the
 * one mistyped; the fixture, which cites nothing, gets a paragraph that does.
 */
function stageTypo(files: Map<string, string | Uint8Array>) {
  const main = files.get("main.tex");
  if (params.get("build") !== "typo" || typeof main !== "string" || main.includes("\\cietp")) return;
  files.set("main.tex", main.includes("\\citep{")
    ? main.replace("\\citep{", "\\cietp{")
    : main.replace("\\end{document}", "Attention follows \\citep{bahdanau2015} and \\citep{vaswani2017}; see \\cietp{luong2015effective}.\n\\end{document}"));
}
stageTypo(current.files);

// `?review=unread` has main.tex input a results section whose read fails, as
// an unreadable file's does, so the review's report says what it did not
// cover; `?review=unread-long` names that file at length, for narrow panels.
const UNREAD_INCLUDE = params.get("review") === "unread-long"
  ? "sections/experimental-results-and-ablations-on-long-context-benchmarks.tex"
  : "sections/results.tex";
const unreadInclude = params.get("review")?.startsWith("unread") ?? false;
function stageUnreadInclude(files: Map<string, string | Uint8Array>) {
  const main = files.get("main.tex");
  if (!unreadInclude || typeof main !== "string" || files.has(UNREAD_INCLUDE)) return;
  files.set("main.tex", main.replace("\\end{document}", `\\input{${UNREAD_INCLUDE.replace(/\.tex$/, "")}}\n\\end{document}`));
  files.set(UNREAD_INCLUDE, "\\section{Results}\n");
}
stageUnreadInclude(current.files);

async function openTutorial(): Promise<ProjectSnapshot> {
  if (current.root !== TUTORIAL_ROOT) {
    const relative = (path: string) => path.slice(path.indexOf("/tutorial/") + "/tutorial/".length);
    const tutorialFiles = new Map<string, string | Uint8Array>(
      Object.entries(tutorialText).map(([path, text]) => [relative(path), text]),
    );
    for (const [path, url] of Object.entries(tutorialBinary)) {
      tutorialFiles.set(relative(path), new Uint8Array(await (await fetch(url)).arrayBuffer()));
    }
    stageTypo(tutorialFiles);
    stageUnreadInclude(tutorialFiles);
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

/**
 * Import files…, as far as a page without a Mac can take it. The open panel
 * answers with `?importPick=` (comma-separated Finder items: a name with an
 * extension is a file, one without a folder holding `notes.txt` and
 * `results.csv`; default `main.tex,chapters,references.bib`, two of which the
 * fixture's root already has), and the import lands them as the backend
 * does: asked without a policy, names the target already has come back as
 * conflicts. `?importDelay=<ms>` stretches the copy
 * and reports its progress, to look at the progress toast.
 */
const importPick = (params.get("importPick") ?? "main.tex,chapters,references.bib").split(",").filter(Boolean);
const importDelay = Number(params.get("importDelay")) || 0;

async function importEntries(args: Args) {
  const target = String(args?.targetDirectory ?? "").replace(/\/+$/, "");
  const conflict = args?.conflict as "keepBoth" | "replace" | "skip" | undefined;
  const join = (name: string) => (target ? `${target}/${name}` : name);
  const taken = (path: string) => current.files.has(path) || folders.has(path)
    || [...current.files.keys()].some((file) => file.startsWith(`${path}/`));
  const names = (args?.paths as string[] ?? []).map((path) => path.split("/").pop() ?? path);
  if (!conflict) {
    const conflicts = names.filter((name) => taken(join(name)));
    if (conflicts.length) return { conflicts, files: [], entries: [], skipped: [] };
  }
  const entries: string[] = [];
  const skipped: string[] = [];
  const files: { path: string; kind: string }[] = [];
  for (const name of names) {
    let path = join(name);
    if (taken(path) && conflict === "skip") {
      skipped.push(name);
      continue;
    }
    if (taken(path) && conflict !== "replace") {
      const dot = name.includes(".") ? name.lastIndexOf(".") : name.length;
      for (let number = 2; taken(path); number += 1) path = join(`${name.slice(0, dot)}-${number}${name.slice(dot)}`);
    }
    entries.push(path);
    const contents = name.includes(".") ? [[path, `% ${name}\n`]] : [[`${path}/notes.txt`, "Notes\n"], [`${path}/results.csv`, "a,b\n1,2\n"]];
    for (const [file, text] of contents) {
      current.files.set(file, text);
      files.push({ path: file, kind: "text" });
    }
  }
  for (let step = 1; importDelay && step <= 10; step += 1) {
    await new Promise((resolve) => setTimeout(resolve, importDelay / 10));
    emit("project-import-progress", { written: step, total: 10 });
  }
  return { conflicts: [], files, entries, skipped };
}

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

/**
 * `?deadline=<hours>` stages a submission deadline that many hours from now
 * (negative once passed), stored as its AoE wall clock the way the manifest
 * keeps it; `?deadlineVenue=` names it. The checklist's deadline card edits it
 * through `set_project_deadline`.
 */
let benchDeadline: ProjectDeadline | null = (() => {
  const hours = params.get("deadline");
  if (hours == null || !Number.isFinite(Number(hours))) return null;
  const wall = new Date(Date.now() + (Number(hours) - 12) * 3_600_000);
  return { venue: params.get("deadlineVenue") ?? "NeurIPS 2027", kind: "paper", due: wall.toISOString().slice(0, 16) };
})();

/**
 * `?submissionItems=1` stages the checklist's own items in each state: one
 * confirmed against its file as the bench reports it, one whose file changed
 * after it was confirmed, one whose file is gone, one to check with a long
 * owner, source and title, and one to do. The checklist edits them through
 * `set_submission_items`, which stamps a confirmed file the way the backend does.
 */
const BENCH_MTIME = 1_700_000_000_000;
let benchItems: SubmissionItem[] = params.get("submissionItems") === "1"
  ? [
    { id: "i1", title: "Reference PDF matches the camera-ready", status: "confirmed", file: "reference.pdf", confirmedMtimeMs: BENCH_MTIME },
    { id: "i2", title: "Main source signed off by every author", status: "confirmed", file: "main.tex", owner: "All authors", confirmedMtimeMs: BENCH_MTIME - 60_000 },
    { id: "i3", title: "supplementary.pdf checked", status: "review", file: "supplementary/supplementary-material-final.pdf", owner: "Grace" },
    {
      id: "i4",
      title: "Reproducibility checklist answered and attached as the last page of the supplementary appendix",
      status: "review",
      owner: "Ada Lovelace-Byron (corresponding author)",
      source: "https://neurips.cc/Conferences/2027/PaperInformation/ReproducibilityChecklistGuidelines",
      sourceChecked: "2027-04-02",
    },
    { id: "i5", title: "Cover letter", status: "todo", source: "Program chairs' email of 2 April" },
  ]
  : [];

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
      venue: "neurips",
      deadline: benchDeadline,
      submissionItems: benchItems,
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
  // Crossref found no notice for it, so its citation card says Verified.
  ...BENCH_PAPERS.map((paper) => ({ ...paper, citationHealth: { kind: "unknown", checkedAt: "2026-10-01T00:00:00Z" } })),
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

/**
 * What Discover literature finds: alphaXiv hits (year and votes, no authors)
 * ahead of OpenAlex works (authors, citation counts, DOIs), as the backend
 * merges them, with abstracts as OpenAlex gives them. Fictional apart from
 * the first and the last (a six-figure citation count, for the row's width).
 */
const LITERATURE_HITS = [
  { source: "alphaxiv", arxivId: "1706.03762", title: "Attention Is All You Need", year: 2017, authors: [], votes: 412,
    snippet: "We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely." },
  { source: "alphaxiv", arxivId: "2410.05258", title: "Differential Attention for Long-Context Retrieval with Sparse Multimodal Supervision", year: 2024, authors: [], votes: 87 },
  { source: "alphaxiv", arxivId: "2502.07890", title: "Scaling Laws for Sparse Mixture-of-Experts Decoders", year: 2025, authors: [], votes: 9 },
  { source: "openalex", title: "Effective Approaches to Attention-based Neural Machine Translation", year: 2015,
    authors: ["Minh-Thang Luong", "Hieu Pham", "Christopher D. Manning"], citedByCount: 9214, doi: "10.18653/v1/d15-1166", landingUrl: "https://doi.org/10.18653/v1/d15-1166",
    abstract: "An attentional mechanism has lately been used to improve neural machine translation (NMT) by selectively focusing on parts of the source sentence during translation. This paper examines two simple and effective classes of attentional mechanism: a global approach which always attends to all source words and a local one that only looks at a subset of source words at a time." },
  { source: "openalex", title: "A Survey of Attention in Long-Form Document Understanding for the Proceedings of the International Symposium on Scholarly Communication", year: 2023,
    authors: ["Ada Example", "Grace Sample", "Kim Placeholder", "Lee Instance"], citedByCount: 31, doi: "10.5555/proceedings.international-symposium-on-scholarly-communication.2023.volume-12.issue-4" },
  { source: "openalex", arxivId: "1512.03385", title: "Deep Residual Learning for Image Recognition", year: 2016,
    authors: ["Kaiming He", "Xiangyu Zhang", "Shaoqing Ren", "Jian Sun"], citedByCount: 228417, doi: "10.48550/arxiv.1512.03385", landingUrl: "https://arxiv.org/abs/1512.03385",
    abstract: "Deeper neural networks are more difficult to train. We present a residual learning framework to ease the training of networks that are substantially deeper than those used previously." },
];

/**
 * `?doctor=ready` answers the TeX toolchain check with everything installed
 * and `?doctor=missing` with no TeX at all, for looking at Install LaTeX
 * tools' answer and the setup wizard.
 */
const doctorReport = (() => {
  const doctor = params.get("doctor");
  if (doctor !== "ready" && doctor !== "missing") return null;
  const tex = ["latexmk", "synctex", "bibtex", "pdflatex", "conference-fonts"];
  const checks = [...tex, "uv", "uvx"].map((name) => ({ name, detail: "", ok: doctor === "ready" || !tex.includes(name) }));
  return { ok: doctor === "ready", summary: "", checks };
})();
/** Where `?recents=1`'s moved project used to be: opening anything under it fails. */
const MOVED_PROJECT_ROOT = "/Users/writer/Moved";
const fullTextOnly = params.get("papers") === "fulltext";
const libraryPapers = params.get("papers") === "library";

const unhandled = new Set<string>();
/** `?fetch=pending`'s downloads under way, by request id: each fails as cancelled when stopped. */
const pendingFetches = new Map<string, (reason: Error) => void>();
const counts = new Map<string, number>();

/**
 * A successful build with a handful of warnings, the fixture's log and PDF.
 * `?build=clean` drops the warnings, `?build=failed` fails it and
 * `?build=typo` fails it on a mistyped command (stageTypo), for looking at
 * the other results.
 */
/** The passes a build of the fixture runs, as latexmk announces them: pdflatex, bibtex, pdflatex again. */
const BUILD_STEPS = [
  { tool: "pdflatex", run: 1, draft: false, startedMs: 0, durationMs: 612 },
  { tool: "bibtex", run: 1, draft: false, startedMs: 612, durationMs: 96 },
  { tool: "pdflatex", run: 2, draft: false, startedMs: 708, durationMs: 431 },
];

/**
 * `?build=running`: a build that never finishes, reporting its passes as
 * latexmk would (the backend's `build-progress`), so the Build button's live
 * sequence can be looked at. It stays in its second pdflatex pass.
 */
function runningBuild(args: Args): Promise<never> {
  const report = (elapsedMs: number, count: number) => window.setTimeout(() => emit("build-progress", {
    projectRoot: current.root,
    progressId: args?.progressId ?? null,
    elapsedMs,
    steps: BUILD_STEPS.slice(0, count).map((step, index) => index === count - 1 ? { ...step, durationMs: null } : step),
  }), elapsedMs);
  BUILD_STEPS.forEach((step, index) => report(step.startedMs, index + 1));
  return new Promise<never>(() => {});
}

function buildResult() {
  const outcome = params.get("build");
  const warnings = [
    { level: "warning", message: "There were undefined references.", file: "main.tex", line: 4 },
    { level: "warning", message: "Overfull \\hbox (4.2pt too wide) in paragraph", file: "chapters/ch01.tex", line: 12 },
  ];
  const typo = outcome === "typo" ? typoBuild() : null;
  const failed = outcome === "failed" || typo !== null;
  return {
    success: !failed,
    hasPdf: true,
    log: outcome === "failed" ? failedBuildLog(["./main.tex:6: Undefined control sequence.", "l.6 \\include{chapters/ch02}", "                         "])
      : typo ? failedBuildLog(typo.log) : fixture.buildLog,
    durationMs: 1_234,
    diagnostics: outcome === "clean" ? []
      : outcome === "failed" ? [{ level: "error", message: "Undefined control sequence.", file: "main.tex", line: 6 }]
        : typo ? typo.diagnostics : warnings,
    rootDocument: "main.tex",
    // The failed build stops in its first pass.
    steps: failed ? [{ ...BUILD_STEPS[0], durationMs: 388 }] : BUILD_STEPS,
    pages: failed ? null : sizes.pdfPages ?? PLAYBOOK_FIXTURE.pdfPages,
    synctex: true,
  };
}

/** What TeX reports for stageTypo's \\cietp, at the line it is on now: fixed, the build succeeds again. */
function typoBuild() {
  const lines = String(current.files.get("main.tex") ?? "").split("\n");
  const index = lines.findIndex((text) => text.includes("\\cietp"));
  if (index < 0) return null;
  const line = index + 1;
  const text = lines[index]!;
  const end = text.indexOf("\\cietp") + "\\cietp".length;
  return {
    log: [`./main.tex:${line}: Undefined control sequence.`, `l.${line} ${text.slice(0, end)}`, `${" ".repeat(end + 4)}${text.slice(end)}`],
    diagnostics: [
      { level: "error", message: "Undefined control sequence.", file: "main.tex", line },
      { level: "warning", message: "Citation `luong2015effective' on page 1 undefined on input line " + line + "." },
      { level: "warning", message: "Overfull \\hbox (6.1pt too wide) in paragraph at lines 38--41", file: "main.tex", line: 38 },
    ],
  };
}

/** The fixture's log with TeX's error two thirds of the way down, where a real one stops the run. */
function failedBuildLog(error: string[]) {
  const lines = fixture.buildLog.split("\n");
  const at = Math.floor(lines.length * 2 / 3);
  lines.splice(at, 0, ...error);
  return lines.join("\n");
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
 * model with the answer. Each fix also answers with its reason, as the
 * prompt asks: a category and, for some, a note in the asked language.
 */
type Fix = [pattern: RegExp, replacement: string, category?: string, note?: string, noteZh?: string];
const PROOFREAD_FIXES: Fix[] = [
  [/\bteh\b/g, "the", "spelling"],
  [/\bwich\b/g, "which", "spelling"],
  [/\bbeleive\b/g, "believe", "spelling"],
  [/\brecieves?\b/g, "receives", "spelling"],
  [/\boccured\b/g, "occurred", "spelling"],
  [/\bseperate\b/g, "separate", "spelling"],
  [/\bachieve state of the art\b/g, "achieves state-of-the-art", "grammar", "Agreement, and a hyphenated modifier", "主谓一致，复合修饰语加连字符"],
  [/\ba ([aeiou])/g, "an $1", "grammar", "“an” before a vowel sound", "元音前用 an"],
  [/ {2,}/g, " "],
  [/ ,/g, ",", "punctuation", "No space before a comma", "逗号前不空格"],
];
const POLISH_FIXES: Fix[] = [
  [/\bIn this paper,? we show that\b/g, "This paper shows that", "concision"],
  [/\bin order to\b/g, "to", "concision", "Shorter, same meaning", "更简短，意思不变"],
  [/\bdue to the fact that\b/g, "because", "concision"],
  [/\bvery important\b/g, "essential", "word choice", "Stronger than an intensifier", "比加强副词更有力"],
  [/\ba lot of\b/g, "many", "word choice", "Less colloquial", "更书面"],
];
const UNSAFE_FIXES: Fix[] = [
  [/\$([^$]+)\$/, "$\\hat{$1}$", "consistency"],
  [/\\cite\{([^}]+)\}/, "\\cite{$1-2024}", "consistency"],
];
const proofreadTasks = new Map<string, { text: string; ready: number }>();

// --- Reviewer's pass ------------------------------------------------------
// The agent's review of the tutorial: real passages of its main.tex, with a
// point whose quote the paper does not hold (Lattice leaves it out). The
// report comes back 2.5 s after the ask; `?review=running` holds it until the
// page reloads, for the running state, `?review=failed` fails the task, and
// `?review=long` gives every point a long title and place, for narrow panels.
// `.research/reviews/` is kept in memory.

const REVIEW_REPORT = (zh: boolean) => ({
  readiness: "needs-work",
  verdict: zh
    ? "一篇清楚、严谨的教程。有两处会让审稿人停下来：§3 关于“解释”的论断没有出处，数值例子也无法核对。其余都是润色层面的问题。"
    : "A clear, careful tutorial. Two things would stop a reviewer: the explanation claim in §3 has no source, and the numerical example can’t be checked. The rest is polish.",
  strengths: zh
    ? ["清楚区分了注意力“计算了什么”和“解释了什么”。", "每个公式后面都有一句话说明它的作用。", "表 1 比较的是角色，而不是不可比的分数。"]
    : ["A careful line between what attention computes and what it explains.", "Every equation is followed by one sentence that says what it does.", "Table 1 compares roles, not incompatible scores."],
  findings: [
    {
      kind: "key", severity: "major", section: "§3", file: "main.tex", search: "attention as explanation faithfulness",
      title: zh ? "关于“注意力即解释”的论断缺少出处" : "A claim about attention as explanation has no source",
      quote: "Attention visualizations describe routing weights inside a model, not a causal explanation of the model's final prediction.",
      reason: zh
        ? "这是全文最强的论断，审稿人一定会要证据。Jain & Wallace (2019) 与 Wiegreffe & Pinter (2019) 分别给出了正反两方面的论证，引用它们并说明你依据的是哪一个结论。"
        : "This is the paper's strongest claim and a reviewer will ask for evidence. Jain & Wallace (2019) and Wiegreffe & Pinter (2019) argue both sides; cite them and say which result you rely on.",
    },
    {
      kind: "key", severity: "major", section: "§2.1", file: "main.tex",
      title: zh ? "数值例子无法复现" : "The numerical example can’t be reproduced",
      quote: "For the query at \\emph{connects}, suppose the scaled scores are",
      reason: zh
        ? "这个例子跳过了它要说明的那一步：请给出原始点积和 d_k，让读者能在 softmax 之前核对缩放。"
        : "The example skips the step it illustrates: give the raw dot products and d_k, so a reader can check the scaling before the softmax.",
    },
    {
      kind: "citation", severity: "minor", section: "§3", file: "main.tex", search: "relative position representations transformer",
      title: zh ? "“可学习或相对位置表示”没有引用" : "“Learned or relative position representations” is uncited",
      quote: "many later architectures use learned or relative position representations",
      reason: zh ? "至少各举一例，例如相对位置的 Shaw et al. (2018) 与 RoFormer (2021)。" : "Name at least one of each, e.g. Shaw et al. (2018) for relative positions and RoFormer (2021).",
    },
    {
      kind: "citation", severity: "minor", section: "§5", file: "main.tex", search: "FlashAttention exact attention IO-aware",
      title: zh ? "“精确注意力”需要限定" : "“Exact attention” needs its qualifier",
      quote: "FlashAttention computes exact attention while tiling operations to reduce expensive transfers",
      reason: zh ? "它在浮点运算重排的意义下是精确的；照 FlashAttention 原文那样说明这一点。" : "Exact up to floating-point reordering; say so, as the FlashAttention paper does.",
    },
    {
      kind: "clarity", severity: "minor", section: "§7", file: "main.tex",
      title: zh ? "“可复现的学习流程”一节读起来像产品说明" : "“Reproducible learning workflow” reads as product notes",
      quote: "This repository is also a worked example of a research workspace.",
      reason: zh ? "它打断了第 6 节与结论之间的论证，建议移到附录。" : "It interrupts the argument between §6 and the conclusion; move it to an appendix.",
    },
    {
      kind: "question", severity: "minor", section: "Table 1", file: "main.tex",
      title: zh ? "ViT 一行是否默认使用了 class token？" : "Does the ViT row assume a class token?",
      quote: "ViT & Image patch & Bidirectional & Image classification",
      reason: zh ? "说明分类读取的是 [CLS] token 还是对图块做池化；这会改变“双向”所指的范围。" : "Say whether classification reads a [CLS] token or pools patches; it changes what “bidirectional” covers.",
    },
    {
      kind: "clarity", severity: "minor", section: "§4", file: "main.tex",
      title: "Invented", quote: "A sentence the tutorial never wrote.", reason: "",
    },
  ],
});
let paperReviewState: unknown = null;

// --- Find support ---------------------------------------------------------
// OpenAlex's answer for a claim about attention as explanation: three real
// abstracts that speak to it (Jain & Wallace, Serrano & Smith, Wiegreffe &
// Pinter) and one that does not. The agent picks keywords, then names the
// three with a sentence from each, and one passage no abstract holds
// (Lattice leaves it out). `?support=running` holds the reading until the
// page reloads, `?support=none` finds nothing that speaks to the claim,
// `?support=failed` fails the reading, and `?support=long` gives every paper
// a long title, venue and author list, for narrow panels.

const SUPPORT_HITS = [
  {
    source: "openalex", title: "Attention is not Explanation", year: 2019, venue: "North American Chapter of the Association for Computational Linguistics",
    authors: ["Sarthak Jain", "Byron C. Wallace"], doi: "10.18653/v1/n19-1357", citedByCount: 1580,
    abstract: "Attention mechanisms have seen wide adoption in neural NLP models. In addition to improving predictive performance, these are often touted as affording transparency: models equipped with attention provide a distribution over attended-to input units, and this is often presented (at least implicitly) as communicating the relative importance of inputs. However, it is unclear what relationship exists between attention weights and model outputs. In this work we perform extensive experiments across a variety of NLP tasks that aim to assess the degree to which attention weights provide meaningful “explanations” for predictions. We find that they largely do not. For example, learned attention weights are frequently uncorrelated with gradient-based measures of feature importance, and one can identify very different attention distributions that nonetheless yield equivalent predictions. Our findings show that standard attention modules do not provide meaningful explanations and should not be treated as though they do.",
  },
  {
    source: "openalex", title: "Is Attention Interpretable?", year: 2019, venue: "Annual Meeting of the Association for Computational Linguistics",
    authors: ["Sofia Serrano", "Noah A. Smith"], doi: "10.18653/v1/p19-1282", arxivId: "1906.03731", citedByCount: 820,
    abstract: "Attention mechanisms have recently boosted performance on a range of NLP tasks. Because attention layers explicitly weight input components’ representations, it is also often assumed that attention can be used to identify information that models found important (e.g., specific contextualized word tokens). We test whether that assumption holds by manipulating attention weights in already-trained text classification models and analyzing the resulting differences in their predictions. While we observe some ways in which higher attention weights correlate with greater impact on model predictions, we also find many ways in which this does not hold, i.e., where gradient-based rankings of attention weights better predict their effects than their magnitudes. We conclude that while attention noisily predicts input components’ overall importance to a model, it is by no means a fail-safe indicator.",
  },
  {
    source: "openalex", title: "Attention is not not Explanation", year: 2019, venue: "Empirical Methods in Natural Language Processing",
    authors: ["Sarah Wiegreffe", "Yuval Pinter"], doi: "10.18653/v1/d19-1002", arxivId: "1908.04626", citedByCount: 900,
    abstract: "Attention mechanisms play a central role in NLP systems, especially within recurrent neural network (RNN) models. Recently, there has been increasing interest in whether or not the intermediate representations offered by these modules may be used to explain the reasoning for a model’s prediction, and consequently reach insights regarding the model’s decision-making process. A recent paper claims that ‘Attention is not Explanation’ (Jain and Wallace, 2019). We challenge many of the assumptions underlying this work, arguing that such a claim depends on one’s definition of explanation, and that testing it needs to take into account all elements of the model. We propose four alternative tests to determine when/whether attention can be used as explanation.",
  },
  {
    source: "openalex", title: "Attention Is All You Need", year: 2017, venue: "Neural Information Processing Systems",
    authors: ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar", "Jakob Uszkoreit", "Llion Jones"], arxivId: "1706.03762", citedByCount: 120000,
    abstract: "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.",
  },
];

const SUPPORT_REPLY = {
  papers: [
    { id: "p1", signal: "supports", passage: "For example, learned attention weights are frequently uncorrelated with gradient-based measures of feature importance, and one can identify very different attention distributions that nonetheless yield equivalent predictions." },
    { id: "p2", signal: "supports", passage: "We conclude that while attention noisily predicts input components’ overall importance to a model, it is by no means a fail-safe indicator." },
    { id: "p3", signal: "mixed", passage: "We challenge many of the assumptions underlying this work, arguing that such a claim depends on one’s definition of explanation, and that testing it needs to take into account all elements of the model." },
    { id: "p4", signal: "contradicts", passage: "Attention is a faithful explanation of every prediction." },
  ],
};

function supportHits() {
  if (params.get("support") !== "long") return SUPPORT_HITS;
  return SUPPORT_HITS.map((hit) => ({
    ...hit,
    title: `${hit.title}: ${hit.title} — a Longer Title, with a Subtitle That Wraps`,
    venue: `Proceedings of the 2019 Conference of the ${hit.venue}: Human Language Technologies, Volume 1 (Long and Short Papers)`,
    authors: [...hit.authors, "Alexandria Ocasio-Fitzgerald-Montgomery", "Jean-Baptiste Delacroix-Hernández"],
  }));
}

// --- Annotations ----------------------------------------------------------
// `.research/annotations.json` kept in memory. On the tutorial, `?annotations=1`
// seeds five open notes (one made on the PDF), `?annotations=review` a round
// in review (proposals, an accepted one and a question) after a settled first
// round, and `?annotations=rounds` two settled rounds to compare.

type BenchAnnotation = Record<string, unknown> & { id: string; quote: string; revision?: Record<string, unknown> };
let annotationsState: { annotations: BenchAnnotation[]; rounds: Array<Record<string, unknown>> } | null = null;
const roundFiles = new Map<number, Array<{ path: string; before: string | null; after: string | null }>>();

/** The seeded notes: quote, note, intent, minutes ago, and (for one) where it sits on the PDF. */
const SEEDED_ANNOTATIONS: Array<[string, string, string | null, number, boolean?]> = [
  ["Attention turns a collection of token representations into context-sensitive representations by learning which pieces of information should interact.",
    "Too abstract for the opening line; start with what the reader will be able to do", "rewrite", 42],
  ["The Transformer made a stronger design choice", "Say what the choice was before calling it stronger", null, 31],
  ["That choice exposes parallel computation during training", "One line contrasting this with an RNN", "clarify", 20],
  ["The factor $1/\\sqrt{d_k}$ controls score magnitude", "Add one sentence of intuition before the variance argument", null, 12],
  ["Multiplicative variants made this retrieval efficient", "Name the variants (dot-product, general)", "clarify", 1, true],
];

/** The agent's canned answers in the bench, by the passage they revise. */
const BENCH_REVISIONS: Array<[string, string, string, string]> = [
  ["Attention turns a collection",
    "This tutorial shows how attention lets each token choose which others to read from, and why that one choice made the Transformer possible. Attention turns a collection of token representations into context-sensitive representations by learning which pieces of information should interact.",
    "Opens with what the reader gets; the definition moves to the next sentence.", "先说读者能得到什么，定义挪到下一句。"],
  ["Multiplicative variants",
    "Multiplicative variants (dot-product and general scoring) made this retrieval efficient",
    "Names the two variants Luong et al. compare.", "点名 Luong 等人比较的两种变体。"],
  ["That choice exposes",
    "Unlike a recurrent network, which must step through tokens one by one, that choice exposes parallel computation during training",
    "Contrasts the Transformer with an RNN in one clause.", "用一个从句对比 RNN。"],
  ["The Transformer made",
    "The Transformer made attention the only path between positions, a stronger design choice",
    "Says what the choice was before judging it.", "先说是什么选择，再评价它。"],
];

function benchAnnotations() {
  if (annotationsState) return annotationsState;
  const seed = params.get("annotations");
  if (!seed || current.root !== TUTORIAL_ROOT) return { annotations: [], rounds: [] };
  const main = String(current.files.get("main.tex") ?? "");
  // `?annotationNumbers=<n>` numbers the seeds from n + 1, for wide pins.
  const numberBase = Number(params.get("annotationNumbers") ?? 0) || 0;
  const annotations = SEEDED_ANNOTATIONS.flatMap(([quote, body, intent, minutes, pdf], index): BenchAnnotation[] => {
    const from = main.indexOf(quote);
    if (from < 0) return [];
    const at = new Date(Date.now() - minutes * 60_000).toISOString();
    return [{
      id: `bench-annotation-${index + 1}`, number: numberBase + index + 1, path: "main.tex", from, to: from + quote.length, quote,
      prefix: main.slice(Math.max(0, from - 32), from), suffix: main.slice(from + quote.length, from + quote.length + 32),
      body, ...intent ? { intent } : {},
      ...pdf ? { pdf: { page: 1, rects: [{ x: 0.408, y: 0.552, width: 0.322, height: 0.0125 }], text: quote } } : {},
      authorId: "me", authorName: "Leo", resolved: false, replies: [], createdAt: at, updatedAt: at,
    }];
  });
  const rounds: Array<Record<string, unknown>> = [];
  if (seed === "review" || seed === "rounds") {
    const settled = (number: number, hoursAgo: number) => ({
      number, startedAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
      settledAt: new Date(Date.now() - (hoursAgo - 0.2) * 3_600_000).toISOString(), outcomes: {} as Record<string, string>,
      historyId: `bench-round-${number}`,
    });
    const before = main.replace("A sequence model must decide how information at one position can influence another.",
      "A sequence model has to decide, at every step, how information at one position can influence another one.");
    const first = settled(1, 3);
    first.outcomes = { "bench-old-1": "accepted", "bench-old-2": "accepted" };
    roundFiles.set(1, [{ path: "main.tex", before, after: main }]);
    rounds.push(first);
    if (seed === "rounds") {
      const second = settled(2, 1);
      second.outcomes = { "bench-annotation-2": "accepted", "bench-annotation-3": "rejected" };
      const revised = BENCH_REVISIONS[3]!;
      const after = main.replace("The Transformer made a stronger design choice", revised[1]);
      roundFiles.set(2, [{ path: "main.tex", before: main, after }]);
      current.files.set("main.tex", after);
      rounds.push(second);
    } else {
      const zh = lang === "zh-CN";
      const open = { number: 2, startedAt: new Date(Date.now() - 5 * 60_000).toISOString(), outcomes: {} as Record<string, string> };
      for (const annotation of annotations) {
        const number = (annotation.number as number) - numberBase;
        const canned = BENCH_REVISIONS.find(([start]) => annotation.quote.startsWith(start));
        if (number === 4) {
          annotation.revision = { round: 2, state: "asked", question: zh ? "直觉放在式 (2) 之前还是之后？" : "Should the intuition go before equation (2) or after it?" };
        } else if (number === 2 && canned) {
          annotation.revision = { round: 2, state: "accepted", original: annotation.quote, text: canned[1], reason: zh ? canned[3] : canned[2] };
          annotation.resolved = true;
        } else if (canned) {
          annotation.revision = { round: 2, state: "proposed", original: annotation.quote, text: canned[1], reason: zh ? canned[3] : canned[2] };
        }
        if (annotation.revision) open.outcomes[annotation.id] = String(annotation.revision.state);
      }
      roundFiles.set(2, [{ path: "main.tex", before: main, after: null }]);
      rounds.push(open);
    }
  }
  annotationsState = { annotations, rounds };
  return annotationsState;
}

/** The bench agent's answer to an annotation: a canned revision, or a question when asked to cite. */
function annotationReply(prompt: string): string {
  const passage = /<passage>\n([\s\S]*)\n<\/passage>/.exec(prompt)?.[1] ?? "";
  const zh = prompt.includes("in Simplified Chinese");
  if (prompt.includes("<bibliography>")) {
    return `<question>${zh ? "要引用哪篇论文？参考文献里没有直接支持这句话的。" : "Which paper should support this? Nothing in the bibliography states it directly."}</question>`;
  }
  const canned = BENCH_REVISIONS.find(([start]) => passage.trim().startsWith(start));
  const text = canned?.[1] ?? passage.replace(/\bvery\b\s*/g, "").replace(/\bin order to\b/g, "to").replace(/\bdeliberately\b\s*/g, "");
  const reason = canned ? (zh ? canned[3] : canned[2]) : (zh ? "更紧凑，意思不变。" : "Tighter, same meaning.");
  return `<revision>${text}</revision>\n<reason>${reason}</reason>`;
}

function textTask(args: Args): unknown {
  const mode = params.get("proofread");
  const action = String(args?.action ?? "");
  if (action === "start") {
    if (mode === "unavailable") throw "agent_route_unavailable";
    const prompt = String(args?.prompt ?? "");
    if (prompt.startsWith("Review the LaTeX paper")) {
      const taskId = `text-task:${proofreadTasks.size + 1}`;
      const report = REVIEW_REPORT(prompt.includes("in Simplified Chinese"));
      if (params.get("review") === "long") {
        for (const finding of report.findings) {
          finding.title = `${finding.title} ${finding.title}`;
          finding.section = `${finding.section}, Appendix B.3 (Ablations)`;
        }
      }
      const ready = params.get("review") === "running" ? Infinity : performance.now() + 2_500;
      proofreadTasks.set(taskId, { text: `<review>\n${JSON.stringify(report, null, 2)}\n</review>`, ready });
      return { taskId };
    }
    if (prompt.startsWith("Suggest how to search the scholarly literature")) {
      const taskId = `text-task:${proofreadTasks.size + 1}`;
      proofreadTasks.set(taskId, { text: "<terms>attention weights explanation faithfulness</terms>", ready: performance.now() + 900 });
      return { taskId };
    }
    if (prompt.startsWith("A writer wants to know which papers bear on a claim")) {
      const taskId = `text-task:${proofreadTasks.size + 1}`;
      const reply = params.get("support") === "none" ? { papers: [] } : SUPPORT_REPLY;
      const ready = params.get("support") === "running" ? Infinity : performance.now() + 1_800;
      proofreadTasks.set(taskId, { text: `<support>\n${JSON.stringify(reply, null, 2)}\n</support>`, ready });
      return { taskId };
    }
    if (prompt.startsWith("Revise a passage")) {
      const taskId = `text-task:${proofreadTasks.size + 1}`;
      proofreadTasks.set(taskId, { text: annotationReply(prompt), ready: performance.now() + 1_200 + Math.random() * 1_600 });
      return { taskId };
    }
    const excerpt = /<excerpt>\n([\s\S]*)\n<\/excerpt>$/.exec(prompt)?.[1] ?? "";
    const fixes = [
      ...PROOFREAD_FIXES,
      ...prompt.startsWith("Polish") ? POLISH_FIXES : [],
      ...mode === "unsafe" ? UNSAFE_FIXES : [],
    ];
    const zh = prompt.includes("in Simplified Chinese");
    const reasons: string[] = [];
    const fixed = fixes.reduce((text, [pattern, replacement, category, note, noteZh]) => text.replace(pattern, (match) => {
      const revised = match.replace(new RegExp(pattern.source, pattern.flags.replace("g", "")), replacement);
      if (category) reasons.push([`${match} => ${revised}`, category, ...note ? [zh ? noteZh : note] : []].join(" | "));
      return revised;
    }), excerpt);
    const taskId = `text-task:${proofreadTasks.size + 1}`;
    const text = `Here is the proofread excerpt.\n<proofread>\n${fixed}\n</proofread>\n<reasons>\n${reasons.join("\n")}\n</reasons>`;
    proofreadTasks.set(taskId, { text, ready: performance.now() + 1_600 });
    return { taskId };
  }
  const task = proofreadTasks.get(String(args?.taskId ?? ""));
  if (!task) throw "Agent task not found.";
  if (action === "cancel") return { status: "running" };
  if (performance.now() < task.ready) return { status: "running" };
  if (mode === "failed" || params.get("review") === "failed" || (params.get("support") === "failed" && task.text.startsWith("<support>"))) {
    return { status: "failed", message: "Codex is not signed in." };
  }
  const model = params.get("proofreadModel");
  return { status: "completed", text: task.text, ...model ? { model } : {} };
}

/** Every `\\cite…{keys}` in the project's .tex files, as `list_citation_usages` reports them. */
function citationUsages() {
  const usages: Array<{ kind: string; symbol: string; role: string; path: string; line: number; snippet: string }> = [];
  for (const [path, content] of current.files) {
    if (!path.endsWith(".tex") || typeof content !== "string") continue;
    const lines = content.split("\n");
    lines.forEach((text, index) => {
      for (const match of text.matchAll(/\\(?:no)?cite[a-z]*\*?(?:\[[^\]]*\])*\{([^}]*)\}/g)) {
        for (const key of match[1].split(",").map((part) => part.trim()).filter(Boolean)) {
          usages.push({ kind: "citation", symbol: key, role: "reference", path, line: index + 1, snippet: text.trim().slice(0, 160) });
        }
      }
    });
  }
  return usages;
}

/**
 * The tutorial's references as `list_citations` reports them (fields without
 * their braces), so a `\\cite` there has its card; the fixture cites nothing.
 */
function tutorialCitations() {
  if (current.root !== TUTORIAL_ROOT && !scale.bibEntries) return [];
  const field = (entry: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*\\{((?:[^{}]|\\{[^{}]*\\})*)\\}`, "i")
    .exec(entry)?.[1].replace(/[{}]/g, "").replace(/\s+/g, " ").trim() ?? "";
  return [...current.files].flatMap(([path, content]) => (
    path.endsWith(".bib") && typeof content === "string" ? content.split(/\n(?=@)/) : []
  )).flatMap((entry) => {
    const key = /^\s*@\w+\s*\{\s*([^,\s]+)\s*,/.exec(entry)?.[1];
    if (!key) return [];
    const arxivId = field(entry, "eprint");
    const doi = field(entry, "doi");
    return [{
      key, title: field(entry, "title"), authors: field(entry, "author"), year: field(entry, "year"),
      venue: field(entry, "journal") || field(entry, "booktitle") || (arxivId ? "arXiv" : ""),
      ...arxivId ? { arxivId } : {}, ...doi ? { doi } : {},
    }];
  });
}

/** `bibliography_audit_scan` over the project's `.bib` files, as the backend reads them. */
function bibliographyAuditScan() {
  const entries = [...current.files].flatMap(([path, content]) => (
    path.endsWith(".bib") && typeof content === "string"
      ? content.split(/\n(?=@)/).flatMap((bibtex) => {
        const key = /^\s*@\w+\s*\{\s*([^,\s]+)\s*,/.exec(bibtex)?.[1];
        const title = /\btitle\s*=\s*\{([^}]*)\}/i.exec(bibtex)?.[1] ?? "";
        return key ? [{ path, key, title, bibtex: bibtex.trim(), issues: [] }] : [];
      })
      : []
  ));
  const coverage = [...current.files].flatMap(([path, content]) => (
    path.endsWith(".bib") && typeof content === "string" ? [{ path, kind: "bibliography", entries: entries.filter((entry) => entry.path === path).length }] : []
  ));
  return { entries, issues: [], coverage };
}

function answer(command: string, args: Args): unknown {
  counts.set(command, (counts.get(command) ?? 0) + 1);
  // `?overleaf=review` (or `long`, `expired`) links the open project to Overleaf (bench-overleaf.ts).
  const overleaf = overleafAnswer(command, args, {
    params, lang, emit, root: () => current.root,
    text: (path) => {
      const content = current.files.get(path);
      return typeof content === "string" ? content : "";
    },
  });
  if (overleaf !== NOT_HANDLED) return overleaf;
  // `?arxiv=ready` (or `running`, `failed`, `unbuilt`, `long`) stages Export for arXiv (bench-arxiv.ts).
  const arxiv = arxivAnswer(command, args, { params, send: sendOnChannel });
  if (arxiv !== NOT_HANDLED) return arxiv;
  // `?linkedBib=ready` (or `unlinked`, `missing`, `long`) stages the linked library (bench-linked-library.ts).
  const linked = linkedLibraryAnswer(command, args, { params });
  if (linked !== NOT_HANDLED) return linked;
  switch (command) {
    // `?welcome=1` starts on the welcome screen, as a launch with no project does.
    case "initial_project":
      // `?tutorial=1` starts in the tutorial project, as after its Guided tutorial entry.
      return params.has("welcome") ? null : params.has("tutorial") ? openTutorial() : snapshot();
    case "open_project":
      if (String(args?.path ?? "").startsWith(MOVED_PROJECT_ROOT)) throw new Error("No such file or directory (os error 2)");
      return snapshot();
    case "refresh_project":
    case "list_project_tree_with_hidden":
      return snapshot();
    case "open_tutorial_project":
      return openTutorial();
    case "read_project_file": {
      if (unreadInclude && pathArg(args) === UNREAD_INCLUDE) throw new Error("Permission denied (os error 13)");
      const content = current.files.get(pathArg(args));
      if (typeof content !== "string") throw new Error(`No such text file: ${pathArg(args)}`);
      return content;
    }
    case "write_project_file": {
      // `?save=fail`: every write fails as a full disk does, for the save slot's failed state.
      if (params.get("save") === "fail") throw new Error("No space left on device (os error 28)");
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
      return params.get("build") === "running" ? runningBuild(args) : buildResult();
    // `?pdf=<url>` answers with that PDF instead, such as the tutorial compiled
    // outside the checkout, for screenshots of a real page.
    case "read_compiled_pdf":
      if (params.get("pdf")) return fetch(params.get("pdf")!).then((response) => response.arrayBuffer());
      return copyBuffer(fixture.compiledPdf);
    case "synctex_heading_pages":
      // The fixture PDF has no SyncTeX map: about a page per 45 source lines.
      return (args?.headings as Array<{ line: number }> | undefined ?? []).map(({ line }) => Math.max(1, Math.ceil(line / 45)));
    case "stat_project_file":
      return { exists: current.files.has(pathArg(args)), mtimeMs: BENCH_MTIME };
    case "search_project":
      return searchProject(String(args?.query ?? ""));
    case "harper_lint":
    case "texlab_diagnostics":
      return [];
    case "count_project_words":
      return { text: 120_000, headers: 400, captions: 0, total: 120_400, source: "texcount" };
    case "overleaf_status":
      return { connected: false, expired: false, email: null, name: null, host: "https://www.overleaf.com" };
    case "git_status": {
      const tracked = Boolean(scale.gitVersions || COMPARE_VERSIONS);
      return { available: tracked, repository: tracked, branch: tracked ? "main" : null, files: [] };
    }
    case "git_log":
      return (COMPARE_VERSIONS ?? SCALE_VERSIONS).slice(0, Number(args?.limit ?? 100));
    case "git_compare_files":
      return [{ path: "main.tex", kind: "modified" }, { path: "references.bib", kind: "modified" }];
    case "git_compare_file": {
      const after = String(current.files.get(pathArg(args)) ?? "");
      return { before: olderText(after), after, binary: false };
    }
    case "export_changes_pdf":
      return new Promise((resolve, reject) => setTimeout(() => (params.get("export") === "failed"
        ? reject(new Error("latexdiff is not installed. It comes with MacTeX; with BasicTeX, run “sudo tlmgr install latexdiff” in Terminal, then export again."))
        : resolve({ path: "main-changes.pdf", simplified: false })), 1_200));
    case "list_history":
      return SCALE_HISTORY;
    case "get_history_entry": {
      const path = SCALE_HISTORY.find((item) => item.id === args?.transactionId)?.files[0] ?? "main.tex";
      const after = String(current.files.get(path) ?? "");
      return { id: args?.transactionId, changes: [{ path, before: after.replace(/Section/, "Part"), after }] };
    }
    case "bibliography_audit_scan":
      return bibliographyAuditScan();
    case "list_unused_symbols":
      return { labels: [], citations: [] };
    case "list_citation_usages":
      return citationUsages();
    case "list_citations":
      return tutorialCitations();
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
      if (scale.paperCount) return SCALE_PAPERS;
      if (libraryPapers) return LIBRARY_PAPERS;
      return params.has("papers") ? BENCH_PAPERS.map((paper) => ({ ...paper, hasBlog: !fullTextOnly })) : [];
    // The fixture's health is all it knows: Crossref has nothing newer.
    case "refresh_citation_health":
      return {};
    case "search_literature_abstracts":
      return supportHits();
    // Add to Papers from Find support: imported as cited, with nothing to download.
    case "import_reference": {
      const input = String(args?.input ?? "");
      const hit = SUPPORT_HITS.find((item) => input.includes(item.arxivId ?? "\0") || input === item.doi);
      if (!hit) throw "Nothing found for that reference.";
      return { arxivId: hit.arxivId ?? "", title: hit.title, citationKey: `${hit.authors[0].split(" ").at(-1)!.toLowerCase()}2019${hit.title.split(" ")[0].toLowerCase()}`, alreadyImported: false };
    }
    // Find support's Cite: the DOI resolves to its entry, which joins the
    // bibliography through write_project_file.
    case "resolve_citation_query": {
      const hit = SUPPORT_HITS.find((item) => item.doi && String(args?.query ?? "").toLowerCase() === item.doi);
      if (!hit) throw "No citation found.";
      const key = `${hit.authors[0].split(" ").at(-1)!.toLowerCase()}2019${hit.title.split(" ")[0].toLowerCase()}`;
      const author = hit.authors.join(" and ");
      return {
        key, title: hit.title, author, year: String(hit.year), journal: "", booktitle: hit.venue, publisher: "", url: "", doi: hit.doi, entryType: "inproceedings",
        bibtex: `@inproceedings{${key},\n  title = {${hit.title}},\n  author = {${author}},\n  booktitle = {${hit.venue}},\n  year = {${hit.year}},\n  doi = {${hit.doi}}\n}`,
      };
    }
    case "search_literature":
      return { hits: (args?.page ?? 0) === 0 ? LITERATURE_HITS : [], hasMore: false };
    // `?fetch=pending`: a paper's download stays under way until its Cancel,
    // for looking at its progress and stopping it.
    case "fetch_paper":
    case "fetch_web_reference":
      if (params.get("fetch") !== "pending") return null;
      emit("paper-import-progress", "fulltext");
      return new Promise((_, reject) => pendingFetches.set(String(args?.requestId), reject));
    case "cancel_paper_fetch": {
      const reject = pendingFetches.get(String(args?.requestId));
      pendingFetches.delete(String(args?.requestId));
      reject?.(new Error("Paper import cancelled."));
      return Boolean(reject);
    }
    case "read_paper":
      return `## Abstract\n\n${"Paper content. ".repeat(40)}`;
    case "read_paper_blog_local":
      return fullTextOnly ? null : `## Overview\n\n${"Blog content. ".repeat(40)}`;
    case "synara_open_log_folder":
      return false;
    case "agent_text_task":
      return textTask(args);
    case "list_annotations":
      return benchAnnotations();
    case "read_paper_review":
      return paperReviewState;
    case "save_paper_review":
      paperReviewState = args?.review ?? null;
      return null;
    case "save_annotations":
      annotationsState = { annotations: (args?.annotations as BenchAnnotation[]) ?? [], rounds: (args?.rounds as Array<Record<string, unknown>>) ?? [] };
      return null;
    case "save_annotation_round": {
      const number = Number(args?.number);
      roundFiles.set(number, (args?.files as Array<{ path: string; before: string | null; after: string | null }>) ?? []);
      return args?.settled ? `bench-round-${number}` : null;
    }
    case "read_annotation_round":
      return roundFiles.get(Number(args?.number)) ?? [];
    case "restore_annotation_round":
      for (const file of (args?.files as Array<{ path: string; after: string | null }>) ?? []) {
        if (typeof file.after === "string") current.files.set(file.path, file.after);
      }
      return null;
    // Reverse SyncTeX, roughly: page 1 of the tutorial holds main.tex's first
    // sixty lines, top to bottom; Lattice then finds the selected words near it.
    case "synctex_edit":
      return { path: "main.tex", line: Math.max(1, Math.round(Number(args?.y ?? 0) / 792 * 60)) };
    case "synara_ensure_ready":
    case "create_project_entry":
      return createEntry(args);
    case "choose_import_entries":
      return importPick.map((name) => `/Users/bench/Downloads/${name}`);
    case "import_project_files":
      return importEntries(args);
    case "rename_project_entry":
      return renameEntry(args);
    case "set_submission_items":
      benchItems = ((args?.items as SubmissionItem[] | undefined) ?? []).map((item) => ({
        ...item,
        confirmedMtimeMs: item.status === "confirmed" && item.file && current.files.has(item.file)
          ? item.confirmedMtimeMs ?? BENCH_MTIME
          : undefined,
      }));
      return snapshot().manifest;
    case "set_project_deadline":
      benchDeadline = (args?.deadline as ProjectDeadline | null | undefined) ?? null;
      return snapshot().manifest;
    case "run_doctor":
      // The TeX toolchain check is outside the bench unless `?doctor=` asks
      // for a report; the app treats a failure as an environment that does
      // not expose it.
      if (doctorReport) return doctorReport;
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

/** What Tauri does for `channel.send`: the channel's callback, with the message's place in order. */
function sendOnChannel(channel: unknown, message: unknown) {
  const id = (channel as { id?: number } | undefined)?.id;
  if (id !== undefined) callbacks.get(id)?.({ index: 0, message });
}

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
// `?whatsNew=toast`: the last launch ran an older version, so this one is the
// first after an update and announces it.
if (params.get("whatsNew") === "toast") localStorage.setItem("lattice.last-run-version.v1", "0.7.0");
// `?recents=1` gives the welcome screen (`?welcome=1`) projects to reopen. The
// newest one's folder is gone, so launch cannot reopen it and the welcome
// screen says so, as after a writer moved the folder. The next one has built
// the fixture's PDF, so the desk shows its first page; the others have no PDF.
if (params.has("recents")) {
  const day = 86_400_000;
  localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify([
    { name: "Thesis draft", path: `${MOVED_PROJECT_ROOT}/thesis-draft`, openedAt: Date.now() - day / 2 },
    { name: "Sparse attention", path: "/Users/writer/Papers/sparse-attention", openedAt: Date.now() - day },
    { name: "NeurIPS rebuttal", path: "/Users/writer/Papers/2026/neurips-rebuttal", openedAt: Date.now() - 3 * day },
    { name: "Reading notes", path: "/Users/writer/Documents/reading-notes" },
  ]));
  const { rememberFirstPage } = await import("../../src/project/first-pages");
  await rememberFirstPage("/Users/writer/Papers/sparse-attention", copyBuffer(fixture.compiledPdf), "ICML");
}
// Stored raw, not as JSON (loadThemePreference).
if (theme) localStorage.setItem(THEME_PREFERENCE_KEY, theme);

await import("../../src/main.tsx");

// The notification API, for raising toasts from a driver (screenshots and QA of
// the toast stack): `window.__latticeBench.notify.notifyError("Build", "…")`.
// main.tsx already loaded it, so this adds nothing to what the page runs.
Object.assign((window as unknown as { __latticeBench: object }).__latticeBench, {
  notify: await import("../../src/telemetry/app-notify"),
});
