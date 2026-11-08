/**
 * The website demo's backend: every command the app sends, answered in the
 * page over the tutorial held in memory (tools/mock-backend), with nothing
 * from the performance bench. What needs the Mac says so: the Build answers
 * with the PDF compiled ahead of time (content/compiled/) and tells a
 * visitor whose edits it does not show; the Agent, papers outside the
 * demo's library, Overleaf and native dialogs decline. Edits land in History,
 * and Versions tracks the tutorial from the moment the page opened it.
 */
import { annotationsAnswer } from "../mock-backend/annotations";
import { bibliographyAuditScan, bibliographyCitations, citationUsages, labelReferences } from "../mock-backend/bibliography";
import { BUILD_STEPS, stageTypo, typoFailure, withError } from "../mock-backend/build";
import { historyAnswer } from "../mock-backend/history";
import { MockProject, termMatcher, type ProjectFiles } from "../mock-backend/project";
import { installTauriInternals, NOT_HANDLED, windowAnswer, type Args, type MockTauri } from "../mock-backend/tauri-internals";
import { textTasks } from "../mock-backend/text-tasks";
import { versionsAnswer } from "../mock-backend/versions";
import build from "./content/compiled/build.json";
import compiledPdf from "./content/compiled/main.pdf?url";
import { paperHits, papersAnswer, type PapersContext } from "./demo-papers";
import { synctexAnswer } from "./demo-synctex";

/** Where the tutorial seems to live; the app shows it in a few places (the window title, Reveal). */
const DEMO_ROOT = "/Lattice Tutorials/Understanding Attention";

/** Whether the app is showing Simplified Chinese (it sets the document's language). */
const zh = () => document.documentElement.lang === "zh-CN";
const say = (en: string, zhText: string) => (zh() ? zhText : en);

/** Sources the compiled PDF was built from: an edit to one of them is not in the PDF. */
const BUILD_SOURCE = /\.(?:tex|bib|sty|cls)$/;

