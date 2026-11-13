/**
 * The performance benchmark's page: the real app, answered by an in-memory
 * backend that holds the deterministic fixture project (scripts/perf-fixture.mjs).
 *
 * tools/mock-backend stands in for Tauri (as it does for the website's demo,
 * tools/web-demo) and holds the project, builds, text tasks and notes that
 * both pages share; this page stages them with query parameters and adds
 * what only the benchmark and screenshots need. Commands neither models
 * resolve to `null`; `window.__latticeBench.unhandled` lists them, which is
 * where to look when a new startup command appears.
 *
 * The counters (React commits, DOM mutations, long tasks) are not here: the
 * driver injects them before any page script runs, so the same probe also
 * measures the real app. See scripts/perf-bench.mjs.
 */
import { PLAYBOOK_FIXTURE, perfFixture, type PerfFixtureSizes } from "../../scripts/perf-fixture.mjs";
import { annotationsAnswer, type MockAnnotation } from "../mock-backend/annotations";
import { BUILD_STEPS, PREAMBLE_BUILD_STEPS, stageTypo, typoFailure, withError } from "../mock-backend/build";
import { MOCK_MTIME, MockProject, copyBuffer, termMatcher } from "../mock-backend/project";
import { installTauriInternals, NOT_HANDLED, windowAnswer, type Args } from "../mock-backend/tauri-internals";
import { textTasks } from "../mock-backend/text-tasks";
import { arxivAnswer } from "./bench-arxiv";
import { paintStandInDesktop } from "./bench-glass";
import { linkedLibraryAnswer, linkedLibraryBibliography } from "./bench-linked-library";
import { bibliographyAnswer } from "./bench-bibliography";
import { CROSSREFS_ROOT, crossrefsIndex, crossrefsProject } from "./bench-crossrefs";
import { TUTORIAL_ROOT, tutorialFiles } from "./bench-tutorial";
import { benchScale } from "./bench-scale";
import { compareVersions, olderText } from "./bench-compare";
import { addNestedTree } from "./bench-nested-tree";
import { overleafAnswer } from "./bench-overleaf";
import { BENCH_PAPERS, LIBRARY_PAPERS, LITERATURE_HITS } from "./bench-papers";
import { rootsAnswer } from "./bench-roots";
import { terminalAnswer } from "./bench-terminal";
import { zoteroAnswer } from "./bench-zotero";
import type { ProjectDeadline, ProjectSnapshot, SubmissionItem } from "../../src/app-types";
// app-settings has no side effects (its imports are type-only), so importing
// its keys here runs no app code before the mock backend below is installed.
import {
  APPEARANCE_KEY, BUILD_PREFERENCES_KEY, RECENT_PROJECTS_KEY, THEME_PREFERENCE_KEY, TUTORIAL_SEEN_KEY, type InterfaceLanguage, type ThemePreference,
} from "../../src/settings/app-settings";
import {
  THEME_TINTS, normalizeAccent, type ThemeTint, type Translucency,
} from "../../src/settings/theme-customization";

const ROOT = "/bench/lattice-perf-fixture";

const params = new URLSearchParams(location.search);
const sizes: Partial<PerfFixtureSizes> = {};
for (const key of ["largeMarkdownBytes", "chapterBytes", "chapters", "longTexBytes", "notes", "codeBlocks", "pdfPages", "logLines"] as const) {
  const value = Number(params.get(key));
  if (Number.isFinite(value) && value > 0) sizes[key] = value;
}
const fixture = perfFixture(sizes);

const { scale, papers: SCALE_PAPERS, history: SCALE_HISTORY, versions: SCALE_VERSIONS, bibliography: scaleBibliography } = benchScale(params);

addNestedTree(params, fixture.files);
const linkedBibliography = linkedLibraryBibliography(params);
if (linkedBibliography) fixture.files.set("references.bib", linkedBibliography);

if (scaleBibliography) fixture.files.set("references.bib", scaleBibliography);

const COMPARE_VERSIONS = compareVersions(params);

/**
 * The project the page has open: the fixture, until the Guided tutorial entry
 * opens the bundled sample (bench-tutorial.ts), so Get started can be seen here.
 */
const current = new MockProject({ root: ROOT, id: "lattice-perf-fixture", name: "Lattice perf fixture", files: fixture.files });
// `?arxiv=long` names the project at length, for the export sheet's width checks.
if (params.get("arxiv") === "long") current.name = "Understanding Attention in Transformer Language Models: A Long Study";

