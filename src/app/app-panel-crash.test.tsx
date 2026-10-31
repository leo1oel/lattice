// The harness's module mocks register as it loads: import it before anything it mocks.
import {
  appendToEditor, expectEditorText, invokeCalls, markdownSnapshot, mockCommands, persistLayout, projectCommands, projectSnapshot,
  readFiles, refreshableProject, visualDocument, visualEditorOf,
} from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { documentCanvas } from "./app-test-canvas";
import { useSyncExternalStore } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadVisualMarkdownEditorModule } from "../canvas/canvas-lazy-modules";
import type { DocumentCanvasProps } from "../canvas/canvas-model";
import { chunk } from "../lib/lazy-chunk";
import { RootErrorBoundary } from "../telemetry/root-error-boundary";
import App from "../App";

/** Flipped by a test to make the next render of the canvas throw, as a bug in it would. */
const crash = { on: false, listeners: new Set<() => void>() };
const setCrash = (on: boolean) => {
  crash.on = on;
  for (const listener of crash.listeners) listener();
};
const subscribe = (listener: () => void) => {
  crash.listeners.add(listener);
  return () => crash.listeners.delete(listener);
};

function CrashableCanvas(props: DocumentCanvasProps) {
  if (useSyncExternalStore(subscribe, () => crash.on)) throw new Error("canvas render failed");
  return <documentCanvas.Component {...props} />;
}

const { renderApp } = appHarness({ documentCanvas: { load: documentCanvas.load, Component: CrashableCanvas } });

const SOURCE_EDITOR = ".source-editor .cm-editor";
const written = (args: unknown) => ({ content: (args as { content: string }).content, hadConflicts: false });
const writesOf = (path: string) => invokeCalls("write_project_file")
  .map(([, args]) => args as { path: string; content: string })
  .filter((args) => args.path === path)
  .map((args) => args.content);

afterEach(() => setCrash(false));

describe("a panel that crashes", () => {
  it("keeps the rest of the window, writes the edit its editor still held, and reloads", async () => {
    // React reports the caught render error on the console; this test causes it on purpose.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const snapshot = markdownSnapshot("notes.md");
    persistLayout(snapshot.root, { openTabs: ["notes.md"], activeFile: "notes.md", canvasMode: "split" });
    await loadVisualMarkdownEditorModule();
    renderApp({ ...refreshableProject(snapshot), read_project_file: readFiles({ "notes.md": "# Notes" }), write_project_file: written });
    await expectEditorText("# Notes", SOURCE_EDITOR, { timeout: 10_000 });
    const visual = visualEditorOf(await screen.findByRole("textbox", { name: "Markdown document editor" }));
    // The visual editor hands its edits to the document after a debounce, which has not run when the canvas crashes.
    act(() => {
      visual.commands.setContent(visualDocument(visual, "# Notes\n\nLast words."));
      setCrash(true);
    });

    // Before the fix the error reached the root boundary, and the whole window became the crash page.
    const card = await screen.findByRole("alert");
    expect(card).toHaveTextContent("This panel stopped working");
    // In the editor's panel, inside the workspace that is still there around it.
    expect(card.closest(".lattice-trellis")).not.toBeNull();
    // The edit the visual editor still held reaches the disk.
    await waitFor(() => expect(writesOf("notes.md")).toEqual(["# Notes\n\nLast words."]));

    setCrash(false);
    fireEvent.click(screen.getByRole("button", { name: "Reload panel" }));
    await expectEditorText("# Notes\n\nLast words.", SOURCE_EDITOR, { timeout: 10_000 });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("outside every panel, still writes the edit typed just before it, as the crash page replaces the window", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const source = "\\documentclass{article}";
    mockCommands({ ...projectCommands(projectSnapshot(), source), write_project_file: written });
    // Settings has no panel of its own: its render error reaches the root boundary, as main.tsx mounts it.
    const SettingsThatCrashes = (): never => { throw new Error("settings render failed"); };
    render(
      <RootErrorBoundary>
        <App surfaces={{
          documentCanvas,
          projectPdfPanel: { load: chunk(async () => ({})), Component: () => null },
          settingsDialog: SettingsThatCrashes,
        }} />
      </RootErrorBoundary>,
    );
    await expectEditorText(source, SOURCE_EDITOR, { timeout: 10_000 });
    // Autosave waits about a second for a pause in typing; the crash comes first.
    await appendToEditor(" last words", SOURCE_EDITOR);
    expect(writesOf("main.tex")).toEqual([]);
    fireEvent.keyDown(window, { key: ",", metaKey: true });

    expect(await screen.findByRole("alert")).toHaveAccessibleName("Lattice couldn’t open this window");
    // Before the fix App unmounted with the edit only in memory, and nothing wrote it.
    await waitFor(() => expect(writesOf("main.tex")).toEqual([`${source} last words`]));
  });
});
