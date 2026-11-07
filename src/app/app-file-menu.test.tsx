// The harness's module mocks register as it loads: import it before anything it mocks.
import { emitTauriEvent, expectInvoked, notesSnapshot, projectCommands, setAutoBuildMode } from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { documentCanvas } from "./app-test-canvas";
import { fireEvent, screen } from "@testing-library/react";
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
});
