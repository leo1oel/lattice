import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";

/**
 * A message the Rust host wrote itself, as a stable `code` with `params`,
 * beside its English `message`. The English stays the source of truth for
 * logs, copied reports, fingerprints and the agent; only the display is
 * translated.
 */
export type CodedMessage = {
  message: string;
  code?: string;
  params?: Record<string, string>;
};

/**
 * The display text of a compile diagnostic: Lattice's own build advice in the
 * interface language, and the TeX engine's messages unchanged.
 */
export function compileDiagnosticText(diagnostic: CodedMessage): string {
  const params = diagnostic.params ?? {};
  const file = params.file ?? "";
  switch (diagnostic.code) {
    case "latex-tool-missing": {
      const tool = params.tool ?? "";
      return i18n._(msg`The LaTeX tool ''${tool}'' was not found. Install MacTeX or TeX Live, then restart Lattice.`);
    }
    case "tex-dependency-missing":
      return i18n._(msg`Missing LaTeX dependency \`${file}\`. BasicTeX does not include every package available on Overleaf. Use Install missing package to find and install its TeX Live package.`);
    case "conference-style-missing": {
      const venue = params.venue ?? "";
      return i18n._(msg`Missing style file \`${file}\`. It is part of the ${venue} template and belongs next to main.tex — TeX Live cannot install it. Sync or copy it back from another copy of the project.`);
    }
    case "latexmkrc-failed": {
      const reason = params.reason ?? "";
      return reason
        ? i18n._(msg`latexmk stopped before LaTeX ran because ${file} failed: ${reason}. The Log tab shows the output of the command it runs.`)
        : i18n._(msg`latexmk stopped before LaTeX ran because ${file} failed. The Log tab shows the output of the command it runs.`);
    }
    case "playwright-chromium-missing": {
      const command = params.command ?? "";
      return i18n._(msg`The project's .latexmkrc runs Playwright, and the Chromium this Playwright version needs is not downloaded, so latexmk stopped before LaTeX ran. Run \`${command}\` in Terminal, then build again.`);
    }
    case "stale-build":
      return i18n._(msg`Stale failed build. Use Clean rebuild (Shift-click Build), or delete aux files and build again.`);
    case "build-cancelled": {
      const seconds = params.seconds ?? "";
      return i18n._(msg`Build stopped after ${seconds}s. The log below is how far it got.`);
    }
    case "pdf-fonts-not-times":
      return pdfFontsText(params, params.upToDate === "true");
    default:
      return diagnostic.message;
  }
}

/**
 * A conference PDF typeset in the wrong fonts, and what in its build replaced
 * Times (`TimesCause` in pdf_fonts.rs). Shared with the TeX doctor's
 * `pdf-embedded-fonts` check, which carries the same code.
 */
export function pdfFontsText(params: Record<string, string>, upToDate = false): string {
  const { venue = "", fonts = "" } = params;
  const problem = fonts
    ? i18n._(msg`PDF fonts are not the Times that ${venue} requires (${fonts}).`)
    : i18n._(msg`PDF fonts are not the Times that ${venue} requires.`);
  const text = `${problem} ${timesFixText(params.cause)}`;
  return upToDate
    ? `${text} — ${i18n._(msg`latexmk did not recompile (Nothing to do / up-to-date). Hold Shift and click Build to force a rebuild with the installed Times fonts.`)}`
    : text;
}

function timesFixText(cause: string | undefined): string {
  // The LaTeX goes in as a parameter: its braces would read as placeholders.
  switch (cause) {
    case "lmodern": {
      const command = "\\usepackage{lmodern}";
      return i18n._(msg`The document loads lmodern after Times, which replaces it with Latin Modern: remove ${command}, then Build.`);
    }
    case "fontspec": {
      const command = "\\setmainfont{Times New Roman}";
      return i18n._(msg`The document loads fontspec, which makes Latin Modern the main font: add ${command} after it, or build with pdfLaTeX.`);
    }
    case "unicode-encoding": {
      const command = "\\usepackage[T1]{fontenc}";
      return i18n._(msg`XeLaTeX and LuaLaTeX have no Times in their default encoding, so LaTeX fell back to Latin Modern: add ${command} after the template, or build with pdfLaTeX.`);
    }
    case "fonts-missing":
      return i18n._(msg`Times is not installed, so LaTeX fell back to Computer Modern: click Install required tools in the TeX doctor, then Shift-click Build.`);
    case "not-loaded": {
      const command = "\\usepackage{times}";
      return i18n._(msg`The document never loads Times: add ${command} after the template, then Build.`);
    }
    default:
      return i18n._(msg`Expected NimbusRomNo9L-*.`);
  }
}
