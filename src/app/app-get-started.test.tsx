import { projectCommands, projectSnapshot, invokeCalls, failedBuild, fileNode } from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { settingsDialog } from "./app-test-settings";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

const { renderApp } = appHarness({ settingsDialog });

const tutorial = projectSnapshot({
  root: "/tmp/Lattice Tutorials/Understanding Attention", name: "Understanding Attention", venue: "tutorial",
  files: [fileNode("main.tex"), fileNode("references.bib")],
});
const noTex = { ok: false, summary: "", checks: ["synctex", "bibtex", "conference-fonts", "uv", "uvx"].map((name) => ({ name, detail: "", ok: true })) };
const progress = () => JSON.parse(localStorage.getItem("lattice.get-started.v1") ?? "null") as { done: string[] } | null;

describe("Get started", () => {
  it("opens beside the sample from the tutorial entry, with no tour over the window", async () => {
    renderApp({ ...projectCommands(null), open_tutorial_project: tutorial });
    fireEvent.click(await screen.findByRole("button", { name: "Guided tutorial" }));
    const panel = await screen.findByRole("complementary", { name: "Get started" });
    expect(within(panel).getByText("Your first paper in Lattice")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /Change the title, then build/ })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // The sample is not the writer's own project: the last step waits.
    expect(progress()?.done ?? []).not.toContain("own");
  });

  it("leaves a missing TeX to its first step: no setup dialog at launch or when the sample's build cannot start", async () => {
    localStorage.removeItem("lattice.tutorial-seen.v1");
    renderApp({
      ...projectCommands(null), open_tutorial_project: tutorial, run_doctor: noTex,
      build_project: failedBuild("Could not start latexmk. Install MacTeX or TeX Live."),
    });
    const panel = await screen.findByRole("complementary", { name: "Get started" });
    await waitFor(() => expect(invokeCalls("build_project")).not.toHaveLength(0));
    const latex = panel.querySelector<HTMLElement>('[data-step="latex"]')!;
    await waitFor(() => expect(latex).toHaveTextContent("Not installed"));
    expect(screen.queryByRole("dialog", { name: "Install LaTeX tools" })).not.toBeInTheDocument();

    // Asked for from the step, setup opens.
    fireEvent.click(within(latex).getByRole("button", { name: "Install LaTeX" }));
    expect(await screen.findByRole("dialog", { name: "Install LaTeX tools" })).toBeInTheDocument();
  });

  it("counts a project of the writer's own as the last step", async () => {
    renderApp(projectCommands(projectSnapshot({ root: "/Users/writer/Papers/mine", name: "Mine" })));
    await waitFor(() => expect(progress()?.done).toContain("own"));
  });
});
