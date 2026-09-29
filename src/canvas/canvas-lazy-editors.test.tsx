/** Clean implementation for Lattice; spec: docs/visual-editor-spec.md */
import { Suspense } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VISUAL_EDITOR_ENGINE_KEY } from "../settings/app-settings";
import { DeferredVisualMarkdownEditor } from "./canvas-lazy-editors";

const props = { text: "# Title\n\nBody\n", activePath: "notes.md", onChangeMarkdown: () => true, onUndo: () => true, onRedo: () => true };

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("visual Markdown engine selection", () => {
  it("mounts the Lattice engine by default", async () => {
    const { container } = render(<Suspense fallback={null}><DeferredVisualMarkdownEditor {...props} /></Suspense>);
    await waitFor(() => expect(container.querySelector(".lx-md-editor h1")?.textContent).toBe("Title"), { timeout: 10_000 });
    expect(container.querySelector(".visual-markdown-editor")).toBeNull();
  });

  it("mounts the vendored editor only when the hidden fallback selects it", async () => {
    localStorage.setItem(VISUAL_EDITOR_ENGINE_KEY, "ok");
    const { container } = render(<Suspense fallback={null}><DeferredVisualMarkdownEditor {...props} /></Suspense>);
    await waitFor(() => expect(container.querySelector(".visual-markdown-editor")).not.toBeNull(), { timeout: 10_000 });
    expect(container.querySelector(".lx-md-editor")).toBeNull();
  });
});

describe("visual Markdown chunk warmth", () => {
  it("marks the chunk warmed once the Lattice engine has loaded", async () => {
    vi.resetModules();
    const modules = await import("./canvas-lazy-modules");
    expect(modules.isVisualMarkdownEditorWarmed()).toBe(false);
    await modules.loadLatticeVisualEditorModule();
    expect(modules.isVisualMarkdownEditorWarmed()).toBe(true);
  }, 10_000);
});
