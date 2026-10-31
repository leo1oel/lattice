/**
 * The bench's answers for Export for arXiv (palette: "Export for arXiv…"), so
 * the sheet can be looked at in each of its states.
 *
 * `?arxiv=ready` stages the sheet's usual result: a NeurIPS paper whose pack
 * builds alone, with two TODOs among its comments (one warning). The test
 * build answers after a second and a half, so the running row shows first.
 * `?arxiv=running` keeps the test build running; `failed` has it stop on an
 * undefined control sequence; `unbuilt` is a paper never built here; `long`
 * gives the files, the project and a comment 60-character names, for width
 * checks. The switches re-run the check as the backend does (comments kept
 * ship as a warning; `\input` files not merged ship on their own), and
 * Export ZIP saves to a made-up Desktop path.
 */
import { NOT_HANDLED } from "./bench-overleaf";

type Args = Record<string, unknown> | undefined;
type Context = {
  params: URLSearchParams;
  /** Deliver `message` on the Tauri channel the app passed as `channel`. */
  send: (channel: unknown, message: unknown) => void;
};

const MODES = ["ready", "running", "failed", "unbuilt", "long"] as const;
const LONG = "a-rather-long-file-name-for-the-narrow-window-check";

function pack(mode: string, options: { stripComments?: boolean; mergeInputs?: boolean }) {
  const long = mode === "long";
  const figure = (name: string) => long ? `figures/${name}-${LONG}.pdf` : `figures/${name}.pdf`;
  const sections = options.mergeInputs === false
    ? [{ path: "sections/introduction.tex", bytes: 8_412 }, { path: "sections/method.tex", bytes: 14_960 }]
    : [];
  const files = [
    { path: figure("attention-heads"), bytes: 412_300 },
    { path: figure("attention-map"), bytes: 1_160_000 },
    { path: "figures/training-curve.png", bytes: 208_400 },
    { path: "main.bbl", bytes: 6_210 },
    { path: "main.tex", bytes: options.mergeInputs === false ? 21_870 : 45_180 },
    { path: "neurips_2024.sty", bytes: 13_640 },
    ...sections,
  ].sort((a, b) => a.path.localeCompare(b.path));
  return {
    rootDocument: "main.tex",
    files,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    sizeLimitBytes: 50_000_000,
    leftOut: ["attention-demo.html", "attention-map.tldr", "notes.md", "references.bib", "results.lattice-sheet", "slides/"],
    figures: files.filter((file) => /\.(pdf|png)$/.test(file.path)).map((file) => file.path),
    missing: [],
    miscased: [],
    bibliography: { state: "included", file: "main.bbl" },
    comments: {
      removed: options.stripComments !== false,
      count: 27,
      todos: 2,
      lines: [
        { file: "main.tex", line: 48, text: long ? `TODO: ${LONG} ${LONG}` : "TODO: tighten the abstract to 150 words", todo: true },
        { file: "sections/method.tex", line: 112, text: "TODO: cite the FlashAttention paper here", todo: true },
        { file: "main.tex", line: 12, text: "\\usepackage[final]{neurips_2024}", todo: false },
        { file: "sections/introduction.tex", line: 7, text: "Ana: should this come before the related work?", todo: false },
        { file: "sections/method.tex", line: 30, text: "older wording kept for reference", todo: false },
      ],
    },
    merged: options.mergeInputs === false ? [] : ["sections/introduction.tex", "sections/method.tex"],
    engine: "pdf",
    digest: "bench",
  };
}

function compile(mode: string) {
  return mode === "failed"
    ? {
      outcome: "failed",
      pages: null,
      durationMs: 1_840,
      error: { message: "Undefined control sequence. \\citep", file: "main.tex", line: 214 },
      log: "main.tex:214: Undefined control sequence.\nl.214 ...as shown by \\citep\n",
    }
    : { outcome: "ok", pages: 9, durationMs: 3_100 };
}

export function arxivAnswer(command: string, args: Args, { params, send }: Context): unknown {
  const mode = params.get("arxiv");
  if (!mode || !(MODES as readonly string[]).includes(mode)) return NOT_HANDLED;
  switch (command) {
    case "check_arxiv_package": {
      if (mode === "unbuilt") return { kind: "unbuilt", rootDocument: "main.tex" };
      const staged = { kind: "package", ...pack(mode, (args?.options ?? {}) as { stripComments?: boolean; mergeInputs?: boolean }) };
      send(args?.onStaged, staged);
      if (mode === "running") return new Promise<never>(() => {});
      return new Promise((resolve) => window.setTimeout(() => resolve({ ...staged, compile: compile(mode) }), 1_500));
    }
    case "cancel_arxiv_check":
      return null;
    case "export_arxiv_package":
      return new Promise((resolve) => window.setTimeout(() => resolve(null), 400));
    case "plugin:dialog|save": {
      const name = (args?.options as { defaultPath?: string } | undefined)?.defaultPath ?? "paper-arxiv.zip";
      return `/Users/writer/Desktop/${name}`;
    }
    case "plugin:opener|reveal_item_in_dir":
      return null;
    default:
      return NOT_HANDLED;
  }
}
