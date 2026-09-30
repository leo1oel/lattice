import { windowApi, synaraHook, interfaceSounds, projectCommands, overleafSyncResult, ROOT, projectSnapshot, buildResult, deferred, chooseOption, buildButton, renderApp, renderOverleafPaper, openSettings, findElement, findFrame, postWindowMessage, expectInvoked, invokeCalls, nextFrames, findOverleafSyncButton, stubObjectUrls, chooseProjectMenuItem } from "./app-test-utils";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { getDocument } from "pdfjs-dist";
import { describe, expect, it, vi } from "vitest";
import { referenceAssetPreviewDataUrl } from "../project/reference-preview";

describe("welcome screen", () => {
  it("renders the first page of a PDF figure for reference hover previews", async () => {
    const render = vi.fn(() => ({ promise: Promise.resolve() }));
    const destroy = vi.fn(() => Promise.resolve());
    const getViewport = vi.fn(({ scale }: { scale: number }) => ({ width: 500 * scale, height: 300 * scale }));
    vi.mocked(getDocument).mockReturnValue({
      promise: Promise.resolve({ getPage: vi.fn(() => Promise.resolve({ getViewport, render })) }), destroy,
    } as never);
    const image = "data:image/png;base64,preview";
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(image);
    await expect(referenceAssetPreviewDataUrl({
      path: "figures/result.pdf", mimeType: "application/pdf", base64: "JVBERi0xLjQ=",
    })).resolves.toBe(image);
    expect(vi.mocked(getDocument)).toHaveBeenCalledWith(expect.objectContaining({ disableFontFace: true, useSystemFonts: false }));
    expect(render).toHaveBeenCalledWith(expect.objectContaining({ background: "#F9F9FA" }));
    expect(destroy).toHaveBeenCalled();
  });

  it("offers project creation and existing folder import", () => {
    renderApp();
    expect(screen.getByRole("heading", { name: "Research, written with evidence" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new project/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open folder/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Guided tutorial" })).toBeInTheDocument();
  });

  it.each([
    ["from the welcome screen", true], ["directly on a genuinely empty first launch", false],
  ])("starts the guided tutorial %s", async (_when, tutorialSeen) => {
    if (!tutorialSeen) localStorage.removeItem("lattice.tutorial-seen.v1");
    renderApp({
      initial_project: null,
      open_tutorial_project: () => { throw new Error("Tutorial fixture stopped after invocation."); },
    });
    if (tutorialSeen) fireEvent.click(screen.getByRole("button", { name: "Guided tutorial" }));
    await expectInvoked("open_tutorial_project");
    expect(open).not.toHaveBeenCalled();
  });

  it("opens the project creation dialog", () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: /new project/i }));
    expect(screen.getByRole("heading", { name: "Create a research project" })).toBeInTheDocument();
    expect(screen.getByLabelText("Project name")).toHaveValue("Untitled research");
    expect(screen.getByRole("combobox", { name: "Venue template" })).toHaveTextContent("NeurIPS");
    expect(screen.getByText("Verified against the official 2026 style; creates a preprint draft")).toBeInTheDocument();
  });

  it("keeps duplicate project errors inside the creation dialog", async () => {
    vi.mocked(open).mockResolvedValue("/tmp/research");
    renderApp({
      initial_project: null, create_project: () => { throw new Error("That folder already exists and is not empty."); },
    });
    fireEvent.click(screen.getByRole("button", { name: /new project/i }));
    fireEvent.click(screen.getByRole("button", { name: "Choose location" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That folder already exists and is not empty.");
    expect(screen.getByRole("heading", { name: "Create a research project" })).toBeInTheDocument();
  });

  it("keeps an explicitly opened project instead of replacing it with the tutorial", async () => {
    localStorage.removeItem("lattice.tutorial-seen.v1");
    const snapshot = projectSnapshot({ root: "/tmp/research/First paper", projectId: "first-paper-id", name: "First paper" });
    renderApp({
      ...projectCommands(snapshot),
      open_tutorial_project: () => { throw new Error("Tutorial fixture stopped after invocation."); },
    });
    await expectInvoked("read_project_file", { path: "main.tex", projectRoot: snapshot.root });
    expect(invoke).not.toHaveBeenCalledWith("open_tutorial_project");
    expect(open).not.toHaveBeenCalled();
  });

  it("starts the first build as soon as a new project opens", async () => {
    const snapshot = projectSnapshot({ root: "/tmp/research/New paper", projectId: "new-paper-id", name: "New paper" });
    vi.mocked(open).mockResolvedValue("/tmp/research");
    renderApp({
      ...projectCommands(null), create_project: snapshot, build_project: buildResult(),
      // Creation no longer binds a window; the caller places the project.
      open_project: snapshot,
    });
    fireEvent.click(screen.getByRole("button", { name: /new project/i }));
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "New paper" } });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Venue template" }), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("option", { name: "ICML" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose location" }));
    await expectInvoked("create_project", { parent: "/tmp/research", name: "New paper", venue: "icml" });
    await expectInvoked("build_project", expect.objectContaining({ force: false, projectRoot: "/tmp/research/New paper" }));
    expect(await screen.findByRole("button", { name: "Switch project" })).toHaveTextContent("New paper");
    expect(await screen.findByLabelText("Editor status", {}, { timeout: 20_000 })).toBeInTheDocument();
  }, 30_000);

  it("preserves a forced build queued behind an ordinary build", async () => {
    const success = buildResult({ durationMs: 1 })();
    const ordinaryBuild = deferred<typeof success>();
    let buildCalls = 0;
    renderApp({ ...projectCommands(), build_project: () => (++buildCalls === 1 ? ordinaryBuild.promise : success) });
    await waitFor(() => expect(buildButton()).toHaveAttribute("aria-busy", "true"));
    await waitFor(() => expect(buildCalls).toBe(1));
    fireEvent.keyDown(window, { key: "p", ctrlKey: true, shiftKey: true });
    fireEvent.click(await screen.findByRole("option", { name: /Clean rebuild/i }));
    expect(buildCalls).toBe(1);
    ordinaryBuild.resolve(success);
    await waitFor(() => expect(invokeCalls("build_project")).toHaveLength(2));
    expect(invokeCalls("build_project")[1]?.[1]).toEqual(expect.objectContaining({ force: true }));
    // The queued build can finish before the lazy editor imports do. Let the
    // real canvas mount before teardown so those imports keep a live test host.
    expect(await screen.findByLabelText("Editor status", {}, { timeout: 20_000 })).toBeInTheDocument();
  });

  it("shows an existing compiled PDF without waiting for the initial build", async () => {
    const TestURL = stubObjectUrls(() => "blob:cached-pdf");
    renderApp({
      ...projectCommands(), build_project: new Promise<never>(() => undefined),
      read_compiled_pdf: () => new TextEncoder().encode("%PDF-1.4 cached").buffer,
    });
    await expectInvoked("read_compiled_pdf", { projectRoot: ROOT });
    expect(TestURL.createObjectURL).toHaveBeenCalledOnce();
  });

  it("uses fixed application fonts while preserving editor size controls", async () => {
    localStorage.setItem("lattice.appearance.v4", JSON.stringify({
      uiFont: "-apple-system, BlinkMacSystemFont, sans-serif", interfaceScale: 1.1,
      editorFont: "Menlo, ui-monospace, monospace", editorFontSize: 14,
    }));
    renderApp();
    expect(screen.queryByTitle("Toggle theme")).not.toBeInTheDocument();
    await openSettings();
    const settingsNavigation = await screen.findByRole("navigation", { name: "Settings sections" }, { timeout: 5000 });
    const section = (name: string) => within(settingsNavigation).getByRole("button", { name });
    expect(section("Appearance")).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/latex editor font/i)).not.toBeInTheDocument();
    await chooseOption("Color theme", "Dark");
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(localStorage.getItem("lattice.theme-preference.v1")).toBe("dark");
    expect(screen.queryByLabelText("Interface font")).not.toBeInTheDocument();
    const rootStyle = (name: string) => document.documentElement.style.getPropertyValue(name);
    await waitFor(() => {
      expect(rootStyle("--ui-font")).toBe('"Inter Variable", Inter, "Avenir Next", "Segoe UI", sans-serif');
      expect(rootStyle("--editor-font")).toBe('"Ioskeley Mono", Menlo, "SF Mono", ui-monospace, monospace');
    });
    expect(screen.getByRole("slider", { name: /editor font size/i })).toHaveValue("14");
    fireEvent.click(screen.getByRole("button", { name: "Editor & builds" }));
    expect(section("Appearance")).not.toHaveAttribute("aria-current");
    expect(section("Editor & builds")).toHaveAttribute("aria-current", "page");
    expect(screen.getByLabelText("Automatic build")).toHaveTextContent("Automatic");
    expect(screen.getByText(/leave the editor or stop typing for 1.2 seconds/i)).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem("lattice.build-preferences.v2")).toContain("automatic"));
    expect(synaraHook.enabledCalls).not.toContain(true);
    fireEvent.click(screen.getByRole("button", { name: "Providers" }));
    await waitFor(() => expect(synaraHook.enabledCalls).toContain(true));
    expect(screen.getByText("Open a project to manage Agent settings")).toBeInTheDocument();
    expect(screen.queryByLabelText("Agent system prompt")).not.toBeInTheDocument();
  });

  it("does not load provider settings when opening a non-Agent settings page", async () => {
    renderApp({ ...projectCommands(), build_project: buildResult() });
    await chooseProjectMenuItem("Settings");
    expect(await screen.findByRole("heading", { name: "Appearance" }, { timeout: 60_000 })).toBeInTheDocument();
    const providersFrame = 'iframe[title="Synara Providers settings"]';
    expect(document.querySelector(providersFrame)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Providers" }));
    await waitFor(() => expect(document.querySelector(providersFrame)).not.toBeNull());
  }, 60_000);

  it("keeps successful TeX checks compact while retaining failure details", async () => {
    renderApp({ initial_project: null, run_doctor: { ok: true, summary: "ready", checks: [
      { name: "latexmk", detail: "LaTeX build driver: /Library/TeX/texbin/latexmk", ok: true },
      { name: "texlab", detail: "TexLab language server: not found on PATH", ok: false },
    ] } });
    await openSettings("TeX doctor");
    fireEvent.click(screen.getByRole("button", { name: "Run TeX doctor" }));
    const checklist = await findElement(".doctor-checklist");
    const latexmk = within(checklist).getByText("latexmk").closest("li");
    const texlab = within(checklist).getByText("texlab").closest("li");
    expect(latexmk).toHaveClass("ok");
    expect(latexmk).not.toHaveTextContent("LaTeX build driver");
    expect(texlab).toHaveClass("bad");
    expect(texlab).toHaveTextContent("not found on PATH");
  });

  it("uses the doctor button for progress and hides setup actions when tools are ready", async () => {
    const readyReport = { ok: true, summary: "ready", checks: ["latexmk", "pdflatex", "synctex", "bibtex", "conference-fonts", "uv", "uvx"]
      .map((name) => ({ name, detail: "ok", ok: true })) };
    const doctor = deferred<typeof readyReport>();
    renderApp({ initial_project: null, run_doctor: () => doctor.promise });
    await openSettings("TeX doctor");
    const runButton = screen.getByRole("button", { name: "Run TeX doctor" });
    await waitFor(() => expect(runButton).toBeDisabled());
    expect(screen.queryByText("Checking local tools…")).not.toBeInTheDocument();
    await act(async () => doctor.resolve(readyReport));
    await waitFor(() => expect(document.querySelector(".doctor-status")).toHaveTextContent("Ready to compile"));
    expect(screen.queryByRole("button", { name: "Install required tools" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy summary" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Install LaTeX tools" })).not.toBeInTheDocument();
  });

  it("resets the settings page scroll position when leaving Logs", async () => {
    renderApp();
    await openSettings("Logs");
    const settingsViewport = await findElement(".settings-content [data-slot='scroll-area-viewport']");
    settingsViewport.scrollTop = 400;
    fireEvent.click(screen.getByRole("button", { name: "Editor & builds" }));
    await waitFor(() => expect(settingsViewport).toHaveProperty("scrollTop", 0));
  });

  it("keeps an expanded Synara settings panel reachable from the old bottom", async () => {
    renderApp(projectCommands());
    await chooseProjectMenuItem("Settings");
    fireEvent.click(await screen.findByRole("button", { name: "Providers" }, { timeout: 10_000 }));
    const frame = await findFrame("Synara Providers settings");
    const settingsViewport = document.querySelector<HTMLDivElement>(".settings-content [data-slot='scroll-area-viewport']")!;
    Object.defineProperties(settingsViewport, {
      clientHeight: { configurable: true, value: 470 },
      scrollHeight: { configurable: true, get: () => Number.parseInt(frame.style.height, 10) + 730 },
    });
    await act(() => nextFrames(2));

    const providersHeight = (height: number) => postWindowMessage(frame.contentWindow, {
      type: "synara:settings-content-height", height, section: "providers",
    });
    settingsViewport.scrollTop = 500;
    providersHeight(1_200);
    await waitFor(() => expect(frame.style.height).toBe("1200px"));
    await act(() => nextFrames(2));
    expect(settingsViewport.scrollTop).toBe(500);

    settingsViewport.scrollTop = 1_445;
    providersHeight(1_400);
    await waitFor(() => expect(settingsViewport.scrollTop).toBe(2_130));

    // Skills replaces a list with a detail page, unlike the disclosure above. The iframe does not own the scroll in
    // embed mode: navigation must reset this host viewport, including when detail content arrives asynchronously.
    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    const skillsFrame = await findFrame("Synara Skills settings");
    let scrollTop = 0;
    Object.defineProperties(settingsViewport, {
      scrollHeight: { configurable: true, get: () => Number.parseInt(skillsFrame.style.height, 10) },
      scrollTop: {
        configurable: true, get: () => scrollTop,
        set: (value: number) => { scrollTop = Math.max(0, Math.min(value, settingsViewport.scrollHeight - 470)); },
      },
    });
    const message = (data: object) => postWindowMessage(skillsFrame.contentWindow, { section: "skills", ...data });
    const settle = () => act(() => nextFrames(2));
    const skillsHeight = (height: number) => message({ type: "synara:settings-content-height", height });
    skillsHeight(2_400);
    await settle();
    settingsViewport.scrollTop = 615;
    message({ type: "synara:settings-navigation", view: "detail" });
    skillsHeight(470);
    await settle();
    skillsHeight(1_600);
    await settle();
    expect(settingsViewport.scrollTop).toBe(0);
    skillsHeight(470);
    message({ type: "synara:settings-navigation", view: "list" });
    await settle();
    skillsHeight(2_400);
    await settle();
    expect(settingsViewport.scrollTop).toBe(615);
  });

  it("switches the app chrome and settings to Simplified Chinese and persists the choice", async () => {
    renderApp();
    await openSettings();
    expect(screen.getByLabelText("Interface language")).toHaveTextContent("Follow system (default)");
    await chooseOption("Interface language", "Simplified Chinese");
    await waitFor(() => expect(document.documentElement.lang).toBe("zh-CN"));
    expect(await screen.findByRole("dialog", { name: "设置" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "设置分区" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "外观" })).toBeInTheDocument();
    expect(screen.getByText("选择菜单、设置和帮助文字所使用的语言")).toBeInTheDocument();
    expect(localStorage.getItem("lattice.appearance.v5")).toContain('"interfaceLanguage":"zh-CN"');
    fireEvent.click(screen.getByRole("button", { name: "关闭设置" }));
    expect(await screen.findByRole("heading", { name: "让研究写作有据可循" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建项目" })).toBeInTheDocument();
  });

  it("keeps Settings draggable from its header and the top window strip", async () => {
    renderApp();
    await openSettings();
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    const header = dialog.querySelector<HTMLElement>(".settings-header")!;
    fireEvent.mouseDown(header, { button: 0, buttons: 1, detail: 1 });
    await waitFor(() => expect(windowApi.startDragging).toHaveBeenCalledOnce());
    windowApi.startDragging.mockClear();
    const topStrip = document.querySelector<HTMLElement>("[data-modal-window-drag]")!;
    fireEvent.pointerDown(topStrip, { button: 0, buttons: 1, pointerType: "mouse" });
    fireEvent.mouseDown(topStrip, { button: 0, buttons: 1, detail: 1 });
    fireEvent.pointerUp(topStrip, { button: 0, buttons: 0, pointerType: "mouse" });
    fireEvent.mouseUp(topStrip, { button: 0, buttons: 0, detail: 1 });
    fireEvent.click(topStrip, { button: 0, detail: 1 });
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    await waitFor(() => expect(windowApi.startDragging).toHaveBeenCalledOnce());
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });

  it.each([
    ["persists the editor spellcheck setting when it is turned off", "Editor & builds", "Check spelling in prose", "editorSpellcheck"],
    ["lets the user mute the small set of interface sounds", undefined, "Interface sounds", "interfaceSounds"],
  ])("%s", async (_name, section, label, setting) => {
    renderApp();
    await openSettings(section);
    const toggle = await screen.findByLabelText(label);
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(localStorage.getItem("lattice.appearance.v5")).toContain(`"${setting}":false`));
    if (setting === "interfaceSounds") expect(interfaceSounds.configure).toHaveBeenLastCalledWith(false);
  });

  it("shows the Git name that signs comments and keeps Your name as the fallback", async () => {
    renderApp({ ...projectCommands(projectSnapshot({ files: [] })), git_user_name: "Ada Lovelace" });
    await expectInvoked("git_user_name");
    await chooseProjectMenuItem("Settings");
    fireEvent.click(await screen.findByRole("button", { name: "Editor & builds" }));
    expect(await screen.findByText(/Your comments are signed as Ada Lovelace/)).toBeInTheDocument();
    const field = screen.getByLabelText("Your name");
    expect(field).toHaveAttribute("placeholder", "Ada Lovelace");
    fireEvent.change(field, { target: { value: "Grace Hopper" } });
    expect(localStorage.getItem("lattice.author-name.v1")).toBe("Grace Hopper");
  });

  it("keeps automatic commits signed as Lattice whatever name signs comments", async () => {
    localStorage.setItem("lattice.author-name.v1", "Grace Hopper");
    renderOverleafPaper({
      git_user_name: "Ada Lovelace",
      overleaf_sync: () => overleafSyncResult({ pushed: ["main.tex"] }),
    }, { syncMode: "live" });
    await expectInvoked("git_user_name");
    await expectInvoked("overleaf_rt_connect", { projectRoot: "/tmp/lattice-overleaf-paper" });
    fireEvent.click(await findOverleafSyncButton());
    await expectInvoked("git_auto_commit", expect.objectContaining({ author: null }));
    expect(invokeCalls("git_auto_commit").every(([, args]) => (args as { author: unknown }).author === null)).toBe(true);
  });

  it("opens every Settings dropdown with the Settings popover contract", async () => {
    renderApp({ initial_project: null });
    for (const section of ["Appearance", "Editor & builds"]) {
      await openSettings(section);
      const content = await screen.findByRole("heading", { name: section });
      const triggers = content.closest(".settings-section")!.querySelectorAll('[data-slot="select-trigger"]');
      expect(triggers.length).toBeGreaterThan(0);
      for (const trigger of triggers) {
        fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
        const listbox = await screen.findByRole("listbox");
        expect(listbox.closest('[data-slot="select-content"]')).toHaveAttribute("data-settings-control", "true");
        fireEvent.keyDown(listbox, { key: "Escape" });
        await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
      }
      fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument());
    }
  });

  it.each([
    ["keeps an explicitly selected manual build preference", "lattice.build-preferences.v2", "Manual only"],
    ["migrates the legacy manual default to automatic build", "lattice.build-preferences.v1", "Automatic"],
  ])("%s", async (_name, key, label) => {
    localStorage.setItem(key, JSON.stringify({ autoBuildMode: "manual" }));
    renderApp();
    await openSettings("Editor & builds");
    expect(screen.getByLabelText("Automatic build")).toHaveTextContent(label);
  });
});
