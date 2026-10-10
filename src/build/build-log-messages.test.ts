import { describe, expect, it } from "vitest";
import { compileDiagnosticText } from "./build-log-messages";
import { compileRepairMessage } from "./compile-repair-messages";
import { doctorCheckDetail, doctorCheckLabel } from "./tex-doctor-messages";

describe("build log messages", () => {
  it("render Lattice's build advice with the English the host writes", () => {
    const cases: [string, Record<string, string>, string][] = [
      ["latex-tool-missing", { tool: "pdflatex" }, "The LaTeX tool 'pdflatex' was not found. Install MacTeX or TeX Live, then restart Lattice."],
      ["tex-dependency-missing", { file: "algorithm.sty" }, "Missing LaTeX dependency `algorithm.sty`. BasicTeX does not include every package available on Overleaf. Use Install missing package to find and install its TeX Live package."],
      ["conference-style-missing", { file: "cvpr.sty", venue: "CVPR" }, "Missing style file `cvpr.sty`. It is part of the CVPR template and belongs next to main.tex — TeX Live cannot install it. Sync or copy it back from another copy of the project."],
      ["latexmkrc-failed", { file: ".latexmkrc", reason: "Figure export failed" }, "latexmk stopped before LaTeX ran because .latexmkrc failed: Figure export failed. The Log tab shows the output of the command it runs."],
      ["build-cancelled", { seconds: "2.5" }, "Build stopped after 2.5s. The log below is how far it got."],
      ["pdf-fonts-not-times", { venue: "ICLR", fonts: "LMRoman10-Regular", cause: "lmodern" }, "PDF fonts are not the Times that ICLR requires (LMRoman10-Regular). The document loads lmodern after Times, which replaces it with Latin Modern: remove \\usepackage{lmodern}, then Build."],
      ["pdf-fonts-not-times", { venue: "NeurIPS", fonts: "Arial", cause: "unknown", upToDate: "true" }, "PDF fonts are not the Times that NeurIPS requires (Arial). Expected NimbusRomNo9L-*. — latexmk did not recompile (Nothing to do / up-to-date). Hold Shift and click Build to force a rebuild with the installed Times fonts."],
    ];
    for (const [code, params, english] of cases) {
      expect(compileDiagnosticText({ message: "raw", code, params })).toBe(english);
    }
    // TeX's own messages, and codes this build does not know, stay as reported.
    expect(compileDiagnosticText({ message: "Undefined control sequence." })).toBe("Undefined control sequence.");
    expect(compileDiagnosticText({ message: "raw", code: "from-a-newer-host" })).toBe("raw");
  });

  it("render doctor checks and fall back to the reported detail", () => {
    const check = (name: string, code: string, params: Record<string, string> = {}) =>
      doctorCheckDetail({ name, detail: "raw", ok: false, code, params });
    expect(check("biber", "tool-not-found")).toBe("Biber bibliography processor: not found on PATH");
    expect(check("pdflatex", "tool-failed", { path: "/bin/pdflatex", error: "boom" }))
      .toBe("pdfLaTeX engine: /bin/pdflatex could not run: boom");
    expect(check("icml-packages", "files-missing", { files: "algorithm.sty" }))
      .toBe("Missing algorithm.sty — ICML Build will Emergency stop. In Terminal: sudo tlmgr install algorithms   (or click Install BasicTeX in Lattice).");
    expect(check("unknown-tool", "tool-not-found")).toBe("raw");
    expect(doctorCheckDetail({ name: "latexmk-version", detail: "Latexmk 4.83", ok: true })).toBe("Latexmk 4.83");
    expect(doctorCheckLabel("conference-fonts")).toBe("Conference fonts");
    expect(doctorCheckLabel("latexmk")).toBe("latexmk");
  });

  it("render the repair relay's known status lines", () => {
    expect(compileRepairMessage("Error: Repair has no active turn.")).toBe("Repair has no active turn.");
    expect(compileRepairMessage("Repair turn interrupted.")).toBe("Repair turn interrupted.");
    expect(compileRepairMessage("The agent service is unavailable.")).toBe("The agent service is unavailable.");
    expect(compileRepairMessage("Error: provider crashed")).toBe("Error: provider crashed");
  });
});
