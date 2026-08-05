import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatMarkdown } from "./chat-markdown";
import { parseComarkMarkdown } from "./chat-markdown-renderer";

async function renderMarkdown(
  text: string,
  options: {
    macros?: Record<string, string>;
    breaks?: boolean;
    activePath?: string;
    onOpenProjectPath?: (path: string) => void;
    onToggleTask?: (index: number, checked: boolean) => void;
    onReplaceBlock?: (
      range: { startLine: number; endLine: number },
      replacement: string,
      expected: string,
    ) => boolean;
  } = {},
) {
  const view = render(
    <ChatMarkdown
      text={text}
      macros={options.macros}
      breaks={options.breaks}
      activePath={options.activePath}
      onOpenProjectPath={options.onOpenProjectPath}
      onToggleTask={options.onToggleTask}
      onReplaceBlock={options.onReplaceBlock}
    />,
  );
  await waitFor(() => expect(view.container.querySelector(".comark-content")).not.toBeNull());
  return view.container;
}

describe("ChatMarkdown with CoMark", () => {
  it("renders the Markdown the application emits", async () => {
    const container = await renderMarkdown("Use **bold**, *italic*, and `code`.");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("italic");
    expect(container.querySelector("code")?.textContent).toBe("code");
  });

  it("renders emoji and typographic punctuation", async () => {
    const container = await renderMarkdown(`:rocket: "Ready" -- go... (c)`);
    expect(container.textContent).toContain("🚀 “Ready” – go… ©");
  });

  it("resolves bindings from frontmatter with visible defaults", async () => {
    const container = await renderMarkdown("---\nauthor: Ada\n---\nBy {{ frontmatter.author }}; {{ frontmatter.missing || Unknown }}.");
    expect(container.textContent).toContain("By Ada; Unknown.");
  });

  it("exposes heading, description, summary, and TOC metadata", async () => {
    const tree = await parseComarkMarkdown("# Paper title\n\nA short description.\n\n## Results\n\nBefore marker.\n\n<!-- more -->\n\n## Details", false);
    expect(tree.nodes[0]).toEqual([
      "h1",
      { id: "paper-title", "data-source-line": 1, "data-source-end-line": 1 },
      "Paper title",
    ]);
    expect(tree.meta).toMatchObject({
      title: "Paper title",
      description: "A short description.",
      toc: { links: [{ id: "results", text: "Results", depth: 2 }, { id: "details", text: "Details", depth: 2 }] },
    });
    expect(JSON.stringify(tree.meta.summary)).toContain("Before marker.");
    expect(JSON.stringify(tree.meta.summary)).not.toContain("Details");
  });

  it("renders built-in alerts and task lists", async () => {
    const onToggleTask = vi.fn();
    const container = await renderMarkdown("> [!TIP]\n> Keep going.\n\n- [x] Parsed\n- [ ] Reviewed", {
      onToggleTask,
    });
    expect(container.querySelector('blockquote[as="tip"]')?.textContent).toContain("Keep going.");
    const tasks = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(tasks).toHaveLength(2);
    expect(tasks[0].checked).toBe(true);
    expect(tasks[1].disabled).toBe(false);
    fireEvent.click(tasks[1]);
    expect(onToggleTask).toHaveBeenCalledWith(5, true);
  });

  it("adds source-line anchors to top-level preview blocks", async () => {
    const container = await renderMarkdown("# First\n\nParagraph.\n\n## Last");
    expect(Array.from(container.querySelectorAll<HTMLElement>("[data-source-line]"))
      .map((node) => Number(node.dataset.sourceLine))).toEqual([1, 3, 5]);
  });

  it("edits rendered blocks through exact Markdown source ranges", async () => {
    const onReplaceBlock = vi.fn(() => true);
    const container = await renderMarkdown("Intro with **bold**.\ncontinued here.\n\n## Results", {
      onReplaceBlock,
    });
    fireEvent.click(container.querySelector<HTMLButtonElement>(
      'button[aria-label="Edit paragraph Markdown"]',
    )!);
    const editor = await waitFor(() => {
      const textarea = container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Edit paragraph Markdown"]',
      );
      expect(textarea).not.toBeNull();
      return textarea!;
    });
    expect(editor.value).toBe("Intro with **bold**.\ncontinued here.");
    fireEvent.change(editor, { target: { value: "Revised with *emphasis*." } });
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
    expect(onReplaceBlock).toHaveBeenCalledWith(
      { startLine: 1, endLine: 2 },
      "Revised with *emphasis*.",
      "Intro with **bold**.\ncontinued here.",
    );
  });

  it("cancels a visual block edit without changing Markdown", async () => {
    const onReplaceBlock = vi.fn(() => true);
    const container = await renderMarkdown("# Original", { onReplaceBlock });
    fireEvent.click(container.querySelector<HTMLButtonElement>(
      'button[aria-label="Edit heading 1 Markdown"]',
    )!);
    const editor = await waitFor(() => container.querySelector<HTMLTextAreaElement>("textarea")!);
    fireEvent.change(editor, { target: { value: "# Discarded" } });
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(onReplaceBlock).not.toHaveBeenCalled();
    expect(await waitFor(() => container.querySelector("h1")?.textContent)).toBe("Original");
    await waitFor(() => expect(document.activeElement).toBe(container.querySelector(
      'button[aria-label="Edit heading 1 Markdown"]',
    )));
  });

  it("does not treat IME composition keys as edit commands", async () => {
    const onReplaceBlock = vi.fn(() => true);
    const container = await renderMarkdown("Original", { onReplaceBlock });
    fireEvent.click(container.querySelector<HTMLButtonElement>(
      'button[aria-label="Edit paragraph Markdown"]',
    )!);
    const editor = await waitFor(() => container.querySelector<HTMLTextAreaElement>("textarea")!);
    fireEvent.keyDown(editor, { key: "Escape", isComposing: true });
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true, isComposing: true });
    expect(container.querySelector("textarea")).toBe(editor);
    expect(onReplaceBlock).not.toHaveBeenCalled();
  });

  it("excludes a CRLF block terminator from the editable source", async () => {
    const onReplaceBlock = vi.fn(() => true);
    const container = await renderMarkdown("First line\r\nsecond line\r\n\r\nNext", { onReplaceBlock });
    fireEvent.click(container.querySelector<HTMLButtonElement>(
      'button[aria-label="Edit paragraph Markdown"]',
    )!);
    const editor = await waitFor(() => container.querySelector<HTMLTextAreaElement>("textarea")!);
    expect(editor.value).toBe("First line\nsecond line");
    fireEvent.change(editor, { target: { value: "Changed\nblock" } });
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    expect(onReplaceBlock).toHaveBeenCalledWith(
      { startLine: 1, endLine: 2 },
      "Changed\nblock",
      "First line\r\nsecond line",
    );
  });

  it("exposes source editors for rendered formulas and diagrams", async () => {
    const onReplaceBlock = vi.fn(() => true);
    const container = await renderMarkdown(
      "$$\nx+y\n$$\n\n```mermaid\ngraph TD\n  A --> B\n```",
      { onReplaceBlock },
    );
    await waitFor(() => expect(container.querySelector(".chat-mermaid img")).not.toBeNull());
    expect(container.querySelector('button[aria-label="Edit formula Markdown"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Edit diagram Markdown"]')).not.toBeNull();
  });

  it("reports the parser source line for a continued task item", async () => {
    const onToggleTask = vi.fn();
    const container = await renderMarkdown("-\n  [ ] Continued task", { onToggleTask });
    fireEvent.click(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    expect(onToggleTask).toHaveBeenCalledWith(2, true);
  });

  it("keeps JSON Render specs visible and never executes their component tree", async () => {
    const container = await renderMarkdown('```json-render\n{"type":"script","props":{"content":"alert(1)","dangerouslySetInnerHTML":{"__html":"<img data-injected>"}}}\n```');
    expect(container.querySelector(".chat-json-render-fallback")?.textContent).toContain('"type":"script"');
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("[data-injected]")).toBeNull();
  });

  it("can preserve single newlines as line breaks", async () => {
    const withBreaks = await renderMarkdown("first\nsecond");
    expect(withBreaks.querySelector("br")).not.toBeNull();

    const commonMark = await renderMarkdown("first\nsecond", { breaks: false });
    expect(commonMark.querySelector("br")).toBeNull();
  });

  it("renders inline and display math with KaTeX", async () => {
    const inline = await renderMarkdown("The loss $x^2$ falls.");
    expect(inline.querySelector(".katex")).not.toBeNull();
    expect(inline.textContent).not.toContain("$x^2$");

    const display = await renderMarkdown("$$\n\\sum_{i=1}^{n} x_i\n$$");
    expect(display.querySelector(".chat-math-block .katex-display")).not.toBeNull();
    expect(display.querySelector(".markdown-rich-editable-block"))
      .toHaveAttribute("data-source-line", "1");
  });

  it("preserves the \\( \\) and \\[ \\] math delimiters", async () => {
    const inline = await renderMarkdown("value \\(a+b\\) here");
    expect(inline.querySelector(".katex")).not.toBeNull();

    const display = await renderMarkdown("\\[\na+b\n\\]");
    expect(display.querySelector(".chat-math-block .katex-display")).not.toBeNull();
  });

  it("expands project macros so preview math matches the paper", async () => {
    const container = await renderMarkdown("$\\R^n$", {
      macros: { "\\R": "\\mathbb{R}" },
    });
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.textContent).not.toContain("undefined control sequence");
  });

  it("leaves dollar signs in prose alone", async () => {
    const container = await renderMarkdown("It costs $5 and then $10 more.");
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toContain("$5");
    expect(container.textContent).toContain("$10");
  });

  it("does not treat dollars inside code as math", async () => {
    const fenced = await renderMarkdown("```sh\necho $HOME and $PATH\n```");
    expect(fenced.querySelector(".katex")).toBeNull();
    expect(fenced.querySelector("code")?.textContent).toContain("$HOME");

    const span = await renderMarkdown("Run `cd $HOME` first.");
    expect(span.querySelector(".katex")).toBeNull();
    expect(span.querySelector("code")?.textContent).toContain("$HOME");
  });

  it("highlights fenced code with Shiki", async () => {
    const container = await renderMarkdown("```typescript\nconst answer: number = 42\n```");
    expect(container.querySelector("pre.shiki")).not.toBeNull();
    expect(container.querySelectorAll("pre.shiki span").length).toBeGreaterThan(0);
  });

  it("renders footnotes with navigable references", async () => {
    const container = await renderMarkdown("Evidence[^source].\n\n[^source]: Supporting result.");
    expect(container.querySelector(".footnote-ref a")).toHaveAttribute("href", "#fn-source");
    expect(container.querySelector("#fn-source")?.textContent).toContain("Supporting result.");
  });

  it("renders Mermaid fences as diagrams", async () => {
    const container = await renderMarkdown("```mermaid\ngraph TD\n  A --> B\n```");
    await waitFor(() => {
      const diagram = container.querySelector<HTMLImageElement>(".chat-mermaid img");
      expect(diagram?.src).toContain("data:image/svg+xml");
    });
    const zoomIn = container.querySelector<HTMLButtonElement>('button[aria-label="Zoom in diagram"]');
    fireEvent.click(zoomIn!);
    expect(container.querySelector<HTMLImageElement>(".chat-mermaid img")?.style.width).toBe("125%");
    expect(container.querySelector('button[aria-label="Reset diagram zoom"]')).toHaveTextContent("125%");
  });

  it("preserves an unchanged Mermaid node when earlier blocks change", async () => {
    const source = "```mermaid\ngraph TD\n  A --> B\n```";
    const view = render(<ChatMarkdown text={source} breaks={false} />);
    const original = await waitFor(() => {
      const diagram = view.container.querySelector<HTMLImageElement>(".chat-mermaid img");
      expect(diagram).not.toBeNull();
      return diagram!;
    });
    view.rerender(<ChatMarkdown text={`A new introduction.\n\n${source}`} breaks={false} />);
    await waitFor(() => expect(view.container.querySelector("p")?.textContent).toBe("A new introduction."));
    expect(view.container.querySelector(".chat-mermaid img")).toBe(original);
  });

  it("keeps full-document metadata and start-line anchors after appended edits", async () => {
    const source = "Evidence[^source].\n\nA paragraph\nthat spans lines.\n\n[^source]: Supporting result.";
    const view = render(<ChatMarkdown text={source} breaks={false} />);
    await waitFor(() => expect(view.container.querySelector(".footnotes")).not.toBeNull());
    expect(view.container.querySelector("p[data-source-line='3']")?.textContent)
      .toContain("A paragraph");

    view.rerender(<ChatMarkdown text={`${source}\n\nAppended.`} breaks={false} />);
    await waitFor(() => expect(view.container.textContent).toContain("Appended."));
    expect(view.container.querySelector(".footnotes")?.textContent).toContain("Supporting result.");
    expect(view.container.querySelector("p[data-source-line='3']")?.textContent)
      .toContain("A paragraph");
  });

  it("opens relative links as project files", async () => {
    const onOpenProjectPath = vi.fn();
    const container = await renderMarkdown("[`target`](native-unified-view.md)", {
      activePath: "notes/index.md",
      onOpenProjectPath,
    });
    fireEvent.click(container.querySelector("a")!);
    expect(onOpenProjectPath).toHaveBeenCalledWith("notes/native-unified-view.md");
  });

  it("removes executable HTML and event handlers", async () => {
    const container = await renderMarkdown(
      `<script>alert(1)</script><img src=x onerror=alert(1)>

::div{:dangerouslySetInnerHTML='{"__html":"<img data-injected src=x>"}'}
::`,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")?.hasAttribute("onerror")).toBe(false);
    expect(container.querySelector("[data-injected]")).toBeNull();
  });

  it("auto-closes incomplete math and survives malformed input", async () => {
    const incomplete = await renderMarkdown("The result is $x^2 + ");
    expect(incomplete.querySelector(".katex")).not.toBeNull();

    const malformed = await renderMarkdown("$\\frac{1}{$");
    expect(malformed.querySelector(".comark-content")).not.toBeNull();
  });
});