/**
 * `?build=typo`: main.tex mistypes \\citep as \\cietp, the build fails on it
 * and also warns (an unresolved citation, an overfull line), so the
 * explained build error can be looked at (mock-backend/build.ts).
 */
const typo = params.get("build") === "typo";
if (typo) stageTypo(current.files);

async function openCrossrefs(): Promise<ProjectSnapshot> {
  if (current.root !== CROSSREFS_ROOT) current.replace(await crossrefsProject());
  return snapshot();
}

async function openTutorial(): Promise<ProjectSnapshot> {
  if (current.root !== TUTORIAL_ROOT) {
    const files = await tutorialFiles();
    if (typo) stageTypo(files);
    current.replace({ root: TUTORIAL_ROOT, id: "understanding-attention", name: "Understanding Attention", files });
  }
  return snapshot();
}

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
  const taken = (path: string) => current.taken(path);
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
    tauri.emit("project-import-progress", { written: step, total: 10 });
  }
  return { conflicts: [], files, entries, skipped };
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
let benchItems: SubmissionItem[] = params.get("submissionItems") === "1"
  ? [
    { id: "i1", title: "Reference PDF matches the camera-ready", status: "confirmed", file: "reference.pdf", confirmedMtimeMs: MOCK_MTIME },
    { id: "i2", title: "Main source signed off by every author", status: "confirmed", file: "main.tex", owner: "All authors", confirmedMtimeMs: MOCK_MTIME - 60_000 },
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

function snapshot() {
  return current.snapshot({
    rootDocuments: [{ path: "main.tex", name: "Main", isDefault: true }],
    primaryBibliography: "references.bib",
    trusted: true,
    // The sample carries the venue `create_tutorial` gives it
    // (lattice_core::project::create): Get started tells it from a project
    // of the writer's own by that.
    venue: current.root === TUTORIAL_ROOT ? "tutorial" : "neurips",
    deadline: benchDeadline,
    submissionItems: benchItems,
  });
}

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
 * the other results. `?build=preamble` first makes the preamble format, as a
 * build after a preamble edit does (lattice_core::latex::preamble_format).
 * `?build=running` never finishes (mock-backend/build.ts).
 */
function buildResult() {
  const outcome = params.get("build");
  const warnings = [
    { level: "warning", message: "There were undefined references.", file: "main.tex", line: 4 },
    { level: "warning", message: "Overfull \\hbox (4.2pt too wide) in paragraph", file: "chapters/ch01.tex", line: 12 },
  ];
  const typoError = outcome === "typo" ? typoFailure(current.text("main.tex")) : null;
  const failed = outcome === "failed" || typoError !== null;
  return {
    success: !failed,
    hasPdf: true,
    log: outcome === "failed" ? withError(fixture.buildLog, ["./main.tex:6: Undefined control sequence.", "l.6 \\include{chapters/ch02}", "                         "])
      : typoError ? withError(fixture.buildLog, typoError.log) : fixture.buildLog,
    durationMs: 1_234,
    diagnostics: outcome === "clean" ? []
      : outcome === "failed" ? [{ level: "error", message: "Undefined control sequence.", file: "main.tex", line: 6 }]
        : typoError ? typoError.diagnostics : warnings,
    rootDocument: "main.tex",
    // The failed build stops in its first pass.
    steps: failed ? [{ ...BUILD_STEPS[0], durationMs: 388 }] : outcome === "preamble" ? PREAMBLE_BUILD_STEPS : BUILD_STEPS,
    pages: failed ? null : sizes.pdfPages ?? PLAYBOOK_FIXTURE.pdfPages,
    synctex: true,
  };
}

/**
 * Project search over the fixture: paths and lines holding every term, then each listed
 * Paper whose title does, shaped like the backend's hits (files first, papers
 * under `.research/papers/<key>/`), so Find in project can be looked at.
 */
function searchProject(query: string) {
  const matches = termMatcher(query);
  const hits = current.search(query, matches);
  const papers = libraryPapers ? LIBRARY_PAPERS : params.has("papers") ? BENCH_PAPERS : [];
  for (const paper of papers) {
    if (!paper.hasFullText || !matches(paper.title)) continue;
    const key = paper.arxivId || paper.citationKey;
    hits.push({ kind: "paper", path: `.research/papers/${key}/paper.md`, title: paper.title, snippet: paper.title, line: null, arxivId: paper.arxivId || null });
  }
  return hits;
}

/**
 * The agent's text tasks (mock-backend/text-tasks.ts). `?proofread=failed`
 * fails the task, `?proofread=unavailable` answers like a runtime that
 * predates the route, `?proofread=unsafe` also changes the first inline math
 * and citation key (which the card must hold back), and
 * `?proofreadModel=<name>` reports that model with the answer.
 */
const textTask = textTasks({ mode: () => params.get("proofread"), model: () => params.get("proofreadModel") });

// --- Annotations ----------------------------------------------------------
// `.research/annotations.json` kept in memory. On the tutorial, `?annotations=1`
// seeds five open notes (one made on the PDF), `?annotations=review` a round
// in review (proposals, an accepted one and a question) after a settled first
// round, and `?annotations=rounds` two settled rounds to compare.

function reviewPdfStates(main: string, numberBase: number): MockAnnotation[] {
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  const note = (number: number, path: string, source: string, quote: string, body: string, extra: Record<string, unknown> = {}): MockAnnotation => {
    const from = Math.max(0, source.indexOf(quote));
    return {
      id: `bench-review-${number}`, number: numberBase + number, path, from, to: from + quote.length, quote,
      prefix: "", suffix: "", body, authorId: "me", authorName: "Leo", resolved: false, replies: [], createdAt: at, updatedAt: at, ...extra,
    };
  };
  const notes = String(current.files.get("notes.md") ?? "");
  return [
    note(1, "main.tex", main, "Additive attention introduced a learned alignment mechanism", "Date this: 2014 or 2015?", {
      resolved: true,
      replies: [{ id: "bench-reply", authorId: "co", authorName: "Mina Okafor-Lindqvist", body: "Bahdanau et al. is ICLR 2015.", createdAt: at }],
    }),
    note(2, "main.tex", main, "\\citep{vaswani2017attention}", "Cite the NeurIPS version, not arXiv"),
    note(3, "notes.md", notes, "Markdown component gallery", "Retitle before sharing"),
  ];
}

const annotations = annotationsAnswer({
  project: current,
  seed: () => (current.root === TUTORIAL_ROOT ? params.get("annotations") : null),
  // `?annotationNumbers=<n>` numbers the seeds from n + 1, for wide pins.
  numberBase: Number(params.get("annotationNumbers") ?? 0) || 0,
  // `?reviewPdf=states` adds what Export review PDF tells apart: a resolved
  // note with a reply, one quoting only a citation (a margin note), and one in
  // a file the PDF is not built from (not on it).
  extra: params.get("reviewPdf") === "states" ? reviewPdfStates : undefined,
  zh: () => lang === "zh-CN",
});

// Builds and their PDFs, `?roots=1` and `?pdf=<url>` (bench-roots.ts).
const roots = rootsAnswer({ params, files: () => current.files, mainPdf: fixture.compiledPdf, build: buildResult, tauri: () => tauri, root: () => current.root });

function answer(command: string, args: Args): unknown {
  counts.set(command, (counts.get(command) ?? 0) + 1);
  // `?overleaf=review` (or `long`, `expired`) links the open project to Overleaf (bench-overleaf.ts).
  const overleaf = overleafAnswer(command, args, {
    params, lang, emit: tauri.emit, root: () => current.root, text: (path) => current.text(path),
  });
  if (overleaf !== NOT_HANDLED) return overleaf;
  // `?arxiv=ready` (or `running`, `failed`, `unbuilt`, `long`) stages Export for arXiv (bench-arxiv.ts).
  const arxiv = arxivAnswer(command, args, { params, send: tauri.sendOnChannel });
  if (arxiv !== NOT_HANDLED) return arxiv;
  // `?linkedBib=ready` (or `unlinked`, `missing`, `long`) stages the linked library (bench-linked-library.ts).
  const linked = linkedLibraryAnswer(command, args, { params });
  if (linked !== NOT_HANDLED) return linked;
  // `?zotero=library` (or `long`, `missing`) stages a Zotero library with annotations (bench-zotero.ts).
  const zotero = zoteroAnswer(command, args, { params, files: () => current.files });
  if (zotero !== NOT_HANDLED) return zotero;
  const shell = terminalAnswer(command, args, () => current);
  if (shell !== NOT_HANDLED) return shell;
  const bibliography = bibliographyAnswer(command, args, {
    params,
    files: current.files,
    cited: current.root === TUTORIAL_ROOT || current.root === CROSSREFS_ROOT || Boolean(scale.bibEntries),
    references: current.root === CROSSREFS_ROOT ? crossrefsIndex : undefined,
  });
  if (bibliography !== NOT_HANDLED) return bibliography;
  // `?save=fail`: every write fails as a full disk does, for the save slot's failed state.
  if (command === "write_project_file" && params.get("save") === "fail") throw new Error("No space left on device (os error 28)");
  for (const area of [(name: string, input: Args) => current.answer(name, input), windowAnswer, annotations, roots]) {
    const answered = area(command, args);
    if (answered !== NOT_HANDLED) return answered;
  }
  switch (command) {
    // `?welcome=1` starts on the welcome screen, as a launch with no project does.
    case "list_local_templates":
      return params.has("templates") ? [{ id: "12345678-1234-4234-8234-123456789abc", name: "学校与实验室联合投稿模板 · Journal of Long Research Titles 2026", sourceUrl: "https://example.edu/templates/journal", version: "2026", files: ["main.tex"], root: "main.tex", engine: "xelatex", preview: null }] : [];
    case "inspect_template_source":
      return { files: ["main.tex", "appendix.tex", "styles/学校学位论文与实验室联合投稿格式文件.cls", "figures/多语言图示与较长资源文件名称.png"], root: "main.tex", engine: "xelatex" };
    case "save_local_template":
      return { ...args?.template as object, id: "87654321-1234-4234-8234-123456789abc" };
    case "initial_project":
      // `?tutorial=1` starts in the tutorial project, as after its Guided tutorial entry.
      if (params.has("crossrefs")) return openCrossrefs();
      return params.has("welcome") ? null : params.has("tutorial") ? openTutorial() : snapshot();
    case "refresh_project":
    case "open_project":
      if (String(args?.path).startsWith(MOVED_PROJECT_ROOT)) throw new Error("No such file or directory (os error 2)");
      return snapshot();
    case "list_project_tree_with_hidden":
      return current.tree();
    case "open_tutorial_project":
      return openTutorial();
    // `?signatures=<url>`: page signatures (lattice_core::pdf_pages) of the
    // PDFs `?pdf=` answers with, computed outside the page and keyed by byte
    // length, so a rebuild can be shown in place. Without it the preview
    // reloads whole, as it does for a PDF the backend cannot read.
    case "pdf_page_signatures": {
      const signatures = params.get("signatures");
      if (!signatures) throw new Error("The bench has no page signatures.");
      const length = (args as unknown as ArrayBuffer).byteLength;
      return fetch(signatures).then((response) => response.json()).then((known: Record<string, unknown>) => {
        if (!known[length]) throw new Error(`No page signatures for a ${length}-byte PDF.`);
        return known[length];
      });
    }
    case "synctex_heading_pages":
      // The fixture PDF has no SyncTeX map: about a page per 45 source lines.
      return (args?.headings as Array<{ line: number }> | undefined ?? []).map(({ line }) => Math.max(1, Math.ceil(line / 45)));
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
      const after = String(current.files.get(current.path(args)) ?? "");
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
    case "list_unused_symbols":
      return { labels: [], citations: [] };
    case "set_window_material":
      return glass ? ((args?.material as { translucent?: boolean } | undefined)?.translucent ? "translucent" : "opaque") : "unsupported";
    // Papers only with `?papers=1` (or `?papers=fulltext`, a Paper without a
    // blog, or `?papers=library`): the budgeted scenarios run with an empty library.
    case "list_papers":
      if (scale.paperCount) return SCALE_PAPERS;
      if (libraryPapers) return LIBRARY_PAPERS;
      return params.has("papers") ? BENCH_PAPERS.map((paper) => ({ ...paper, hasBlog: !fullTextOnly })) : [];
    // The fixture's health is all it knows: Crossref has nothing newer.
    case "refresh_citation_health":
      return {};
    case "search_literature":
      return { hits: (args?.page ?? 0) === 0 ? LITERATURE_HITS : [], hasMore: false };
    // `?fetch=pending`: a paper's download stays under way until its Cancel,
    // for looking at its progress and stopping it.
    case "fetch_paper":
    case "fetch_web_reference":
      if (params.get("fetch") !== "pending") return null;
      tauri.emit("paper-import-progress", "fulltext");
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
    // Reverse SyncTeX, roughly: page 1 of the tutorial holds main.tex's first
    // sixty lines, top to bottom; Lattice then finds the selected words near it.
    case "synctex_edit":
      return { path: "main.tex", line: Math.max(1, Math.round(Number(args?.y ?? 0) / 792 * 60)) };
    // Forward SyncTeX on the same rough map, a page per sixty lines.
    case "synctex_view": {
      if (!String(args?.path ?? "").endsWith(".tex")) return null;
      const line = Math.max(1, Number(args?.line ?? 1));
      return { page: Math.floor((line - 1) / 60) + 1, x: 108, y: (line - 1) % 60 / 60 * 792, width: 396, height: 10 };
    }
    // Export review PDF writes nothing here; `?reviewPdf=rebuilt` refuses as a PDF rebuilt meanwhile does.
    case "save_review_pdf":
      if (params.get("reviewPdf") === "rebuilt") throw new Error("The PDF was rebuilt while you were exporting. Export again.");
      return String(args?.destination ?? "");
    case "plugin:dialog|save":
      return `/Users/writer/Desktop/${(args?.options as { defaultPath?: string } | undefined)?.defaultPath ?? "paper.pdf"}`;
    // No Synara here: the Agent panel shows its runtime as unavailable.
    case "synara_ensure_ready":
      throw new Error("missing path");
    case "choose_import_entries":
      return importPick.map((name) => `/Users/bench/Downloads/${name}`);
    case "import_project_files":
      return importEntries(args);
    case "set_submission_items":
      benchItems = ((args?.items as SubmissionItem[] | undefined) ?? []).map((item) => ({
        ...item,
        confirmedMtimeMs: item.status === "confirmed" && item.file && current.files.has(item.file)
          ? item.confirmedMtimeMs ?? MOCK_MTIME
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

const tauri = installTauriInternals(answer);
Object.assign(window, { __latticeBench: { root: ROOT, emit: tauri.emit, unhandled, counts, fixtureSizes: sizes } });

/** A query parameter restricted to `allowed`; anything else is reported and ignored. */
function choiceParam<T extends string>(name: string, allowed: readonly T[]): T | null {
  const value = params.get(name);
  if (value === null) return null;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  console.warn(`perf bench: ignoring ${name}=${value}; expected one of ${allowed.join(", ")}`);
  return null;
}

// `?theme=` and `?lang=` serve screenshots and QA (perf:bench --serve).
// The benchmark passes neither: it runs in the browser's own appearance
// ("system", light in headless Chrome) and in English, because scenarios find
// controls by their English names whatever the machine's locale.
const theme = choiceParam<ThemePreference>("theme", ["system", "light", "dark"]);
const lang = choiceParam<InterfaceLanguage>("lang", ["en", "zh-CN", "system"]);
// `?tint=`, `?accent=` (a preset or a hex colour without its #) and
// `?glass=subtle|strong` show the theme choices in Settings → Appearance. A
// browser has no vibrancy, so `?glass=` also answers set_window_material as a
// translucent macOS window would and paints a stand-in desktop behind the
// page. Without it the page shows the opaque fallback a browser-hosted
// Lattice really gets.
const tint = choiceParam<ThemeTint>("tint", THEME_TINTS);
const accentParam = params.get("accent");
const accent = accentParam ? normalizeAccent(/^[0-9a-f]{6}$/i.test(accentParam) ? `#${accentParam}` : accentParam) : undefined;
const glass = choiceParam<Translucency>("glass", ["subtle", "strong"]);
const themeChoices = { ...(tint && { tint }), ...(accent && { accent }), ...(glass && { translucency: glass }) };
if (glass) paintStandInDesktop();

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
    // A corrupt entry is replaced, as in the app.
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

// The notification API, for a driver's toasts (screenshots, QA):
// `window.__latticeBench.notify.notifyError("Build", "…")`.
// main.tsx already loaded it, so this adds nothing to what the page runs.
Object.assign((window as unknown as { __latticeBench: object }).__latticeBench, {
  notify: await import("../../src/telemetry/app-notify"),
});
