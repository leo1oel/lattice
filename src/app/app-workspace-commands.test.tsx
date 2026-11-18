import { projectCommands, findEditorView } from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { documentCanvas } from "./app-test-canvas";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";

const { renderApp } = appHarness({ documentCanvas });

const openPalette = async () => {
  fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true });
  return screen.findByRole("searchbox", { name: "Command palette" });
};
const workspaceTabs = () => screen.getAllByRole("tab").filter((tab) => tab.hasAttribute("data-workspace")).map((tab) => tab.textContent);

it("deletes the workspace the project is in from the palette, but never the last one", async () => {
  renderApp(projectCommands());
  await findEditorView(".source-editor[data-editor-pane='primary'] .cm-editor");

  let input = await openPalette();
  fireEvent.change(input, { target: { value: "workspace" } });
  await screen.findByRole("option", { name: /^New workspace/ });
  expect(screen.queryByRole("option", { name: "Delete workspace" })).toBeNull();
  fireEvent.keyDown(input, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("searchbox", { name: "Command palette" })).not.toBeInTheDocument());

  fireEvent.click(screen.getByRole("button", { name: "New workspace" }));
  fireEvent.keyDown(await screen.findByRole("textbox", { name: "Workspace name" }), { key: "Enter" });
  await waitFor(() => expect(workspaceTabs()).toHaveLength(2));

  input = await openPalette();
  fireEvent.change(input, { target: { value: "Delete workspace" } });
  await screen.findByRole("option", { name: "Delete workspace" });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(workspaceTabs()).toHaveLength(1));
});
