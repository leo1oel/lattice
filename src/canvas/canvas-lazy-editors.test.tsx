/** Clean implementation for Lattice; spec: docs/visual-editor-spec.md */
import { Suspense } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeferredVisualMarkdownEditor } from "./canvas-lazy-editors";

const props = { text: "# Title\n\nBody\n", activePath: "notes.md", onChangeMarkdown: () => true, onUndo: () => true, onRedo: () => true };

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("deferred visual Markdown editor", () => {
  it("mounts the Lattice engine", async () => {
    const { container } = render(<Suspense fallback={null}><DeferredVisualMarkdownEditor {...props} /></Suspense>);
    await waitFor(() => expect(container.querySelector(".lx-md-editor h1")?.textContent).toBe("Title"), { timeout: 10_000 });
    expect(container.querySelector(".visual-markdown-editor")).toBeNull();
  });
});

describe("visual Markdown chunk warmth", () => {
  it("marks the chunk warmed once the engine has loaded", async () => {
    vi.resetModules();
    const modules = await import("./canvas-lazy-modules");
    expect(modules.isVisualMarkdownEditorWarmed()).toBe(false);
    await modules.loadVisualMarkdownEditorModule();
    expect(modules.isVisualMarkdownEditorWarmed()).toBe(true);
  }, 10_000);
});
