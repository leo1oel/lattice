import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TrellisController } from "./trellis-controller";
import { LayoutSwitch } from "./trellis-workspace-switch";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

function renamingField() {
  const controller = new TrellisController();
  controller.installHandlers({ workspace: (id) => controller.ui.set({ workspace: id, preset: null }) });
  controller.ui.set({ workspace: controller.workspaces.recent() });
  render(<LayoutSwitch controller={controller} compact={false} />);
  fireEvent.doubleClick(screen.getByRole("tab", { name: "Workspace" }));
  return screen.getByRole("textbox", { name: "Workspace name" }) as HTMLInputElement;
}

const tabNames = () => within(screen.getByRole("tablist", { name: "Workspaces" })).getAllByRole("tab").map((tab) => tab.textContent);

// WebKit sends the Enter that commits a candidate right after compositionend,
// with isComposing false and keyCode 229; the field once kept the half-typed
// pinyin as the workspace's name.
describe("renaming a workspace with an input method", () => {
  it("leaves Enter and Escape to the candidates, then renames on the next Enter", async () => {
    const field = renamingField();
    fireEvent.compositionStart(field);
    fireEvent.change(field, { target: { value: "gongzuo" } });
    fireEvent.keyDown(field, { key: "Escape" });
    fireEvent.keyDown(field, { key: "Enter", keyCode: 229 });
    expect(screen.getByRole("textbox", { name: "Workspace name" })).toBe(field);

    fireEvent.change(field, { target: { value: "工作" } });
    fireEvent.compositionEnd(field);
    fireEvent.keyDown(field, { key: "Enter", keyCode: 13 });
    expect(screen.getByRole("textbox", { name: "Workspace name" })).toBe(field);

    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    fireEvent.keyDown(field, { key: "Enter", keyCode: 13 });
    expect(screen.queryByRole("textbox", { name: "Workspace name" })).toBeNull();
    expect(tabNames()).toEqual(["工作"]);
  });
});
