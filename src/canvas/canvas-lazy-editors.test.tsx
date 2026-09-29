import { Suspense } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VISUAL_EDITOR_ENGINE_KEY } from "../settings/app-settings";
import { DeferredVisualMarkdownEditor } from "./canvas-lazy-editors";

const props = { text: "# Title\n\nBody\n", activePath: "notes.md", onChangeMarkdown: () => true, onUndo: () => true, onRedo: () => true };

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("visual Markdown engine selection", () => {
  it("mounts the vendored editor by default", async () => {
    const { container } = render(<Suspense fallback={null}><DeferredVisualMarkdownEditor {...props} /></Suspense>);
    await waitFor(() => expect(container.querySelector(".visual-markdown-editor")).not.toBeNull(), { timeout: 10_000 });
    expect(container.querySelector(".lx-md-editor")).toBeNull();
  });

  it("mounts the Lattice engine when the setting selects it", async () => {
    localStorage.setItem(VISUAL_EDITOR_ENGINE_KEY, "lattice");
    const { container } = render(<Suspense fallback={null}><DeferredVisualMarkdownEditor {...props} /></Suspense>);
    await waitFor(() => expect(container.querySelector(".lx-md-editor h1")?.textContent).toBe("Title"), { timeout: 10_000 });
    expect(container.querySelector(".visual-markdown-editor")).toBeNull();
  });
});
