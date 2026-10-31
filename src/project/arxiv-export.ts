/**
 * The arXiv export sheet's model: the pack and checks the backend reports
 * (`src-tauri/src/latex/arxiv.rs`), and how each check reads as a row.
 *
 * A row's state is the backend's finding put as the sheet shows it: a
 * warning (TODO comments, a non-pdfLaTeX engine, a file named in another
 * case than the disk's) never blocks the export;
 * a failure (missing files, no `.bbl`, a package that does not build alone,
 * over arXiv's limit) does.
 */
import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";

export type ArxivOptions = { stripComments: boolean; mergeInputs: boolean };

type CompileCheck = {
  outcome: "ok" | "failed" | "timedOut" | "cancelled";
  pages: number | null;
  durationMs: number;
  error?: { message: string; file: string | null; line: number | null };
  log?: string;
};

type CommentLine = { file: string; line: number; text: string; todo: boolean };

export type ArxivPackage = {
  rootDocument: string;
  files: { path: string; bytes: number }[];
  totalBytes: number;
  sizeLimitBytes: number;
  leftOut: string[];
  figures: string[];
  missing: string[];
  /** Files the build found only because macOS's disk ignores case. */
  miscased: { written: string; file: string }[];
  bibliography: { state: "included"; file: string } | { state: "none" } | { state: "missing" };
  comments: { removed: boolean; count: number; todos: number; lines: CommentLine[] };
  merged: string[];
  engine: string;
  digest: string;
  compile?: CompileCheck;
};

export type ArxivCheck = { kind: "unbuilt"; rootDocument: string } | ({ kind: "package" } & ArxivPackage);

export type CheckState = "pending" | "running" | "ok" | "warn" | "fail";

type CheckRow = {
  id: "figures" | "bibliography" | "compile" | "comments" | "size";
  state: CheckState;
  label: string;
  detail: string;
  /** The row's own disclosure: the comments it found. */
  review?: CommentLine[];
};

/** Names shown before the rest are counted. */
const LISTED_NAMES = 4;

const ENGINE_NAMES: Record<string, string> = { pdf: "pdfLaTeX", pdflatex: "pdfLaTeX", xelatex: "XeLaTeX", lualatex: "LuaLaTeX" };

function engineName(engine: string) {
  return ENGINE_NAMES[engine.trim().toLowerCase()] ?? "pdfLaTeX";
}

/** Decimal units, as arXiv states its limit (50 MB), in the reader's locale. */
export function formatSize(bytes: number, locale = i18n.locale || "en") {
  const [value, unit] = bytes < 1_000_000
    ? [Math.max(1, Math.round(bytes / 1_000)), "kilobyte"]
    : [bytes / 1_000_000, "megabyte"];
  return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "short", maximumFractionDigits: 1 }).format(value);
}

/** The pack's top level: files by name, folders as `figures/`. */
export function topLevelNames(paths: readonly string[]) {
  const names = new Set<string>();
  for (const path of paths) {
    const slash = path.indexOf("/");
    names.add(slash < 0 ? path : `${path.slice(0, slash + 1)}`);
  }
  return [...names].sort((a, b) => Number(a.endsWith("/")) - Number(b.endsWith("/")) || a.localeCompare(b));
}

