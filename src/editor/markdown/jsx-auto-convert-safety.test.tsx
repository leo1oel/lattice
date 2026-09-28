import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getParseHealth, resetParseHealth } from "../../open-knowledge-core/metrics/parse-health.ts";
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

    await waitFor(() => {
      // Replacing one node can rerender a neighbour and reschedule its effect.
      // Keep advancing frames like a browser instead of freezing after one batch;
      // the queue also contains editor work unrelated to JSX conversion.
      act(() => {
        const scheduled = [...frames.values()];
        frames.clear();
        scheduled.forEach((callback) => callback(performance.now()));
      });
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

describe("JSX chrome actions resolve their live target", () => {
  afterEach(() => {
    cleanup();
    resetParseHealth();
  });

  function calloutPositions(editor: Editor): number[] {
    const positions: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "jsxComponent" && node.attrs.componentName === "Callout") {
        positions.push(pos);
      }
    });
    return positions;
  }

  it("deletes the component, not the block that now sits at its rendered position", async () => {
    // A block inserted above shifts the component before React re-renders
    // its NodeView; the chrome must not act on the position it rendered with.
    const editor = mountEditor('<Callout title="Target">\nBody.\n</Callout>\n\nTail stays.\n');
    const deleteButton = await screen.findByRole("button", { name: "Delete Callout" });
    editor.view.dispatch(
      editor.state.tr.insert(0, editor.schema.nodes.paragraph.create(null, editor.schema.text("Inserted"))),
    );
    expect(calloutPositions(editor)).toHaveLength(1);

    fireEvent.click(deleteButton);

    expect(calloutPositions(editor)).toEqual([]);
    expect(serialize(editor)).toBe("Inserted\n\nTail stays.\n");
  });

  it("refuses a chrome action once its component changed underneath it", async () => {
    const editor = mountEditor('<Callout title="Target">\nBody.\n</Callout>\n\nTail stays.\n');
    const deleteButton = await screen.findByRole("button", { name: "Delete Callout" });
    const [pos] = calloutPositions(editor);
    const current = editor.state.doc.nodeAt(pos!)!;
    // Update the node without letting React re-render the NodeView, as a
    // concurrent write does between render and click.
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(pos!, undefined, {
        ...current.attrs,
        props: { ...(current.attrs.props as Record<string, unknown>), title: "Edited elsewhere" },
        sourceDirty: true,
      }),
    );

    fireEvent.click(deleteButton);

    expect(calloutPositions(editor)).toHaveLength(1);
    expect(getParseHealth().jsxActionAborted["delete-chrome"]).toBe(1);
  });
});
