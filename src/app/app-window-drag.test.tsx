import { openSettings, projectCommands, windowApi } from "./app-test-utils";
import { fireEvent, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { appHarness } from "./app-test-mount";
import { settingsDialog } from "./app-test-settings";

// Where the mounted app lets a press move the window: the title bar and the
// strips that stand in for it while a dialog covers it. How a press becomes a
// drag is `beginWindowDrag`'s, tested in src/app-utils-window-drag.test.tsx.
const { renderApp } = appHarness({ settingsDialog });

it("drags the window from the title bar's empty space", async () => {
  renderApp(projectCommands());
  await screen.findByRole("button", { name: "Switch project" });
  fireEvent.mouseDown(document.querySelector(".titlebar-drag-area")!, { button: 0, buttons: 1 });
  fireEvent.mouseMove(window, { buttons: 1 });
  expect(windowApi.startDragging).toHaveBeenCalledOnce();
});

it("keeps Settings draggable from its top edge and the top window strip", async () => {
  renderApp();
  await openSettings();
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  const topEdge = dialog.querySelector<HTMLElement>(".settings-drag-strip")!;
  fireEvent.mouseDown(topEdge, { button: 0, buttons: 1, detail: 1 });
  fireEvent.mouseMove(window, { buttons: 1 });
  expect(windowApi.startDragging).toHaveBeenCalledOnce();
  windowApi.startDragging.mockClear();
  const topStrip = document.querySelector<HTMLElement>("[data-modal-window-drag]")!;
  // A click on the strip neither dismisses Settings nor moves the window.
  fireEvent.pointerDown(topStrip, { button: 0, buttons: 1, pointerType: "mouse" });
  fireEvent.mouseDown(topStrip, { button: 0, buttons: 1, detail: 1 });
  fireEvent.pointerUp(topStrip, { button: 0, buttons: 0, pointerType: "mouse" });
  fireEvent.mouseUp(topStrip, { button: 0, buttons: 0, detail: 1 });
  fireEvent.click(topStrip, { button: 0, detail: 1 });
  expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  expect(windowApi.startDragging).not.toHaveBeenCalled();
  // Pressing it and moving does, and Settings stays open.
  fireEvent.pointerDown(topStrip, { button: 0, buttons: 1, pointerType: "mouse" });
  fireEvent.mouseDown(topStrip, { button: 0, buttons: 1, detail: 1 });
  fireEvent.mouseMove(window, { buttons: 1 });
  expect(windowApi.startDragging).toHaveBeenCalledOnce();
  expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
});
