import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppTitlebar, type AppTitlebarProps } from "./app-titlebar";

vi.mock("../canvas/editor-tabs", () => ({ EditorTabs: () => null }));
vi.mock("../project/project-dialogs", () => ({ ProjectMenu: () => null }));
afterEach(cleanup);

it("keeps the focused build control while changing its action immediately", () => {
  // Unused menu and editor props belong to the mocked children, not this interaction.
  const props = {
    project: { root: "/paper", manifest: { name: "Paper" } },
    projectMenuOpen: false,
    sidebarOpen: true,
    sidebarWidth: 240,
    buildPreferences: { autoBuildMode: "manual" },
    building: false,
    cleaning: false,
    build: null,
    compile: vi.fn(),
    abortBuild: vi.fn(),
    cleanAndRebuild: vi.fn(),
  } as unknown as AppTitlebarProps;
  const { rerender } = render(<AppTitlebar {...props} />);
  const button = screen.getByRole("button", { name: "Build" });
  button.focus();
  fireEvent.click(button);
  expect(props.compile).toHaveBeenCalledWith(false, true);

  rerender(<AppTitlebar {...props} building cleaning />);
  expect(screen.getByRole("button", { name: "Stop" })).toBe(button);
  expect(button).toHaveFocus();
  expect(button).toBeEnabled();
  fireEvent.click(button, { shiftKey: true });
  expect(props.abortBuild).toHaveBeenCalledOnce();
  expect(props.cleanAndRebuild).not.toHaveBeenCalled();

  rerender(<AppTitlebar {...props} build={{ success: true, hasPdf: true, log: "", durationMs: 1730, diagnostics: [], rootDocument: "main.tex" }} />);
  expect(button).toHaveTextContent("1.7s");
  expect(screen.queryByText("Stop")).toBeNull();
  expect(button).toHaveFocus();
  fireEvent.click(button, { shiftKey: true });
  expect(props.cleanAndRebuild).toHaveBeenCalledOnce();

  rerender(<AppTitlebar {...props} cleaning />);
  expect(button).toBeDisabled();
});
