import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VisualMarkdownEditor } from "./visual-markdown-editor";
import { getMarkdownManager, parseVisualMarkdown } from "./visual-markdown-schema";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: vi.fn(async () => ""),
  writeText: vi.fn(async () => undefined),
}));

function mountEditor(source: string): Editor {
  render(
    <VisualMarkdownEditor
      text={source}
      activePath="unknown-components.md"
      onChangeMarkdown={() => true}
      onUndo={() => false}
      onRedo={() => false}
    />,
  );
  const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
  return (surface as HTMLElement & { editor: Editor }).editor;
}

function serialize(editor: Editor): string {
  return getMarkdownManager().serialize(editor.getJSON());
}

describe("deferred unknown JSX conversion", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("preserves adjacent unknown components and following source as earlier fallbacks expand", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const blocks = [
      "<UnknownOne>\nFirst body.\n</UnknownOne>",
      '<UnknownTwo mode="wide">\nSecond body.\n</UnknownTwo>',
      "<UnknownThree />",
    ];
    const source = `${blocks.join("\n\n")}\n\nFollowing bytes stay here.\n`;
    const editor = mountEditor(source);

    await waitFor(() => expect(frames.size).toBeGreaterThanOrEqual(3));
    act(() => {
      const scheduled = [...frames.values()];
      frames.clear();
      scheduled.forEach((callback) => callback(performance.now()));
    });

    await waitFor(() => {
      const fallbacks: string[] = [];
      editor.state.doc.descendants((node) => {
        if (node.type.name === "rawMdxFallback") fallbacks.push(node.textContent);
      });
      expect(fallbacks).toEqual(blocks);
    });
    expect(serialize(editor)).toBe(source);
  });

  it("converts the replacement's source instead of dispatching a stale fallback", async () => {
    const editor = mountEditor("<Unknown>\nOriginal.\n</Unknown>\n");
    const replacement = editor.schema
      .nodeFromJSON(parseVisualMarkdown("<Unknown>\nReplacement.\n</Unknown>\n"))
      .child(0);

    act(() => {
      editor.view.dispatch(
        editor.state.tr.replaceWith(0, editor.state.doc.child(0).nodeSize, replacement),
      );
    });

    await waitFor(() => expect(editor.state.doc.child(0).type.name).toBe("rawMdxFallback"));
    expect(editor.state.doc.child(0).textContent).toBe("<Unknown>\nReplacement.\n</Unknown>");
  });

  it("does not restore an unknown component removed before its deferred callback", () => {
    const source = "<Unknown>\nRemove me.\n</Unknown>\n\nFollowing bytes stay here.\n";
    const editor = mountEditor(source);

    act(() => {
      editor.view.dispatch(editor.state.tr.delete(0, editor.state.doc.child(0).nodeSize));
    });

    expect(serialize(editor)).toBe("Following bytes stay here.\n");
  });
});
