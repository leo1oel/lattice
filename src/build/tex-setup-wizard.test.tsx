import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isConferenceFontsMissing,
  isMissingTexBuildError,
  isRequiredSetupMissing,
  missingRequiredToolNames,
  missingTexToolNames,
  type DoctorReportLike,
} from "./tex-setup";
import { TexSetupWizard } from "./tex-setup-wizard";

type Channel = { onmessage: ((message: unknown) => void) | null };
const tauri = vi.hoisted(() => ({ invoke: vi.fn(), channel: null as Channel | null }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
  Channel: class {
    onmessage: ((message: unknown) => void) | null = null;

    constructor() {
      tauri.channel = this;
    }
  },
}));

const check = (name: string, ok = true, detail = ok ? "ok" : "missing") => ({ name, detail, ok });
const report = (...checks: DoctorReportLike["checks"]): DoctorReportLike => ({
  ok: checks.every((item) => item.ok),
  summary: "doctor",
  checks,
});
const TEX_TOOLS = ["latexmk", "pdflatex", "synctex", "bibtex"].map((name) => check(name));
const READY = [...TEX_TOOLS, check("conference-fonts"), check("uv"), check("uvx")];

function renderWizard(initial: DoctorReportLike, onRecheck = vi.fn(async (): Promise<DoctorReportLike | null> => null)) {
  const onClose = vi.fn();
  render(<TexSetupWizard open report={initial} checking={false} onClose={onClose} onRecheck={onRecheck} />);
  return { onClose, onRecheck };
}

describe("tex setup wizard helpers", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.channel = null;
  });

  it("detects a missing TeX toolchain from doctor checks, accepting any one engine", () => {
    expect(missingTexToolNames(report(check("latexmk", false), check("pdflatex", false))))
      .toEqual(["latexmk", "synctex", "bibtex", "pdflatex"]);
    expect(missingTexToolNames(report(...TEX_TOOLS, check("xelatex", false), check("lualatex", false)))).toEqual([]);
    expect(missingTexToolNames(report(...TEX_TOOLS.filter(({ name }) => name !== "synctex"), check("synctex", false))))
      .toEqual(["synctex"]);
    expect(missingTexToolNames(null)).toEqual([]);
  });

  it("recognizes build errors that mean TeX is not installed", () => {
    expect(isMissingTexBuildError("Could not start latexmk. Install MacTeX or TeX Live.")).toBe(true);
    expect(isMissingTexBuildError("The LaTeX tool 'pdflatex' was not found.")).toBe(true);
    expect(isMissingTexBuildError("Undefined control sequence.")).toBe(false);
    expect(isMissingTexBuildError(
      "Latexmk: Missing input file 'cvpr.sty' message in .log file:\nLaTeX Error: File `cvpr.sty' not found.",
    )).toBe(false);
  });

  it("reports conference font status separately from compile tools", () => {
    const fontsMissing = report(...TEX_TOOLS, check("conference-fonts", false, "Missing t1ptm.fd"));
    expect(missingTexToolNames(fontsMissing)).toEqual([]);
    expect(isConferenceFontsMissing(fontsMissing)).toBe(true);
    expect(isConferenceFontsMissing(report())).toBe(true);
  });

  it("offers one managed install action when only uv is missing", () => {
    const { onClose } = renderWizard(report(...TEX_TOOLS, check("conference-fonts"), check("uv", false), check("uvx", false)));

    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Install required tools" })).toBeEnabled();
    expect(screen.getByText(/about 45 MB/)).toBeInTheDocument();
    const uvMissing = report(check("uv", false), check("uvx", false));
    expect(isRequiredSetupMissing(uvMissing)).toBe(true);
    expect(missingRequiredToolNames(uvMissing)).toEqual(["uv", "uvx"]);
    for (const retired of ["Install MacTeX (full)", "Skip for now", "Recheck", "Close"]) {
      expect(screen.queryByText(retired)).not.toBeInTheDocument();
    }

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Install required tools" }));
    expect(tauri.invoke).toHaveBeenCalledWith("start_tex_install", { mode: "toolsOnly", onProgress: expect.anything() });
  });

  it("renders backend installation progress and closes only after verification", async () => {
    let finishInstall!: () => void;
    tauri.invoke.mockReturnValue(new Promise<void>((resolve) => {
      finishInstall = resolve;
    }));
    const { onClose, onRecheck } = renderWizard(report(check("latexmk", false)), vi.fn(async () => report(...READY)));

    fireEvent.click(screen.getByRole("button", { name: "Install Basic TeX" }));
    expect(tauri.invoke).toHaveBeenCalledWith("start_tex_install", { mode: "full", onProgress: expect.anything() });
    expect(document.querySelector(".tex-setup-install-loader")).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    act(() => tauri.channel?.onmessage?.({ stage: "downloading", progress: 0.37 }));
    expect(screen.getByRole("progressbar", { name: "BasicTeX installation progress" }))
      .toHaveAttribute("aria-valuenow", "37");
    expect(document.querySelector(".tex-setup-progress-fill")).toHaveStyle({ width: "37%" });

    act(() => tauri.channel?.onmessage?.({ stage: "installing-packages", progress: 0.82 }));
    expect(screen.getByText("Can take up to 15 minutes")).toBeInTheDocument();

    await act(async () => finishInstall());
    expect(onRecheck).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows the concrete doctor failure and keeps install available", async () => {
    tauri.invoke.mockResolvedValue(undefined);
    renderWizard(report(check("latexmk", false)), vi.fn(async () => report(
      check("latexmk", false, "Permission denied"),
      check("conference-fonts", false, "Missing uhvr8a.pfb — Permission denied"),
    )));

    fireEvent.click(screen.getByRole("button", { name: "Install Basic TeX" }));

    expect(await screen.findByText(/Missing tools: latexmk/)).toBeInTheDocument();
    expect(screen.getByText(/Missing uhvr8a\.pfb — Permission denied/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install Basic TeX" })).toBeEnabled();
  });
});
