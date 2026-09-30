import type { ComponentProps } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppTitlebar } from "./app-titlebar";

vi.mock("../project/project-dialogs", () => ({ ProjectMenu: () => null }));
afterEach(cleanup);

it("carries the project switcher, the panel controls and the tools, but no build button", () => {
  // Unused menu props belong to the mocked ProjectMenu, not this layout.
  const props = {
    project: { root: "/paper", manifest: { name: "Paper" } },
    projectMenu: { open: false, setOpen: vi.fn(), importing: false, building: true },
    panelControls: <button type="button">Panels</button>,
    canvasToolbar: <button type="button">Project history</button>,
  } as unknown as ComponentProps<typeof AppTitlebar>;
  render(<AppTitlebar {...props} />);
  expect(screen.getByRole("button", { name: "Switch project" })).toHaveTextContent("Paper");
  // A running build keeps the project from being switched underneath it.
  expect(screen.getByRole("button", { name: "Switch project" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Panels" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Project history" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Build" })).toBeNull();
});
