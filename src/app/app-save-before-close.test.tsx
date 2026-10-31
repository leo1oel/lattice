// The harness's module mocks register as it loads: import it before anything it mocks.
import {
  appendToEditor, emitTauriEvent, expectEditorText, expectInvoked, expectNotification, invokeCalls, markdownSnapshot, persistLayout,
  projectCommands, projectSnapshot, readFiles, refreshableProject, visualDocument, visualEditorOf, type CommandResult,
} from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { documentCanvas } from "./app-test-canvas";
import { invoke } from "@tauri-apps/api/core";
import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { loadVisualMarkdownEditorModule } from "../canvas/canvas-lazy-modules";
import { SAVE_BEFORE_CLOSE_EVENT } from "./use-save-before-close";

const { renderApp } = appHarness({ documentCanvas });

/** The page enables its close guard as it starts, and answers each request it receives. */
const closeCommands = { enable_save_before_close: undefined, finish_save_before_close: undefined } satisfies Record<string, CommandResult>;
const written = (args: unknown) => ({ content: (args as { content: string }).content, hadConflicts: false });

/** The writes of `path`, and the save-before-close answers, in the order the page sent them. */
const closeTimeline = (path: string) => vi.mocked(invoke).mock.calls
  .filter(([command, args]) => (command === "write_project_file" && (args as { path: string }).path === path)
    || command === "finish_save_before_close")
  .map(([command, args]) => (command === "write_project_file" ? (args as { content: string }).content : args));

const SOURCE = "\\documentclass{article}";
const SOURCE_EDITOR = ".source-editor .cm-editor";

/** main.tex open, with an edit typed just now: the autosave timer (about a second) has not fired yet. */
async function openWithTyping(commands: Record<string, CommandResult> = {}) {
  renderApp({ ...projectCommands(projectSnapshot(), SOURCE), write_project_file: written, ...closeCommands, ...commands });
  await expectEditorText(SOURCE, SOURCE_EDITOR, { timeout: 10_000 });
  await appendToEditor(" last words", SOURCE_EDITOR);
}

describe("saving before the window closes or Lattice quits", () => {
  it("writes the edit typed just before ⌘Q, then lets the window go", async () => {
    await openWithTyping();
    expect(invokeCalls("write_project_file")).toHaveLength(0);
    emitTauriEvent(SAVE_BEFORE_CLOSE_EVENT, 7);
    // Before the fix nothing answered, and the window closed with the edit only in memory.
    await waitFor(() => expect(closeTimeline("main.tex")).toEqual([
      `${SOURCE} last words`,
      { id: 7, saved: true },
    ]));
    expect(invokeCalls("enable_save_before_close")).toHaveLength(1);
  });

  it("publishes and writes an edit still pending in the visual Markdown editor", async () => {
    const snapshot = markdownSnapshot("notes.md");
    persistLayout(snapshot.root, { openTabs: ["notes.md"], activeFile: "notes.md", canvasMode: "split" });
    await loadVisualMarkdownEditorModule();
    renderApp({
      ...refreshableProject(snapshot), read_project_file: readFiles({ "notes.md": "# Notes" }),
      write_project_file: written, ...closeCommands,
    });
    await expectEditorText("# Notes", SOURCE_EDITOR, { timeout: 10_000 });
    const visual = visualEditorOf(await screen.findByRole("textbox", { name: "Markdown document editor" }));
    // The visual editor hands its edits to the document after a debounce, which has not run yet.
    act(() => { visual.commands.setContent(visualDocument(visual, "# Notes\n\nLast words.")); });
    emitTauriEvent(SAVE_BEFORE_CLOSE_EVENT, 3);
    await waitFor(() => expect(closeTimeline("notes.md")).toEqual(["# Notes\n\nLast words.", { id: 3, saved: true }]));
  });

  it("keeps the window open once when the edit cannot be written, and closes on the next try", async () => {
    await openWithTyping({
      write_project_file: () => Promise.reject(new Error("disk full")),
    });
    emitTauriEvent(SAVE_BEFORE_CLOSE_EVENT, 1);
    await expectInvoked("finish_save_before_close", { id: 1, saved: false });
    await expectNotification(/window stayed open/);
    emitTauriEvent(SAVE_BEFORE_CLOSE_EVENT, 2);
    await expectInvoked("finish_save_before_close", { id: 2, saved: true });
  });

  it("starts writing the last edit as the page reloads", async () => {
    await openWithTyping();
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    await waitFor(() => expect(closeTimeline("main.tex")).toEqual([`${SOURCE} last words`]));
  });
});
