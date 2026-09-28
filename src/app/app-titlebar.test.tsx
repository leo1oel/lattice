import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppTitlebar } from "./app-titlebar";

vi.mock("../canvas/editor-tabs", () => ({ EditorTabs: () => null }));
vi.mock("../project/project-dialogs", () => ({ ProjectMenu: () => null }));
afterEach(cleanup);

it("keeps the focused build control while changing its action immediately", () => {
  // Unused menu and editor props belong to the mocked children, not this interaction.
  const compile = vi.fn();
  const abortBuild = vi.fn();
  const cleanAndRebuild = vi.fn();
  const renderTitlebar = (pipeline: object = {}) => {
    const props = {
      project: { root: "/paper", manifest: { name: "Paper" } },
      projectMenu: { open: false },
      sidebar: { sidebarOpen: true, sidebarWidth: 240 },
      buildPreferences: { autoBuildMode: "manual" },
      compile,
      buildPipeline: { building: false, cleaning: false, build: null, abortBuild, cleanAndRebuild, ...pipeline },
    } as unknown as ComponentProps<typeof AppTitlebar>;
    return <AppTitlebar {...props} />;
  };
  const { rerender } = render(renderTitlebar());
  const button = screen.getByRole("button", { name: "Build" });
  button.focus();
  fireEvent.click(button);
  expect(compile).toHaveBeenCalledWith(false, true);

  rerender(renderTitlebar({ building: true, cleaning: true }));
  expect(screen.getByRole("button", { name: "Stop" })).toBe(button);
  expect(button).toHaveFocus();
  expect(button).toBeEnabled();
  fireEvent.click(button, { shiftKey: true });
  expect(abortBuild).toHaveBeenCalledOnce();
  expect(cleanAndRebuild).not.toHaveBeenCalled();

  rerender(renderTitlebar({ build: { success: true, hasPdf: true, log: "", durationMs: 1730, diagnostics: [], rootDocument: "main.tex" } }));
  expect(button).toHaveTextContent("1.7s");
  expect(screen.queryByText("Stop")).toBeNull();
  expect(button).toHaveFocus();
  fireEvent.click(button, { shiftKey: true });
  expect(cleanAndRebuild).toHaveBeenCalledOnce();

  rerender(renderTitlebar({ cleaning: true }));
  expect(button).toBeDisabled();
});
