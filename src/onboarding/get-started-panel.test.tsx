import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SmallStore } from "../trellis/trellis-small-store";
import type { BuildOutcome } from "../app/use-build-pipeline";
import type { TrellisController, TrellisDocToolsState } from "../trellis/trellis-controller";
import GetStartedPanel, { type GetStartedPanelProps } from "./get-started-panel";
import {
  GET_STARTED_KEY, markGetStartedStep, SAMPLE_MANUSCRIPT, skipGetStartedStep, watchGetStartedBuild,
} from "./get-started-progress";

const running = vi.hoisted(() => ({ agentTurns: 0 }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => (command === "restart_impact" ? { terminalCommands: 0, builds: 0, agentTurns: running.agentTurns } : undefined)),
}));

const TEX = ["latexmk", "pdflatex", "synctex", "bibtex", "conference-fonts"];
const doctor = (missing: string[] = []) => ({
  ok: missing.length === 0,
  summary: "",
  checks: [...TEX, "uv", "uvx"].map((name) => ({ name, detail: "", ok: !missing.includes(name) })),
});

// The title src-tauri/templates/tutorial/main.tex ships with.
const SAMPLE_TITLE = "\\title{Understanding Attention: A Worked Guide to Transformer Reasoning}";
const MANUSCRIPT = `\\documentclass{article}\n${SAMPLE_TITLE}\n\\begin{document}\nHello.\n\\end{document}\n`;

/** Only what the checklist reads of the controller. */
function fakeController() {
  const docTools = new SmallStore<Pick<TrellisDocToolsState, "lastBuild">>({ lastBuild: null });
  const texts = new Map([[SAMPLE_MANUSCRIPT, MANUSCRIPT]]);
  const pdf = { id: "pdf", type: "pdf", placement: "docked", visible: true, selected: true, params: {}, panelId: "panel-pdf" };
  const agent = { id: "agent", type: "agent", placement: "docked", visible: true, selected: true, params: {}, panelId: "panel-agent" };
  const manuscript = { id: "file-main", type: "file", placement: "docked", visible: true, selected: true, params: { key: SAMPLE_MANUSCRIPT }, panelId: "panel-main" };
  const controller = {
    docTools,
    texts,
    app: { get: () => ({ activeKey: SAMPLE_MANUSCRIPT }) },
    ws: { view: (kind: string) => ({ pdf, agent } as Record<string, unknown>)[kind], views: () => [manuscript], select: vi.fn() },
    panelRect: vi.fn(() => new DOMRect(600, 40, 400, 700)),
    showPanel: vi.fn(),
    revealTool: vi.fn(),
    subscribeWorkspace: vi.fn(() => () => undefined),
  } as unknown as TrellisController;
  return { controller, docTools, texts, showPanel: controller.showPanel as ReturnType<typeof vi.fn> };
}

function succeeded(finishedAt: number): BuildOutcome {
  return {
    status: "succeeded", seconds: 1.2, counts: { error: 0, warning: 0, info: 0 },
    rootDocument: SAMPLE_MANUSCRIPT, finishedAt, steps: [], pages: 4, synctex: true, issue: null,
  };
}

