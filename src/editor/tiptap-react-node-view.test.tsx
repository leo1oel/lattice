import { Node } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import {
  EditorContent,
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  type Editor,
  type NodeViewProps,
} from "@tiptap/react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

// A React NodeView whose component renders no [data-node-view-content] target
// still needs somewhere for ProseMirror to render the node's children, so its
// contentDOM must stay attached to the node view root. @tiptap/react 3.23.5
// returned early and left it detached (Lattice patched that); 3.29.1 fixed it
// upstream. These cases fail if an upgrade regresses either path.

function Hole() {
  return <NodeViewWrapper data-testid="with-hole"><NodeViewContent /></NodeViewWrapper>;
}

function NoHole({ node }: NodeViewProps) {
  return <NodeViewWrapper data-testid="without-hole" data-size={node.content.size} />;
}

const box = (name: string, component: typeof Hole | typeof NoHole) => Node.create({
  name,
  group: "block",
  content: "paragraph+",
  parseHTML: () => [{ tag: `div[data-${name}]` }],
  renderHTML: () => ["div", { [`data-${name}`]: "" }, 0],
  addNodeView: () => ReactNodeViewRenderer(component),
});

function Harness({ content }: { content: string }) {
  const editor = useEditor({
    immediatelyRender: true,
    extensions: [Document, Paragraph, Text, box("withhole", Hole), box("withouthole", NoHole)],
    content,
  });
  return <EditorContent editor={editor} />;
}

function renderEditor(content: string): Editor {
  const { container } = render(<Harness content={content} />);
  return container.querySelector<HTMLElement & { editor: Editor }>(".tiptap")!.editor;
}

afterEach(cleanup);

describe("@tiptap/react node view content hole", () => {
  it("renders children into the NodeViewContent target when there is one", async () => {
    renderEditor("<div data-withhole><p>inside</p></div>");
    const root = await screen.findByTestId("with-hole");
    const contentDOM = root.querySelector("[data-node-view-content-react]");
    await waitFor(() => expect(contentDOM?.parentElement).toHaveAttribute("data-node-view-content"));
    expect(contentDOM).toHaveTextContent("inside");
  });

  it("keeps contentDOM on the node view root when there is no content target", async () => {
    const editor = renderEditor("<div data-withouthole><p>kept</p></div>");
    await screen.findByTestId("without-hole");
    const contentDOM = editor.view.dom.querySelector("[data-node-view-content-react]");
    expect(contentDOM).not.toBeNull();
    expect(contentDOM!.isConnected).toBe(true);
    expect(contentDOM!.parentElement).toHaveClass("react-renderer");
    expect(contentDOM).toHaveTextContent("kept");
    // Edits still render inside the node view and reach the document.
    editor.commands.insertContentAt(3, "!");
    expect(editor.state.doc.textContent).toBe("k!ept");
    expect(contentDOM).toHaveTextContent("k!ept");
  });
});
