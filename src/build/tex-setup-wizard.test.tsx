import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  isConferenceFontsMissing,
  isMissingTexBuildError,
  isRequiredSetupMissing,
  missingPaperToolNames,
  missingTexToolNames,
  type DoctorReportLike,
} from "./tex-setup";
import { TexSetupWizard } from "./tex-setup-wizard";
import * as notify from "../telemetry/app-notify";

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

afterEach(cleanup);

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

  it("offers one managed install action, or later, when only uv is missing", () => {
    const { onClose } = renderWizard(report(...TEX_TOOLS, check("conference-fonts"), check("uv", false), check("uvx", false)));

    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Install paper tools" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Install later" })).toBeEnabled();
    // It names the tool, what needs it, and that writing and compiling do not.
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Adding papers and looking up citations run on uv, a 45 MB Python tool. Writing and compiling work without it.",
    );
    const uvMissing = report(check("uv", false), check("uvx", false));
    expect(isRequiredSetupMissing(uvMissing)).toBe(true);
    expect(missingPaperToolNames(uvMissing)).toEqual(["uv", "uvx"]);
    for (const retired of ["Install MacTeX (full)", "Skip for now", "Recheck", "Close"]) {
      expect(screen.queryByText(retired)).not.toBeInTheDocument();
    }

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Install paper tools" }));
    expect(tauri.invoke).toHaveBeenCalledWith("start_tex_install", { mode: "toolsOnly", onProgress: expect.anything() });
  });

  it("renders backend installation progress and closes only after verification", async () => {
    let finishInstall!: () => void;
    tauri.invoke.mockReturnValue(new Promise<void>((resolve) => {
      finishInstall = resolve;
    }));
    const { onClose, onRecheck } = renderWizard(report(check("latexmk", false)), vi.fn(async () => report(...READY)));

    fireEvent.click(screen.getByRole("button", { name: "Install Basic TeX (1 GB)" }));
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

  it("finishes an install whose package update failed with a warning, not a failure", async () => {
    const warnings = vi.spyOn(notify, "notifyWarning");
    tauri.invoke.mockResolvedValue(
      "BasicTeX is installed, but its LaTeX packages could not be updated. Update them later from Settings → TeX doctor.\n"
      + "Updating the installed LaTeX packages failed.\ntlmgr: could not get texlive.tlpdb",
    );
    const { onClose } = renderWizard(report(check("latexmk", false)), vi.fn(async () => report(...READY)));

    fireEvent.click(screen.getByRole("button", { name: "Install Basic TeX (1 GB)" }));

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(warnings).toHaveBeenCalledWith(
      "LaTeX setup",
      "BasicTeX is installed, but its LaTeX packages could not be updated. Update them later from Settings → TeX doctor.",
      { detail: "Updating the installed LaTeX packages failed.\ntlmgr: could not get texlive.tlpdb" },
    );
    warnings.mockRestore();
  });

  it("shows the concrete doctor failure and keeps install available", async () => {
    tauri.invoke.mockResolvedValue(undefined);
    renderWizard(report(check("latexmk", false)), vi.fn(async () => report(
      check("latexmk", false, "Permission denied"),
      check("conference-fonts", false, "Missing uhvr8a.pfb — Permission denied"),
    )));

    fireEvent.click(screen.getByRole("button", { name: "Install Basic TeX (1 GB)" }));

    expect(await screen.findByText(/Missing tools: latexmk/)).toBeInTheDocument();
    expect(screen.getByText(/Missing uhvr8a\.pfb — Permission denied/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install Basic TeX (1 GB)" })).toBeEnabled();
  });
});


describe("on Windows", () => {
  const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
  const CANCELLED = "The TeX installation was cancelled.";
  let userAgent: MockInstance | undefined;
  beforeEach(() => {
    userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(WINDOWS);
    tauri.invoke.mockReset();
  });
  afterEach(() => userAgent?.mockRestore());

  it("installs TeX Live from the dialog, with no BasicTeX wording", async () => {
    tauri.invoke.mockResolvedValue(null);
    const { onClose } = renderWizard(report(check("latexmk", false)), vi.fn(async () => report(...READY)));
    expect(screen.queryByRole("button", { name: /Basic TeX/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Install TeX Live (1 GB)" }));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(tauri.invoke).toHaveBeenCalledWith("start_tex_install", expect.objectContaining({ mode: "full" }));
  });

  it("offers Cancel only while installing, and a cancelled install shows no error", async () => {
    // This project's TS lib has no Promise.withResolvers, so keep the reject by hand.
    let reject: (reason: unknown) => void = () => {};
    const install = new Promise<unknown>((_, fail) => { reject = fail; });
    tauri.invoke.mockImplementation((command: string) => command === "start_tex_install"
      ? install
      : Promise.resolve(true));
    renderWizard(report(check("latexmk", false)));
    expect(screen.queryByRole("button", { name: "Cancel installation" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Install TeX Live (1 GB)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel installation" }));
    expect(tauri.invoke).toHaveBeenCalledWith("cancel_tex_install");
    await act(async () => { reject(CANCELLED); });
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Cancel installation" })).not.toBeInTheDocument());
    expect(screen.queryByText(CANCELLED)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install TeX Live (1 GB)" })).toBeEnabled();
  });

  it("shows another failure's message and keeps install available", async () => {
    tauri.invoke.mockRejectedValue("TeX Live installation failed. Please try again.");
    renderWizard(report(check("latexmk", false)));
    fireEvent.click(screen.getByRole("button", { name: "Install TeX Live (1 GB)" }));
    expect(await screen.findByText(/TeX Live installation failed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install TeX Live (1 GB)" })).toBeEnabled();
  });
});