function renderPanel(
  overrides: Partial<GetStartedPanelProps> = {}, report: ReturnType<typeof doctor> | null = doctor(), fake = fakeController(),
) {
  const texSetup = {
    doctorReport: report,
    doctorBusy: false,
    runDoctor: vi.fn(async () => report),
    openWizard: vi.fn(async () => undefined),
    openForMissingPaperTools: vi.fn(async () => undefined),
  };
  const props: GetStartedPanelProps = {
    controller: fake.controller,
    openFile: vi.fn(),
    texSetup,
    openProviderSettings: vi.fn(),
    newProject: vi.fn(),
    openFolder: vi.fn(),
    openOverleaf: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  const view = render(<GetStartedPanel {...props} />);
  return { ...fake, ...view, props, texSetup };
}

const step = (id: string) => document.querySelector<HTMLElement>(`[data-step="${id}"]`)!;
const stored = () => JSON.parse(localStorage.getItem(GET_STARTED_KEY) ?? "null") as { done: string[]; skipped: string[] } | null;

afterEach(() => {
  cleanup();
  localStorage.clear();
  running.agentTurns = 0;
  vi.mocked(invoke).mockClear();
});

describe("GetStartedPanel", () => {
  it("starts on LaTeX when it is missing, and installs it from the step", async () => {
    const { texSetup } = renderPanel({}, doctor(["pdflatex"]));
    expect(screen.getByText("Your first paper in Lattice")).toBeInTheDocument();
    expect(step("latex")).toHaveAttribute("data-state", "current");
    expect(within(step("latex")).getByText("Not installed")).toBeInTheDocument();
    // One sentence of why, then the action, and nothing to skip: nothing builds without it.
    expect(within(step("latex")).getByText(/BasicTeX is about 1 GB/)).toBeInTheDocument();
    expect(within(step("latex")).queryByRole("button", { name: "Skip" })).not.toBeInTheDocument();
    fireEvent.click(within(step("latex")).getByRole("button", { name: "Install LaTeX" }));
    expect(texSetup.openWizard).toHaveBeenCalledTimes(1);
  });

  it("counts LaTeX found as its first step done, and opens the next one", async () => {
    renderPanel();
    expect(step("latex")).toHaveAttribute("data-state", "done");
    expect(within(step("latex")).getByText("Ready")).toBeInTheDocument();
    expect(step("build")).toHaveAttribute("data-state", "current");
    expect(within(step("build")).getByRole("button", { name: "Show me" })).toBeInTheDocument();
    await waitFor(() => expect(stored()?.done).toEqual(["latex"]));
    expect(screen.getByText("1/6")).toBeInTheDocument();
  });

  it("ticks the build step only once a build of a title the writer changed succeeds", () => {
    const { controller, docTools, texts } = renderPanel();
    const stop = watchGetStartedBuild(controller, () => true);
    // The sample building with its own title proves nothing was tried.
    act(() => docTools.set({ lastBuild: succeeded(1) }));
    expect(step("build")).toHaveAttribute("data-state", "current");

    texts.set(SAMPLE_MANUSCRIPT, MANUSCRIPT.replace(SAMPLE_TITLE, "\\title{My attention paper}"));
    act(() => docTools.set({ lastBuild: { ...succeeded(2), status: "failed", wrotePdf: false } as BuildOutcome }));
    expect(step("build")).toHaveAttribute("data-state", "current");
    act(() => docTools.set({ lastBuild: succeeded(3) }));
    expect(step("build")).toHaveAttribute("data-state", "done");
    expect(step("jump")).toHaveAttribute("data-state", "current");
    expect(stored()?.done).toEqual(["latex", "build"]);
    stop();
  });

  it("ticks the build step for a title edited on an earlier launch, as the sample is kept across launches", () => {
    const { controller, docTools, texts } = renderPanel();
    const stop = watchGetStartedBuild(controller, () => true);
    // Edited on an earlier launch, whose builds all failed without TeX.
    texts.set(SAMPLE_MANUSCRIPT, MANUSCRIPT.replace(SAMPLE_TITLE, "\\title{My attention paper}"));
    act(() => docTools.set({ lastBuild: succeeded(1) }));
    expect(step("build")).toHaveAttribute("data-state", "done");
    stop();
  });

  it("ticks the build step for a build that succeeded while the checklist was closed", () => {
    const fake = fakeController();
    const stop = watchGetStartedBuild(fake.controller, () => true);
    fake.texts.set(SAMPLE_MANUSCRIPT, MANUSCRIPT.replace(SAMPLE_TITLE, "\\title{My attention paper}"));
    fake.docTools.set({ lastBuild: succeeded(1) });
    stop();
    renderPanel({}, doctor(), fake);
    expect(step("build")).toHaveAttribute("data-state", "done");
    expect(step("jump")).toHaveAttribute("data-state", "current");
  });

  it("brings LaTeX back as the current step when the check finds it missing again", () => {
    markGetStartedStep("latex");
    markGetStartedStep("build");
    const { texSetup } = renderPanel({}, doctor(["latexmk"]));
    expect(step("latex")).toHaveAttribute("data-state", "current");
    expect(screen.getByText("1/6")).toBeInTheDocument();
    fireEvent.click(within(step("latex")).getByRole("button", { name: "Install LaTeX" }));
    expect(texSetup.openWizard).toHaveBeenCalledTimes(1);
  });

  it("collapses the current step from its header, and opens it again", () => {
    renderPanel();
    const head = within(step("build")).getByRole("button", { name: /Change the title, then build/ });
    expect(head).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(head);
    expect(head).toHaveAttribute("aria-expanded", "false");
    expect(within(step("build")).queryByRole("button", { name: "Show me" })).not.toBeInTheDocument();
    fireEvent.click(head);
    expect(head).toHaveAttribute("aria-expanded", "true");
  });

  it("shows the Agent panel, where an agent's connection is, from the Agent step", async () => {
    const { props, showPanel } = renderPanel();
    fireEvent.click(within(step("agent")).getByRole("button", { name: /Ask the Agent to revise/ }));
    fireEvent.click(within(step("agent")).getByRole("button", { name: "Show me" }));
    expect(showPanel).toHaveBeenCalledWith("agent", { focus: false });
    expect(await screen.findByText("Check that an agent is connected")).toBeInTheDocument();
    expect(props.openFile).not.toHaveBeenCalled();
    // Done or skipped, nothing else: the panel, not the row, says whether an agent is connected.
    expect(within(step("agent")).getByRole("button", { name: /Ask the Agent to revise/ })).toHaveTextContent(/^\d?Ask the Agent to revise$/);
  });

  it("shows steps marked where they happened, and keeps skipped ones aside", () => {
    // A citation inserted while the checklist was closed still counts.
    markGetStartedStep("cite");
    skipGetStartedStep("build");
    renderPanel();
    expect(step("cite")).toHaveAttribute("data-state", "done");
    expect(step("build")).toHaveAttribute("data-state", "skipped");
    expect(within(step("build")).getByText("Skipped")).toBeInTheDocument();
    expect(step("jump")).toHaveAttribute("data-state", "current");

    fireEvent.click(within(step("jump")).getByRole("button", { name: "Skip" }));
    expect(step("jump")).toHaveAttribute("data-state", "skipped");
    expect(step("agent")).toHaveAttribute("data-state", "current");
    // Another window's progress, stored meanwhile, is kept by the next write.
    localStorage.setItem(GET_STARTED_KEY, JSON.stringify({ done: ["cite", "own"], skipped: ["build", "jump"] }));
    act(() => markGetStartedStep("agent"));
    expect(stored()).toEqual({ done: ["cite", "agent", "own"], skipped: ["build", "jump"] });
  });

  it("rings the place Show me brings up, without dimming, until the next click", async () => {
    const { props, showPanel } = renderPanel();
    fireEvent.click(within(step("build")).getByRole("button", { name: "Skip" }));
    fireEvent.click(within(step("jump")).getByRole("button", { name: "Show me" }));
    expect(showPanel).toHaveBeenCalledWith("pdf", { focus: false });
    const hint = await screen.findByText("Double-click a sentence");
    expect(hint.closest(".get-started-show-me")).toHaveAttribute("aria-hidden", "true");
    expect(document.querySelector(".get-started-ring")).toHaveStyle({ width: "400px", height: "700px" });
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByText("Double-click a sentence")).not.toBeInTheDocument());
    expect(props.openFile).not.toHaveBeenCalled();
  });

  it("opens the manuscript on its title line for the build step", () => {
    const { props } = renderPanel();
    fireEvent.click(within(step("build")).getByRole("button", { name: "Show me" }));
    expect(props.openFile).toHaveBeenCalledWith(SAMPLE_MANUSCRIPT, { line: 2 });
  });

  it("says how to connect Claude Code or Codex, and rechecks by restarting the agent", async () => {
    const { props, showPanel } = renderPanel();
    fireEvent.click(within(step("agent")).getByRole("button", { name: /Ask the Agent to revise/ }));
    const agent = step("agent");
    expect(within(agent).getByText(/choose Annotate, write what should change, then Save and revise now/)).toBeInTheDocument();
    // Folded away, so a writer already connected is not told to install.
    const connect = within(agent).getByText("How to connect Claude Code or Codex").closest("details")!;
    expect(connect.open).toBe(false);
    fireEvent.click(within(agent).getByText("How to connect Claude Code or Codex"));
    expect(connect.open).toBe(true);
    expect(within(agent).getByRole("button", { name: /Claude Code/ })).toBeInTheDocument();
    expect(within(agent).getByRole("button", { name: /Codex/ })).toBeInTheDocument();
    expect(within(agent).getByText(/Set its path in Settings › Providers/)).toBeInTheDocument();
    fireEvent.click(within(agent).getByRole("button", { name: "Provider settings" }));
    expect(props.openProviderSettings).toHaveBeenCalledTimes(1);

    fireEvent.click(within(agent).getByRole("button", { name: "Recheck" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("synara_restart"));
    await waitFor(() => expect(showPanel).toHaveBeenCalledWith("agent", { focus: false }));
  });

  it("never rechecks by a restart while a turn is running in any window", async () => {
    running.agentTurns = 1;
    const { showPanel } = renderPanel();
    fireEvent.click(within(step("agent")).getByRole("button", { name: /Ask the Agent to revise/ }));
    fireEvent.click(within(step("agent")).getByRole("button", { name: "Recheck" }));
    await waitFor(() => expect(within(step("agent")).getByRole("button", { name: "Recheck" })).toBeEnabled());
    expect(invoke).toHaveBeenCalledWith("restart_impact");
    expect(invoke).not.toHaveBeenCalledWith("synara_restart");
    expect(showPanel).not.toHaveBeenCalled();
  });

  it("offers a project of the writer's own as the last step", () => {
    const { props } = renderPanel();
    fireEvent.click(within(step("own")).getByRole("button", { name: /Start your own paper/ }));
    fireEvent.click(within(step("own")).getByRole("button", { name: "New project" }));
    fireEvent.click(within(step("own")).getByRole("button", { name: "Open folder" }));
    fireEvent.click(within(step("own")).getByRole("button", { name: "From Overleaf" }));
    expect(props.newProject).toHaveBeenCalledTimes(1);
    expect(props.openFolder).toHaveBeenCalledTimes(1);
    expect(props.openOverleaf).toHaveBeenCalledTimes(1);
  });

  it("says when every step is done", () => {
    localStorage.setItem(GET_STARTED_KEY, JSON.stringify({ done: ["build", "jump", "cite", "agent", "own"], skipped: [] }));
    renderPanel();
    expect(screen.getByText("You’re ready to write")).toBeInTheDocument();
    expect(screen.getByText("6/6")).toBeInTheDocument();
  });
});
