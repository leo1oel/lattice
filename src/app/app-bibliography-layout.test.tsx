import { projectCommands, findEditorView, projectSnapshot, fileNodes, attentionPaper, openTreeFile, chooseLayoutPreset, openPaper } from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { documentCanvas } from "./app-test-canvas";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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

it("opens a paper beside the library in the Bibliography layout, away from the written documents", async () => {
  renderApp({
    ...projectCommands(projectSnapshot({ files: fileNodes("main.tex", "references.bib") }), "\\documentclass{main}"),
    list_papers: () => [attentionPaper()],
    read_paper: "# Attention\n\nPaper content.",
  });
  await openTreeFile("references.bib");
  await chooseLayoutPreset("Bibliography");
  const panel = (id: string) => document.querySelector<HTMLElement>(`[data-trellis-part="panel"][data-panel="${id}"]`);
  await waitFor(() => expect(panel("panel-bibliography")).toBeInTheDocument());

  await openPaper("Attention Is All You Need");
  await waitFor(() => expect(within(panel("panel-library")!).getByRole("tab", { name: /Attention Is All You Need/ })).toBeInTheDocument());
  expect(within(panel("panel-bibliography")!).queryByRole("tab", { name: /Attention Is All You Need/ })).toBeNull();
  expect(within(panel("panel-bibliography")!).getByRole("tab", { name: /references\.bib/ })).toBeInTheDocument();
});
