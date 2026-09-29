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
    case "pdf-fonts-computer-modern":
    case "pdf-fonts-not-times":
      return pdfFontsText(diagnostic.code, params.fonts ?? "", params.upToDate === "true");
    default:
      return diagnostic.message;
  }
}

/**
 * A conference PDF typeset in the wrong fonts. Shared with the TeX doctor's
 * `pdf-embedded-fonts` check, which carries the same codes.
 */
export function pdfFontsText(code: "pdf-fonts-computer-modern" | "pdf-fonts-not-times", fonts: string, upToDate = false): string {
  if (code === "pdf-fonts-computer-modern") {
    if (upToDate) {
      return fonts
        ? i18n._(msg`PDF still uses Computer Modern (${fonts}). Expected NimbusRom/Times — Shift-click Build after Install BasicTeX. — latexmk did not recompile (Nothing to do / up-to-date). Hold Shift and click Build to force a rebuild with the installed Times fonts.`)
        : i18n._(msg`PDF still uses Computer Modern. Expected NimbusRom/Times — Shift-click Build after Install BasicTeX. — latexmk did not recompile (Nothing to do / up-to-date). Hold Shift and click Build to force a rebuild with the installed Times fonts.`);
    }
    return fonts
      ? i18n._(msg`PDF still uses Computer Modern (${fonts}). Expected NimbusRom/Times — Shift-click Build after Install BasicTeX.`)
      : i18n._(msg`PDF still uses Computer Modern. Expected NimbusRom/Times — Shift-click Build after Install BasicTeX.`);
  }
  return upToDate
    ? i18n._(msg`PDF fonts are not NeurIPS Times (${fonts}). Expected NimbusRomNo9L-*. — latexmk did not recompile (Nothing to do / up-to-date). Hold Shift and click Build to force a rebuild with the installed Times fonts.`)
    : i18n._(msg`PDF fonts are not NeurIPS Times (${fonts}). Expected NimbusRomNo9L-*.`);
}
