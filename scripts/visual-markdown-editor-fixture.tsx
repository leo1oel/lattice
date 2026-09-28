// Mounts the shipping Markdown visual editor (Tiptap) inside the same scroll
// container the canvas gives it, for browser checks of the embedded editor.
// Open /icon-lab.html on the Vite dev server, then:
//   const { mountVisualMarkdownEditorFixture } = await import('/scripts/visual-markdown-editor-fixture.tsx');
//   const fixture = await mountVisualMarkdownEditorFixture();
// `fixture.markdown()` is the last Markdown the editor committed,
// `fixture.applyRemote(text)` delivers a collaborator's edit the way a
// collaboration session does (a new `text` prop), and
// `fixture.setPresence(cursors)` paints collaborator carets.
import { useState } from "react";
import ReactDOM from "react-dom/client";
import { flushSync } from "react-dom";
import { I18nProvider } from "@lingui/react";
import type { Editor } from "@tiptap/react";
import { ScrollArea } from "../src/components/ui/scroll-area";
import { MarkdownWorkspaceIndex } from "../src/editor/markdown/markdown-workspace-index";
import { VisualMarkdownEditor } from "../src/editor/markdown/visual-markdown-editor";
import { activateAppLocale, i18n } from "../src/i18n";
import type { PaperSummary } from "../src/app-types";
import type { PresenceCursor } from "../src/overleaf/overleaf-editor-extensions";
import "../src/index.css";
import "../src/App.css";

const DEFAULT_TEXT = `# Fixture heading

Plain paragraph with **bold**, *italic*, \`code\`, ~~strike~~ and a [link](https://example.com).

- first bullet
- second bullet
  - nested bullet

1. first step
2. second step

- [ ] open task
- [x] done task

> A quoted line.

| Name | Value |
| --- | --- |
| alpha | 1 |
| beta | 2 |

\`\`\`ts
const answer = 42;
\`\`\`

<Callout type="note" title="Initial">

Callout body.

</Callout>

![Swatch](figures/swatch.svg)

Closing paragraph.
`;

// Project images reach the editor through onLoadAsset, as in the app.
const SWATCH = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><rect width="240" height="80" fill="#3784ff"/></svg>')}`;

const PAPERS: PaperSummary[] = [
  { arxivId: "1706.03762", title: "Attention Is All You Need", citationKey: "vaswani2017attention", hasFullText: true, hasBlog: true },
  { arxivId: "2010.11929", title: "An Image is Worth 16x16 Words", citationKey: "dosovitskiy2021image", hasFullText: false, hasBlog: true },
];

export type VisualMarkdownEditorFixture = {
  editor: () => Editor;
  markdown: () => string;
  changes: () => number;
  applyRemote: (text: string) => void;
  setPresence: (cursors: PresenceCursor[]) => void;
};

export async function mountVisualMarkdownEditorFixture(text = DEFAULT_TEXT): Promise<VisualMarkdownEditorFixture> {
  await activateAppLocale("en");
  document.body.replaceChildren();
  const host = document.createElement("div");
  host.id = "visual-markdown-editor-fixture";
  document.body.append(host);
  const style = document.createElement("style");
  style.textContent = `
    body { margin: 0; background: var(--surface-canvas); }
    #visual-markdown-editor-fixture { position: fixed; inset: 0; display: flex; }
    #visual-markdown-editor-fixture > .markdown-preview { flex: 1; min-width: 0; }
  `;
  document.head.append(style);

  const workspaceIndex = new MarkdownWorkspaceIndex(async () => "");
  workspaceIndex.noteDocumentContent("notes/other.md", "# Other note\n\nLinked page.\n");
  let committed = text;
  let changeCount = 0;
  let setText: (next: string) => void = () => {};
  let setCursors: (next: PresenceCursor[]) => void = () => {};

  function Harness() {
    const [value, setValue] = useState(text);
    const [cursors, setPresence] = useState<PresenceCursor[]>([]);
    setText = setValue;
    setCursors = setPresence;
    return (
      <ScrollArea
        className="markdown-preview"
        orientation="vertical"
        fadeEdges={false}
        contentClassName="markdown-preview-content"
        viewportClassName="editor-doc-scroll"
        viewportProps={{ "data-testid": "editor-scroll-container" }}
      >
        <VisualMarkdownEditor
          text={value}
          activePath="notes/fixture.md"
          projectRoot="/fixture"
          workspaceIndex={workspaceIndex}
          papers={PAPERS}
          presenceCursors={cursors}
          onLoadAsset={async (path) => (path === "notes/figures/swatch.svg" ? SWATCH : null)}
          onChangeMarkdown={(next) => {
            committed = next;
            changeCount += 1;
            setValue(next);
            return true;
          }}
          onUndo={() => false}
          onRedo={() => false}
        />
      </ScrollArea>
    );
  }

  const root = ReactDOM.createRoot(host);
  flushSync(() => root.render(<I18nProvider i18n={i18n}><Harness /></I18nProvider>));
  const surface = await new Promise<HTMLElement & { editor: Editor }>((resolve) => {
    const find = () => {
      const element = document.querySelector<HTMLElement & { editor: Editor }>(".tiptap[contenteditable]");
      if (element?.editor) resolve(element);
      else requestAnimationFrame(find);
    };
    find();
  });
  return {
    editor: () => surface.editor,
    markdown: () => committed,
    changes: () => changeCount,
    applyRemote: (next) => flushSync(() => setText(next)),
    setPresence: (next) => flushSync(() => setCursors(next)),
  };
}
