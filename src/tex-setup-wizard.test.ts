import { beforeEach, describe, expect, it } from "vitest";
import {
  clearTexSetupDismissal,
  dismissTexSetup,
  isConferenceFontsMissing,
  isMissingTexBuildError,
  isTexInstallKind,
  isTexToolchainMissing,
  missingTexToolNames,
  TEX_SETUP_DISMISS_KEY,
  wasTexSetupDismissed,
} from "./tex-setup";

describe("tex setup wizard helpers", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("detects a missing TeX toolchain from doctor checks", () => {
    expect(isTexToolchainMissing({
      ok: false,
      summary: "missing",
      checks: [
        { name: "latexmk", detail: "missing", ok: false },
        { name: "pdflatex", detail: "missing", ok: false },
        { name: "lattice-agent", detail: "ok", ok: true },
      ],
    })).toBe(true);
    expect(isTexToolchainMissing({
      ok: false,
      summary: "agent missing but TeX ok",
      checks: [
        { name: "latexmk", detail: "ok", ok: true },
        { name: "pdflatex", detail: "ok", ok: true },
        { name: "synctex", detail: "ok", ok: true },
        { name: "bibtex", detail: "ok", ok: true },
        { name: "xelatex", detail: "missing", ok: false },
        { name: "lualatex", detail: "missing", ok: false },
        { name: "lattice-agent", detail: "missing", ok: false },
      ],
    })).toBe(false);
    expect(missingTexToolNames({
      ok: false,
      summary: "missing",
      checks: [
        { name: "latexmk", detail: "ok", ok: true },
        { name: "pdflatex", detail: "ok", ok: true },
        { name: "synctex", detail: "missing", ok: false },
        { name: "bibtex", detail: "ok", ok: true },
      ],
    })).toEqual(["synctex"]);
  });

  it("recognizes build errors that mean TeX is not installed", () => {
    expect(isMissingTexBuildError("Could not start latexmk. Install MacTeX or TeX Live.")).toBe(true);
    expect(isMissingTexBuildError("The LaTeX tool 'pdflatex' was not found.")).toBe(true);
    expect(isMissingTexBuildError("Undefined control sequence.")).toBe(false);
  });

  it("persists dismissal in localStorage", () => {
    expect(wasTexSetupDismissed()).toBe(false);
    dismissTexSetup();
    expect(wasTexSetupDismissed()).toBe(true);
    expect(localStorage.getItem(TEX_SETUP_DISMISS_KEY)).toBe("1");
    clearTexSetupDismissal();
    expect(wasTexSetupDismissed()).toBe(false);
  });

  it("accepts only basic and full install kinds", () => {
    expect(isTexInstallKind("basic")).toBe(true);
    expect(isTexInstallKind("full")).toBe(true);
    expect(isTexInstallKind("mactex")).toBe(false);
  });

  it("reports conference font status separately from compile tools", () => {
    const report = {
      ok: true,
      summary: "ready tools, missing fonts",
      checks: [
        { name: "latexmk", detail: "ok", ok: true },
        { name: "pdflatex", detail: "ok", ok: true },
        { name: "synctex", detail: "ok", ok: true },
        { name: "bibtex", detail: "ok", ok: true },
        { name: "conference-fonts", detail: "Missing t1ptm.fd", ok: false },
      ],
    };
    expect(isTexToolchainMissing(report)).toBe(false);
    expect(isConferenceFontsMissing(report)).toBe(true);
  });
});