export function installDemoBackend(files: ProjectFiles): { tauri: MockTauri; unhandled: Set<string> } {
  const project = new MockProject({ root: DEMO_ROOT, id: "understanding-attention", name: "Understanding Attention", files });
  const compiledFrom = new Map([...files].filter(([path, content]) => BUILD_SOURCE.test(path) && typeof content === "string"));
  // The build fails on this until the visitor fixes it: Get started's build step is reading how Lattice explains it.
  stageTypo(project.files);
  const unhandled = new Set<string>();
  let pdf: Promise<ArrayBuffer> | null = null;

  const annotations = annotationsAnswer({ project, seed: () => "open", zh, author: "Ada" });
  const history = historyAnswer({ project });
  const versions = versionsAnswer({ project });
  const papers: PapersContext = {
    notFound: NOT_HANDLED,
    zh: false,
    files: project.files,
    // As papers.rs cites: the entry appended to the bibliography, as a History entry of its own.
    cite: (key, bibtex) => history.cite("references.bib", key, bibtex),
  };
  const textTask = textTasks();
  const snapshot = () => project.snapshot({
    rootDocuments: [{ path: "main.tex", name: "Main", isDefault: true }],
    primaryBibliography: "references.bib",
    trusted: true,
    venue: "neurips",
    deadline: null,
    submissionItems: [],
  });

  /** Whether a source the PDF was built from now reads differently. */
  const edited = () => [...project.files].some(([path, content]) => BUILD_SOURCE.test(path) && compiledFrom.get(path) !== content)
    || [...compiledFrom.keys()].some((path) => !project.files.has(path));

  /**
   * The build the app runs as the project opens finds the PDF up to date, as
   * latexmk would for the source it was compiled from: the visitor meets the
   * staged typo on the first Build they ask for.
   */
  let opened = false;
  const openingBuild = () => ({
    success: true, hasPdf: true, log: build.log, durationMs: 180, diagnostics: build.warnings,
    rootDocument: "main.tex", venue: "NeurIPS", steps: [], pages: build.pages, synctex: true,
  });

  /** latexmk's passes as they happen, then the result: the typo's failure, or the PDF compiled ahead of time. */
  const runBuild = (args: Args) => new Promise((resolve) => {
    const failure = typoFailure(project.text("main.tex"));
    const steps = failure ? [{ ...BUILD_STEPS[0]!, durationMs: 388 }] : BUILD_STEPS;
    const progress = (count: number) => tauri.emit("build-progress", {
      projectRoot: project.root, progressId: args?.progressId ?? null, elapsedMs: steps[count - 1]!.startedMs,
      steps: steps.slice(0, count).map((step, index) => (index === count - 1 ? { ...step, durationMs: null } : step)),
    });
    steps.forEach((step, index) => window.setTimeout(() => progress(index + 1), step.startedMs));
    const last = steps.at(-1)!;
    window.setTimeout(() => resolve(failure
      ? {
        success: false, hasPdf: true, log: withError(build.log, failure.log), durationMs: last.startedMs + last.durationMs!,
        diagnostics: failure.diagnostics, rootDocument: "main.tex", venue: "NeurIPS", steps, pages: null, synctex: true,
      }
      : {
        success: true, hasPdf: true, log: build.log, durationMs: last.startedMs + last.durationMs!,
        diagnostics: [
          ...build.warnings,
          ...edited() ? [{
            level: "info",
            message: say(
              "This demo shows the PDF compiled before your edits. Lattice on your Mac compiles them with your TeX.",
              "演示里显示的是你修改前编译好的 PDF。Mac 上的 Lattice 会用你的 TeX 编译你的修改。",
            ),
          }] : [],
        ],
        rootDocument: "main.tex", venue: "NeurIPS", steps, pages: build.pages, synctex: true,
      }), last.startedMs + last.durationMs!);
  });

  function answer(command: string, args: Args): unknown {
    for (const area of [
      // History answers the editor's saves itself, so each lands there.
      history, (name: string, input: Args) => project.answer(name, input), versions, windowAnswer, annotations, synctexAnswer,
      (name: string, input: Args) => papersAnswer(name, input, { ...papers, zh: zh(), files: project.files }),
    ]) {
      const answered = area(command, args);
      if (answered !== NOT_HANDLED) return answered;
    }
    switch (command) {
      case "initial_project":
      case "open_project":
      case "open_tutorial_project":
      case "refresh_project":
        return snapshot();
      case "list_project_tree_with_hidden":
        return project.tree();
      case "build_project":
        if (!opened) {
          opened = true;
          return openingBuild();
        }
        return runBuild(args);
      case "read_compiled_pdf":
        pdf ??= fetch(compiledPdf).then((response) => response.arrayBuffer());
        // The viewer may take the buffer over, so each read gets its own copy.
        return pdf.then((bytes) => bytes.slice(0));
      case "pdf_page_signatures":
        throw new Error("The demo has no page signatures.");
      case "search_project": {
        const matches = termMatcher(String(args?.query ?? ""));
        return [...project.search(String(args?.query ?? ""), matches), ...paperHits(matches)];
      }
      case "count_project_words": {
        const words = project.text("main.tex").replace(/%.*$/gm, "").replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?/g, " ").match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
        return { text: words, headers: 0, captions: 0, total: words, source: "texcount" };
      }
      case "list_citations":
        return { citations: bibliographyCitations(project.files), skipped: [] };
      case "list_references":
        return { references: labelReferences(project.files), skipped: [] };
      case "list_citation_usages":
        return citationUsages(project.files);
      case "bibliography_audit_scan":
        return bibliographyAuditScan(project.files);
      case "agent_text_task":
        return textTask(args);
      // The Agent runs the AI tools signed in on the visitor's Mac.
      case "synara_ensure_ready":
        throw new Error(say("The Agent runs in Lattice on your Mac.", "AI 助手在 Mac 上的 Lattice 里运行。"));
      case "harper_lint":
      case "texlab_diagnostics":
        return [];
      case "run_doctor": {
        const checks = ["latexmk", "synctex", "bibtex", "pdflatex", "conference-fonts", "uv", "uvx"].map((name) => ({ name, detail: "", ok: true }));
        return { ok: true, summary: "", checks };
      }
      case "overleaf_status":
        return { connected: false, expired: false, email: null, name: null, host: "https://www.overleaf.com" };
      // Signing in opens Overleaf in a window of the Mac app, and syncing runs there.
      case "overleaf_begin_login":
      case "overleaf_poll_login":
        throw new Error(say(
          "Overleaf sync runs in Lattice on your Mac: sign in there, and your projects stay in sync as you write.",
          "Overleaf 同步在 Mac 上的 Lattice 里运行：在那里登录后，你的项目会在写作时保持同步。",
        ));
      // latexdiff typesets the marked-up PDF with the visitor's TeX.
      case "export_changes_pdf":
        throw new Error(say("Exporting a PDF with changes marked needs Lattice and TeX on your Mac.", "导出标注修改的 PDF 需要 Mac 上的 Lattice 和 TeX。"));
      case "search_paper_library":
        return [];
      case "list_unused_symbols":
        return { labels: [], citations: [] };
      case "set_window_material":
        return "unsupported";
      // Links leave for a new tab; native dialogs have nothing to show, so they answer as cancelled.
      case "plugin:opener|open_url":
        window.open(String(args?.url ?? ""), "_blank", "noopener");
        return null;
      // Native window and logging calls a browser tab has nothing to do with.
      case "set_native_locale":
      case "plugin:window|current_monitor":
      case "plugin:window|set_min_size":
      case "plugin:webview|set_webview_zoom":
      case "plugin:log|log":
      case "plugin:updater|check":
      case "enable_save_before_close":
      case "disable_save_before_close":
      case "overleaf_rt_disconnect":
      case "align_traffic_lights":
      case "plugin:window|title":
      case "plugin:window|set_title":
      case "watch_project":
      case "overleaf_link":
      case "git_user_name":
      case "set_pdf_copy_text":
      case "review_mode_load":
        return null;
      case "plugin:dialog|open":
      case "plugin:dialog|save":
      case "choose_import_entries":
        return null;
      default:
        if (command.startsWith("list_")) return [];
        unhandled.add(command);
        return null;
    }
  }

  const tauri = installTauriInternals(answer);
  return { tauri, unhandled };
}
