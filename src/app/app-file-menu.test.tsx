// The harness's module mocks register as it loads: import it before anything it mocks.
import { emitTauriEvent, expectInvoked, notesSnapshot, projectCommands, setAutoBuildMode } from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { documentCanvas } from "./app-test-canvas";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

const { renderApp } = appHarness({ documentCanvas });

// The project title menu's actions, from the macOS File menu (native_locale.rs).
describe("File menu", () => {
  it("runs the project title menu's actions in the focused window", async () => {
    renderApp(projectCommands());
    await screen.findByRole("button", { name: "Switch project" });

    emitTauriEvent("file-command", "new-project");
    expect(await screen.findByRole("heading", { name: "Create a research project" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    emitTauriEvent("file-command", "overleaf-open");
    expect(await screen.findByRole("dialog", { name: /Overleaf/ })).toBeInTheDocument();
  });

  it("opens New project with ⇧⌘N, the key File ▸ New Project shows", async () => {
    renderApp(projectCommands());
    await screen.findByRole("button", { name: "Switch project" });
    fireEvent.keyDown(window, { key: "n", metaKey: true, shiftKey: true });
    expect(await screen.findByRole("heading", { name: "Create a research project" })).toBeInTheDocument();
  });

  it("opens a project from Open Recent in its own window, as the switcher does", async () => {
    setAutoBuildMode("manual");
    localStorage.setItem("lattice.recent-projects.v1", JSON.stringify([
      { name: "Notes", path: "/tmp/notes" }, { name: "Overleaf paper", path: "/tmp/overleaf-paper" },
    ]));
    renderApp({
      ...projectCommands(notesSnapshot(), "# Private draft"),
      open_project_window: () => ({ label: "project-1", focusedExisting: false }),
    });
    await screen.findByRole("button", { name: "Switch project" });
    emitTauriEvent("open-recent", "/tmp/overleaf-paper");
    await expectInvoked("open_project_window", { path: "/tmp/overleaf-paper" });
  });

  it("lists eight other projects in the switcher, then finds the rest from it and from Open Recent", async () => {
    setAutoBuildMode("manual");
    const notes = notesSnapshot();
    localStorage.setItem("lattice.recent-projects.v1", JSON.stringify([
      { name: "Notes", path: notes.root },
      ...Array.from({ length: 12 }, (_, index) => ({ name: `Paper ${index}`, path: `/tmp/paper-${index}` })),
    ]));
    renderApp({
      ...projectCommands(notes, "# Private draft"),
      open_project_window: () => ({ label: "project-1", focusedExisting: false }),
      recent_project_states: (args) => (args as { paths: string[] }).paths.map((path) => ({ missing: false, overleaf: path === "/tmp/paper-10" })),
    });
    fireEvent.pointerDown(await screen.findByRole("button", { name: "Switch project" }), { button: 0 });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Paper 7" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Paper 8" })).not.toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "All recent projects…" }));
    fireEvent.change(await screen.findByRole("searchbox", { name: "Search recent projects" }), { target: { value: "paper 10" } });
    const found = await screen.findByRole("option", { name: "Paper 10" });
    await waitFor(() => expect(found).toHaveTextContent("Overleaf"));
    expect(screen.queryByRole("option", { name: "Notes" })).not.toBeInTheDocument();
    fireEvent.click(found);
    await expectInvoked("open_project_window", { path: "/tmp/paper-10" });

    emitTauriEvent("file-command", "open-recent-project");
    expect(await screen.findByRole("searchbox", { name: "Search recent projects" })).toBeInTheDocument();
  });
});
