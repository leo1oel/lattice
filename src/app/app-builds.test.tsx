import { interfaceSounds, tauriCoreApi, projectCommands, ROOT, projectSnapshot, failedBuild, deferred, setInterfaceLanguage, buildButton, expectInvoked, invokeCalls, visibleToasts } from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { projectPdfPanel } from "./app-test-pdf-panel";
import { invoke } from "@tauri-apps/api/core";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { formatAppLogs } from "../telemetry/app-log-store";

const { renderApp, openWithAutomaticBuilds } = appHarness({ projectPdfPanel });

describe("builds and the PDF reader", () => {

  it("automatically rebuilds after the active source changes on disk", async () => {
    let source = "\\documentclass{article}";
    let mtimeMs = 1;
    await openWithAutomaticBuilds({ read_project_file: () => source, stat_project_file: () => ({ exists: true, mtimeMs }) });
    source = "\\documentclass{article}\nExternal edit.";
    mtimeMs = 2;
    await waitFor(() => expect(invoke)
      .toHaveBeenCalledWith("build_project", expect.objectContaining({ force: false, projectRoot: ROOT })), { timeout: 3_500 });
    expect(interfaceSounds.play).not.toHaveBeenCalled();
  });

  it("shows failed build guidance once and acknowledges a manual retry", async () => {
    renderApp({
      ...projectCommands(),
      build_project: failedBuild(
        "Missing style file `iclr2026_conference.sty`. It is part of the ICLR template and belongs next to main.tex — "
          + "TeX Live cannot install it. Sync or copy it back from another copy of the project.",
        "LaTeX Error: File `iclr2026_conference.sty' not found.\n",
      ),
    });
    await waitFor(() => {
      expect(visibleToasts("Build")).toHaveLength(0);
      expect(formatAppLogs()).toContain("[ERROR] [Build] Build failed");
    });
    const diagnostics = await screen.findByLabelText("Compile diagnostics", {}, { timeout: 40_000 });
    expect(within(diagnostics).getByText("Build failed · 1 error")).toBeInTheDocument();
    expect(within(diagnostics).getByText(/Sync or copy it back from another copy/)).toBeInTheDocument();
    fireEvent.click(within(diagnostics).getByRole("button", { name: "Dismiss diagnostics" }));
    expect(screen.queryByLabelText("Compile diagnostics")).not.toBeInTheDocument();
    const buildsBeforeManualRequest = invokeCalls("build_project").length;
    fireEvent.click(buildButton());
    await waitFor(() => expect(invokeCalls("build_project")).toHaveLength(buildsBeforeManualRequest + 1));
    await waitFor(() => expect(visibleToasts("Build")).toHaveLength(0));
    expect(await screen.findByLabelText("Compile diagnostics")).toBeInTheDocument();
    expect(formatAppLogs()).toContain("[ERROR] [Build] Build failed");
  }, 40_000);

  it("installs a missing LaTeX package in-app and rebuilds", async () => {
    await setInterfaceLanguage("zh-CN");
    const install = deferred();
    renderApp({
      ...projectCommands(), start_tex_dependency_install: () => install.promise,
      build_project: failedBuild(
        "Missing LaTeX dependency `newtxmath.sty`. BasicTeX does not include every package available on Overleaf.",
        "LaTeX Error: File `newtxmath.sty' not found.\n",
      ),
    });
    const diagnostics = await screen.findByLabelText("编译问题");
    fireEvent.click(within(diagnostics).getByRole("button", { name: "安装" }));
    await expectInvoked("start_tex_dependency_install",
      expect.objectContaining({ missingFile: "newtxmath.sty", onProgress: expect.anything() }));
    expect(screen.getByRole("dialog", { name: "安装组件" })).toBeInTheDocument();
    act(() => {
      tauriCoreApi.channel?.onmessage?.({ stage: "installing-dependency", progress: 0.64 });
    });
    expect(screen.getByRole("progressbar", { name: "LaTeX 软件包安装进度" })).toHaveAttribute("aria-valuenow", "64");
    const buildCallsBeforeInstall = invokeCalls("build_project").length;
    await act(async () => install.resolve());
    await waitFor(() => expect(invokeCalls("build_project").length).toBeGreaterThan(buildCallsBeforeInstall));
    expect(screen.queryByRole("dialog", { name: "安装组件" })).not.toBeInTheDocument();
    expect(formatAppLogs()).toContain("[SUCCESS] [LaTeX 设置] LaTeX 组件已安装");
  });

  it("does not open TeX setup when latexmk reports a missing project style", async () => {
    renderApp({
      ...projectCommands(projectSnapshot({ name: "CVPR paper" }), "\\usepackage[review]{cvpr}"),
      build_project: failedBuild(
        "Missing style file `cvpr.sty`. It is part of the CVPR template and belongs next to main.tex — TeX Live cannot install it.",
        "Latexmk: Missing input file 'cvpr.sty' message in .log file:\nLaTeX Error: File `cvpr.sty' not found.\n",
      ),
    });
    await waitFor(() => expect(formatAppLogs()).toContain("Missing style file `cvpr.sty`"));
    expect(screen.queryByRole("dialog", { name: "Install LaTeX tools" })).not.toBeInTheDocument();
  });
});
