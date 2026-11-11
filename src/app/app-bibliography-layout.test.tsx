import { projectCommands, findEditorView } from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { documentCanvas } from "./app-test-canvas";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";

const { renderApp } = appHarness({ documentCanvas });

it("enters Bibliography from the palette and marks it selected in Panels", async () => {
  renderApp(projectCommands());
  await findEditorView(".source-editor[data-editor-pane='primary'] .cm-editor");
  fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true });
  const input = await screen.findByRole("searchbox", { name: "Command palette" });
  fireEvent.change(input, { target: { value: "Switch to the Bibliography layout" } });
  await screen.findByRole("option", { name: "Switch to the Bibliography layout" });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(screen.queryByRole("searchbox", { name: "Command palette" })).not.toBeInTheDocument());
  fireEvent.pointerDown(screen.getByRole("button", { name: "Panels" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
  expect(await screen.findByRole("menuitemradio", { name: "Bibliography" })).toHaveAttribute("aria-checked", "true");
  expect(screen.getByRole("menuitemradio", { name: "Reading" })).toHaveAttribute("aria-checked", "false");
});
