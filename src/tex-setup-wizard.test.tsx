import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isConferenceFontsMissing,
  isMissingTexBuildError,
  isTexToolchainMissing,
  missingTexToolNames,
} from "./tex-setup";
import { TexSetupWizard } from "./tex-setup-wizard";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  channel: null as { onmessage: ((message: unknown) => void) | null } | null,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
  Channel: class {
    onmessage: ((message: unknown) => void) | null = null;

    constructor() {
      tauri.channel = this;
    }
  },
}));

describe("tex setup wizard helpers", () => {
  beforeEach(() => {
    localStorage.clear();
    tauri.invoke.mockReset();
    tauri.channel = null;
  });

  it("detects a missing TeX toolchain from doctor checks", () => {
    expect(isTexToolchainMissing({
      ok: false,
      summary: "missing",
      checks: [
        { name: "latexmk", detail: "missing", ok: false },
        { name: "pdflatex", detail: "missing", ok: false },
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

  it("offers only the mandatory BasicTeX install action", () => {
    const onClose = vi.fn();
    render(
      <TexSetupWizard
        open
        report={{
          ok: false,
          summary: "missing",
          checks: [
            { name: "latexmk", detail: "missing", ok: false },
            { name: "pdflatex", detail: "missing", ok: false },
          ],
        }}
        checking={false}
        onClose={onClose}
        onRecheck={vi.fn(async () => null)}
      />,
    );

    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Install Basic TeX" })).toBeEnabled();
    expect(screen.getByText(/about 1 GB after installation and can take up to 15 minutes/))
      .toBeInTheDocument();
    expect(screen.queryByText("Install MacTeX (full)")).not.toBeInTheDocument();
    expect(screen.queryByText("Skip for now")).not.toBeInTheDocument();
    expect(screen.queryByText("Recheck")).not.toBeInTheDocument();
    expect(screen.queryByText("Close")).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders backend installation progress and closes only after verification", async () => {
    let finishInstall!: () => void;
    tauri.invoke.mockReturnValue(new Promise<void>((resolve) => {
      finishInstall = resolve;
    }));
    const onClose = vi.fn();
    const onRecheck = vi.fn(async () => ({
      ok: true,
      summary: "ready",
      checks: [
        { name: "latexmk", detail: "ok", ok: true },
        { name: "pdflatex", detail: "ok", ok: true },
        { name: "synctex", detail: "ok", ok: true },
        { name: "bibtex", detail: "ok", ok: true },
        { name: "conference-fonts", detail: "ok", ok: true },
      ],
    }));
    render(
      <TexSetupWizard
        open
        report={{
          ok: false,
          summary: "missing",
          checks: [{ name: "latexmk", detail: "missing", ok: false }],
        }}
        checking={false}
        onClose={onClose}
        onRecheck={onRecheck}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Install Basic TeX" }));
    expect(tauri.invoke).toHaveBeenCalledWith("start_tex_install", {
      onProgress: expect.anything(),
    });
    expect(document.querySelector(".tex-setup-install-loader")).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      tauri.channel?.onmessage?.({ stage: "downloading", progress: 0.37 });
    });
    expect(screen.getByRole("progressbar", { name: "BasicTeX installation progress" }))
      .toHaveAttribute("aria-valuenow", "37");
    expect(document.querySelector(".tex-setup-progress-fill")).toHaveStyle({ width: "37%" });

    act(() => {
      tauri.channel?.onmessage?.({ stage: "installing-packages", progress: 0.82 });
    });
    expect(screen.getByText("This is the longest step and can take up to 15 minutes."))
      .toBeInTheDocument();

    await act(async () => finishInstall());
    expect(onRecheck).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows the concrete doctor failure and keeps install available", async () => {
    tauri.invoke.mockResolvedValue(undefined);
    render(
      <TexSetupWizard
        open
        report={{
          ok: false,
          summary: "missing",
          checks: [{ name: "latexmk", detail: "missing", ok: false }],
        }}
        checking={false}
        onClose={vi.fn()}
        onRecheck={vi.fn(async () => ({
          ok: false,
          summary: "permissions",
          checks: [
            { name: "latexmk", detail: "Permission denied", ok: false },
            { name: "conference-fonts", detail: "Missing uhvr8a.pfb — Permission denied", ok: false },
          ],
        }))}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Install Basic TeX" }));

    expect(await screen.findByText(/Missing tools: latexmk/)).toBeInTheDocument();
    expect(screen.getByText(/Missing uhvr8a\.pfb — Permission denied/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install Basic TeX" })).toBeEnabled();
  });
});
