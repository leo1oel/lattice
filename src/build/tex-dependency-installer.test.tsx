import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateAppLocale } from "../i18n";
import { TexDependencyInstaller, type TexDependencyInstallStatus } from "./tex-dependency-installer";

function renderInstaller(status: Omit<TexDependencyInstallStatus, "missingFile">) {
  const onClose = vi.fn();
  const onRetry = vi.fn();
  render(<TexDependencyInstaller status={{ missingFile: "newtxmath.sty", ...status }} onClose={onClose} onRetry={onRetry} />);
  return { onClose, onRetry };
}

describe("TexDependencyInstaller", () => {
  afterEach(async () => {
    cleanup();
    await activateAppLocale("en");
  });

  it("shows native package installation progress without a Terminal handoff", () => {
    renderInstaller({ progress: { stage: "installing-dependency", progress: 0.64 }, installing: true, error: null });

    expect(screen.getByText(/newtxmath\.sty/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "LaTeX package installation progress" }))
      .toHaveAttribute("aria-valuenow", "64");
    expect(document.querySelector(".tex-setup-progress-fill")).toHaveStyle({ width: "64%" });
    expect(screen.queryByText(/Terminal/)).not.toBeInTheDocument();
  });

  it("allows a failed installation to be retried or closed", () => {
    const { onClose, onRetry } = renderInstaller({
      progress: { stage: "searching-packages", progress: 0.02 },
      installing: false,
      error: "The TeX Live repository could not be searched.",
    });

    expect(screen.getByRole("alert")).toHaveTextContent("repository could not be searched");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledWith("newtxmath.sty");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("asks which package to install when several provide the file", async () => {
    const { onClose, onRetry } = renderInstaller({
      progress: { stage: "searching-packages", progress: 0.02 },
      installing: false,
      error: null,
      packages: ["arabtex", "ledmac"],
    });
    expect(screen.getByText("Several TeX Live packages provide newtxmath.sty. Choose the one to install.")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "ledmac" }));
    expect(onRetry).toHaveBeenCalledWith("newtxmath.sty", "ledmac");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();

    cleanup();
    await activateAppLocale("zh-CN");
    renderInstaller({ progress: { stage: "searching-packages", progress: 0.02 }, installing: false, error: null, packages: ["arabtex", "ledmac"] });
    expect(screen.getByText("TeX Live 中有多个组件提供 newtxmath.sty，请选择要安装的组件")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();
  });

  // A conference template's own .sty is the commonest failure; the third
  // audit found its summary still English in a Chinese interface.
  it("shows a failure the host wrote in the interface language", async () => {
    await activateAppLocale("zh-CN");
    renderInstaller({
      progress: { stage: "searching-packages", progress: 0.02 },
      installing: false,
      error: "No TeX Live package provides neurips_2026.sty. It may be a custom project or conference-template file; sync or copy it from Overleaf into the project folder.",
    });
    expect(screen.getByRole("alert")).toHaveTextContent("TeX Live 中没有提供 neurips_2026.sty 的组件");
  });

  it("splits a translated failure from the tool output after it", async () => {
    await activateAppLocale("zh-CN");
    renderInstaller({
      progress: { stage: "verifying-dependency", progress: 0.9 },
      installing: false,
      error: "The package installation finished, but newtxmath.sty is still unavailable.\nkpsewhich: exit status 1",
    });
    expect(screen.getByRole("alert")).toHaveTextContent("组件已安装完成，但仍找不到 newtxmath.sty");
    expect(screen.getByRole("alert")).not.toHaveTextContent("kpsewhich");
    expect(document.querySelector(".tex-setup-error-details pre")).toHaveTextContent("kpsewhich: exit status 1");
  });
});