/** The archive's suggested name: the project's, as a file name can carry it. */
export function archiveName(projectName: string) {
  const base = projectName.trim().replace(/[\\/:*?"<>|]+/g, "-") || "paper";
  return [base, "arxiv.zip"].join("-");
}

export function summaryLine(pack: ArxivPackage) {
  const count = pack.files.length;
  const files = count === 1 ? i18n._(msg`1 file`) : i18n._(msg`${count} files`);
  const names = topLevelNames(pack.files.map((file) => file.path));
  const shown = names.slice(0, LISTED_NAMES).join(", ") + (names.length > LISTED_NAMES ? ", …" : "");
  return `${files} · ${formatSize(pack.totalBytes)} · ${shown}`;
}

export function leftOutLine(leftOut: readonly string[]) {
  const hidden = leftOut.length - LISTED_NAMES;
  const names = leftOut.slice(0, LISTED_NAMES).join(", ");
  return hidden > 0
    ? i18n._(msg`Left out: ${names} and ${hidden} more`)
    : i18n._(msg`Left out: ${names}`);
}

export function pendingRows(): CheckRow[] {
  return [
    { id: "figures", state: "pending", label: i18n._(msg`Every figure is included`), detail: "" },
    { id: "bibliography", state: "pending", label: i18n._(msg`Bibliography travels as a .bbl`), detail: "" },
    { id: "compile", state: "pending", label: i18n._(msg`Builds from the package alone`), detail: "" },
    { id: "comments", state: "pending", label: i18n._(msg`Comments removed`), detail: "" },
    { id: "size", state: "pending", label: i18n._(msg`Under arXiv’s size limit`), detail: "" },
  ];
}

export function checkRows(pack: ArxivPackage): CheckRow[] {
  return [figuresRow(pack), bibliographyRow(pack), compileRow(pack), commentsRow(pack), sizeRow(pack)];
}

function figuresRow(pack: ArxivPackage): CheckRow {
  const label = i18n._(msg`Every figure is included`);
  if (pack.missing.length > 0) {
    const [first] = pack.missing;
    const more = pack.missing.length - 1;
    return {
      id: "figures",
      state: "fail",
      label: i18n._(msg`Files the last build used are missing`),
      detail: more > 0 ? i18n._(msg`${first} and ${more} more; build again`) : i18n._(msg`${first}; build again`),
    };
  }
  // The test build runs on this Mac and passes; arXiv's TeX runs on Linux and
  // cannot find a folder named in another case, so this is the place to say it.
  if (pack.miscased.length > 0) {
    const [{ written, file }] = pack.miscased;
    const more = pack.miscased.length - 1;
    return {
      id: "figures",
      state: "warn",
      label: i18n._(msg`The source spells file names in another case`),
      detail: more > 0
        ? i18n._(msg`${written} is ${file} on disk, and ${more} more; arXiv can fail to find them`)
        : i18n._(msg`${written} is ${file} on disk; arXiv can fail to find it`),
    };
  }
  const count = pack.figures.length;
  const detail = count === 0
    ? i18n._(msg`The paper has no figures`)
    : count === 1 ? i18n._(msg`1 figure`) : i18n._(msg`${count} figures`);
  return { id: "figures", state: "ok", label, detail };
}

function bibliographyRow(pack: ArxivPackage): CheckRow {
  const { bibliography } = pack;
  if (bibliography.state === "included") {
    const file = bibliography.file;
    return { id: "bibliography", state: "ok", label: i18n._(msg`Bibliography travels as ${file}`), detail: "" };
  }
  if (bibliography.state === "missing") {
    return { id: "bibliography", state: "fail", label: i18n._(msg`The bibliography has no .bbl`), detail: i18n._(msg`Build the paper so it has one; arXiv doesn’t run BibTeX`) };
  }
  return { id: "bibliography", state: "ok", label: i18n._(msg`No bibliography to include`), detail: "" };
}

function compileRow(pack: ArxivPackage): CheckRow {
  const label = i18n._(msg`Builds from the package alone`);
  const engine = engineName(pack.engine);
  const compile = pack.compile;
  if (!compile || compile.outcome === "cancelled") {
    return { id: "compile", state: "running", label, detail: i18n._(msg`${engine} in a clean folder…`) };
  }
  if (compile.outcome === "timedOut") {
    return { id: "compile", state: "fail", label: i18n._(msg`The package did not finish building`), detail: i18n._(msg`Stopped after 2 minutes`) };
  }
  if (compile.outcome === "failed") {
    const error = compile.error;
    const where = error?.file ? `${error.file}${error.line ? `:${error.line}` : ""}: ` : "";
    return {
      id: "compile",
      state: "fail",
      label: i18n._(msg`The package does not build alone`),
      detail: error ? `${where}${error.message}` : i18n._(msg`See the log for why`),
    };
  }
  const seconds = (compile.durationMs / 1000).toFixed(1);
  const count = compile.pages;
  const pages = count === null ? "" : count === 1 ? i18n._(msg`1 page`) : i18n._(msg`${count} pages`);
  const built = [engine, pages, i18n._(msg`${seconds} s`)].filter(Boolean).join(" · ");
  if (engine !== "pdfLaTeX") {
    return { id: "compile", state: "warn", label, detail: i18n._(msg`${built}; arXiv builds with pdfLaTeX`) };
  }
  return { id: "compile", state: "ok", label, detail: built };
}

function commentsRow(pack: ArxivPackage): CheckRow {
  const { removed, count, todos, lines } = pack.comments;
  if (count === 0) {
    return { id: "comments", state: "ok", label: i18n._(msg`No comments in the source`), detail: "" };
  }
  const counted = count === 1 ? i18n._(msg`1 comment line`) : i18n._(msg`${count} comment lines`);
  const detail = todos === 0 ? counted : todos === 1 ? i18n._(msg`${counted}, 1 of them a TODO`) : i18n._(msg`${counted}, ${todos} of them TODOs`);
  if (!removed) {
    return { id: "comments", state: "warn", label: i18n._(msg`Comments will be published`), detail, review: lines };
  }
  return { id: "comments", state: todos > 0 ? "warn" : "ok", label: i18n._(msg`Comments removed`), detail, review: lines };
}

function sizeRow(pack: ArxivPackage): CheckRow {
  const size = formatSize(pack.totalBytes);
  const limit = formatSize(pack.sizeLimitBytes);
  return pack.totalBytes <= pack.sizeLimitBytes
    ? { id: "size", state: "ok", label: i18n._(msg`Under arXiv’s size limit`), detail: i18n._(msg`${size} of ${limit}`) }
    : { id: "size", state: "fail", label: i18n._(msg`Over arXiv’s size limit`), detail: i18n._(msg`${size} of ${limit}; leave out large figures`) };
}
