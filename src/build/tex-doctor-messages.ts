import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";
import { pdfFontsText } from "./build-log-messages";

/** A TeX doctor check as `run_doctor` reports it (`DoctorCheck` in models.rs). */
export type CodedDoctorCheck = {
  name: string;
  detail: string;
  ok: boolean;
  code?: string;
  params?: Record<string, string>;
};

// What each tool the doctor probes is for, by check name (doctor.rs).
const TOOL_DESCRIPTIONS: Record<string, MessageDescriptor> = {
  latexmk: msg`LaTeX build driver`,
  pdflatex: msg`pdfLaTeX engine`,
  xelatex: msg`XeLaTeX engine`,
  lualatex: msg`LuaLaTeX engine`,
  synctex: msg`SyncTeX bidirectional search`,
  bibtex: msg`BibTeX bibliography processor`,
  biber: msg`Biber bibliography processor`,
  texlab: msg`TexLab language server (optional editor diagnostics)`,
  git: msg`Git (optional project status / commit panel)`,
  texcount: msg`TeXcount body word counts (optional status bar)`,
  uv: msg`Python tooling used for literature and bibliography tools`,
  uvx: msg`Runner used for Lattice's pinned literature tools`,
};

// Checks that are not named after a tool.
const CHECK_LABELS: Record<string, MessageDescriptor> = {
  "project-root": msg`Root document`,
  bibliography: msg`Bibliography`,
  "latexmk-version": msg`latexmk version`,
  "conference-fonts": msg`Conference fonts`,
  "icml-packages": msg`ICML packages`,
  "neurips-packages": msg`NeurIPS packages`,
  "pdf-embedded-fonts": msg`PDF embedded fonts`,
};

/** The row title of a doctor check: a tool's own name, or what the check verifies. */
export function doctorCheckLabel(name: string): string {
  const label = CHECK_LABELS[name];
  return label ? i18n._(label) : name;
}

function missingFilesText(name: string, files: string): string | null {
  switch (name) {
    case "conference-fonts":
      return i18n._(msg`Missing ${files} — PDF text will look wrong even if .tfm exists. Click Install BasicTeX in Lattice (watch Terminal for FONTS OK), then Shift-click Build.`);
    case "icml-packages":
      return i18n._(msg`Missing ${files} — ICML Build will Emergency stop. In Terminal: sudo tlmgr install algorithms   (or click Install BasicTeX in Lattice).`);
    case "neurips-packages":
      return i18n._(msg`Missing ${files} — NeurIPS Build will Emergency stop. In Terminal: sudo tlmgr install collection-latexextra   (or click Install BasicTeX in Lattice).`);
    default:
      return null;
  }
}

function kpsewhichMissingText(name: string): string | null {
  switch (name) {
    case "conference-fonts":
      return i18n._(msg`Cannot verify fonts (kpsewhich missing). Install BasicTeX from Lattice.`);
    case "icml-packages":
      return i18n._(msg`Cannot verify ICML packages (kpsewhich missing). Install BasicTeX from Lattice.`);
    case "neurips-packages":
      return i18n._(msg`Cannot verify NeurIPS packages (kpsewhich missing). Install BasicTeX from Lattice.`);
    default:
      return null;
  }
}

function codedDetail(check: CodedDoctorCheck): string | null {
  const params = check.params ?? {};
  const tool = TOOL_DESCRIPTIONS[check.name];
  const description = tool ? i18n._(tool) : null;
  const error = params.error ?? "";
  switch (check.code) {
    case "tool-not-found":
      return description && i18n._(msg`${description}: not found on PATH`);
    case "tool-failed": {
      const path = params.path ?? "";
      return description && i18n._(msg`${description}: ${path} could not run: ${error}`);
    }
    case "managed-tool-failed":
      return description && i18n._(msg`${description}: ${error}`);
    case "root-document-missing": {
      const { project = "", engine = "", document = "" } = params;
      return i18n._(msg`Project ${project} · engine ${engine} · root ${document} (missing)`);
    }
    case "bibliography-missing": {
      const file = params.file ?? "";
      return i18n._(msg`Primary bibliography ${file} (missing)`);
    }
    case "kpsewhich-missing":
      return kpsewhichMissingText(check.name);
    case "files-missing":
      return missingFilesText(check.name, params.files ?? "");
    case "pdf-fonts-not-times":
      return pdfFontsText(params);
    case "pdf-unreadable": {
      const path = params.path ?? "";
      return i18n._(msg`Could not read ${path}: ${error}`);
    }
    default:
      return null;
  }
}

/** A doctor check's detail in the interface language; uncoded details stay as reported. */
export function doctorCheckDetail(check: CodedDoctorCheck): string {
  return codedDetail(check) ?? check.detail;
}
