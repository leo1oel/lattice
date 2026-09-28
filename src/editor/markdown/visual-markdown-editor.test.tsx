import { readFileSync } from "node:fs";
import { EditorView as CMEditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { AllSelection, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { GapCursor } from "@tiptap/pm/gapcursor";
import { CellSelection, TableMap } from "@tiptap/pm/tables";
import type { Editor } from "@tiptap/react";
// Loads the `setContent(…, { contentType: "markdown" })` option typing.
import type {} from "@tiptap/markdown";
import { type ComponentProps, useMemo, useRef, useState } from "react";
import { afterEach, describe, expect, it, type Mock, onTestFinished, vi } from "vitest";
import { getComponentItems, getInlineComponentItems } from "@ok-app/editor/slash-command/component-items";
import { getEmbedStarterItems } from "@ok-app/editor/slash-command/embed-starter-items";
import { tableEnterDown } from "@ok-app/editor/extensions/table-row-enter";
import { LinkPathSuggestionInput } from "@ok-app/editor/link-path-suggestions";
import { getParseHealth, resetParseHealth } from "../../open-knowledge-core/metrics/parse-health";
import { parseWithFallback } from "../../open-knowledge-core/markdown/parse-with-fallback";
import tutorialMarkdown from "../../../src-tauri/templates/tutorial/notes.md?raw";
import { msg } from "@lingui/core/macro";
import { activateAppLocale, i18n } from "../../i18n";
import {
  addBlockBelow,
  blockControlCrossAxisOffset,
  moveBlockUp,
  moveTopLevelBlock,
  PRESERVE_VISUAL_VIEWPORT_META,
  restoreVisualViewportWithReveal,
  type PreserveVisualViewportMeta,
} from "./visual-editor-block-controls";
import { exactVisualSourceRanges, restoreUnchangedBlocks, VisualMarkdownEditor } from "./visual-markdown-editor";
import { getMarkdownManager, parseVisualMarkdown } from "./visual-markdown-schema";
import { canonicalizeSupportedMarkdown, preserveMarkdownEnvelope } from "./markdown-collab";
import { MarkdownWorkspaceIndex } from "./markdown-workspace-index";
import { LARGE_MARKDOWN_PREVIEW_THRESHOLD, markdownPreviewSyncPolicy } from "./markdown-preview-sync-policy";
import { documentHeadingItems } from "./document-heading-items";

const notifications = vi.hoisted(() => ({ error: vi.fn() }));
const opener = vi.hoisted(() => ({ openUrl: vi.fn(async () => undefined) }));
const clipboard = vi.hoisted(() => ({
  readText: vi.fn(async () => ""),
  writeText: vi.fn(async () => undefined),
}));
vi.mock("../../telemetry/app-notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../telemetry/app-notify")>()),
  notifyError: notifications.error,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: opener.openUrl }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => clipboard);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "elementsFromPoint");
});

type EditorProps = ComponentProps<typeof VisualMarkdownEditor>;
type ChangeMock = Mock<(next: string, expected: string) => boolean>;

const PAPER_PATH = ".research/papers/example/paper.md";
const PAPER = { activePath: PAPER_PATH, optimizeForReading: true };
const PNG = "data:image/png;base64,cGxvdA==";

// The surface is labelled in the active locale; one test switches to zh-CN.
const getSurface = () =>
  screen.getByRole("textbox", { name: i18n._(msg`Markdown document editor`) }) as HTMLElement & { editor: Editor };

function editorProps(props: Partial<EditorProps> = {}): EditorProps {
  return { text: "Hello", activePath: "notes.md", onChangeMarkdown: () => true, onUndo: () => false, onRedo: () => false, ...props };
}

/**
 * Mounts the editor with inert host callbacks. `rerender` merges props over
 * the previous ones; `surface`/`editor` read the live ProseMirror host.
 */
function renderEditor(props: string | Partial<EditorProps> = {}, onChange: ChangeMock = vi.fn(() => true)) {
  let current = editorProps({ onChangeMarkdown: onChange, ...(typeof props === "string" ? { text: props } : props) });
  const view = render(<VisualMarkdownEditor {...current} />);
  return {
    ...view,
    onChange,
    rerender: (next: Partial<EditorProps>) => view.rerender(<VisualMarkdownEditor {...(current = { ...current, ...next })} />),
    get surface() { return getSurface(); },
    get editor() { return getSurface().editor; },
  };
}

/** A host that accepts every publication, so each `text` prop is the editor's own echo. */
function ControlledEditor({ initial, ...props }: Partial<EditorProps> & { initial: string }) {
  const [text, setText] = useState(initial);
  const accepted = useRef(initial);
  return (
    <VisualMarkdownEditor
      {...editorProps(props)}
      text={text}
      onChangeMarkdown={(next, expected) => {
        if (accepted.current !== expected) return false;
        accepted.current = next;
        setText(next);
        return true;
      }}
    />
  );
}

const lastChange = (onChange: ChangeMock) => String(onChange.mock.lastCall?.[0]);
const editorMarkdown = (editor: Editor) => getMarkdownManager().serialize(editor.getJSON());
const rect = (top: number, bottom: number) => new DOMRect(0, top, 100, bottom - top);
const setRect = (element: Element, value: DOMRect) => vi.spyOn(element, "getBoundingClientRect").mockReturnValue(value);
const ada = (row: number, column: number) => ({ name: "Ada", hue: 210, row, column });
const blocks = (count: number) => Array.from({ length: count }, (_, index) => `Block ${index}: ${"content ".repeat(14)}`);
const workspaceCss = () => readFileSync("src/styles/editor-workspace.css", "utf8");

/** Position of the first node that is the text `match` or satisfies it. */
function nodePos(editor: Editor, match: string | ((node: PMNode) => boolean)): number {
  let found = -1;
  editor.state.doc.descendants((node, position) => {
    if (found < 0 && (typeof match === "string" ? node.isText && node.text === match : match(node))) found = position;
  });
  return found;
}
const typePos = (editor: Editor, type: string) => nodePos(editor, (node) => node.type.name === type);

function selectText(editor: Editor, from: number, to = from) {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)));
}
function focusText(editor: Editor, from: number, to = from) {
  editor.view.focus();
  selectText(editor, from, to);
}
function selectNode(editor: Editor, position: number) {
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, position)));
}

/** Routes `text` through handleTextInput like the DOM input path, so input rules fire. */
function textInput(editor: Editor, text: string) {
  const { from, to } = editor.state.selection;
  const insert = () => editor.state.tr.insertText(text, from, to);
  if (!editor.view.someProp("handleTextInput", (handle) => handle(editor.view, from, to, text, insert))) {
    editor.view.dispatch(insert());
  }
}
const typeText = (editor: Editor, text: string) => [...text].forEach((char) => textInput(editor, char));

function waitForElement<T extends Element = HTMLElement>(selector: string): Promise<T> {
  return waitFor(() => {
    const element = document.querySelector<T>(selector);
    expect(element).not.toBeNull();
    return element!;
  });
}

function openSlashMenu(editor: Editor, query = "") {
  editor.chain().focus().insertContent(`/${query}`).run();
  return screen.findByRole("listbox", { name: i18n._(msg`Slash commands`) });
}

async function openComponentProperties(name: string) {
  const component = await waitForElement(`[data-component-name="${name}"]`);
  fireEvent.click(within(component).getByRole("button", { name: `${name} properties` }));
  return { component, input: await screen.findByRole("textbox", { name: /title/i }) };
}

async function replaceEditorText(text: string) {
  getSurface().innerHTML = `<p>${text}</p>`;
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function injectCss(css: string) {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  onTestFinished(() => style.remove());
}

function overrideProperty(target: object, key: string, descriptor: PropertyDescriptor) {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  onTestFinished(() => {
    if (original) Object.defineProperty(target, key, original);
    else Reflect.deleteProperty(target, key);
  });
}

function stubPassiveIntersectionObserver() {
  vi.stubGlobal("IntersectionObserver", class {
    readonly root = null;
    readonly rootMargin = "0px";
    readonly thresholds = [0];
    disconnect = vi.fn();
    observe = vi.fn();
    unobserve = vi.fn();
    takeRecords = () => [];
  });
}

function stubElementsFromPoint(elements: Element[]) {
  const mock = vi.fn(() => elements);
  Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: mock });
  // Nested drag handles use ProseMirror's coordinate hit testing. jsdom has
  // no layout/caret hit-testing APIs, so resolve the same mocked hit stack
  // through the real editor DOM rather than fabricating a document position.
  const surface = elements.find((element) => element.classList.contains("ProseMirror"));
  const editor = (surface as (HTMLElement & { editor: Editor }) | undefined)?.editor;
  if (editor) {
    vi.spyOn(editor.view, "posAtCoords").mockImplementation(({ left, top }) => {
      const element = document.elementsFromPoint(left, top)[0];
      if (!element || !surface?.contains(element)) return null;
      const pos = editor.view.posAtDOM(element, 0);
      return { pos, inside: pos - 1 };
    });
  }
  return mock;
}

const SIMPLE_TABLE = "| Left | Right |\n| --- | --- |\n| A | B |";
const INFERRED_TABLE = ["| Group | Group | Metric |", "| --- | --- | --- |", "| Group | Group | 1 |", "| Other | Variant | 2 |"].join("\n");
const MERGED_LAYOUT_TABLE = [
  '<!-- lattice-table-layout:v1 {"spans":[[0,0,1,2]]} -->',
  "",
  "| Group | Group | Metric |",
  "| --- | --- | --- |",
  "| A | B | 1 |",
].join("\n");
const RADIO_TABLE = [
  "|  | Model | SA-Co/Gold | SA-Co/Gold | SA-Co/Gold | SA-Co/Gold | SA-Co/Gold | SA-Co/Gold | SA-Co/Gold | SA-Co/Gold |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  "|  | Model | metaclip_nps | sa1b_nps | crowded | fg_food | fg_sports_equipment | attributes | wiki_common | Avg |",
  "| C-RADIOv4 | SO400M-VDT8 | 43.0 | 44.5 | 54.9 | 38.4 | 38.4 | 40.3 | 22.2 | 40.3 |",
  "| C-RADIOv4 | SO400M-G | 43.8 | 45.7 | 55.9 | 40.1 | 39.8 | 41.6 | 23.1 | 41.4 |",
].join("\n");
const CONTENTS_MARKDOWN = [
  "## Contents", "- [Introduction](#introduction)", "- [Method](#method)", "",
  "## Introduction", "Opening context.", "", "## Method", "Experimental details.",
].join("\n");
const EMPTY_CALLOUT = "<Callout type=\"note\" collapsible={false} defaultOpen>\n\n</Callout>";
const TITLED_CALLOUT = "<Callout title=\"Initial\">\nBody\n</Callout>";
// An HTML comment reaches mdast without source positions, so the parser
// cannot say which bytes belong to which block, and restoreUnchangedBlocks
// has nothing it can safely splice. The two-space-indented paragraph after
// the footnote definition is then a real rewrite — its leading spaces do not
// survive the round trip — so the gate has to keep this document source-only.
const UNMAPPABLE_MARKDOWN = "<!-- c -->\n\n[^n]: First paragraph.\n\n  Not a continuation.\n";

describe("VisualMarkdownEditor", () => {
  describe("selection chrome and layout helpers", () => {
    it("hides native selection only for a NodeSelection, not ranges containing selected NodeViews", async () => {
      const { surface, editor } = renderEditor('Before\n\n<Callout type="note">\n\nInside\n\n</Callout>\n\nAfter\n');
      const hiddenSelectionSelectors = [...workspaceCss().replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{\s*background: transparent;\s*\}/g)]
        .map((match) => match[1])
        .filter((selector) => selector.includes(".visual-markdown-editor") && selector.includes("::selection"))
        .flatMap((selector) => selector.split(",").map((part) => part.replace("::selection", "").trim()));
      expect(hiddenSelectionSelectors.length).toBeGreaterThan(0);
      const hidesNativeSelection = () => hiddenSelectionSelectors.some((selector) =>
        surface.matches(selector) || surface.querySelector(selector) !== null);
      act(() => editor.commands.setNodeSelection(editor.state.doc.firstChild!.nodeSize));
      expect(surface).toHaveAttribute("data-node-selection", "true");
      expect(hidesNativeSelection()).toBe(true);
      act(() => editor.commands.selectAll());
      // Since @tiptap/react 3.31, a range that encloses NodeViews no longer
      // marks them ProseMirror-selectednode; only the NodeSelection target is.
      expect(surface.querySelector(".ProseMirror-selectednode")).toBeNull();
      expect(surface).toHaveAttribute("data-node-selection", "false");
      expect(hidesNativeSelection()).toBe(false);
      act(() => editor.commands.setTextSelection({ from: 2, to: editor.state.doc.content.size - 2 }));
      expect(surface).toHaveAttribute("data-node-selection", "false");
      expect(hidesNativeSelection()).toBe(false);
      act(() => editor.commands.setTextSelection(2));
      expect(surface).toHaveAttribute("data-node-selection", "false");
    });

    it.each([
      ["footnote", "Body[^note]\n\n[^note]: Last words.\n", ".footnote-backref", ".footnote-body"],
      ["code block", "Body\n\n```text\nLast words.\n```\n", ".ok-codeblock-chrome", ".ok-codeblock-pre"],
    ])("excludes trailing %s controls from native selection without excluding its content", async (_name, source, chromeSelector, contentSelector) => {
      const { surface, editor } = renderEditor(source);
      await waitFor(() => expect(surface.querySelector(chromeSelector)).not.toBeNull());
      // jsdom cannot reproduce Chromium's native AllSelection boundary bug.
      // Check the real DOM/CSS contract here; native selection paint also needs
      // browser verification with Cmd+A on a document ending in these blocks.
      const rule = workspaceCss().match(/\.visual-markdown-editor \.footnote-backref,[^{}]+\{[^}]+\}/);
      expect(rule).not.toBeNull();
      injectCss(rule![0]);
      expect(getComputedStyle(surface.querySelector(chromeSelector)!).userSelect).toBe("none");
      expect(getComputedStyle(surface.querySelector(contentSelector)!).userSelect).not.toBe("none");
      act(() => editor.commands.selectAll());
      expect(editor.state.selection).toBeInstanceOf(AllSelection);
      expect(editor.state.selection.content().content.textBetween(0, editor.state.doc.content.size)).toContain("Last words.");
    });

    it.each([
      ["table", "| A | B |\n| --- | --- |\n| C | D |\n", "A"],
      ["list", "- Item\n", "Item"],
      ["codeBlock", "```text\nExample\n```\n", "Example"],
    ])("does not append an unauthored paragraph after a final %s", async (type, source, firstText) => {
      const { editor, onChange } = renderEditor(source);
      act(() => editor.commands.focus("start"));
      expect(editor.state.doc.lastChild?.type.name).toBe(type);
      act(() => editor.commands.insertContentAt(nodePos(editor, (node) => node.isText), "X"));
      await waitFor(() => expect(onChange).toHaveBeenCalled());
      expect(editor.state.doc.lastChild?.type.name).toBe(type);
      expect(lastChange(onChange)).toBe(source.replace(firstText, `X${firstText}`));
    });

    it.each<[string, Parameters<typeof blockControlCrossAxisOffset>, number]>([
      ["to the first line of a two-line block", [48, 24], 2],
      ["to the first line of a taller block", [72, 24], 2],
      ["to a single-line block", [24, 24], 2],
      ["to the visible image instead of its outer node view", [260, 28, "jsxComponent", 16], 16],
      ["on a divider line", [1, 28, "thematicBreak"], -9.5],
    ])("aligns block controls %s", (_label, args, expected) => {
      expect(blockControlCrossAxisOffset(...args)).toBe(expected);
    });

    it("uses one adaptive synchronization policy for every Markdown preview", () => {
      expect(markdownPreviewSyncPolicy(1_000)).toEqual({ publicationIdleMs: 200, publicationMaxMs: 1_500, peerScrollSettleMs: 0 });
      expect(markdownPreviewSyncPolicy(LARGE_MARKDOWN_PREVIEW_THRESHOLD))
        .toEqual({ publicationIdleMs: 1_000, publicationMaxMs: 5_000, peerScrollSettleMs: 140 });
    });

    it("reveals an added block below the viewport with bottom breathing room", () => {
      const viewport = document.createElement("div");
      const anchor = document.createElement("p");
      const reveal = document.createElement("p");
      viewport.append(anchor, reveal);
      document.body.append(viewport);
      viewport.scrollTop = 480;
      setRect(viewport, rect(100, 600));
      setRect(anchor, rect(400, 450));
      const revealRect = setRect(reveal, rect(520, 580));
      restoreVisualViewportWithReveal(viewport, 480, anchor, 400, reveal);
      expect(viewport.scrollTop).toBe(480);
      revealRect.mockReturnValue(rect(590, 645));
      restoreVisualViewportWithReveal(viewport, 480, anchor, 400, reveal);
      expect(viewport.scrollTop).toBe(565);
    });
  });

  describe("section rail and paper contents", () => {
    it("builds an interactive section rail from rendered Markdown headings, including an authored Contents, but not for a single section", async () => {
      const { rerender } = renderEditor("# Example paper\n\n## Introduction\nOpening context.\n\n### Setup\nExperimental details.\n\n## Results\nThe result.");
      const navigation = screen.getByRole("navigation", { name: "Document sections" });
      expect(within(navigation).queryByRole("button", { name: "Example paper" })).toBeNull();
      const introduction = within(navigation).getByRole("button", { name: "Introduction" });
      const setup = within(navigation).getByRole("button", { name: "Setup" });
      const results = within(navigation).getByRole("button", { name: "Results" });
      expect(introduction).toHaveAttribute("aria-current", "location");
      expect(introduction).toHaveAttribute("tabindex", "0");
      expect(introduction).toHaveAttribute("data-depth", "0");
      expect(setup).toHaveAttribute("tabindex", "-1");
      expect(setup).toHaveAttribute("data-depth", "1");
      expect(results).toHaveAttribute("data-depth", "0");
      expect(document.querySelector(".visual-block-controls")).not.toBeNull();
      introduction.focus();
      fireEvent.keyDown(introduction, { key: "ArrowDown" });
      expect(setup).toHaveFocus();
      setRect(navigation, rect(100, 172));
      fireEvent.pointerMove(navigation, { clientY: 160, pointerType: "mouse" });
      expect(navigation.querySelector(".visual-heading-rail-preview-card")).toHaveTextContent("Results");
      const scrollIntoView = vi.spyOn(document.getElementById("results")!, "scrollIntoView");
      fireEvent.click(results);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
      // An author-written Contents section stays visible in ordinary Markdown.
      rerender({ text: CONTENTS_MARKDOWN });
      expect(await screen.findByRole("button", { name: "Contents" })).toBeInTheDocument();
      expect(document.querySelector(".visual-generated-paper-contents")).toBeNull();
      rerender({ text: "# Example\n\n## Only section\n\nBody." });
      await waitFor(() => expect(screen.queryByRole("navigation", { name: "Document sections" })).toBeNull());
    });

    it("keeps duplicate heading IDs aligned with the editor", () => {
      const items = documentHeadingItems({
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Repeat" }] },
          { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Repeat" }] },
        ],
      });
      expect(items.map(({ id, level }) => ({ id, level }))).toEqual([{ id: "repeat", level: 2 }, { id: "repeat-1", level: 3 }]);
    });

    it("hides a generated paper Contents block without breaking block controls", async () => {
      const { surface, editor } = renderEditor({ text: CONTENTS_MARKDOWN, ...PAPER });
      const hiddenContents = document.querySelectorAll(".visual-generated-paper-contents");
      expect(hiddenContents).toHaveLength(2);
      for (const hidden of hiddenContents) {
        expect(hidden).toHaveAttribute("aria-hidden", "true");
        expect(hidden).not.toHaveAttribute("hidden");
      }
      expect(screen.queryByRole("button", { name: "Contents" })).toBeNull();
      expect(screen.getByRole("button", { name: "Introduction" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Method" })).toBeInTheDocument();
      expect(editorMarkdown(editor)).toContain("## Contents");
      expect(editorMarkdown(editor)).toContain("[Introduction](#introduction)");
      const introduction = document.getElementById("introduction")!;
      setRect(surface.firstElementChild!, rect(100, 104));
      setRect(surface.lastElementChild!, rect(300, 328));
      setRect(introduction, rect(160, 188));
      stubElementsFromPoint([introduction, surface]);
      fireEvent.mouseMove(introduction, { clientX: 50, clientY: 174 });
      const controls = document.querySelector<HTMLElement>(".ok-block-controls")!;
      await waitFor(() => expect(controls.style.visibility).not.toBe("hidden"));
      expect(controls.style.pointerEvents).toBe("auto");
    });

    it("keeps generated Paper Contents hidden across a passive viewport chunk boundary", () => {
      renderEditor({
        ...PAPER,
        editable: false,
        text: [
          ...Array.from({ length: 11 }, (_, index) => `Preface ${index}.`),
          "## Contents", "- [Introduction](#introduction)", "- [Method](#method)",
          "## Introduction", "Opening context.", "## Method",
          ...Array.from({ length: 165 }, (_, index) => `Method detail ${index}: ${"content ".repeat(18)}`),
        ].join("\n\n"),
      });
      expect(screen.getByRole("document", { name: "Visual Markdown editor" })).toHaveAttribute("data-virtualized", "true");
      expect(document.querySelectorAll(".visual-generated-paper-contents")).toHaveLength(2);
    });
  });

  describe("virtualized reading", () => {
    it("keeps large read-only documents virtual until the complete surface is requested", async () => {
      const onOpenProjectPath = vi.fn();
      const { onChange } = renderEditor({
        text: [`[Open](other.md) ${"content ".repeat(14)}`, ...blocks(180).slice(1)].join("\n\n"),
        activePath: "large.md",
        onOpenProjectPath,
        editable: false,
      });
      const passive = screen.getByRole("document", { name: "Visual Markdown editor" });
      expect(passive).toHaveAttribute("data-virtualized", "true");
      expect(passive).toHaveTextContent("Open");
      expect(passive.querySelectorAll("[data-visual-chunk-id]").length).toBeGreaterThan(0);
      expect(passive.querySelectorAll("[data-visual-chunk-id]").length).toBeLessThan(10);
      expect(onChange).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("link", { name: "Open" }));
      expect(onOpenProjectPath).toHaveBeenCalledWith("other.md");
      expect(document.querySelector("[data-virtualized='true']")).not.toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Edit document" }));
      const complete = await screen.findByRole("textbox", { name: "Markdown document editor" });
      expect(complete).toHaveAttribute("contenteditable", "false");
      expect(document.querySelector("[data-virtualized='true']")).toBeNull();
      expect(onChange).not.toHaveBeenCalled();
    });

    it("resolves paper fragments after activating a virtualized paper", async () => {
      const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
      renderEditor({
        text: [
          `[Figure 10(a)](https://arxiv.org/html/2407.06438v3#S7.F10.sf1) ${"content ".repeat(14)}`,
          ...blocks(179).slice(1),
          '<a id="S7.F10"></a>\n\nFinal figure.',
        ].join("\n\n"),
        activePath: ".research/papers/2407.06438/paper.md",
        editable: false,
      });
      expect(screen.getByRole("document", { name: "Visual Markdown editor" })).toHaveAttribute("data-virtualized", "true");
      fireEvent.click(screen.getByRole("link", { name: "Figure 10(a)" }));
      await screen.findByRole("textbox", { name: "Markdown document editor" });
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" }));
      expect(opener.openUrl).not.toHaveBeenCalled();
    });

    it("opens arXiv when a virtualized paper has no converted fragment target", async () => {
      renderEditor({
        text: [`Table [8](#A0.T8) ${"content ".repeat(14)}`, ...blocks(180).slice(1)].join("\n\n"),
        activePath: ".research/papers/2606.11033/paper.md",
        editable: false,
      });
      expect(screen.getByRole("document", { name: "Visual Markdown editor" })).toHaveAttribute("data-virtualized", "true");
      fireEvent.click(screen.getByRole("link", { name: "8" }));
      await waitFor(() => expect(opener.openUrl).toHaveBeenCalledWith("https://arxiv.org/html/2606.11033#A0.T8"));
    });

    it("keeps one scroll geometry when a large editable document is clicked", () => {
      const { surface } = renderEditor(blocks(180).join("\n\n"));
      expect(surface).toHaveAttribute("contenteditable", "true");
      expect(document.querySelector("[data-virtualized='true']")).toBeNull();
    });

    it("renders passive formulas without an intermediate source placeholder", async () => {
      stubPassiveIntersectionObserver();
      const onLoadAsset = vi.fn(async () => "data:image/png;base64,AA==");
      const { unmount } = renderEditor({
        text: [
          "Inline $x^2$ appears before the first scroll.",
          "$$\n\\sum_{i=1}^{n} x_i\n$$",
          "![Deferred](images/deferred.png)",
          ...blocks(180),
        ].join("\n\n"),
        editable: false,
        onLoadAsset,
      });
      const passive = screen.getByRole("document", { name: "Visual Markdown editor" });
      let sawPlaceholder = false;
      const mutations = new MutationObserver(() => {
        sawPlaceholder ||= passive.querySelector(".math-placeholder") !== null;
      });
      mutations.observe(passive, { childList: true, subtree: true });
      expect(passive).toHaveAttribute("data-virtualized", "true");
      await waitFor(() => expect(passive.querySelectorAll(".katex")).toHaveLength(2));
      await Promise.resolve();
      mutations.disconnect();
      expect(sawPlaceholder).toBe(false);
      expect(passive.querySelector(".math-placeholder")).toBeNull();
      expect(onLoadAsset).not.toHaveBeenCalled();
      unmount();
    });
  });

  describe("Overleaf presence and carets", () => {
    const caret = () => waitForElement(".visual-overleaf-caret");

    it("draws Overleaf cursors and publishes the visual caret in Markdown coordinates", async () => {
      const onCaretChange = vi.fn();
      const { editor } = renderEditor({
        text: "# Hello",
        activePath: "presence-heading.md",
        presenceCursors: [{ ...ada(0, 4), color: "#0E7490" }],
        onCaretChange,
      });
      await waitFor(() => expect(document.querySelector(".visual-overleaf-caret-label")).toHaveTextContent("Ada"));
      expect(document.querySelector(".visual-overleaf-caret-label")).toHaveStyle({ backgroundColor: "#0E7490" });
      act(() => { editor.commands.setTextSelection(3); });
      await waitFor(() => expect(onCaretChange).toHaveBeenLastCalledWith(0, 4));
    });

    it("draws and updates an Overleaf cursor inside an editable code block", async () => {
      const codeTextBefore = (element: HTMLElement) => {
        const range = document.createRange();
        range.selectNodeContents(element.closest("code")!);
        range.setEndBefore(element);
        return range.toString();
      };
      const { rerender } = renderEditor({ text: "```js\nconst value = 1\n```", activePath: "presence-code.md", presenceCursors: [ada(1, 5)] });
      const firstCaret = await waitFor(() => {
        const element = document.querySelector<HTMLElement>(".visual-overleaf-caret");
        expect(element?.closest(".ok-codeblock-pre code")).not.toBeNull();
        return element!;
      });
      expect(codeTextBefore(firstCaret)).toBe("const");
      rerender({ presenceCursors: [ada(1, 11)] });
      await waitFor(() => {
        const moved = document.querySelector<HTMLElement>(".visual-overleaf-caret");
        expect(moved).not.toBe(firstCaret);
        expect(moved?.closest(".ok-codeblock-pre code")).not.toBeNull();
        expect(codeTextBefore(moved!)).toBe("const value");
      });
    });

    it("reveals preview source while an Overleaf cursor is inside its code", async () => {
      const { rerender } = renderEditor({
        text: "```html preview\n<p>Hello</p>\n```",
        activePath: "presence-preview-code.md",
        presenceCursors: [ada(1, 3)],
      });
      const block = await waitFor(() => {
        const element = document.querySelector<HTMLElement>('.ok-codeblock[data-language="html"]');
        expect(element).toHaveAttribute("data-code-visible", "true");
        expect(element?.querySelector(".visual-overleaf-caret")?.closest("code")).not.toBeNull();
        return element!;
      });
      rerender({ presenceCursors: [] });
      await waitFor(() => expect(block).toHaveAttribute("data-code-visible", "false"));
    });

    it.each([
      ["a code block opening fence", "```js\nconst value = 1\n```", 0, 1, ".ok-codeblock"],
      ["a code block closing fence", "```js\nconst value = 1\n```", 2, 1, ".ok-codeblock"],
      ["an image atom, rather than drawing it at the document start", "![Alt](image.png)", 0, 10, ".visual-markdown-editor"],
    ])("does not misplace an unmappable source-only cursor from %s", async (_label, text, row, column, readySelector) => {
      renderEditor({ text, activePath: "presence-source-only.md", presenceCursors: [ada(row, column)] });
      await waitForElement(readySelector);
      expect(document.querySelector(".visual-overleaf-caret")).toBeNull();
    });

    it("maps marked, nested, and emoji visual carets back to exact source columns", async () => {
      const onCaretChange = vi.fn();
      const { editor } = renderEditor({ text: "**bold**\n\n- one\n- two 😀", activePath: "presence-marks.md", onCaretChange });
      act(() => { editor.commands.setTextSelection(nodePos(editor, "bold") + 2); });
      await waitFor(() => expect(onCaretChange).toHaveBeenLastCalledWith(0, 4));
      act(() => { editor.commands.setTextSelection(nodePos(editor, "two 😀") + "two 😀".length); });
      await waitFor(() => expect(onCaretChange).toHaveBeenLastCalledWith(3, 8));
      act(() => { editor.commands.insertContent("!"); });
      await waitFor(() => expect(onCaretChange).toHaveBeenLastCalledWith(3, 9));
    });

    it.each([
      ["the original CRLF coordinate space", "A\r\n\r\nB\r\n", "presence-crlf.md", "B", 1, [2, 1]],
      ["an untouched MDX component body", '<Callout title="Exact">\n  Body\n</Callout>', "presence-mdx.md", "Body", 2, [1, 4]],
    ] as const)("publishes visual carets in %s", async (_label, text, activePath, node, offset, [row, column]) => {
      const onCaretChange = vi.fn();
      const { editor } = renderEditor({ text, activePath, onCaretChange });
      act(() => { editor.commands.setTextSelection(nodePos(editor, node) + offset); });
      await waitFor(() => expect(onCaretChange).toHaveBeenLastCalledWith(row, column));
    });

    it("does not confuse a visible heading hash with Markdown heading punctuation", async () => {
      renderEditor({ text: "# # Title", activePath: "presence-heading-hash.md", presenceCursors: [ada(0, 3)] });
      const element = await caret();
      expect(element.closest("h1")).not.toBeNull();
      expect(element.previousSibling).toHaveTextContent("#");
    });

    it("rebuilds a remote cursor after canonical Markdown is replaced", async () => {
      const { rerender } = renderEditor({ text: "First", activePath: "presence-reconcile.md", presenceCursors: [ada(0, 4)] });
      await waitFor(() => expect(document.querySelector(".visual-overleaf-caret")?.previousSibling).toHaveTextContent("Firs"));
      rerender({ text: "Second" });
      await waitFor(() => expect(document.querySelector(".visual-overleaf-caret")?.previousSibling).toHaveTextContent("Seco"));
    });

    it("keeps source positions after an inferred paper table aligned", async () => {
      const { rerender } = renderEditor({ text: "| Group | Group | Metric |\n| --- | --- | --- |\n| Group | Group | 1 |\n\nAfter table", ...PAPER, presenceCursors: [ada(4, 5)] });
      const element = await caret();
      expect(element.closest("p")).not.toBeNull();
      expect(element.closest("table")).toBeNull();
      rerender({ presenceCursors: [ada(2, 12)] });
      await waitFor(() => expect(document.querySelector(".visual-overleaf-caret")).toBeNull());
    });

    it("draws an Overleaf cursor inside the matching table cell without blocking local caret placement there", async () => {
      const { editor, onChange } = renderEditor({ text: SIMPLE_TABLE, activePath: "table-presence.md", presenceCursors: [ada(2, 3)] });
      const element = await caret();
      const cell = element.closest<HTMLTableCellElement>("td")!;
      expect(cell).toHaveTextContent("A");
      expect(element).not.toHaveAttribute("contenteditable");
      expect(element).not.toHaveClass("ProseMirror-widget");
      expect(element).toHaveAttribute("aria-hidden", "true");
      const textPosition = nodePos(editor, "A");
      expect(textPosition).toBeGreaterThan(0);
      editor.commands.setTextSelection(1);
      vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: textPosition, inside: -1 });
      expect(fireEvent.mouseDown(cell, { button: 0, clientX: 20, clientY: 20 })).toBe(true);
      expect(fireEvent.click(cell, { button: 0, clientX: 20, clientY: 20 })).toBe(false);
      expect(editor.state.selection.from).toBe(textPosition);
      expect(editor.state.selection.$from.node(-1).type.spec.tableRole).toMatch(/cell/);
      editor.commands.insertContent("X");
      await waitFor(() => expect(lastChange(onChange)).toContain("XA"));
    });

    it.each([3, 11])("maps an explicit merged cell cursor from source column %i to its visual origin", async (column) => {
      renderEditor({ text: MERGED_LAYOUT_TABLE, activePath: "explicit-table-presence.md", presenceCursors: [ada(2, column)] });
      const header = (await caret()).closest("th");
      expect(header).toBe(document.querySelector("th"));
      expect(header).toHaveAttribute("colspan", "2");
    });

    it.each([
      ["a delimiter-row cursor in its header cell", SIMPLE_TABLE, 1, "th"],
      ["a delimiter cursor below an escaped-pipe header", "| A \\| B | C |\n| --- | --- |\n| x | y |", 1, "th"],
      ["a delimiter cursor below an empty header", "| | Right |\n| --- | --- |\n| x | y |", 1, "th"],
      ["a delimiter cursor in a one-column table", "| Only |\n| --- |\n| x |", 1, "th"],
      ["a dash-only body row as a body row, not the delimiter", "| Left | Right |\n| --- | --- |\n| --- | --- |", 2, "td"],
    ])("anchors %s", async (_label, text, row, cellSelector) => {
      renderEditor({ text, activePath: "table-delimiter-presence.md", presenceCursors: [ada(row, 3)] });
      expect((await caret()).closest(cellSelector)).toBe(document.querySelector(cellSelector));
    });
  });

  describe("comments and tracked changes", () => {
    const comment = (overrides: object = {}) => ({
      id: "c1", path: "commented.md", from: 10, to: 19, quote: "brown fox", prefix: "quick ", suffix: " jumps",
      body: "why this one?", authorId: "ada", authorName: "Ada", resolved: false, replies: [],
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...overrides,
    });
    const suggestion = (id: string, overrides: object = {}) => ({
      id, position: 1, text: "ell", deletion: false, userId: "ada", timestamp: null, hue: 210, ...overrides,
    });
    const trackActions = () => ({ authorName: vi.fn(() => "Ada"), canAct: vi.fn(() => true), onAccept: vi.fn(), onReject: vi.fn() });
    const changeMark = (id: string) => document.querySelector<HTMLElement>(`[data-visual-change-id='${id}']`)!;

    it.each([true, false])("previews a comment and replies on hover without opening the sidebar (editable=%s)", async (editable) => {
      const onEditorCommentClick = vi.fn();
      const { unmount } = renderEditor({
        text: "The quick brown fox jumps.",
        activePath: "commented.md",
        editable,
        editorComments: [comment({
          replies: [{ id: "r1", authorId: "grace", authorName: "Grace", body: "Because it is the example.", createdAt: "2026-01-02T00:00:00.000Z" }],
        }), comment({ id: "c2", from: 4, to: 9, quote: "quick", prefix: "The ", suffix: " brown", resolved: true })],
        onEditorCommentClick,
      });
      const mark = await waitForElement("[data-visual-comment-id='c1']");
      // The highlight covers the quoted prose, not the whole paragraph; a resolved comment stays unpainted.
      expect(mark.textContent).toBe("brown fox");
      expect(document.querySelector("[data-visual-comment-id='c2']")).toBeNull();
      fireEvent.mouseOver(mark);
      const tooltip = await screen.findByRole("tooltip");
      expect(mark).toBeInTheDocument();
      expect(mark).toHaveAttribute("aria-describedby", tooltip.id);
      for (const text of ["Ada", "why this one?", "Grace", "Because it is the example."]) expect(tooltip).toHaveTextContent(text);
      expect(onEditorCommentClick).not.toHaveBeenCalled();
      fireEvent.mouseOut(mark, { relatedTarget: tooltip });
      fireEvent.mouseEnter(tooltip);
      expect(screen.getByRole("tooltip")).toBe(tooltip);
      fireEvent.keyDown(mark, { key: "Escape" });
      expect(screen.queryByRole("tooltip")).toBeNull();
      fireEvent.focusIn(mark);
      await screen.findByRole("tooltip");
      fireEvent.click(mark);
      expect(onEditorCommentClick).toHaveBeenCalledWith("c1");
      expect(screen.queryByRole("tooltip")).toBeNull();
      fireEvent.mouseOver(mark);
      fireEvent.mouseOut(mark, { relatedTarget: document.body });
      fireEvent.mouseOver(mark);
      await screen.findByRole("tooltip");
      fireEvent.scroll(document);
      expect(screen.queryByRole("tooltip")).toBeNull();
      fireEvent.focusIn(mark);
      await screen.findByRole("tooltip");
      unmount();
      expect(screen.queryByRole("tooltip")).toBeNull();
    });

    it("highlights an Overleaf suggestion and exposes accept and reject actions", async () => {
      const change = suggestion("suggestion-1");
      const actions = trackActions();
      renderEditor({ activePath: "presence-suggestion.md", overleafChanges: [change], overleafTrackChangeActions: actions });
      const mark = await waitForElement("[data-visual-change-id='suggestion-1']");
      expect(mark).toHaveClass("visual-tracked-change-insert");
      expect(mark).toHaveTextContent("ell");
      fireEvent.mouseOver(mark);
      expect(await screen.findByText("Ada")).toBeInTheDocument();
      fireEvent.mouseOver(mark.parentElement!);
      expect(screen.getByRole("dialog", { name: "Suggested change" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Accept" }));
      expect(actions.onAccept).toHaveBeenCalledWith(change);
      fireEvent.mouseOver(changeMark("suggestion-1"));
      expect(await screen.findByText("Ada")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Reject" }));
      expect(actions.onReject).toHaveBeenCalledWith(change);
    });

    it("keeps suggestion actions open across the popover gap and while keyboard-open, restoring trigger focus", async () => {
      renderEditor({ activePath: "suggestion-hover.md", overleafChanges: [suggestion("suggestion-hover")], overleafTrackChangeActions: trackActions() });
      const mark = await waitForElement("[data-visual-change-id='suggestion-hover']");
      setRect(mark, { left: 100, right: 150, top: 100, bottom: 120 } as DOMRect);
      fireEvent.mouseOver(mark);
      const popover = await screen.findByRole("dialog", { name: "Suggested change" });
      setRect(popover, { left: 100, right: 280, top: 60, bottom: 90 } as DOMRect);
      fireEvent.pointerMove(window, { clientX: 110, clientY: 95 });
      await new Promise((resolve) => setTimeout(resolve, 220));
      expect(popover).toBeInTheDocument();
      fireEvent.pointerMove(window, { clientX: 1000, clientY: 1000 });
      await waitFor(() => expect(popover).not.toBeInTheDocument());
      // Opened from the keyboard, the same pointer departure must not close it.
      mark.focus();
      fireEvent.keyDown(mark, { key: "Enter" });
      const accept = await screen.findByRole("button", { name: "Accept" });
      await waitFor(() => expect(accept).toHaveFocus());
      fireEvent.pointerMove(window, { clientX: 1000, clientY: 1000 });
      await new Promise((resolve) => setTimeout(resolve, 220));
      expect(accept).toBeInTheDocument();
      fireEvent.keyDown(accept, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Suggested change" })).toBeNull());
      expect(mark).toHaveFocus();
    });

    it("renders deleted suggestion text at its zero-width Overleaf anchor", async () => {
      renderEditor({
        activePath: "presence-deletion.md",
        overleafChanges: [suggestion("deletion-1", { text: "removed", deletion: true })],
        overleafTrackChangeActions: trackActions(),
      });
      await waitFor(() => expect(document.querySelector("[data-visual-change-id='deletion-1']")).toHaveTextContent("removed"));
      expect(changeMark("deletion-1")).toHaveClass("visual-tracked-change-delete");
      expect(changeMark("deletion-1").parentElement).toHaveTextContent("Hremovedello");
    });

    it("rebuilds and acts on the latest suggestion after a canonical update", async () => {
      const initial = suggestion("suggestion-moving", { text: "irs" });
      const shifted = { ...initial, position: 2, text: "con" };
      const actions = trackActions();
      const { rerender } = renderEditor({ text: "First", activePath: "suggestion-reconcile.md", overleafChanges: [initial], overleafTrackChangeActions: actions });
      await waitFor(() => expect(document.querySelector("[data-visual-change-id='suggestion-moving']")).toHaveTextContent("irs"));
      rerender({ text: "Second", overleafChanges: [shifted] });
      await waitFor(() => expect(document.querySelector("[data-visual-change-id='suggestion-moving']")).toHaveTextContent("con"));
      fireEvent.mouseOver(changeMark("suggestion-moving"));
      fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
      expect(actions.onReject).toHaveBeenCalledWith(shifted);
    });

    it.each([
      [false, "submit"], [true, "submit"], [false, "cancel"], [true, "escape"],
    ] as const)("marks a Markdown comment draft with pending edit %s and %s", async (pendingEdit, action) => {
      const onCreateComment = vi.fn();
      const { surface, editor } = renderEditor({ onCreateComment });
      focusText(editor, 1, 6);
      const commentButton = await screen.findByRole("button", { name: "Comment" });
      if (pendingEdit) {
        act(() => {
          const transaction = editor.state.tr.insertText("New ", 1);
          transaction.setSelection(TextSelection.create(transaction.doc, 5, 10));
          editor.view.dispatch(transaction);
        });
      }
      fireEvent.click(commentButton);
      const composer = await screen.findByRole("dialog", { name: "Add comment" });
      expect(surface.querySelector(".editor-comment-draft")?.textContent).toBe("Hello");
      expect(onCreateComment).not.toHaveBeenCalled();
      if (action === "cancel") fireEvent.click(within(composer).getByRole("button", { name: "Cancel" }));
      else if (action === "escape") fireEvent.keyDown(within(composer).getByRole("textbox", { name: "Comment" }), { key: "Escape" });
      else {
        fireEvent.change(within(composer).getByRole("textbox", { name: "Comment" }), { target: { value: "Please clarify this." } });
        fireEvent.click(within(composer).getByRole("button", { name: "Add comment" }));
        expect(onCreateComment).toHaveBeenCalledWith(pendingEdit ? 4 : 0, pendingEdit ? 9 : 5, "Please clarify this.");
      }
      if (action !== "submit") expect(onCreateComment).not.toHaveBeenCalled();
      expect(surface.querySelector(".editor-comment-draft")).toBeNull();
    });

    it.each([
      { text: "## Intro\n\nA paragraph\n- one\n- two\n\nText", wholeDocument: false },
      { text: "## Intro\r\n\r\nA paragraph\r\n- one\r\n- two\r\n\r\nText", wholeDocument: false },
      { text: "## Intro\n\nA paragraph\n- one\n- two\n\nText", wholeDocument: true },
    ])("anchors comments without normalizing tight Markdown blocks: %j", async ({ text, wholeDocument }) => {
      const onCreateComment = vi.fn();
      const { editor, onChange } = renderEditor({ text, onCreateComment });
      // The preceding heading occupies seven PM positions, independent of the
      // source's newline convention. Source offsets must retain those bytes.
      act(() => {
        editor.view.focus();
        editor.view.dispatch(editor.state.tr.setSelection(wholeDocument
          ? new AllSelection(editor.state.doc)
          : TextSelection.create(editor.state.doc, 8, 19)));
      });
      const button = await screen.findByRole("button", { name: "Comment" });
      fireEvent.mouseDown(button);
      fireEvent.mouseUp(button);
      fireEvent.click(button);
      const composer = await screen.findByRole("dialog", { name: "Add comment" });
      const quote = wholeDocument ? text : "A paragraph";
      expect(composer.querySelector(".editor-comment-quote")?.textContent).toBe(quote);
      fireEvent.change(within(composer).getByRole("textbox", { name: "Comment" }), { target: { value: "Clarify this paragraph." } });
      fireEvent.click(within(composer).getByRole("button", { name: "Add comment" }));
      const from = wholeDocument ? 0 : text.indexOf("A paragraph");
      expect(onCreateComment).toHaveBeenCalledWith(from, from + quote.length, "Clarify this paragraph.");
      expect(onChange).not.toHaveBeenCalled();
    });

    it("keeps comments available while the visual document is read-only", async () => {
      const { surface, editor } = renderEditor({ editable: false, onCreateComment: vi.fn() });
      expect(surface).toHaveAttribute("contenteditable", "false");
      selectText(editor, 1, 6);
      expect(await screen.findByRole("button", { name: "Comment" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: "Bold" })).not.toBeInTheDocument();
    });
  });

  describe("paper links and anchors", () => {
    it("keeps converter anchors invisible and lossless in visual mode", async () => {
      const markdown = '<a id="S3.F1"></a>\n\n![Figure](paper_assets/figure.png)\n\n*Figure 1: Model overview.*\n\nSee Figure [1](#S3.F1).\n';
      const { surface, editor } = renderEditor(markdown);
      await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "true"));
      const target = document.querySelector<HTMLElement>('[data-markdown-anchor][id="S3.F1"]');
      expect(target).not.toBeNull();
      expect(screen.queryByText('<a id="S3.F1"></a>')).not.toBeInTheDocument();
      expect(screen.queryByText(/Visual editing is unavailable/)).not.toBeInTheDocument();
      expect(editorMarkdown(editor)).toBe(markdown);
      const scrollIntoView = vi.spyOn(target!, "scrollIntoView");
      fireEvent.click(screen.getByRole("link", { name: "1" }));
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    });

    it("keeps same-paper arXiv links local, falling subfigures back to their figure, and opens arXiv for omitted fragments", async () => {
      const { surface } = renderEditor({
        text: '<a id="S7.F10"></a>\n\n![Figure](paper_assets/figure.png)\n\nSee Figure [10(a)](https://arxiv.org/html/2407.06438v3#S7.F10.sf1) and Table [8](#A0.T8).\n',
        activePath: ".research/papers/2407.06438/paper.md",
      });
      await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "true"));
      const scrollIntoView = vi.spyOn(document.querySelector<HTMLElement>('[data-markdown-anchor][id="S7.F10"]')!, "scrollIntoView");
      fireEvent.click(screen.getByRole("link", { name: "10(a)" }));
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
      expect(opener.openUrl).not.toHaveBeenCalled();
      // A fragment the converter omitted opens arXiv instead of doing nothing.
      fireEvent.click(screen.getByRole("link", { name: "8" }));
      expect(opener.openUrl).toHaveBeenCalledWith("https://arxiv.org/html/2407.06438#A0.T8");
    });

    it.each([
      ["space escape", "./Agent%20Memory.md", "notes/Agent Memory.md"],
      ["UTF-8 escapes", "./%E7%A0%94%E7%A9%B6.md", "notes/研究.md"],
      ["escaped slash", "./a%2Fb.md", "notes/a%2Fb.md"],
      ["escaped backslash", "./a%5Cb.md", "notes/a%5Cb.md"],
      ["escaped current-directory segment", "./%2E/secret.md", "notes/%2E/secret.md"],
      ["escaped parent-directory segment", "./%2E%2E/secret.md", "notes/%2E%2E/secret.md"],
      ["malformed escape", "./100%ZZ.md", "notes/100%ZZ.md"],
      ["fragment", "./Agent%20Memory.md#section", "notes/Agent Memory.md"],
      ["literal parent segment", "../sibling/file.md", "sibling/file.md"],
    ])("opens a relative project link containing %s on an ordinary click", async (_case, href, expectedPath) => {
      const onOpenProjectPath = vi.fn();
      renderEditor({ text: `[Details](${href})`, activePath: "notes/index.md", onOpenProjectPath });
      fireEvent.click(await screen.findByRole("link", { name: "Details" }));
      expect(onOpenProjectPath).toHaveBeenCalledWith(expectedPath);
    });
  });

  describe("publication and file switching", () => {
    it.each([
      ["in Paper reading mode", PAPER, 1_500],
      ["outside reading mode", {}, 1_000],
    ])("coalesces rapid edits into one deferred publication %s, and flushes a pending edit on unmount", async (_label, props, timeout) => {
      const { editor, onChange, unmount } = renderEditor(props);
      act(() => {
        editor.commands.insertContentAt(6, " a");
        editor.commands.insertContentAt(8, " b");
        editor.commands.insertContentAt(10, " c");
      });
      await Promise.resolve();
      expect(onChange).not.toHaveBeenCalled();
      await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1), { timeout });
      expect(onChange).toHaveBeenCalledWith("Hello a b c", "Hello");
      // A mode or tab unmount publishes the still-pending edit immediately.
      act(() => editor.commands.insertContentAt(12, " final"));
      unmount();
      expect(onChange).toHaveBeenLastCalledWith("Hello a b c final", "Hello a b c");
    });

    it("reuses the TipTap instance when switching files and does not let Undo restore the previous file", async () => {
      const onUndo = vi.fn(() => true);
      const { surface, editor, rerender } = renderEditor({ text: "Alpha document", activePath: "a.md", onUndo });
      act(() => editor.commands.insertContentAt(15, " edited"));
      expect(surface).toHaveTextContent("Alpha document edited");
      rerender({ text: "Beta document", activePath: "b.md" });
      const next = getSurface();
      expect(next.editor).toBe(editor);
      expect(screen.getByLabelText("Visual Markdown editor")).toHaveAttribute("aria-busy", "true");
      expect(next).toHaveAttribute("contenteditable", "false");
      await waitFor(() => expect(next).toHaveTextContent("Beta document"));
      expect(next).not.toHaveTextContent("Alpha document");
      expect(next).toHaveAttribute("contenteditable", "true");
      // History is delegated to the host. After a path swap, Mod-z must not
      // walk TipTap's previous-file stack back to Alpha.
      act(() => { next.editor.commands.keyboardShortcut("Mod-z"); });
      expect(onUndo).toHaveBeenCalledOnce();
      expect(next).toHaveTextContent("Beta document");
      expect(next).not.toHaveTextContent("Alpha");
    });

    /** Mounts "Alpha" at a.md; `latestFlush()` reads the ownership hand-off the editor last registered. */
    function renderWithFlush(onChange?: ChangeMock) {
      const onFlushPendingChange = vi.fn<(flush: (() => boolean) | null) => void>();
      const view = renderEditor({ text: "Alpha", activePath: "a.md", onFlushPendingChange }, onChange);
      return { view, onFlushPendingChange, latestFlush: () => onFlushPendingChange.mock.lastCall?.[0] };
    }

    it("lets the file-transition owner flush an edit before changing paths", () => {
      const { view, onFlushPendingChange, latestFlush } = renderWithFlush();
      act(() => view.editor.commands.insertContentAt(6, " edit"));
      const flush = latestFlush();
      expect(flush).toBeTypeOf("function");
      let accepted = false;
      act(() => { accepted = flush?.() ?? false; });
      expect(accepted).toBe(true);
      expect(view.onChange).toHaveBeenCalledWith("Alpha edit", "Alpha");
      view.unmount();
      expect(onFlushPendingChange).toHaveBeenLastCalledWith(null);
    });

    it("does not hand document ownership away during an IME composition", async () => {
      const { view, latestFlush } = renderWithFlush();
      const { surface } = view;
      const flush = latestFlush();
      fireEvent.compositionStart(surface);
      expect(flush?.()).toBe(false);
      fireEvent.compositionEnd(surface);
      // WebKit can send the Enter that commits a candidate immediately after
      // compositionend. Ownership remains blocked through that event turn, then
      // becomes transferable once the composition guard clears.
      expect(flush?.()).toBe(false);
      await waitFor(() => expect(flush?.()).toBe(true));
    });

    it("allows ownership changes after a rejected draft has been preserved", () => {
      const { view, latestFlush } = renderWithFlush(vi.fn(() => false));
      act(() => view.editor.commands.insertContentAt(6, " edit"));
      const flush = latestFlush();
      const results: boolean[] = [];
      act(() => { results.push(flush?.() ?? true); });
      act(() => { results.push(flush?.() ?? true); });
      expect(results).toEqual([false, true]);
    });

    it("publishes a pending edit for the previous file when the path switches", async () => {
      const publishes: { path: string; next: string; expected: string }[] = [];
      function Harness({ path, text }: { path: string; text: string }) {
        // Recreate the publisher when the path prop changes so changeRef from the
        // previous commit still publishes against the old file during layout flush.
        const publisher = useMemo(() => (next: string, expected: string) => {
          publishes.push({ path, next, expected });
          return true;
        }, [path]);
        return <VisualMarkdownEditor {...editorProps({ text, activePath: path, onChangeMarkdown: publisher })} />;
      }
      const view = render(<Harness path="a.md" text="Alpha" />);
      act(() => getSurface().editor.commands.insertContentAt(6, " edit"));
      act(() => { view.rerender(<Harness path="b.md" text="Beta" />); });
      expect(publishes).toEqual([{ path: "a.md", next: "Alpha edit", expected: "Alpha" }]);
      await waitFor(() => expect(getSurface()).toHaveTextContent("Beta"));
    });

    it("swaps files that share identical body text", async () => {
      const { surface, editor, rerender } = renderEditor({ text: "Same body", activePath: "a.md" });
      act(() => editor.commands.insertContentAt(10, "!"));
      expect(surface).toHaveTextContent("Same body!");
      rerender({ activePath: "b.md" });
      const next = getSurface();
      expect(next.editor).toBe(editor);
      await waitFor(() => expect(next).not.toHaveTextContent("Same body!"));
      expect(next).toHaveTextContent("Same body");
    });

    it("restores the retained editor when a scheduled file swap is cancelled", async () => {
      const { surface, rerender } = renderEditor({ text: "Alpha", activePath: "a.md" });
      await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "true"));
      rerender({ text: "Beta", activePath: "b.md" });
      expect(surface).toHaveAttribute("contenteditable", "false");
      rerender({ text: "Alpha", activePath: "a.md" });
      await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "true"));
      expect(surface).toHaveTextContent("Alpha");
      expect(surface).not.toHaveTextContent("Beta");
    });

    it("constructs file-switch NodeViews outside React lifecycle methods", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { rerender } = renderEditor({ text: "Alpha", activePath: "a.md" });
      rerender({ text: "![Plot](figure.png)", activePath: "b.md" });
      expect(screen.queryByText("Opening document…")).toBeNull();
      expect(document.querySelector(".visual-markdown-loading")).toHaveAttribute("aria-hidden", "true");
      await screen.findByRole("img", { name: "Plot" });
      expect(consoleError.mock.calls.some((call) => String(call[0]).includes("flushSync was called from inside a lifecycle method"))).toBe(false);
    });

    it("uses the last accepted Markdown for rapid consecutive visual edits", async () => {
      const { editor, onChange } = renderEditor("Start");
      editor.commands.setContent("First", { contentType: "markdown" });
      editor.commands.setContent("Second", { contentType: "markdown" });
      await waitFor(() => expect(onChange).toHaveBeenCalledWith("Second", "Start"));
      expect(onChange).toHaveBeenCalledOnce();
    });
  });

  describe("canonical updates and rejected drafts", () => {
    /** The rejected-draft notice offers the complete draft behind an explicit Copy draft action. */
    async function expectDraftNotice(draft: string) {
      await waitFor(() => expect(notifications.error).toHaveBeenCalled());
      const options = notifications.error.mock.calls.at(-1)![2];
      // The ordinary Copy action remains an error-report action. The rejected
      // document has an explicit label so nobody mistakes one payload for the other.
      expect(options.copyText).toBeUndefined();
      expect(options.primaryAction.label).toBe("Copy draft");
      await options.primaryAction.onClick();
      expect(clipboard.writeText).toHaveBeenCalledWith(draft);
      return options;
    }

    it.each([
      ["Hello", "Changed"],
      ["Hello\r\n", "Changed\r\n"],
    ])("reports Markdown when the rendered paragraph is directly edited, keeping CRLF and a final newline: %j", async (text, expected) => {
      const { onChange } = renderEditor(text);
      expect(screen.queryByRole("button", { name: "Edit Markdown source" })).not.toBeInTheDocument();
      await replaceEditorText("Changed");
      await waitFor(() => expect(onChange).toHaveBeenCalledWith(expected, text));
    });

    it("keeps a BOM and final-newline envelope pristine and writes one exact CAS update on edit", async () => {
      const { editor, onChange } = renderEditor("\uFEFFHello\n");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onChange).not.toHaveBeenCalled();
      editor.view.dispatch(editor.state.tr.insertText(" world", 6));
      await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
      expect(onChange).toHaveBeenCalledWith("\uFEFFHello world\n", "\uFEFFHello\n");
    });

    it.each(["**nknk**", "**. nknk**", "中文 **粗体** 内容"])("keeps authored bold text visual across a canonical rerender: %s", async (markdown) => {
      const { surface, rerender } = renderEditor(markdown);
      expect(surface.querySelector("strong")).not.toBeNull();
      expect(surface).not.toHaveTextContent("**");
      rerender({ text: `${markdown}\n` });
      await waitFor(() => expect(surface.querySelector("strong")).not.toBeNull());
      expect(surface).not.toHaveTextContent("**");
    });

    it("does not report an external text update and delegates history to the canonical document", async () => {
      const onUndo = vi.fn(() => true);
      const onRedo = vi.fn(() => true);
      const { onChange, rerender } = renderEditor({ onUndo, onRedo });
      rerender({ text: "External" });
      const surface = getSurface();
      await waitFor(() => expect(surface).toHaveTextContent("External"));
      await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "true"));
      expect(screen.queryByText("unsupported or lossy syntax", { exact: false })).not.toBeInTheDocument();
      surface.editor.commands.keyboardShortcut("Mod-z");
      surface.editor.commands.keyboardShortcut("Mod-Shift-z");
      expect(onUndo).toHaveBeenCalledOnce();
      expect(onRedo).toHaveBeenCalledOnce();
      expect(onChange).not.toHaveBeenCalled();
    });

    it("rebases a rejected local draft over a disjoint remote edit without dropping either", async () => {
      const { surface, editor, onChange, rerender } = renderEditor("Alpha middle Omega", vi.fn(() => false));
      editor.view.dispatch(editor.state.tr.insertText(" tail", editor.state.doc.content.size - 1));
      await waitFor(() => expect(onChange).toHaveBeenCalledWith("Alpha middle Omega tail", "Alpha middle Omega"));
      onChange.mockImplementation(() => true);
      rerender({ text: "Prefix Alpha middle Omega" });
      await waitFor(() => expect(onChange).toHaveBeenCalledWith("Prefix Alpha middle Omega tail", "Prefix Alpha middle Omega"));
      await waitFor(() => expect(surface).toHaveTextContent("Prefix Alpha middle Omega tail"));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("accepts an agent edit without mistaking passive editor normalization for a draft", async () => {
      const { surface, editor, onChange, rerender } = renderEditor("## Scope\n- **Measures**: Initial result\n");
      await waitFor(() => expect(screen.getByRole("textbox")).toHaveTextContent("Initial result"));
      act(() => { editor.view.dispatch(editor.state.tr.insertText("Passive ", 1).setMeta("preventUpdate", true)); });
      expect(surface).toHaveTextContent("Passive");
      rerender({ text: "## Scope\n- **Measures**: Agent revision\n", onChangeMarkdown: () => true });
      await waitFor(() => expect(screen.getByRole("textbox")).toHaveTextContent("Agent revision"));
      expect(onChange).not.toHaveBeenCalled();
      expect(notifications.error).not.toHaveBeenCalled();
    });

    it("keeps remote canonical text authoritative and exposes the complete rejected draft", async () => {
      const { rerender } = renderEditor("Canonical", vi.fn(() => false));
      await replaceEditorText("Conflicting");
      rerender({ text: "Shared canonical" });
      await waitFor(() => expect(screen.getByRole("textbox")).toHaveTextContent("Shared canonical"));
      const options = await expectDraftNotice("Conflicting");
      expect(options.secondaryAction.label).toBe("Restore draft and retry");
    });

    it("preserves an IME draft across a remote canonical update at compositionend", async () => {
      const { surface, rerender } = renderEditor("Original", vi.fn(() => false));
      fireEvent.compositionStart(surface);
      await replaceEditorText("完整的本地草稿");
      rerender({ text: "Remote canonical" });
      expect(surface).toHaveTextContent("完整的本地草稿");
      fireEvent.compositionEnd(surface);
      // The failure is reported through the app's notifications rather than as a
      // bar inside the document, and it carries both ways out of it.
      await waitFor(() => expect(surface).toHaveTextContent("Remote canonical"));
      const options = await expectDraftNotice("完整的本地草稿");
      expect(options.timeoutMs).toBe(0);
      act(() => { void options.secondaryAction.onClick(); });
      expect(surface).toHaveTextContent("完整的本地草稿");
    });
  });

  describe("block insertion and controls", () => {
    it("adds a slash block without unnecessary split preview movement", async () => {
      const onRequestViewportLock = vi.fn();
      const { surface, editor } = renderEditor({ text: "First\n\nSecond", onRequestViewportLock });
      const viewport = surface.closest<HTMLElement>(".visual-markdown-editor")!;
      viewport.classList.add("editor-doc-scroll");
      viewport.scrollTop = 480;
      const localScrollWrites: number[] = [];
      Object.defineProperty(viewport, "scrollTop", {
        configurable: true,
        get: () => 480,
        set: (value: number) => localScrollWrites.push(value),
      });
      const transactions: boolean[] = [];
      let preserveViewport: PreserveVisualViewportMeta | undefined;
      const dispatch = editor.view.dispatch.bind(editor.view);
      vi.spyOn(editor.view, "dispatch").mockImplementation((transaction) => {
        transactions.push(transaction.scrolledIntoView);
        preserveViewport = transaction.getMeta(PRESERVE_VISUAL_VIEWPORT_META) ?? preserveViewport;
        dispatch(transaction);
      });

      addBlockBelow(editor, 0, editor.state.doc.firstChild!);

      expect(transactions[0]).toBe(false);
      expect(localScrollWrites).toEqual([]);
      expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
      expect(editor.state.selection.$from.parent.textContent).toBe("/");
      expect(editor.state.selection.$from.parentOffset).toBe(1);
      expect(editor.state.selection.from).toBe(editor.state.doc.firstChild!.nodeSize + 2);
      expect(window.getSelection()?.anchorNode?.textContent).toBe("/");
      expect(window.getSelection()?.anchorOffset).toBe(1);
      expect(onRequestViewportLock).toHaveBeenCalledTimes(1);
      const [firstAnchor, firstAnchorTop] = onRequestViewportLock.mock.calls[0] as [HTMLElement, number];
      expect(firstAnchor).toHaveTextContent("First");
      const shiftedAnchor = document.createElement("p");
      shiftedAnchor.textContent = "First";
      document.body.append(shiftedAnchor);
      setRect(shiftedAnchor, rect(firstAnchorTop - 36, firstAnchorTop + 12));
      const nodeDom = editor.view.nodeDOM.bind(editor.view);
      vi.spyOn(editor.view, "nodeDOM").mockImplementation((position) => (
        position === preserveViewport?.anchorPosition ? shiftedAnchor : nodeDom(position)
      ));
      expect(await screen.findByRole("listbox", { name: "Slash commands" })).toBeInTheDocument();
      await waitFor(() => expect(onRequestViewportLock).toHaveBeenCalledTimes(2));
      const [deferredAnchor, deferredAnchorTop] = onRequestViewportLock.mock.calls[1] as [HTMLElement | null, number];
      // The first lock may intentionally scroll down to reveal the inserted row.
      // Deferred publication must preserve that new position, not restore the
      // clicked block's pre-insertion screen coordinate.
      expect(deferredAnchor).not.toBeNull();
      expect(deferredAnchor).toHaveTextContent("First");
      expect(deferredAnchorTop).toBe(firstAnchorTop - 36);
      await waitFor(() => expect(viewport.scrollTop).toBe(480));
    });

    it("keeps the Paper reading caret after the inserted slash", () => {
      const { surface, editor } = renderEditor({ text: "First\n\nSecond", ...PAPER });
      addBlockBelow(editor, 0, editor.state.doc.firstChild!);
      expect(surface.children[1]).toHaveTextContent("/");
      expect(surface.children[1]).toHaveClass("ok-chunk-wrapper", "ok-chunk-active");
      expect(editor.state.selection.$from.parentOffset).toBe(1);
      expect(window.getSelection()?.anchorNode?.textContent).toBe("/");
      expect(window.getSelection()?.anchorOffset).toBe(1);
    });

    it("keeps tutorial fenced-code bodies when the block plus action adds a slash paragraph", async () => {
      const { editor, onChange } = renderEditor(tutorialMarkdown);
      await waitFor(() => expect(document.querySelectorAll(".ok-codeblock")).toHaveLength(3));
      await waitFor(() => {
        const callout = document.querySelector<HTMLElement>('[data-component-name="Callout"]');
        const accordion = document.querySelector<HTMLElement>('[data-component-name="Accordion"]');
        expect(callout?.querySelector(".callout-body")).toHaveTextContent("Attention weights show routing patterns");
        expect(accordion?.querySelector(".accordion-body")).toHaveTextContent("Scaling keeps the softmax distribution");
        expect(accordion?.querySelector("details.accordion")).toHaveAttribute("open");
      });
      expect(screen.getByRole("img", { name: "Scaled dot-product attention from Figure 2 of the Transformer paper" })
        .closest(".ok-image-resizable")).toHaveStyle({ width: "223px" });

      act(() => addBlockBelow(editor, 0, editor.state.doc.firstChild!));

      await waitFor(() => expect(onChange).toHaveBeenCalled());
      const codeNodes: string[] = [];
      editor.state.doc.descendants((node) => {
        if (node.type.name === "codeBlock") codeNodes.push(node.textContent);
      });
      const codeSnippets = ["scores = queries", "flowchart LR", "Select a query token"];
      codeSnippets.forEach((snippet, index) => expect(codeNodes[index]).toContain(snippet));
      expect(Array.from(document.querySelectorAll(".ok-codeblock-pre"), (node) => node.textContent))
        .toEqual(expect.arrayContaining(codeSnippets.map((snippet) => expect.stringContaining(snippet))));
      // Every fenced code body, both components, and the sized figure survive verbatim.
      const output = lastChange(onChange);
      const kept = tutorialMarkdown.match(/^(```\S[^\n]*\n[\s\S]*?\n```|<(Callout|Accordion) [\s\S]*?<\/\2>|<img [^\n]*)$/gm)!;
      expect(kept).toHaveLength(6);
      for (const block of kept) expect(output).toContain(block);
    });

    it("keeps accordion block content visible when remounting from Preview to Split", async () => {
      const props = editorProps({
        text: '<Accordion title="Details" defaultOpen>\nA paragraph with **formatted text**.\n\n- First item\n- Second item\n\n```ts\nconst scale = Math.sqrt(64);\n```\n</Accordion>',
      });
      const view = render(<VisualMarkdownEditor key="preview" {...props} synchronizeSourceScroll={false} />);
      const expandedAccordion = () => {
        const accordion = document.querySelector<HTMLElement>('[data-component-name="Accordion"]');
        expect(accordion?.querySelector("details.accordion")).toHaveAttribute("open");
        expect(accordion?.querySelector(".accordion-body")).toHaveTextContent("A paragraph with formatted text");
        expect(accordion?.querySelectorAll(".accordion-body li")).toHaveLength(2);
        expect(accordion?.querySelector(".accordion-body code")).toHaveTextContent("const scale = Math.sqrt(64);");
      };
      await waitFor(expandedAccordion);
      view.rerender(<VisualMarkdownEditor key="split" {...props} synchronizeSourceScroll />);
      await waitFor(expandedAccordion);
    });

    it("mounts Open Knowledge-style block controls with the drop indicator outside the clipped viewport", async () => {
      renderEditor("First\n\nSecond");
      const controls = await waitForElement(".ok-block-controls");
      expect(document.querySelector(".ok-add-block-btn")).toHaveAttribute("aria-label", "Add block below");
      expect(document.querySelector(".ok-drag-grip")).toHaveAttribute("aria-label", "Select block");
      expect(controls).toHaveAttribute("draggable", "true");
      fireEvent.pointerDown(await waitForElement(".visual-drag-grip"), { button: 0, pointerId: 1 });
      await waitFor(() => expect(document.querySelector(".visual-block-drop-line")?.parentElement).toBe(document.body));
    });

    it("reports a selected visual block as Markdown context", async () => {
      const onSelectionMarkdown = vi.fn();
      const { editor } = renderEditor({ text: "## Selected context\n\nUnselected paragraph", onSelectionMarkdown });
      act(() => selectNode(editor, 0));
      await waitFor(() => expect(onSelectionMarkdown).toHaveBeenCalledWith("## Selected context"));
      onSelectionMarkdown.mockClear();
      const grip = document.querySelector<HTMLElement>(".ok-drag-grip");
      expect(grip).not.toBeNull();
      fireEvent.pointerDown(grip!);
      expect(onSelectionMarkdown).toHaveBeenCalledWith("## Selected context");
    });

    it("reveals add and drag controls when an editable document block is hovered", async () => {
      const { surface, editor } = renderEditor("First\n\nSecond");
      await waitFor(() => expect(editor.isEditable).toBe(true));
      const firstBlock = surface.firstElementChild as HTMLElement;
      setRect(firstBlock, rect(100, 128));
      setRect(surface.lastElementChild!, rect(156, 184));
      const elementsFromPoint = stubElementsFromPoint([firstBlock, surface]);
      fireEvent.mouseMove(firstBlock, { clientX: 50, clientY: 112 });
      const controls = document.querySelector<HTMLElement>(".ok-block-controls")!;
      await waitFor(() => expect(controls.style.visibility).not.toBe("hidden"));
      expect(controls.style.pointerEvents).toBe("auto");
      expect(elementsFromPoint).toHaveBeenCalled();
    });

    it("targets the hovered list item and publishes its reorder without moving surrounding prose", async () => {
      const { surface, editor, onChange } = renderEditor("Before\n\n- Alpha\n- Bravo longer\n\nAfter");
      await waitFor(() => expect(editor.isEditable).toBe(true));
      const item = surface.querySelectorAll("li")[1];
      const paragraph = item.querySelector("p")!;
      setRect(surface.firstElementChild!, rect(80, 108));
      setRect(surface.lastElementChild!, rect(220, 248));
      setRect(item, rect(156, 184));
      setRect(paragraph, rect(156, 184));
      stubElementsFromPoint([paragraph, item, surface]);
      fireEvent.mouseMove(paragraph, { clientX: 50, clientY: 170 });
      const grip = await screen.findByRole("button", { name: "Select list item" });
      expect(screen.queryByRole("button", { name: "Add block below" })).toBeNull();
      fireEvent.click(grip);
      expect(editor.state.selection).toBeInstanceOf(NodeSelection);
      expect((editor.state.selection as NodeSelection).node.type.name).toBe("listItem");
      act(() => { expect(moveBlockUp(editor.state, editor.view.dispatch)).toBe(true); });
      await waitFor(() => expect(onChange).toHaveBeenCalledWith(
        "Before\n\n- Bravo longer\n- Alpha\n\nAfter",
        "Before\n\n- Alpha\n- Bravo longer\n\nAfter",
      ));
    });

    it.each([false, true])("drops the first list item beyond the final text hitbox (ordered: %s)", async (ordered) => {
      const { surface, editor } = renderEditor(ordered
        ? "Before\n\n7. Alpha\n8. Bravo longer\n9. Charlie\n\nAfter"
        : "Before\n\n- Alpha\n- Bravo longer\n- Charlie\n\nAfter");
      await waitFor(() => expect(editor.isEditable).toBe(true));
      const list = surface.querySelector("ol, ul")!;
      const items = [...list.children] as HTMLElement[];
      const paragraph = items[0].querySelector("p")!;
      setRect(surface, new DOMRect(100, 80, 400, 220));
      setRect(surface.firstElementChild!, new DOMRect(100, 80, 400, 28));
      setRect(surface.lastElementChild!, new DOMRect(100, 260, 400, 28));
      setRect(list, new DOMRect(100, 120, 400, 84));
      items.forEach((item, index) => setRect(item, new DOMRect(140, 120 + index * 28, 360, 28)));
      setRect(paragraph, new DOMRect(140, 120, 360, 28));
      stubElementsFromPoint([paragraph, items[0], list, surface]);
      fireEvent.mouseMove(paragraph, { clientX: 200, clientY: 130 });
      const grip = await screen.findByRole("button", { name: "Select list item" });
      const computedStyle = window.getComputedStyle.bind(window);
      const styleSpy = vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
        const style = computedStyle(element);
        if (element === paragraph) {
          style.fontSize = "13px";
          style.lineHeight = "21px";
        }
        return style;
      });
      // A real caret hit test returns no item at this gutter/bottom boundary.
      vi.spyOn(editor.view, "posAtCoords").mockReturnValue(null);
      const pointer = (type: string, y: number) => fireEvent(grip, new MouseEvent(type, { bubbles: true, button: 0, clientX: 80, clientY: y }));
      pointer("pointerdown", 130);
      pointer("pointermove", 208);
      styleSpy.mockRestore();
      const ghostParagraph = document.querySelector<HTMLElement>(".visual-block-drag-ghost p");
      expect(ghostParagraph?.style.fontSize).toBe("13px");
      expect(ghostParagraph?.style.lineHeight).toBe("21px");
      expect(document.querySelector<HTMLElement>(".visual-block-drop-line")?.hidden).toBe(false);
      // The small end gap is valid; the following prose is not a list drop zone.
      pointer("pointermove", 270);
      expect(document.querySelector<HTMLElement>(".visual-block-drop-line")?.hidden).toBe(true);
      pointer("pointermove", 208);
      pointer("pointerup", 208);
      const droppedSelection = editor.state.selection;
      fireEvent.click(grip);
      expect(editor.state.selection.eq(droppedSelection)).toBe(true);
      expect([...surface.querySelectorAll("li")].map((item) => item.textContent)).toEqual(["Bravo longer", "Charlie", "Alpha"]);
      expect(surface.firstElementChild?.textContent).toBe("Before");
      expect(surface.lastElementChild?.textContent).toBe("After");
      expect(document.querySelector(".visual-block-drag-ghost")).toBeNull();
    });

    it.each(["ltr", "rtl"])("keeps the list-item grip reachable across its marker gutter (%s)", async (direction) => {
      const { surface, editor } = renderEditor("Before\n\n98. Alpha\n99. Bravo\n100. Charlie\n\nAfter");
      surface.style.direction = direction;
      await waitFor(() => expect(editor.isEditable).toBe(true));
      const list = surface.querySelector("ol")!;
      const item = list.children[1];
      const paragraph = item.querySelector("p")!;
      const gutterX = direction === "rtl" ? 480 : 120;
      setRect(surface.firstElementChild!, new DOMRect(100, 80, 400, 28));
      setRect(surface.lastElementChild!, new DOMRect(100, 260, 400, 28));
      setRect(list, new DOMRect(100, 120, 400, 120));
      setRect(item, new DOMRect(140, 156, 320, 28));
      setRect(paragraph, new DOMRect(140, 156, 320, 28));
      const hitTest = stubElementsFromPoint([paragraph, item, surface]);
      fireEvent.mouseMove(paragraph, { clientX: 250, clientY: 170 });
      const grip = await screen.findByRole("button", { name: "Select list item" });
      setRect(document.querySelector<HTMLElement>(".ok-block-controls")!, new DOMRect(direction === "rtl" ? 510 : 70, 160, 20, 20));

      // The gap resolves to the list, not the item. The earlier plugin must
      // consume this move before DragHandlePlugin can schedule a retarget.
      hitTest.mockReturnValue([list, surface]);
      const handled = editor.view.someProp("handleDOMEvents", (handlers) =>
        handlers.mousemove?.(editor.view, new MouseEvent("mousemove", { clientX: gutterX, clientY: 170 })));
      expect(handled).toBe(true);
      fireEvent.click(grip);
      expect(editor.state.selection).toBeInstanceOf(NodeSelection);
      expect((editor.state.selection as NodeSelection).node.textContent).toBe("Bravo");

      // Leaving the item's row must release the bridge, so whole-list controls
      // are still available from the gutter rather than being permanently locked.
      fireEvent.mouseMove(list, { clientX: gutterX, clientY: 130 });
      await screen.findByRole("button", { name: "Select numbered list" });
      expect(screen.getByRole("button", { name: "Add block below" })).toBeVisible();
    });

    it.each<[string, string, (editor: Editor) => void, string]>([
      ["deletes a selected block as one unit", "First\n\nSecond", (editor) => {
        selectNode(editor, 0);
        expect(editor.state.selection).toBeInstanceOf(NodeSelection);
        expect(editor.commands.keyboardShortcut("Delete")).toBe(true);
      }, "Second"],
      ["moves the current top-level block through the editor transaction", "First\n\nSecond", (editor) => {
        editor.commands.setTextSelection(8);
        expect(moveBlockUp(editor.state, editor.view.dispatch)).toBe(true);
      }, "Second\n\nFirst"],
      ["reorders top-level blocks with the WebKit-safe pointer drag transaction", "First\n\nSecond\n\nThird", (editor) => {
        const positions = new Map<string, number>();
        editor.state.doc.forEach((node, position) => positions.set(node.textContent, position));
        expect(moveTopLevelBlock(editor.state, editor.view.dispatch, positions.get("First")!, positions.get("Second")!, true)).toBe(true);
        expect(editor.state.selection).toBeInstanceOf(NodeSelection);
      }, "Second\n\nFirst\n\nThird"],
    ])("%s", async (_name, source, perform, expected) => {
      const { editor, onChange } = renderEditor(source);
      perform(editor);
      await waitFor(() => expect(onChange).toHaveBeenCalledWith(expected, source));
    });

    it("keeps an atomic block selected after moving it", async () => {
      const { editor, onChange } = renderEditor("Before\n\n$$\nx\n$$\n\nAfter");
      selectNode(editor, typePos(editor, "jsxComponent"));
      const mathComponent = (await screen.findByRole("button", { name: "Dollar Math properties" })).closest<HTMLElement>(".jsx-component-wrapper");
      expect(mathComponent).not.toBeNull();
      expect(within(mathComponent!).queryByRole("button", { name: "Edit display equation" })).not.toBeInTheDocument();
      expect(within(mathComponent!).getAllByRole("button").map((button) => button.getAttribute("aria-label")))
        .toEqual(["Dollar Math properties", "Delete Dollar Math"]);
      expect(moveBlockUp(editor.state, editor.view.dispatch)).toBe(true);
      expect(editor.state.selection).toBeInstanceOf(NodeSelection);
      expect(editor.state.doc.nodeAt(editor.state.selection.from)?.type.name).toBe("jsxComponent");
      await waitFor(() => expect(lastChange(onChange)).toBe("$$\nx\n$$\n\nBefore\n\nAfter"));
    });
  });

  describe("code blocks", () => {
    const selectCodeEnd = (editor: Editor) => selectText(editor, editor.state.doc.firstChild!.nodeSize - 1);
    const hasNoSpanNewlines = (code: HTMLElement) =>
      Array.from(code.querySelectorAll("span")).every((span) => !span.textContent?.includes("\n"));

    it("keeps intentional code clearing authoritative", async () => {
      const { editor, onChange } = renderEditor("```js\nconst value = 1\n```");
      act(() => editor.view.dispatch(editor.state.tr
        .setSelection(TextSelection.create(editor.state.doc, 1, editor.state.doc.firstChild!.nodeSize - 1))
        .deleteSelection()));
      await waitFor(() => expect(onChange).toHaveBeenCalled());
      expect(editor.state.doc.firstChild?.textContent).toBe("");
      expect(editorMarkdown(editor)).toMatch(/^```js\n\n```/);
    });

    it("inserts newlines on Enter inside a code block, advancing beyond Tiptap's triple-Enter exit", async () => {
      const { surface, editor, onChange } = renderEditor("```js\nconst value = 1\n```");
      const code = await waitFor(() => {
        const element = document.querySelector<HTMLElement>(".ok-codeblock-pre code");
        expect(element).toHaveStyle({ whiteSpace: "break-spaces" });
        expect(element).toHaveClass("break-words");
        return element!;
      });
      selectText(editor, 6);
      fireEvent.keyDown(surface, { key: "Enter", code: "Enter" });
      await waitFor(() => expect(onChange).toHaveBeenCalled());
      expect(editor.state.doc.firstChild?.textContent).toBe("const\n value = 1");
      expect(code.textContent).toBe("const\n value = 1");
      expect(editor.state.selection.from).toBe(7);
      textInput(editor, "next");
      expect(editor.state.doc.firstChild?.textContent).toBe("const\nnext value = 1");
      expect(editor.state.selection.from).toBe(11);
      expect(editorMarkdown(editor)).toContain("const\nnext value = 1");
      // Repeated Enter at the end keeps advancing beyond Tiptap's triple-Enter exit.
      expect(editor.extensionManager.extensions
        .filter((extension) => extension.name === "codeBlock")
        .map((extension) => extension.options.exitOnTripleEnter)).toEqual([false]);
      const codeSize = editor.state.doc.firstChild!.nodeSize;
      selectCodeEnd(editor);
      for (let index = 0; index < 4; index += 1) fireEvent.keyDown(surface, { key: "Enter", code: "Enter" });
      expect(editor.state.doc.childCount).toBe(1);
      expect(editor.state.doc.firstChild?.type.name).toBe("codeBlock");
      expect(editor.state.doc.firstChild?.textContent).toBe("const\nnext value = 1\n\n\n\n");
      expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
      expect(editor.state.selection.from).toBe(codeSize + 3);
    });

    it("renders a trailing newline, accepts text on the new line, and keeps line endings outside spans", async () => {
      // Highlighted line endings stay outside inline spans so WebKit can advance the caret.
      const { surface, editor, onChange } = renderEditor("```js\n// first line\n// second line\n```");
      const code = await waitFor(() => {
        const element = document.querySelector<HTMLElement>(".ok-codeblock-pre code .hljs-comment");
        expect(element).not.toBeNull();
        return element!.closest<HTMLElement>("code")!;
      });
      expect(hasNoSpanNewlines(code)).toBe(true);
      const codeSize = editor.state.doc.firstChild!.nodeSize;
      selectCodeEnd(editor);
      fireEvent.keyDown(surface, { key: "Enter", code: "Enter" });
      expect(code).toHaveStyle({ whiteSpace: "break-spaces" });
      expect(code.textContent).toBe("// first line\n// second line\n");
      expect(editor.state.doc.firstChild?.textContent).toBe("// first line\n// second line\n");
      const { from, to } = editor.state.selection;
      expect(from).toBe(codeSize);
      editor.view.dispatch(editor.state.tr.insertText("// third line", from, to));
      expect(code.textContent).toBe("// first line\n// second line\n// third line");
      await waitFor(() => expect(lastChange(onChange)).toContain("// second line\n// third line"));
      fireEvent.keyDown(surface, { key: "Enter", code: "Enter" });
      expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
      expect(editor.state.doc.firstChild?.textContent).toBe("// first line\n// second line\n// third line\n");
      expect(hasNoSpanNewlines(code)).toBe(true);
    });

    it("keeps authored and canonical empty fences empty", () => {
      const { editor } = renderEditor("```js\n\n```");
      act(() => addBlockBelow(editor, 0, editor.state.doc.firstChild!));
      expect(editor.state.doc.firstChild?.textContent).toBe("");
      expect(editorMarkdown(editor)).toContain("```js\n\n```");
    });

    it("does not move deleted code into a neighboring empty fence", () => {
      const { editor } = renderEditor("```js\nconst removed = true\n```\n\n```css\n\n```");
      act(() => editor.view.dispatch(editor.state.tr.delete(0, editor.state.doc.firstChild!.nodeSize)));
      expect(editor.state.doc.firstChild?.type.name).toBe("codeBlock");
      expect(editor.state.doc.firstChild?.attrs.language).toBe("css");
      expect(editor.state.doc.firstChild?.textContent).toBe("");
    });

    it("round-trips code language and title metadata through edits and a canonical rerender", async () => {
      const { onChange, rerender } = renderEditor("```ts title=\"Example with spaces\"\nconst answer = 42;\n```");
      // Upstream chrome: language popover trigger announces the resolved label.
      const languageButton = await screen.findByRole("button", { name: "Code block language: TypeScript. Click to change." });
      expect(screen.getByTestId("ok-codeblock-title")).toHaveTextContent("Example with spaces");
      expect(document.querySelector(".ok-codeblock-pre")).toHaveTextContent("const answer = 42;");
      // The unsupported upstream composer must be absent, not just CSS-hidden.
      expect(screen.queryByTestId("ok-codeblock-ask-ai-btn")).not.toBeInTheDocument();
      // Change language through the upstream cmdk picker.
      fireEvent.click(languageButton);
      fireEvent.click(await screen.findByRole("option", { name: "Python" }));
      // Longer timeout: popover close + attr commit + serialize can exceed the
      // 1s default under full-suite parallel load.
      await waitFor(() => expect(lastChange(onChange)).toBe("```python title=\"Example with spaces\"\nconst answer = 42;\n```"), { timeout: 5000 });
      // Keep the settings popover mounted while a title is typed character by
      // character, then commit the complete value once editing finishes.
      fireEvent.click(screen.getByRole("button", { name: "Code block settings" }));
      const titleInput = await screen.findByTestId("ok-codeblock-title-input");
      for (const value of ["U", "Up", "Updated", "Updated title"]) {
        fireEvent.change(titleInput, { target: { value } });
        expect(screen.getByTestId("ok-codeblock-title-input")).toHaveValue(value);
        expect(screen.getByRole("dialog")).toBeInTheDocument();
      }
      expect(lastChange(onChange)).not.toContain('title="Updated title"');
      fireEvent.keyDown(titleInput, { key: "Enter", code: "Enter" });
      await waitFor(() => expect(lastChange(onChange)).toBe("```python title=\"Updated title\"\nconst answer = 42;\n```"), { timeout: 5000 });
      rerender({ text: lastChange(onChange) });
      await waitFor(() => expect(screen.getByRole("button", { name: "Code block language: Python. Click to change." })).toBeInTheDocument());
      expect(screen.getByTestId("ok-codeblock-title")).toHaveTextContent("Updated title");
      const writeText = vi.fn(() => Promise.resolve());
      overrideProperty(navigator, "clipboard", { value: { writeText } });
      fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
      expect(writeText).toHaveBeenCalledWith("const answer = 42;");
      fireEvent.click(screen.getByRole("button", { name: "Delete code block" }));
      await waitFor(() => expect(lastChange(onChange)).toBe(""));
    });

    it.each([
      ["toml", "[tool]\nname = \"demo\"", ""],
      ["mermaid", "graph TD; A-->B", " w=320px"],
      ["html", "<p>Hello</p>", " w=320px"],
    ])("renders a titled %s block with its title attached to the surface", async (language, body, previewMeta) => {
      renderEditor(`\`\`\`${language} title="Example"${previewMeta}\n${body}\n\`\`\``);
      const block = await waitForElement(`.ok-codeblock[data-language="${language}"]`);
      const title = within(block).getByTestId("ok-codeblock-title");
      const surface = block.querySelector(language === "toml" ? ".ok-codeblock-pre" : ".ok-codeblock-preview");
      expect(surface).not.toBeNull();
      if (language === "toml") {
        expect(title.compareDocumentPosition(surface!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      } else {
        expect(title.parentElement).toBe(surface);
        expect(surface).toHaveStyle({ width: "320px" });
      }
    });
  });

  describe("selection toolbar", () => {
    it.each([
      ["Bold", "**Hello**", "strong"],
      ["Italic", "*Hello*", "em"],
      ["Highlight", "==Hello==", 'mark[data-color="#FFD875"]'],
      ["Convert selection to inline math", "$Hello$", ".math-inline-trigger[data-formula='Hello']"],
    ])("serializes %s formatting from the toolbar", async (name, expected, selector) => {
      const { surface, editor, onChange } = renderEditor();
      focusText(editor, 1, 6);
      fireEvent.mouseDown(await screen.findByRole("button", { name }));
      await waitFor(() => expect(onChange).toHaveBeenCalledWith(expected, "Hello"));
      await waitFor(() => expect(surface.querySelector(selector)).not.toBeNull());
    });

    it("shows an accessible contextual toolbar for a text selection", async () => {
      const { surface, editor } = renderEditor();
      // Query the toolbar's content, not the portal container: a previous
      // test's hidden floating-ui container can linger in document.body for a
      // tick after unmount, which made a container-existence check flaky.
      expect(screen.queryByRole("button", { name: "Bold" })).not.toBeInTheDocument();
      focusText(editor, 1, 6);
      const bold = await screen.findByRole("button", { name: "Bold" });
      const toolbar = bold.closest<HTMLElement>('[data-testid="bubble-menu-bar"]')!;
      expect(bold).toBeEnabled();
      expect(toolbar.querySelector('button[aria-label="Convert selection to inline math"]')).toBeEnabled();
      // The toolbar node is portalled outside .tiptap-editor, so it must carry
      // the vendored theme scope itself. Otherwise WebKit paints unstyled
      // buttons with its dark native button face.
      expect(toolbar).toHaveAttribute("data-ok-vendor", "");
      // TipTap v3 portals the toolbar node itself to body. It no longer wraps
      // BubbleMenu in [data-tippy-root], so host styles must target this node.
      expect(toolbar.parentElement).toBe(document.body);
      expect(toolbar.closest("[data-tippy-root]")).toBeNull();
      // Vitest strips CSS imports. Apply the real host icon rule to the actual
      // composed buttons: TooltipTrigger replaces data-slot="button", which
      // previously left these SVGs at Lucide's heavier default stroke.
      const iconRules = workspaceCss().match(/^\[data-testid="bubble-menu-bar"\][^{]* svg \{[^}]+\}/gm);
      expect(iconRules).not.toBeNull();
      injectCss(iconRules!.join("\n"));
      for (const icon of toolbar.querySelectorAll("button svg")) {
        const size = icon.closest('[data-testid="footnote-bubble-button"]') ? "16px" : "14px";
        expect(getComputedStyle(icon)).toMatchObject({ width: size, height: size, strokeWidth: "1.8" });
      }
      expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
      const outside = document.createElement("button");
      document.body.appendChild(outside);
      fireEvent.blur(surface, { relatedTarget: outside });
      outside.focus();
      await waitFor(() => expect(screen.queryByRole("button", { name: "Bold" })).not.toBeInTheDocument());
    });

    it("updates the mounted selection toolbar when the interface language changes", async () => {
      const { editor, onChange } = renderEditor("中文格式测试");
      act(() => editor.chain().focus().setTextSelection({ from: 1, to: 3 }).run());
      expect(await screen.findByRole("button", { name: "Bold" })).toBeEnabled();
      await act(() => activateAppLocale("zh-CN"));
      expect(await screen.findByTestId("block-type-selector")).toHaveTextContent("正文");
      // jsdom has no selection geometry, so Floating UI may hide the portal
      // during the locale update. This checks its live labels, not placement.
      for (const name of ["粗体", "斜体", "下划线", "删除线", "行内代码", "高亮", "插入链接", "将所选文字转换为脚注", "将所选文字转换为行内公式", "在 Markdown 源码中查看"]) {
        expect(screen.getByLabelText(name, { selector: "button" })).toBeEnabled();
      }
      fireEvent.mouseDown(screen.getByLabelText("粗体", { selector: "button" }));
      await waitFor(() => expect(onChange).toHaveBeenCalledWith("**中文**格式测试", "中文格式测试"));
      fireEvent.pointerDown(screen.getByTestId("block-type-selector"), { button: 0, ctrlKey: false });
      expect(await screen.findByRole("menuitem", { name: "一级标题" })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "任务列表" })).toBeInTheDocument();
      await act(() => activateAppLocale("en"));
      expect(await screen.findByRole("menuitem", { name: "Heading 1" })).toBeInTheDocument();
      expect(screen.getByTestId("block-type-selector")).toHaveTextContent("Text");
    });

    it("offers all Markdown heading levels in the contextual block menu", async () => {
      const { editor, onChange } = renderEditor();
      focusText(editor, 1, 6);
      fireEvent.pointerDown(await screen.findByTestId("block-type-selector"), { button: 0, ctrlKey: false, pointerType: "mouse" });
      const menu = await screen.findByRole("menu");
      expect(within(menu).getAllByRole("menuitem")).toHaveLength(12);
      expect(within(menu).getAllByRole("separator")).toHaveLength(3);
      const text = within(menu).getByRole("menuitem", { name: "Text" });
      expect(text).toHaveAttribute("data-active");
      expect(text.querySelector(".lucide-check")).not.toBeNull();
      for (const level of [4, 5, 6]) expect(within(menu).getByRole("menuitem", { name: `Heading ${level}` })).toBeInTheDocument();
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Heading 5" }));
      await waitFor(() => expect(editor.isActive("heading", { level: 5 })).toBe(true));
      await waitFor(() => expect(onChange).toHaveBeenCalled());
    });

    it.each([false, true])("maps View in source to the selected text when reading optimization is %s", async (optimizeForReading) => {
      const markdown = "# Heading\n\nFirst paragraph.\n\nTarget paragraph.";
      const onViewInSource = vi.fn();
      const { surface, editor } = renderEditor({ text: markdown, optimizeForReading, onViewInSource });
      const target = nodePos(editor, (node) => node.isText && !!node.text?.startsWith("Target"));
      focusText(editor, target + 7, target + 16);
      await waitFor(() => {
        const targetBlock = surface.querySelectorAll(":scope > p, :scope > h1")[2];
        expect(targetBlock).toHaveAttribute("data-source-line", "5");
        expect(targetBlock).toHaveAttribute("data-source-offset", String(markdown.indexOf("Target paragraph.")));
        expect(targetBlock).toHaveAttribute("data-source-end-offset", String(markdown.length));
      });
      const viewSource = await screen.findByRole("button", { name: "View in source Markdown" });
      // Both the View in source and footnote icons stay at the legible size.
      expect(viewSource.querySelector("svg")).toHaveClass("size-4");
      expect((await screen.findByTestId("footnote-bubble-button")).querySelector("svg")).toHaveClass("size-4");
      fireEvent.click(viewSource);
      expect(onViewInSource).toHaveBeenCalledOnce();
      expect(onViewInSource.mock.calls[0]?.[0]).toBe(markdown.indexOf("paragraph.", markdown.indexOf("Target paragraph.")));
    });
  });

  describe("slash menu", () => {
    it.each([2, 5])("opens a searchable slash menu and inserts Heading %i", async (level) => {
      const { editor, onChange } = renderEditor("");
      const menu = await openSlashMenu(editor, `h${level}`);
      expect(menu).toHaveTextContent(`Heading ${level}`);
      expect(menu).not.toHaveTextContent("Heading 1");
      fireEvent.mouseDown(within(menu).getByRole("option", { name: new RegExp(`Heading ${level}`) }));
      await waitFor(() => expect(editor.isActive("heading", { level })).toBe(true));
      expect(editor.getText()).not.toContain(`/h${level}`);
      await waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 2_500 });
    });

    it("offers the complete set of Markdown-native insertions and unmounts the open menu cleanly", async () => {
      const { editor, unmount } = renderEditor("");
      const menu = await openSlashMenu(editor);
      expect(menu.parentElement?.querySelector(".lattice-scrollbar")).toBeInTheDocument();
      for (const name of [
        /Heading 1/, /Heading 2/, /Heading 3/, /Heading 4/, /Heading 5/, /Heading 6/, /Task List/, /Code Block/,
        /^Table/, /^Footnote/, /Inline Math/, /^Link/, /^Mermaid/, /^Image/,
      ]) expect(within(menu).getByRole("option", { name })).toBeInTheDocument();
      for (const name of [/^Tag/, /^Video/, /^Audio/]) expect(within(menu).queryByRole("option", { name })).not.toBeInTheDocument();
      // Unmounting with the menu open must not raise a React removeChild error.
      expect(() => unmount()).not.toThrow();
    });

    it("localizes add-menu options and descriptions in Chinese", async () => {
      await activateAppLocale("zh-CN");
      const menu = await openSlashMenu(renderEditor("").editor);
      expect(within(menu).getAllByRole("option").map((option) => option.textContent)).toEqual([
        "一级标题", "二级标题", "三级标题", "四级标题", "五级标题", "六级标题", "无序列表", "有序列表", "任务列表", "引文",
        "代码块", "表格", "分隔线", "脚注", "表情符号", "行内公式", "链接", "提示框", "折叠面板", "折叠块", "标签页", "数学",
        "Mermaid 图表", "镜像", "镜像源", "对齐块", "图片", "HTML",
      ]);
      for (const group of ["基础块", "插入", "组件", "媒体"]) expect(within(menu).getByText(group)).toBeInTheDocument();
      fireEvent.mouseEnter(within(menu).getByRole("option", { name: "二级标题" }));
      await waitFor(() => expect(menu.parentElement?.parentElement?.querySelector("aside")).toHaveTextContent("用于次级章节的中标题。"));
    });

    it("composes the slash menu from the vendored upstream item sources", () => {
      // Exact upstream parity is enforced by `vendor-open-knowledge.mjs
      // --check`; here we only pin that the production sources actually
      // surface the canonical component pack in the menu.
      const componentLabels = getComponentItems().map((item) => item.label);
      for (const label of ["Callout", "Accordion", "Tabs", "Image", "Video", "Audio", "PDF", "File", "Embed"]) {
        expect(componentLabels).toContain(label);
      }
      expect(getInlineComponentItems().map((item) => item.name)).toEqual(["link"]);
      expect(getEmbedStarterItems().length).toBeGreaterThan(0);
    });

    it("shares preview selection between hover and arrow navigation, and keeps combobox relationships valid with no match", async () => {
      const { surface, editor } = renderEditor("");
      const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
      const menu = await openSlashMenu(editor);
      const option = (name: RegExp) => within(screen.getByRole("listbox", { name: "Slash commands" })).getByRole("option", { name });
      const preview = () => menu.parentElement?.parentElement?.querySelector("aside");
      expect(scrollIntoView).not.toHaveBeenCalled();
      fireEvent.mouseEnter(within(menu).getByRole("option", { name: /Heading 2/ }));
      await waitFor(() => expect(option(/Heading 2/)).toHaveAttribute("aria-selected", "true"));
      expect(preview()).toHaveTextContent("Medium section heading.");
      fireEvent.keyDown(surface, { key: "ArrowDown" });
      await waitFor(() => expect(option(/Heading 3/)).toHaveAttribute("aria-selected", "true"));
      expect(preview()).toHaveTextContent("Small section heading.");
      expect(scrollIntoView).not.toHaveBeenCalled();
      editor.chain().focus().insertContent("no-such-block").run();
      expect(await screen.findByRole("status")).toHaveTextContent("No results");
      expect(screen.queryByRole("listbox", { name: "Slash commands" })).not.toBeInTheDocument();
      expect(surface).not.toHaveAttribute("aria-controls");
      expect(surface).not.toHaveAttribute("aria-activedescendant");
    });

    it.each([
      ["a canonical MDX callout", "callout", /^Callout/, EMPTY_CALLOUT],
      // Upstream no longer prompts for a URL: Image is inserted canonically and
      // its node UI owns subsequent source editing.
      ["an empty image without prompting, dropping the slash query", "image", /Image/, '<img src="" />'],
    ])("inserts %s", async (_label, query, option, expected) => {
      const prompt = vi.spyOn(window, "prompt").mockReturnValue(null);
      const { editor, onChange } = renderEditor("");
      fireEvent.mouseDown(within(await openSlashMenu(editor, query)).getByRole("option", { name: option }));
      await waitFor(() => expect(editorMarkdown(editor)).not.toContain(`/${query}`));
      await waitFor(() => expect(lastChange(onChange)).toBe(expected), { timeout: 2_500 });
      expect(prompt).not.toHaveBeenCalled();
    });

    it("inserts Tabs as two nested, visually selectable MDX Tab components", async () => {
      const { editor, onChange } = renderEditor("");
      fireEvent.mouseDown(within(await openSlashMenu(editor, "tabs")).getByRole("option", { name: /^Tabs/ }));
      const tablist = await screen.findByRole("tablist", { name: "Tabs" });
      // The tab pills derive from child Tab labels and land on a follow-up render.
      await waitFor(() => expect(within(tablist).getAllByRole("tab")).toHaveLength(2));
      const tabs = editor.getJSON().content?.[0] as { content?: Array<{ attrs?: { componentName?: string } }> };
      expect(tabs.content?.map((child) => child.attrs?.componentName)).toEqual(["Tab", "Tab"]);
      await waitFor(() => {
        for (const tag of ["<Tabs>", '<Tab label="Tab 1">', '<Tab label="Tab 2">']) expect(lastChange(onChange)).toContain(tag);
      });
      // Upstream keeps the `+ Add tab` control OUTSIDE the tablist (WAI-ARIA
      // required-owned-elements: a tablist may only own tabs); it's a sibling
      // in the `.tabs-strip` row.
      fireEvent.click(screen.getByRole("button", { name: "Add tab" }));
      await waitFor(() => expect(within(tablist).getAllByRole("tab")).toHaveLength(3));
    });

    it("imports an image through the host project workflow", async () => {
      const onImportAsset = vi.fn(async () => "figures/uploaded.png");
      const { editor, onChange } = renderEditor({ text: "", onImportAsset });
      fireEvent.mouseDown(within(await openSlashMenu(editor, "image")).getByRole("option", { name: /^Image/ }));
      const file = new File(["image"], "plot.png", { type: "image/png" });
      fireEvent.change(document.querySelector('input[aria-label="Choose image to upload"]')!, { target: { files: [file] } });
      await waitFor(() => expect(onImportAsset).toHaveBeenCalledWith(file));
      await waitFor(() => expect(lastChange(onChange)).toBe('<img src="figures/uploaded.png" />'));
    });

    it("opens the emoji picker from the slash menu and inserts at the caret", async () => {
      const { editor, onChange } = renderEditor("Hello");
      editor.chain().focus("end").insertContent(" /emoji").run();
      const menu = await screen.findByRole("listbox", { name: "Slash commands" });
      fireEvent.mouseDown(within(menu).getByRole("option", { name: /Emoji/ }));
      // The item deletes the trigger range, then raises the app-scope picker.
      // Query fresh inside waitFor: Radix re-mounts the popover content while
      // positioning, so a node captured earlier can go stale.
      await waitFor(() => expect(within(screen.getByTestId("emoji-picker-popover")).getByPlaceholderText("Search emoji")).toBeInTheDocument());
      await waitFor(() => expect(editorMarkdown(editor)).not.toContain("/emoji"));
      // Picking inserts plain Unicode at the caret and writes back one canonical update.
      onChange.mockClear();
      const { insertEmojiAtCaret } = await import("@ok-app/editor/components/EmojiInsertPopover");
      insertEmojiAtCaret(editor, "🎉");
      await waitFor(() => expect(lastChange(onChange)).toContain("Hello 🎉"));
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it("inserts Open Knowledge HTML starters as sandboxed preview code blocks", async () => {
      const { surface, editor, onChange } = renderEditor("");
      const menu = await openSlashMenu(editor, "html");
      expect(within(menu).queryByRole("option", { name: /^Chart/ })).not.toBeInTheDocument();
      fireEvent.mouseDown(within(menu).getByRole("option", { name: /^HTML/ }));
      const preview = await screen.findByTitle("HTML preview");
      expect(preview).toHaveAttribute("sandbox", "allow-scripts");
      expect(preview.getAttribute("srcdoc")).not.toContain("okPreviewHeight");
      expect(preview.getAttribute("srcdoc")).toContain("scrollbar-color: transparent transparent");
      expect(preview.getAttribute("srcdoc")).toContain("*:hover::-webkit-scrollbar-thumb");
      const previewWrapper = preview.closest<HTMLElement>(".ok-codeblock-preview")!;
      expect(previewWrapper).toHaveClass("ok-codeblock-preview--html");
      expect(previewWrapper.querySelector(".ok-resize-handle--l")).not.toBeNull();
      expect(previewWrapper.querySelector(".ok-resize-handle--b")).toBeNull();
      setRect(previewWrapper, new DOMRect(0, 0, 320, 416));
      const previewViewport = surface.closest<HTMLElement>(".visual-markdown-editor")!;
      previewViewport.classList.add("editor-doc-scroll");
      previewViewport.scrollTop = 480;
      fireEvent.pointerDown(previewWrapper.querySelector(".ok-resize-handle--r")!, { pointerId: 1, clientX: 320, clientY: 200 });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 400, clientY: 300 });
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 400, clientY: 300 });
      await waitFor(() => expect(lastChange(onChange)).toContain("w=400px"));
      await waitFor(() => expect(previewViewport.scrollTop).toBe(480));
      expect(lastChange(onChange)).not.toContain("h=");
      expect(screen.getByRole("button", { name: "Align preview center" })).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(screen.getByRole("button", { name: "Align preview right" }));
      await waitFor(() => expect(lastChange(onChange)).toContain("align=right"));
      await waitFor(() => expect(lastChange(onChange)).toContain("```html preview"));
      fireEvent.click(screen.getByRole("button", { name: "Hide HTML preview" }));
      expect(screen.queryByTitle("HTML preview")).not.toBeInTheDocument();
      expect(surface).toHaveTextContent("Hello, world!");
      fireEvent.click(screen.getByRole("button", { name: "Show HTML preview" }));
      expect(await screen.findByTitle("HTML preview")).toBeInTheDocument();
    });

    it("opens the URL field when Link is inserted from the slash menu", async () => {
      const { editor, onChange } = renderEditor("");
      fireEvent.mouseDown(within(await openSlashMenu(editor, "link")).getByRole("option", { name: /^Link/ }));
      fireEvent.change(await screen.findByRole("textbox", { name: "Link URL" }), { target: { value: "https://example.com" } });
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      await waitFor(() => expect(lastChange(onChange)).toBe("[link](https://example.com)"));
    });
  });

  describe("MDX components", () => {
    it("edits canonical MDX component content visually and preserves its source until changed", async () => {
      const { editor, onChange } = renderEditor("<Callout title=\"Exact\">\nText with **bold**.\n</Callout>");
      // Upstream JsxComponentView wrapper tags the block with its descriptor name.
      const component = await waitForElement('[data-component-name="Callout"]');
      expect(component.querySelector("strong")).toHaveTextContent("bold");
      expect(onChange).not.toHaveBeenCalled();
      editor.commands.insertContentAt(nodePos(editor, (node) => node.isText && !!node.text?.startsWith("Text with")), "Edited ");
      await waitFor(() => expect(lastChange(onChange)).toContain("Edited Text with **bold**."));
      expect(component.querySelector(".callout")).not.toBeNull();
      // Upstream prop editing flow: gear button opens the PropPanel popover.
      const { input } = await openComponentProperties("Callout");
      expect(input).toHaveValue("Exact");
      fireEvent.change(input, { target: { value: "Changed & quoted \"title\"" } });
      // Upstream serializes non-portable string props as JSX expressions.
      await waitFor(() => expect(lastChange(onChange)).toContain('title={"Changed & quoted \\"title\\""}'));
    });

    it.each([
      // macOS sends the Return that commits the candidate while the editor is
      // still composing. It must not reach the container-exit shortcut against
      // the transient DOM/ProseMirror composition state.
      ["before compositionend", true],
      // WebKit can deliver that Return right after compositionend instead.
      ["after compositionend", false],
    ])("keeps a Callout intact when Chinese IME text is committed by an Enter %s", async (_label, enterWhileComposing) => {
      const { surface, editor, onChange } = renderEditor(EMPTY_CALLOUT);
      editor.commands.setTextSelection(typePos(editor, "paragraph") + 1);
      fireEvent.compositionStart(surface);
      editor.commands.insertContent("中文");
      if (enterWhileComposing) fireEvent.keyDown(surface, { key: "Enter", code: "Enter", isComposing: true });
      fireEvent.compositionEnd(surface);
      if (!enterWhileComposing) fireEvent.keyDown(surface, { key: "Enter", code: "Enter", keyCode: 13, isComposing: false });
      await waitFor(() => expect(lastChange(onChange)).toContain("中文"));
      expect(document.querySelector('[data-component-name="Callout"] .callout')).not.toBeNull();
      expect(editor.state.doc.firstChild?.type.name).toBe("jsxComponent");
      expect(editor.state.doc.firstChild?.childCount).toBeGreaterThanOrEqual(1);
      expect(editor.state.selection).not.toBeInstanceOf(NodeSelection);
    });

    it("keeps the caret in place while typing a Callout property, then returns to the body when properties close", async () => {
      const { editor } = renderEditor(TITLED_CALLOUT);
      const { component, input } = await openComponentProperties("Callout");
      const field = input as HTMLInputElement;
      // Type mid-value the way the browser does: the native value and caret
      // change first, then React sees the input event. The field is rendered
      // from node attrs, so the NodeView re-render must land inside the event
      // (see patches/@tiptap__react@*.patch); otherwise React restores the old
      // value and the caret jumps to the end.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "InXitial");
      field.setSelectionRange(3, 3);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      expect(field).toHaveValue("InXitial");
      expect(field.selectionStart).toBe(3);
      await act(async () => {});
      expect(field).toHaveValue("InXitial");
      expect(field.selectionStart).toBe(3);
      // Closing properties returns to the Callout body instead of highlighting the whole block.
      fireEvent.keyDown(field, { key: "Enter", code: "Enter" });
      await waitFor(() => expect(screen.queryByRole("textbox", { name: /title/i })).not.toBeInTheDocument());
      await waitFor(() => expect(editor.state.selection).not.toBeInstanceOf(NodeSelection));
      expect(component.querySelector(".callout")).not.toBeNull();
    });

    it.each([
      ["before compositionend", true],
      ["after compositionend (WebKit)", false],
    ])("keeps Callout properties open when Enter commits Chinese IME text %s", async (_label, enterWhileComposing) => {
      renderEditor(TITLED_CALLOUT);
      const { component, input } = await openComponentProperties("Callout");
      fireEvent.compositionStart(input);
      fireEvent.change(input, { target: { value: "中文标题" } });
      if (!enterWhileComposing) fireEvent.compositionEnd(input);
      fireEvent.keyDown(input, { key: "Enter", code: "Enter", keyCode: enterWhileComposing ? 229 : 13, isComposing: enterWhileComposing });
      expect(screen.getByRole("textbox", { name: /title/i })).toHaveValue("中文标题");
      expect(component.querySelector(".callout")).not.toBeNull();
      if (enterWhileComposing) fireEvent.compositionEnd(input);
    });

    it("rests after a final image without selecting it when properties close", async () => {
      const { editor } = renderEditor("![Plot](figures/plot.png)");
      await screen.findByRole("img", { name: "Plot" });
      act(() => editor.commands.setNodeSelection(0));
      fireEvent.click(screen.getByRole("button", { name: "CommonMark Image properties" }));
      fireEvent.keyDown(await waitForElement("[data-prop-panel]"), { key: "Escape", code: "Escape" });
      await waitFor(() => expect(editor.state.selection).toBeInstanceOf(GapCursor));
      expect(editor.state.selection.from).toBe(editor.state.doc.content.size);
      expect(editor.state.doc.childCount).toBe(1);
      expect(editor.state.doc.firstChild?.type.name).toBe("jsxComponent");
    });

    it("keeps an authored single trailing blank line editable without growing it", () => {
      const { editor } = renderEditor("- Item\n\n");
      expect(editor.state.doc.childCount).toBe(2);
      expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
      expect(editorMarkdown(editor)).toBe("- Item\n\n");
    });

    it("repairs an empty Callout produced by an editing transaction", () => {
      const { editor } = renderEditor("<Callout type=\"note\">\nBody\n</Callout>");
      editor.view.dispatch(editor.state.tr.delete(1, editor.state.doc.firstChild!.nodeSize - 1));
      expect(editor.state.doc.firstChild?.type.name).toBe("jsxComponent");
      expect(editor.state.doc.firstChild?.childCount).toBe(1);
      expect(editor.state.doc.firstChild?.firstChild?.type.name).toBe("paragraph");
    });

    it("keeps an empty trailing paragraph inside a Callout on Enter", async () => {
      const { editor } = renderEditor(EMPTY_CALLOUT);
      editor.commands.setTextSelection(typePos(editor, "paragraph") + 1);
      expect(editor.commands.keyboardShortcut("Enter")).toBe(true);
      expect(editor.state.doc.firstChild?.type.name).toBe("jsxComponent");
      expect(editor.state.doc.firstChild?.childCount).toBe(2);
      await waitForElement('[data-component-name="Callout"] .callout');
    });

    it("preserves legacy component fences and migrates them only after a visual edit", async () => {
      const { onChange } = renderEditor("```rw-component callout\n{\"title\":\"Legacy\",\"content\":\"Kept\"}\n```");
      await waitForElement('[data-component-name="Callout"]');
      expect(onChange).not.toHaveBeenCalled();
      const { input } = await openComponentProperties("Callout");
      expect(input).toHaveValue("Legacy");
      fireEvent.change(input, { target: { value: "Migrated" } });
      await waitFor(() => {
        const next = lastChange(onChange);
        expect(next).toMatch(/^<Callout /);
        expect(next).toContain('title="Migrated"');
        expect(next).toContain("Kept");
        expect(next).not.toContain("rw-component");
      });
    });

    it("does not let embed or media components load local files or script schemes", async () => {
      // Upstream SAFE_URL_SCHEMES allowlists http/https/mailto/tel/ftp/sms;
      // file: and javascript: are rewritten to an inert "#".
      renderEditor('<Embed src="javascript:alert(1)" />\n\n<Pdf src="file:///etc/passwd" />\n\n<img src="javascript:alert(1)" />');
      // Upstream sanitizeComponentProps rewrites unsafe schemes to "#" before
      // render; Embed then refuses to mount an iframe and shows its
      // scheme-hint placeholder instead.
      const embed = await waitForElement('[data-component-name="Embed"]');
      await waitFor(() => expect(embed.querySelector(".ok-embed--placeholder")).not.toBeNull());
      expect(embed.querySelector("iframe")).toBeNull();
      const pdf = await waitForElement('[data-component-name="Pdf"]');
      const image = await waitForElement('[data-component-name="img"]');
      expect(pdf.querySelector('[src*="file:"]')).toBeNull();
      expect(image.querySelector('[src*="javascript:"]')).toBeNull();
      expect(document.body.innerHTML).not.toContain("file:///etc/passwd");
      expect(document.body.innerHTML).not.toContain("javascript:alert(1)");
    });

    it.each([["before", true], ["after", false]])("renders a read-only MirrorSource indexed %s the mirror mounts and refreshes it", async (_when, indexedFirst) => {
      const workspaceIndex = new MarkdownWorkspaceIndex(async () => "");
      const publishSource = (body: string) => act(() => workspaceIndex.noteDocumentContent("source.md", `<MirrorSource id="shared">\n\n${body}\n\n</MirrorSource>`));
      if (indexedFirst) publishSource("**First version**");
      renderEditor({ text: '<Mirror src="source" anchor="shared" />', workspaceIndex });
      if (!indexedFirst) {
        await waitForElement(".ok-mirror-state");
        publishSource("**First version**");
      }
      const mirror = await waitForElement(".ok-mirror-resolved");
      expect(mirror).toHaveTextContent("First version");
      expect(mirror.querySelector("strong")).not.toBeNull();
      // The index is mutated in place, so neither the prop nor the mirror's own
      // attributes move between these edits. Following every one of them is what
      // proves the view is reading a subscribed value rather than whatever it
      // resolved the first time it rendered.
      for (const [body, expected] of [["Second version", "Second version"], ["Third version", "Third version"], ["**First version**", "First version"]]) {
        publishSource(body);
        await waitFor(() => expect(mirror).toHaveTextContent(expected));
      }
    });

    it("edits a source-preserved block through the nested source editor and reconciles remote edits into it", async () => {
      const { onChange, rerender } = renderEditor("Before\n\n<Unknown>\n\nExact source\n\n</Unknown>");
      // Upstream wildcard path: unregistered JSX auto-converts into a
      // rawMdxFallback rendered as an embedded CodeMirror source editor.
      const wrapper = await waitForElement(".raw-mdx-fallback-wrapper");
      expect(wrapper).toHaveAttribute("role", "group");
      expect(wrapper).toHaveAccessibleName("Unknown component: Unknown");
      const cmView = () => CMEditorView.findFromDOM(document.querySelector<HTMLElement>(".raw-mdx-fallback-wrapper .cm-content")!)!;
      await waitForElement(".raw-mdx-fallback-wrapper .cm-content");
      expect(cmView().state.doc.toString()).toBe("<Unknown>\n\nExact source\n\n</Unknown>");
      rerender({ text: "Before\n\n<Unknown>\n\nRemote\n\n</Unknown>" });
      // Remote canonical replace reconciles into the nested CodeMirror…
      await waitFor(() => expect(cmView().state.doc.toString()).toContain("Remote"));
      // …and, like the byte-identical auto-convert itself, never writes back.
      expect(onChange).not.toHaveBeenCalled();
      cmView().dispatch({ changes: { from: 0, to: cmView().state.doc.length, insert: "<Unknown>\n\nUpdated source\n\n</Unknown>" } });
      await waitFor(() => expect(lastChange(onChange)).toBe("Before\n\n<Unknown>\n\nUpdated source\n\n</Unknown>"));
    });

    it("isolates unsupported blocks while keeping the surrounding document editable", async () => {
      const { editor, onChange } = renderEditor("Editable paragraph\n\n<Unknown prop=\"x\">\n\nExact source\n\n</Unknown>");
      // Upstream wildcard auto-convert: the unregistered component becomes a
      // rawMdxFallback whose nested CodeMirror holds the exact source bytes.
      await waitFor(() => expect(document.querySelector(".raw-mdx-fallback-wrapper")).toHaveTextContent("Exact source"));
      editor.commands.insertContentAt(1, "Updated ");
      await waitFor(() => expect(onChange).toHaveBeenCalled());
      expect(lastChange(onChange)).toContain("<Unknown prop=\"x\">\n\nExact source\n\n</Unknown>");
    });
  });

  describe("footnotes, links, and tags", () => {
    it("renders multiline Markdown footnote definitions as directly editable nodes", async () => {
      // GFM footnote continuation paragraphs are indented by four spaces.
      const { surface, editor, onChange } = renderEditor("Evidence[^source].\n\n[^source]: Supporting **result**.\n\n    Second **paragraph**.");
      expect(await screen.findByText("[source]")).toHaveClass("footnote-ref-link");
      // Upstream DOM: auto-numbered aside with the scroll anchor and backref arrow.
      const footnote = await waitForElement("aside.footnote-def#fn-source");
      await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "true"));
      expect([...footnote.querySelectorAll("strong")].map((strong) => strong.textContent)).toEqual(["result", "paragraph"]);
      expect(footnote.querySelector('a.footnote-backref[href="#fnref-source"]')).not.toBeNull();
      // The definition body is part of the ProseMirror surface: editing it writes back.
      editor.chain().focus().setTextSelection(nodePos(editor, "Supporting ")).insertContent("Extra ").run();
      await waitFor(() => expect(lastChange(onChange)).toContain("[^source]: Extra Supporting **result**.\n\n    Second **paragraph**."));
    });

    it("keeps path suggestions closed while a link field is empty", () => {
      render(
        <LinkPathSuggestionInput
          value=""
          pages={new Set()}
          folderPaths={new Set()}
          onValueChange={() => undefined}
          placeholder="Link URL"
          aria-label="Link URL"
        />,
      );
      fireEvent.focus(screen.getByRole("combobox", { name: "Link URL" }));
      expect(screen.queryByText("No matching paths")).not.toBeInTheDocument();
      expect(screen.queryByRole("listbox", { name: "Path suggestions" })).not.toBeInTheDocument();
    });

    it("renders and edits research hashtags as ordinary text", () => {
      const source = "Model statistics: #Params, #Tokens, and #Samples";
      const { surface, editor } = renderEditor(source);
      const markdown = () => editorMarkdown(editor);
      expect(surface).toHaveTextContent(source);
      expect(surface.querySelector("a.tag, [data-tag]")).toBeNull();
      expect(editor.schema.nodes.tag).toBeUndefined();
      expect(markdown().trimEnd()).toBe(source);
      expect(markdown()).not.toContain("\\#");
      act(() => { editor.chain().focus("end").insertContent(" #anything").run(); });
      expect(surface).toHaveTextContent("#anything");
      expect(screen.queryByRole("listbox", { name: "Tag suggestions" })).not.toBeInTheDocument();
      expect(markdown().trimEnd()).toBe(`${source} #anything`);
      expect(markdown()).not.toContain("\\#");
    });

    it("edits and removes an existing Markdown link in place", async () => {
      const { editor, onChange } = renderEditor("[Docs](https://old.example)");
      const openLinkEditor = () => act(() => {
        selectText(editor, 1, 5);
        window.dispatchEvent(new CustomEvent("research-writer:visual-link-insert", { detail: { editor } }));
      });
      openLinkEditor();
      const input = await screen.findByRole("textbox", { name: "Link URL" });
      expect(input).toHaveValue("https://old.example");
      expect(screen.queryByRole("button", { name: "Bold" })).not.toBeInTheDocument();
      fireEvent.change(input, { target: { value: "https://new.example" } });
      const outside = document.createElement("button");
      outside.textContent = "Outside";
      document.body.appendChild(outside);
      fireEvent.pointerDown(outside);
      fireEvent.click(outside);
      outside.remove();
      expect(screen.queryByRole("textbox", { name: "Link URL" })).not.toBeInTheDocument();
      await waitFor(() => expect(lastChange(onChange)).toBe("[Docs](https://new.example)"));
      await screen.findByRole("link", { name: "Docs" });
      openLinkEditor();
      await screen.findByRole("textbox", { name: "Link URL" });
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
      await waitFor(() => expect(lastChange(onChange)).toBe("Docs"));
      expect(screen.queryByRole("link", { name: "Docs" })).not.toBeInTheDocument();
    });

    it("copies line breaks as newlines without applying citation labels to other nodes", async () => {
      const { surface, editor } = renderEditor("Native models.\\\nVisual features.<br>Language connection.\n\nSee [Study](.research/papers/study/paper.md).\n\n---\n\nConclusion.");
      await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "true"));
      editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));
      const copied = new Map<string, string>();
      fireEvent.copy(surface, {
        clipboardData: { clearData: () => copied.clear(), setData: (type: string, value: string) => copied.set(type, value) },
      });
      expect(copied.get("text/plain")).toBe("Native models.\nVisual features.\nLanguage connection.\n\nSee Study.\n\nConclusion.");
    });
  });

  describe("tables", () => {
    const rowLengths = (table?: { content?: { content?: unknown[] }[] }) => table?.content?.map((row) => row.content?.length);

    async function mergeCells(markdown: string, from: number, to: number, cellTypes = ["tableHeader"]) {
      const view = renderEditor(markdown);
      const cells: number[] = [];
      view.editor.state.doc.descendants((node, position) => {
        if (cellTypes.includes(node.type.name)) cells.push(position);
      });
      view.editor.view.dispatch(view.editor.state.tr.setSelection(CellSelection.create(view.editor.state.doc, cells[from]!, cells[to]!)));
      return { surface: view.surface, editor: view.editor, merge: await screen.findByRole("button", { name: "Merge cells" }) };
    }

    async function splitCellAt(editor: Editor, text: string) {
      editor.commands.setTextSelection(nodePos(editor, text));
      fireEvent.click(await screen.findByRole("button", { name: "Split cell" }));
    }

    it.each([
      ["normal editing chrome without a scroll-triggered renderer", {}, ["frozenTableHeaders", "tableInsertControls"], ["chunkWrapperDecoration"]],
      ["paper reading with lightweight table cell handles", PAPER, ["chunkWrapperDecoration"], ["frozenTableHeaders", "tableInsertControls"]],
    ])("keeps %s editable", async (_label, props, present, absent) => {
      const { surface, editor } = renderEditor({ text: "| Column |\n| --- |\n| Value |", ...props });
      const extensionNames = editor.extensionManager.extensions.map((extension) => extension.name);
      for (const name of present) expect(extensionNames).toContain(name);
      for (const name of absent) expect(extensionNames).not.toContain(name);
      if (present.includes("frozenTableHeaders")) {
        expect(editor.extensionManager.extensions.find((extension) => extension.name === "frozenTableHeaders")?.options)
          .toMatchObject({ topOffset: 0, occludeTop: false });
      }
      expect(surface).toHaveAttribute("contenteditable", "true");
      act(() => { editor.chain().focus().setTextSelection(nodePos(editor, "Value")).run(); });
      expect(await screen.findAllByTestId("table-cell-handle")).toHaveLength(2);
    });

    it("renders and edits GFM tables as visual table cells without rewriting surrounding authored source", async () => {
      const { surface, editor, onChange } = renderEditor("Authored  prose\n\n| Left | Right |\n| :--- | ---: |\n| A | B |");
      await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "true"));
      expect(surface.querySelector("table")).not.toBeNull();
      expect(surface.querySelectorAll("th")).toHaveLength(2);
      expect(surface.querySelectorAll("td")).toHaveLength(2);
      expect(document.querySelector(".visual-markdown-raw-block")).toBeNull();
      expect(nodePos(editor, "A")).toBeGreaterThan(0);
      editor.commands.insertContentAt(nodePos(editor, "A"), "Updated ");
      await waitFor(() => expect(onChange).toHaveBeenCalled());
      expect(lastChange(onChange)).toContain("Updated");
      expect(lastChange(onChange).startsWith("Authored  prose\n\n")).toBe(true);
    });

    it("renders a flattened merged paper table without dropping or shifting columns", () => {
      const table = renderEditor(RADIO_TABLE).surface.querySelector<HTMLTableElement>("table")!;
      expect(table.rows).toHaveLength(4);
      for (const row of [0, 2, 3]) expect(table.rows[row]?.cells).toHaveLength(10);
      expect(table.rows[2]?.cells[0]).toHaveTextContent("C-RADIOv4");
      expect(table.rows[2]?.cells[1]).toHaveTextContent("SO400M-VDT8");
      expect(table.rows[3]?.cells[1]).toHaveTextContent("SO400M-G");
      expect(table.rows[3]?.cells[8]).toHaveTextContent("23.1");
      expect(table.rows[3]?.cells[9]).toHaveTextContent("41.4");
    });

    it("visually merges repeated labels in extracted-paper tables and expands them on save", async () => {
      const { surface, editor, onChange } = renderEditor({ text: RADIO_TABLE, ...PAPER });
      const table = surface.querySelector<HTMLTableElement>("table")!;
      expect(table.rows).toHaveLength(4);
      expect(table.rows[0]?.cells).toHaveLength(3);
      expect(table.rows[0]?.cells[1]).toHaveTextContent("Model");
      expect(table.rows[0]?.cells[1]).toHaveAttribute("rowspan", "2");
      expect(table.rows[0]?.cells[2]).toHaveTextContent("SA-Co/Gold");
      expect(table.rows[0]?.cells[2]).toHaveAttribute("colspan", "8");
      expect(table.rows[2]?.cells).toHaveLength(10);
      expect(table.rows[3]?.cells).toHaveLength(9);
      expect(table.rows[2]?.cells[0]).toHaveTextContent("C-RADIOv4");
      expect(table.rows[2]?.cells[0]).toHaveAttribute("rowspan", "2");
      expect(restoreUnchangedBlocks(editorMarkdown(editor), RADIO_TABLE, editor.state.doc, undefined, PAPER_PATH))
        .toBe(RADIO_TABLE);
      const repeatedLabelPosition = nodePos(editor, "C-RADIOv4");
      expect(repeatedLabelPosition).toBeGreaterThan(0);
      editor.commands.insertContentAt(repeatedLabelPosition, "Updated ");
      expect(editorMarkdown(editor).match(/\| Updated C-RADIOv4 \|/g)).toHaveLength(2);
      await waitFor(() => expect(lastChange(onChange).match(/\| Updated C-RADIOv4 \|/g)).toHaveLength(2));
    });

    it.each([
      ["infers a combined row and column span", INFERRED_TABLE, PAPER_PATH, 0, [2, 1, 3], { colspan: 2, rowspan: 2 }],
      ["honors an explicit layout and keeps its metadata out of the document", MERGED_LAYOUT_TABLE, "notes.md", 0, [2, 3], { colspan: 2 }],
      ["lets an explicit empty layout suppress paper span inference", `<!-- lattice-table-layout:v1 {"spans":[]} -->\n\n${INFERRED_TABLE}`, PAPER_PATH, 0, [3, 3, 3]],
      ["preserves an invalid layout comment instead of dropping table content", '<!-- lattice-table-layout:v1 {"spans":[[0,0,1,3]]} -->\n\n| A | B |\n| --- | --- |\n| C | D |', "notes.md", 1, [2, 2]],
      ["leaves repeated paper data as independent cells", "| Run | Status | Flag A | Flag B | Score |\n| --- | --- | --- | --- | --- |\n| A | Passed | Yes | Yes | 1 |\n| B | Passed | No | No | 2 |", PAPER_PATH, 0, [5, 5, 5]],
      ["leaves ambiguous intersections as independent cells", "| Group | Group | Metric |\n| --- | --- | --- |\n| Group | Variant | 1 |", PAPER_PATH, 0, [3, 3]],
      ["leaves single-level duplicate headers as independent cells", "| Run | Score | Score |\n| --- | --- | --- |\n| A | 1 | 2 |", PAPER_PATH, 0, [3, 3]],
      ["leaves single-stub duplicates as independent cells", "| State | Score |\n| --- | --- |\n| Active | 1 |\n| Active | 2 |", PAPER_PATH, 0, [2, 2, 2]],
    ] as const)("%s and round-trips the exact source", (_label, markdown, path, tableIndex, rows, originAttrs?: object) => {
      const parsed = parseVisualMarkdown(markdown, path);
      expect(parsed.content).toHaveLength(tableIndex + 1);
      expect(parsed.content?.[tableIndex]?.type).toBe("table");
      expect(rowLengths(parsed.content?.[tableIndex])).toEqual(rows);
      if (originAttrs) expect(parsed.content?.[tableIndex]?.content?.[0]?.content?.[0]?.attrs).toMatchObject(originAttrs);
      expect(getMarkdownManager().serialize(parsed)).toBe(`${markdown}\n`);
    });

    it("round-trips explicit layouts for tables nested in a blockquote", () => {
      const markdown = MERGED_LAYOUT_TABLE.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");
      const parsed = parseVisualMarkdown(markdown, "notes.md");
      const table = parsed.content?.[0]?.content?.[0];
      expect(parsed.content?.[0]?.type).toBe("blockquote");
      expect(table?.type).toBe("table");
      expect(table?.content?.[0]?.content?.[0]?.attrs?.colspan).toBe(2);
      const serialized = getMarkdownManager().serialize(parsed);
      expect(serialized).toContain('> <!-- lattice-table-layout:v1 {"spans":[[0,0,1,2]]} -->');
      expect(parseVisualMarkdown(serialized, "notes.md").content?.[0]?.content?.[0]?.content?.[0]?.content?.[0]?.attrs?.colspan).toBe(2);
    });

    it("refuses to serialize malformed table spans", () => {
      const parsed = parseVisualMarkdown("| A | B |\n| --- | --- |\n| C | D |", "notes.md");
      const origin = parsed.content?.[0]?.content?.[0]?.content?.[0];
      expect(origin).toBeDefined();
      origin!.attrs = { ...origin!.attrs, rowspan: 3 };
      expect(() => getMarkdownManager().serialize(parsed)).toThrow("Cannot serialize malformed table spans");
    });

    it("splits an inferred paper cell and persists the explicit unmerged layout", async () => {
      const { surface, editor } = renderEditor({ text: INFERRED_TABLE, ...PAPER });
      await splitCellAt(editor, "Group");
      const splitHeaders = surface.querySelectorAll("tr")[0]?.querySelectorAll("th");
      const splitBodyCells = surface.querySelectorAll("tr")[1]?.querySelectorAll("td");
      expect(splitHeaders).toHaveLength(3);
      expect(splitBodyCells).toHaveLength(3);
      for (const cell of [splitHeaders?.[0], splitHeaders?.[1], splitBodyCells?.[0], splitBodyCells?.[1]]) expect(cell).toHaveTextContent("Group");
      const serialized = editorMarkdown(editor);
      expect(serialized).toContain('<!-- lattice-table-layout:v1 {"spans":[]} -->');
      expect(rowLengths(parseVisualMarkdown(serialized, PAPER_PATH).content?.[0])).toEqual([3, 3, 3]);
    });

    it("splits one merged cell without discarding other explicit spans", async () => {
      const { surface, editor } = renderEditor([
        '<!-- lattice-table-layout:v1 {"spans":[[0,0,1,2],[0,2,1,2]]} -->',
        "",
        "| Left | Left | Right | Right |",
        "| --- | --- | --- | --- |",
        "| A | B | C | D |",
      ].join("\n"));
      await splitCellAt(editor, "Left");
      expect(surface.querySelectorAll("th")).toHaveLength(3);
      expect(surface.querySelectorAll("th")[2]).toHaveAttribute("colspan", "2");
      expect(editorMarkdown(editor)).toContain('<!-- lattice-table-layout:v1 {"spans":[[0,2,1,2]]} -->');
    });

    it("merges matching selected cells without duplicating content or losing column alignment", async () => {
      const { surface, editor, merge } = await mergeCells("| Group | Group | Metric |\n| :--- | ---: | :---: |\n| A | B | 1 |", 0, 1);
      expect(merge.closest("[data-testid='table-span-controls']")).toHaveClass("visual-table-span-controls");
      expect(merge.querySelector("svg")).toBeInTheDocument();
      fireEvent.click(merge);
      const headers = surface.querySelectorAll("th");
      expect(headers).toHaveLength(2);
      expect(headers[0]).toHaveTextContent("Group");
      expect(headers[0]).not.toHaveTextContent("GroupGroup");
      expect(headers[0]).toHaveAttribute("colspan", "2");
      await waitFor(() => {
        const handleButtons = screen.getAllByTestId("table-cell-handle").map((handle) => handle.querySelector("button"));
        expect(handleButtons).toHaveLength(2);
        for (const button of handleButtons) expect(button).toHaveClass("cursor-default");
      });
      const serialized = editorMarkdown(editor);
      expect(serialized).toContain('<!-- lattice-table-layout:v1 {"spans":[[0,0,1,2]]} -->');
      expect(serialized).toContain("| Group | Group | Metric |");
      expect(serialized).toContain("| :--- | ---: | :---: |");
      expect(parseVisualMarkdown(serialized, "notes.md").content?.[0]?.content?.[0]?.content?.[0]?.attrs?.colspan).toBe(2);
    });

    it("merges five selected cells and preserves every distinct value", async () => {
      const { surface, editor, merge } = await mergeCells("| One | Two | Three | Four | Five | Tail |\n| --- | --- | --- | --- | --- | --- |\n| A | B | C | D | E | F |", 0, 4);
      expect(merge).toBeEnabled();
      fireEvent.click(merge);
      const headers = surface.querySelectorAll("th");
      expect(headers).toHaveLength(2);
      expect(headers[0]).toHaveAttribute("colspan", "5");
      const serialized = editorMarkdown(editor);
      expect(serialized).toContain('<!-- lattice-table-layout:v1 {"spans":[[0,0,1,5]]} -->');
      for (const value of ["One", "Two", "Three", "Four", "Five"]) {
        expect(headers[0]).toHaveTextContent(value);
        expect(serialized).toContain(value);
      }
    });

    it("merges a four-cell rectangle across the header boundary", async () => {
      const { surface, editor, merge } = await mergeCells(
        "| Left | Right | Tail |\n| --- | --- | --- |\n| Lower left | Lower right | Value |\n| A | B | C |", 0, 4, ["tableHeader", "tableCell"],
      );
      expect(merge).toBeEnabled();
      fireEvent.click(merge);
      const merged = surface.querySelector("th");
      expect(merged).toHaveAttribute("colspan", "2");
      expect(merged).toHaveAttribute("rowspan", "2");
      for (const value of ["Left", "Right", "Lower left", "Lower right"]) expect(merged).toHaveTextContent(value);
      expect(editorMarkdown(editor)).toContain('<!-- lattice-table-layout:v1 {"spans":[[0,0,2,2]]} -->');
    });

    it("deletes a block-selected table instead of clearing its cells", async () => {
      const { surface, editor, onChange } = renderEditor(`Before\n\n${SIMPLE_TABLE}\n\nAfter`);
      selectNode(editor, typePos(editor, "table"));
      expect(editor.state.selection).toBeInstanceOf(NodeSelection);
      expect(surface.querySelector(".tableWrapper")).toHaveClass("ProseMirror-selectednode");
      expect(editor.commands.keyboardShortcut("Delete")).toBe(true);
      await waitFor(() => expect(lastChange(onChange)).toBe("Before\n\nAfter"));
      expect(surface.querySelector("table")).toBeNull();
    });

    it("shows table controls for a collapsed cell cursor and preserves the GFM header row", async () => {
      const { surface, editor, onChange } = renderEditor(SIMPLE_TABLE);
      editor.chain().focus().setTextSelection(nodePos(editor, "A")).run();
      const handles = await screen.findAllByTestId("table-cell-handle");
      expect(editor.state.selection.empty).toBe(true);
      expect(handles).toHaveLength(2);
      expect(handles[0]?.parentElement?.parentElement).toBe(document.body);
      expect(handles[0]?.parentElement).toHaveClass("is-visible");
      // jsdom gives floating-ui zero-sized rects, so its viewport middleware
      // correctly marks the portaled control hidden in tests. Query the hidden
      // control directly; browsers provide real geometry and reveal it.
      const rowOptions = handles[1]?.querySelector<HTMLButtonElement>("button");
      expect(rowOptions).toHaveAttribute("aria-label", "Row options");
      fireEvent.pointerDown(rowOptions!, { button: 0 });
      fireEvent.pointerUp(document);
      const insertRowBelow = await screen.findByRole("menuitem", { name: "Insert row below" });
      expect(insertRowBelow).toBeEnabled();
      fireEvent.click(insertRowBelow);
      await waitFor(() => expect(surface.querySelectorAll("tr")).toHaveLength(3));
      expect(surface.querySelectorAll("tr:first-child th")).toHaveLength(2);
      await waitFor(() => expect(lastChange(onChange)).toMatch(/\| Left\s+\| Right\s+\|\n\| -+ \| -+ \|/), { timeout: 2_500 });
    });

    it("anchors handles to logical columns and keeps merged tables out of rectangular drag reorder", async () => {
      const { editor } = renderEditor(MERGED_LAYOUT_TABLE);
      act(() => { editor.chain().focus().setTextSelection(nodePos(editor, "B")).run(); });
      const columnOptions = (await screen.findAllByTestId("table-cell-handle"))[0]?.querySelector<HTMLButtonElement>("button");
      // Drag reorder still assumes one PM cell per grid slot. The menu stays
      // available, but merged tables must not advertise or enter that gesture.
      expect(columnOptions).toHaveClass("cursor-default");
      expect(columnOptions).not.toHaveClass("cursor-grab");
      fireEvent.pointerDown(columnOptions!, { button: 0 });
      fireEvent.pointerUp(document);
      await screen.findByRole("menuitem", { name: "Insert column left" });
      const selection = editor.state.selection;
      if (!(selection instanceof CellSelection)) throw new Error("Expected a table cell selection");
      const tableStart = selection.$anchorCell.start(-1);
      // The second logical column is covered by the merged header at columns
      // 0..2, so the safe axis selection expands to that origin cell. The old
      // DOM cellIndex path incorrectly anchored this handle to Metric (2..3).
      expect(TableMap.get(selection.$anchorCell.node(-1)).rectBetween(selection.$anchorCell.pos - tableStart, selection.$headCell.pos - tableStart))
        .toMatchObject({ left: 0, right: 2 });
    });

    it("uses Enter to move down a table column and appends a row at the bottom", async () => {
      const { surface, editor, onChange } = renderEditor(SIMPLE_TABLE);
      editor.chain().focus().setTextSelection(nodePos(editor, "A")).run();
      fireEvent.keyDown(surface, { key: "Enter" });
      await waitFor(() => expect(surface.querySelectorAll("tr")).toHaveLength(3));
      expect(surface.querySelectorAll("tr:first-child th")).toHaveLength(2);
      await waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 2_500 });
    });

    it("moves down a column instead of splitting the cell when table text is selected", () => {
      // Upstream behavior: Enter with a non-empty in-cell selection still moves
      // to the row below (default Enter would delete the selection and split
      // the cell into an unrepresentable multi-paragraph shape).
      const { surface, editor } = renderEditor("| Left | Right |\n| --- | --- |\n| A value | B |");
      const textPosition = nodePos(editor, "A value");
      editor.chain().focus().setTextSelection({ from: textPosition, to: textPosition + 7 }).run();
      const tr = tableEnterDown(editor.state);
      expect(tr).not.toBeNull();
      editor.view.dispatch(tr!);
      // The selected text survives and a fresh row is appended below.
      expect(editor.state.doc.textContent).toContain("A value");
      expect(surface.querySelectorAll("tr")).toHaveLength(3);
      expect(editor.state.selection.empty).toBe(true);
    });
  });

  describe("source preservation and visual eligibility", () => {
    it.each<[string, string, string?]>([
      ["a four-backtick fence around backticks", "Editable\n\n````text\n```\n````", ".ok-codeblock"],
      ["a tilde fence around backticks", "Editable\n\n~~~text\n```\n~~~", ".ok-codeblock"],
      // Both nonstandard casing and metadata-bearing Mermaid fences stay code blocks.
      ["a mixed-case tilde Mermaid fence", "Editable\n\n~~~~MerMaid\ngraph TD; A-->B\n~~~~~", '.ok-codeblock[data-language="MerMaid"]'],
      ["a metadata-bearing Mermaid fence", "Editable\n\n````mermaid title=flow\ngraph TD; A-->B\n`````", '.ok-codeblock[data-language="mermaid"]'],
      ["reference links", "Editable paragraph\n\nRead [Results][paper].\n\n[paper]: results.md \"Title\""],
      ["inline HTML", "Editable paragraph\n\nPress <kbd class=\"key\">&copy;</kbd> now."],
      ["raw-text HTML", "Editable paragraph\n\nCode <script>a && b</script> after."],
      ["an HTML entity", "Editable paragraph\n\nCopyright &copy; 2026."],
      ["block HTML", "Editable paragraph\n\n<aside data-kind=\"note\">Exact HTML</aside>"],
      ["standalone inline HTML without making it a separate block", "Editable\n\nBefore\n<kbd>Ctrl</kbd>\nAfter"],
      ["source-sensitive image syntax", "Before ![Plot](<../figures/my plot.png> \"Results\") after"],
      ["authored LaTeX escapes in untouched inline math", "Accuracy is $88.55\\%$ and the state is $\\mathbf{x}_{p}$ here."],
      ["LaTeX math delimiters in untouched blocks", "Intro paragraph.\n\n\\[\nE=mc^2\n\\]\n\nInline \\(x_i\\) math."],
      ["LaTeX-delimited inline math", "Editable\n\nThe result is \\(x^2\\)."],
      ["LaTeX-delimited display math", "Editable\n\n\\[\nx^2 + y^2\n\\]"],
    ])("preserves %s exactly when nearby prose changes", async (_label, source, readySelector) => {
      const { surface, editor, onChange } = renderEditor(source);
      await (readySelector ? waitForElement(readySelector) : waitFor(() => expect(surface).toHaveAttribute("contenteditable", "true")));
      editor.commands.insertContentAt(1, "Updated ");
      await waitFor(() => expect(onChange).toHaveBeenCalled());
      expect(lastChange(onChange)).toBe(`Updated ${source}`);
    });

    it("preserves math, Mermaid fences, and raw blocks when nearby prose changes", async () => {
      const { editor, onChange } = renderEditor("Editable paragraph\n\nThe value is $x + y$.\n\n```MerMaid\ngraph TD; A-->B\n```\n\n[^note]: Keep  two spaces");
      await waitFor(() => {
        // Language casing is preserved while the fence stays a plain code block.
        expect(document.querySelector('.ok-codeblock[data-language="MerMaid"]')).not.toBeNull();
        // Upstream footnote UI: core renderHTML emits the auto-numbered
        // aside with the fn-{id} anchor and the ↩ back-reference.
        expect(document.querySelector("aside.footnote-def#fn-note")).not.toBeNull();
        expect(document.querySelector('a.footnote-backref[href="#fnref-note"]')).not.toBeNull();
      });
      editor.commands.insertContentAt(1, "Updated ");
      await waitFor(() => expect(onChange).toHaveBeenCalled());
      for (const kept of ["$x + y$", "```MerMaid\ngraph TD; A-->B\n```", "[^note]: Keep  two spaces"]) expect(lastChange(onChange)).toContain(kept);
    });

    it("round-trips Markdown images instead of dropping them on the first edit", async () => {
      const { editor, onChange } = renderEditor("Before ![Plot](figures/plot.png \"Results\") after");
      expect(await screen.findByRole("img", { name: "Plot" })).toHaveAttribute("src", "/figures/plot.png");
      editor.commands.insertContentAt(1, "Updated ");
      await waitFor(() => expect(onChange).toHaveBeenCalled());
      expect(lastChange(onChange)).toContain('![Plot](figures/plot.png "Results")');
    });

    it("keeps thematic breaks and the prose between them visually editable", () => {
      const { surface, editor } = renderEditor("Intro\n\n---\n\nMiddle\n\n---\n\nEnd");
      expect(surface).toHaveTextContent("Middle");
      expect(document.querySelector(".visual-markdown-raw-block")).toBeNull();
      fireEvent.click(surface.querySelector("hr")!);
      expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    });

    it("keeps unmappable Markdown source-only and never splices best-effort ranges into it", async () => {
      const { surface, editor } = renderEditor(UNMAPPABLE_MARKDOWN);
      await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "false"));
      const status = screen.getByRole("status");
      expect(status).toHaveTextContent("unsupported or lossy syntax");
      expect(status).toHaveClass("visual-markdown-eligibility", "warning");
      expect(status).not.toHaveClass("error");
      expect(exactVisualSourceRanges(UNMAPPABLE_MARKDOWN, editor.state.doc.childCount)).toBeNull();
      const canonical = "<!-- c -->\n\n[^n]: First paragraph.\n\nNot a continuation.\n";
      expect(restoreUnchangedBlocks(canonical, UNMAPPABLE_MARKDOWN, editor.state.doc)).toBe(canonical);
      expect(restoreUnchangedBlocks(canonical, UNMAPPABLE_MARKDOWN, editor.state.doc)).toBe(canonical);
    });

    it.each([
      ["an ordinally shifted block after a non-adjacent move", "A\n\nB\n\nC\n", "B\n\nC\n\nA\n", [0, 2]],
      ["a changed heading level with unchanged text", "## Title\n", "### Title\n", []],
    ])("does not restore %s", (_label, original, changed, unchanged) => {
      const { editor } = renderEditor(original);
      const changedDoc = editor.state.doc.type.schema.nodeFromJSON(parseVisualMarkdown(changed));
      expect(restoreUnchangedBlocks(changed, original, changedDoc, new Set(unchanged))).toBe(changed);
    });

    it("reports a lossy paper to its parent without an in-article warning, then clears it once lossless", async () => {
      const onEligibilityChange = vi.fn();
      const { surface, rerender } = renderEditor({ text: UNMAPPABLE_MARKDOWN, ...PAPER, onEligibilityChange });
      await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "false"));
      expect(onEligibilityChange).toHaveBeenLastCalledWith(expect.stringContaining("unsupported or lossy syntax"));
      expect(screen.queryByText("unsupported or lossy syntax", { exact: false })).not.toBeInTheDocument();
      fireEvent.keyDown(surface, { key: "f", altKey: true, metaKey: true });
      expect(screen.getByRole("button", { name: "Replace current match" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Replace all matches" })).toBeDisabled();
      // The same paper path becoming lossless clears the stale warning.
      rerender({ text: "A lossless paper body." });
      await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "true"));
      expect(screen.queryByText("unsupported or lossy syntax", { exact: false })).not.toBeInTheDocument();
    });

    // Every arxiv2md paper opens on syntax the serializer would renormalize: a
    // `## Contents` heading sitting directly on its list, a bold caption sitting
    // directly on its table, `\*` escaping inside a caption. None of it is the
    // reader's typing, so none of it may cost them visual editing — or rewrite
    // the file underneath them on open.
    it.each([
      ["frontmatter", "---\ntitle: Example\nauthors: [Ada]\n---\n\nPaper body.\n"],
      ["a heading tight against its list", "## Contents\n- 1 Introduction\n- 2 Approach\n"],
      ["a caption tight against its table", "**Table 1: Caption.**\n| A | B |\n| --- | --- |\n| 1 | 2 |\n"],
      ["a paragraph tight against its list", "Questions we answer:\n1) First\n2) Second\n"],
      ["a converter checklist", "- 1.\nFirst answer\n- 2.\nSecond answer\n"],
      ["bare converter ordinals", "1.\nFirst answer\n2\\.\nSecond answer\n"],
      ["a stray asterisk in prose", "The authors (1* and 2*) contributed equally.\n"],
      ["emphasis nested in a bold caption", "**Table 1: A *single* Flamingo model.**\n"],
      ["an indented paragraph after a footnote", "[^n]: First paragraph.\n\n  Not a continuation."],
      ["converter-normalized paper math", "## Contents\n\n- Intro\n\n<a id=\"eq\"></a>\n\n$$\nx_{p} \\%\n$$\n\n- •\n  Accuracy is $88.55\\%$ and the state is $\\mathbf{x}_{p}$.\n"],
      // AI assistants emit `\[ … \]` / `\( … \)`; the chat renderer accepts
      // them, so the document surface must too.
      ["LaTeX-delimited math", "Before text.\n\n\\[\n\\mathcal{L}_{\\mathrm{tea}}\n=\n\\sum_{k\\in T} w_k\n\\]\n\nAfter \\(f_S^{\\ell}\\) math.\n"],
    ])("keeps converter Markdown editable and byte-identical: %s", async (_label, markdown) => {
      const { surface, onChange } = renderEditor(markdown);
      await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "true"));
      expect(screen.queryByText("unsupported or lossy syntax", { exact: false })).not.toBeInTheDocument();
      // Opening it may not publish a rewrite of syntax nobody touched.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(onChange).not.toHaveBeenCalled();
    });

    it("renders bare paper ordinals as one continuous list without visible escapes", async () => {
      const { surface, onChange } = renderEditor([
        "1.", "Constrained visual capabilities.",
        "2\\.", "Challenges in efficient training and deployment.",
        "3.", "Multiple components complicate the scaling analysis.",
        "4\\.", "Limited image pre-processing flexibility.",
        "",
      ].join("\n"));
      await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "true"));
      expect(surface.querySelectorAll("ol")).toHaveLength(1);
      expect(surface.querySelectorAll("ol > li")).toHaveLength(4);
      expect(surface).not.toHaveTextContent("2\\.");
      expect(surface).not.toHaveTextContent("4\\.");
      expect(onChange).not.toHaveBeenCalled();
    });

    it("re-serializes only the edited block and leaves tight boundaries alone", async () => {
      const { surface, editor, onChange } = renderEditor("## Contents\n- 1 Introduction\n\nClosing prose.\n");
      await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "true"));
      editor.chain().focus().setTextSelection(nodePos(editor, "Closing prose.") + "Closing prose.".length).insertContent("!").run();
      await waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 2_500 });
      // The heading keeps sitting directly on its list; only the edited
      // paragraph went through the serializer.
      expect(lastChange(onChange)).toBe("## Contents\n- 1 Introduction\n\nClosing prose.!\n");
    });

    it("survives a document whose raw MDX parse throws", async () => {
      // A PDF text-layer paper can carry an unclosed `{`. parse-with-fallback
      // recovers the document parse, but the source-range probe
      // (parseToEditorMdast) throws raw — it must degrade, not crash the
      // editor (it used to take the whole app down with it). Eligibility keeps
      // making its own call from the round trip: this minimal document happens
      // to be lossless, a real PDF paper usually is not and locks to source
      // mode.
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      renderEditor("# UNIC quiet fallback\n\nBefore the break.\n\nvalue = {0|150|never closed\n\nAfter the break.\n");
      const surface = await screen.findByRole("textbox", { name: "Markdown document editor" });
      await waitFor(() => expect(surface.textContent).toContain("Before the break."));
      expect(surface.textContent).toContain("After the break.");
      expect(consoleWarn.mock.calls.some((call) => String(call[0]).includes("editor-mdast-parse-failed"))).toBe(false);
    });

    it("records recovered malformed MDX without flooding the application log", () => {
      resetParseHealth();
      onTestFinished(resetParseHealth);
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const parsed = parseWithFallback("Before\n\nbroken MDX\n\nAfter", {
        parse: (markdown) => {
          const offset = markdown.indexOf("broken MDX");
          if (offset !== -1) throw Object.assign(new Error("Malformed MDX"), { position: { offset } });
          return { type: "doc", content: markdown ? [{ type: "paragraph", content: [{ type: "text", text: markdown }] }] : [] };
        },
      });
      expect(parsed.content?.some((node) => node.type === "rawMdxFallback")).toBe(true);
      expect(getParseHealth().parseFallback.blockLevel).toBeGreaterThan(0);
      expect(consoleWarn.mock.calls.some((call) => String(call[0]).includes("mdx-block-fallback"))).toBe(false);
    });
  });

  describe("math", () => {
    it("collapses typed $formula$ and [label](url) literals into an inline math atom and a link", async () => {
      // Input rules fire only from handleTextInput, so type character by
      // character the way the DOM input path does (upstream test technique).
      const { surface, editor, onChange } = renderEditor("Start here: ");
      editor.chain().focus("end").run();
      typeText(editor, "$x+y$");
      // The rule collapses the completed literal a microtask after the closing $.
      await waitFor(() => expect(editor.state.doc.nodeAt(typePos(editor, "mathInline"))?.attrs.formula).toBe("x+y"));
      await waitFor(() => expect(lastChange(onChange)).toContain("$x+y$"));
      editor.chain().focus("end").run();
      typeText(editor, " see [docs](https://example.com)");
      await waitFor(() => expect(surface.querySelector('a[href="https://example.com"]')).toHaveTextContent("docs"));
      await waitFor(() => expect(lastChange(onChange)).toContain("[docs](https://example.com)"));
    });

    it("renders inline math without disabling visual editing and visibly selects the atom", async () => {
      const { surface, editor } = renderEditor("The result is $x^2$.");
      expect(surface).toHaveAttribute("contenteditable", "true");
      // MathInlineView renders KaTeX inside the click-to-edit trigger span.
      const trigger = (await waitForElement(".math-inline-trigger .katex")).closest(".math-inline-trigger")!;
      selectNode(editor, typePos(editor, "mathInline"));
      expect(trigger.closest(".ProseMirror-selectednode")).not.toBeNull();
    });

    it("renders complete-editor math before any viewport intersection, with LaTeX 2.09 font compatibility macros", async () => {
      stubPassiveIntersectionObserver();
      const { surface } = renderEditor("Inline $\\sc t$ and ${\\sl slanted}$.\n\n$$\n{\\sc Display}\n$$");
      expect(surface).toHaveAttribute("contenteditable", "true");
      await waitFor(() => expect(surface.querySelectorAll(".katex")).toHaveLength(3));
      expect(surface.querySelector(".math-placeholder")).toBeNull();
      expect(document.querySelector('[style*="color:#cc0000"]')).toBeNull();
      expect(document.querySelector(".math-inline-trigger .mathrm")).toHaveTextContent("t");
      expect(document.querySelector(".math-inline-trigger .mathit")).toHaveTextContent("slanted");
      expect(document.querySelector(".math-display .mathrm")).toHaveTextContent("Display");
    });

    it("opens inline math properties only when the atom itself is selected", async () => {
      const { surface, editor } = renderEditor("Before $x^2$ after.");
      const trigger = await waitForElement(".math-inline-trigger");
      await act(async () => {
        selectNode(editor, 0);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
      expect(surface.firstElementChild).toHaveClass("ProseMirror-selectednode");
      expect(trigger.closest(".math-inline-selected")).toBeNull();
      expect(screen.queryByText("Inline Math Properties")).not.toBeInTheDocument();
      selectNode(editor, typePos(editor, "mathInline"));
      expect(await screen.findByText("Inline Math Properties")).toBeInTheDocument();
      // In Chromium the NodeSelection effect can open the controlled popover
      // before the original pointer click reaches Radix's trigger. That same
      // click must not immediately toggle the newly opened popover closed.
      fireEvent.click(trigger);
      expect(trigger).toHaveAttribute("data-state", "open");
      expect(screen.getByText("Inline Math Properties")).toBeInTheDocument();
    });

    it.each([
      ["a dollar-delimited equation in place", "The result is $x^2$."],
      // The formula edit nulls sourceRaw, so LaTeX delimiters give way to the
      // canonical dollar form.
      ["a LaTeX inline formula and canonicalizes it to dollars", "The result is \\(x^2\\)."],
    ])("edits %s", async (_label, source) => {
      const { editor, onChange } = renderEditor(source);
      await waitForElement(".math-inline-trigger");
      // Upstream flow: a NodeSelection on the atom (click / slash-insert)
      // opens the PropPanel popover anchored to it.
      selectNode(editor, typePos(editor, "mathInline"));
      const input = await screen.findByRole("textbox", { name: /formula/i });
      // Formula edits stay local until the author confirms them.
      fireEvent.change(input, { target: { value: "y^3" } });
      expect(onChange).not.toHaveBeenCalled();
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(onChange).toHaveBeenCalledWith("The result is $y^3$.", source));
    });

    it("keeps the inline math editor open while a formula is typed character by character", async () => {
      render(<ControlledEditor initial="The result is $x$." />);
      const { editor } = getSurface();
      await waitForElement(".math-inline-trigger");
      const atomPosition = typePos(editor, "mathInline");
      selectNode(editor, atomPosition);
      for (const formula of ["a", "ab", "abc", "abc+1"]) {
        fireEvent.change(await screen.findByRole("textbox", { name: /formula/i }), { target: { value: formula } });
        await waitFor(() => expect(screen.getByRole("textbox", { name: /formula/i })).toHaveValue(formula));
        await waitFor(() => expect(document.querySelector(".math-inline-trigger")).toHaveAttribute("data-formula", formula));
      }
      expect(editor.state.doc.nodeAt(atomPosition)?.attrs.formula).toBe("x");
      fireEvent.keyDown(screen.getByRole("textbox", { name: /formula/i }), { key: "Enter" });
      await waitFor(() => expect(screen.queryByRole("textbox", { name: /formula/i })).not.toBeInTheDocument());
      expect(editor.state.doc.nodeAt(atomPosition)?.attrs.formula).toBe("abc+1");
    });

    it("preserves block-math formulas when copied between visual editors", async () => {
      render(
        <>
          <VisualMarkdownEditor {...editorProps({ text: "$$\nE=mc^2\n$$", activePath: "source.md" })} />
          <VisualMarkdownEditor {...editorProps({ text: "Destination", activePath: "destination.md" })} />
        </>,
      );
      const [sourceSurface, destinationSurface] = screen.getAllByRole("textbox", { name: "Markdown document editor" }) as (HTMLElement & { editor: Editor })[];
      await waitFor(() => {
        expect(sourceSurface).toHaveAttribute("contenteditable", "true");
        expect(destinationSurface).toHaveAttribute("contenteditable", "true");
      });
      const { editor: sourceEditor } = sourceSurface;
      const { editor: destinationEditor } = destinationSurface;
      const sourceMath = sourceEditor.state.doc.firstChild!;
      sourceEditor.view.dispatch(sourceEditor.state.tr.setNodeMarkup(0, null, {
        ...sourceMath.attrs,
        props: { ...sourceMath.attrs.props, formula: "E=mc^3" },
        sourceDirty: true,
      }));
      selectNode(sourceEditor, 0);
      const data = new Map<string, string>();
      const clipboardData = {
        clearData: () => data.clear(),
        getData: (type: string) => data.get(type) ?? "",
        setData: (type: string, value: string) => { data.set(type, value); },
      } as unknown as DataTransfer;
      fireEvent.copy(sourceSurface, { clipboardData });
      expect(data.get("text/html")).toContain('data-component-name="DollarMath"');
      destinationEditor.view.dispatch(destinationEditor.state.tr.setSelection(new AllSelection(destinationEditor.state.doc)));
      fireEvent.paste(destinationSurface, { clipboardData });
      const pasted = destinationEditor.state.doc.firstChild;
      expect(pasted?.type.name).toBe("jsxComponent");
      expect(pasted?.attrs.componentName).toBe("DollarMath");
      expect(pasted?.attrs.props).toMatchObject({ formula: "E=mc^3" });
      expect(pasted?.attrs.sourceDirty).toBe(true);
      expect(editorMarkdown(destinationEditor)).toContain("E=mc^3");
    });

    it("keeps dollar-denominated prices as prose", async () => {
      const { surface } = renderEditor("It costs $5 and then $10 more.");
      await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "true"));
      expect(surface).toHaveTextContent("It costs $5 and then $10 more.");
      expect(document.querySelector(".math-inline-trigger")).toBeNull();
    });

    it("parses LaTeX display and inline delimiters into math nodes with their exact source", () => {
      // The `=` line is load-bearing: without the display-delimiter swap it
      // turns the formula head into a setext heading.
      const parsed = parseVisualMarkdown("Before text.\n\n\\[\n\\mathcal{L}_{\\mathrm{tea}}\n=\n\\sum_{k\\in T} w_k\n\\]\n\nAfter \\(f_S^{\\ell}\\) math.\n", "notes.md");
      expect((parsed.content ?? []).map((node) => node.attrs?.componentName ?? node.type)).toEqual(["paragraph", "DollarMath", "paragraph"]);
      expect(parsed.content?.[1]?.attrs?.sourceRaw).toBe("\\[\n\\mathcal{L}_{\\mathrm{tea}}\n=\n\\sum_{k\\in T} w_k\n\\]");
      const inline = parsed.content?.[2]?.content?.find((node) => node.type === "mathInline");
      expect(inline?.attrs?.formula).toBe("f_S^{\\ell}");
      expect(inline?.attrs?.sourceRaw).toBe("\\(f_S^{\\ell}\\)");
    });

    it("preserves single-dollar inline math inside converted list prose", () => {
      const markdown = "- •\n  No positional information.\n- •\n  One-dimensional embeddings.\n- •\n  Two axes use $X$ and $Y$, each with size $D/2$.\n- •\n  Relative positional embeddings.\n";
      const serialized = preserveMarkdownEnvelope(getMarkdownManager().serialize(parseVisualMarkdown(markdown, "paper.md")), markdown);
      expect(canonicalizeSupportedMarkdown(serialized)).toBe(canonicalizeSupportedMarkdown(markdown));
    });

    it("keeps latex delimiters inside code fences as code", () => {
      const source = "```latex\n\\[\nE=mc^2\n\\]\n```\n";
      const parsed = parseVisualMarkdown(source, "notes.md");
      expect((parsed.content ?? []).map((node) => node.type)).toEqual(["codeBlock"]);
      expect(preserveMarkdownEnvelope(getMarkdownManager().serialize(parsed), source)).toBe(source);
    });

    it("promotes a single-line latex display block and round-trips its bytes", () => {
      const source = "\\[E=mc^2\\]\n";
      const parsed = parseVisualMarkdown(source, "notes.md");
      const inline = parsed.content?.[0]?.content?.find((node) => node.type === "mathInline");
      expect(inline?.attrs?.formula).toBe("E=mc^2");
      expect(inline?.attrs?.sourceRaw).toBe("\\[E=mc^2\\]");
      expect(preserveMarkdownEnvelope(getMarkdownManager().serialize(parsed), source)).toBe(source);
    });

    it("pairs multiple inline latex spans across a misparsed emphasis run", () => {
      // Two subscripted spans in one paragraph: the `_` after `{supp}` and the
      // `_` before `{\mathrm{tea}}` pair into an emphasis run that hides the
      // first `\)` inside its children. The close scan must descend into the
      // misparsed container — pairing with the second span's close swallowed
      // the prose between into one broken (red) formula.
      const source = "\\(\\mathrm{supp}_{\\mathrm{par}}\\) 问的是「**哪些权重被编辑**」；\\(\\mathrm{supp}_{\\mathrm{tea}}\\) 问的是「**哪些特征被监督**」。\n";
      const parsed = parseVisualMarkdown(source, "notes.md");
      const nodes = parsed.content?.[0]?.content ?? [];
      expect(nodes.filter((node) => node.type === "mathInline").map((node) => node.attrs?.formula))
        .toEqual(["\\mathrm{supp}_{\\mathrm{par}}", "\\mathrm{supp}_{\\mathrm{tea}}"]);
      // The bold runs were authored, not misparse artifacts — they survive the
      // unwrap as real marks.
      const text = nodes.map((node) => (node.type === "text" ? node.text : "")).join("");
      expect(text).toContain("哪些权重被编辑");
      expect(text).toContain("哪些特征被监督");
      expect(preserveMarkdownEnvelope(getMarkdownManager().serialize(parsed), source)).toBe(source);
    });
  });

  describe("previews and images", () => {
    it("renders Mermaid as a normal code block with a preview toggle and plain HTML as a default preview", async () => {
      renderEditor("```mermaid\ngraph TD; A-->B\n```\n\n```html\n<p>Visual by default</p>\n```");
      const block = await waitForElement('.ok-codeblock[data-language="mermaid"]');
      expect(block).toHaveAttribute("data-code-visible", "false");
      expect(screen.getByRole("button", { name: "Code block language: Mermaid. Click to change." })).toBeInTheDocument();
      expect(await screen.findByRole("group", { name: "Mermaid preview" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Hide Mermaid preview" }));
      expect(screen.queryByRole("group", { name: "Mermaid preview" })).not.toBeInTheDocument();
      expect(block).toHaveAttribute("data-code-visible", "true");
      fireEvent.click(screen.getByRole("button", { name: "Show Mermaid preview" }));
      const previewWrapper = (await screen.findByRole("group", { name: "Mermaid preview" })).closest<HTMLElement>(".ok-codeblock-preview")!;
      expect(previewWrapper).toHaveClass("ok-codeblock-preview--mermaid");
      expect(previewWrapper.querySelector(".ok-resize-handle--l")).not.toBeNull();
      expect(previewWrapper.querySelector(".ok-resize-handle--r")).not.toBeNull();
      expect(previewWrapper.querySelector(".ok-resize-handle--b")).toBeNull();
      expect(block).toHaveAttribute("data-code-visible", "false");
      expect(block).toHaveTextContent("graph TD; A-->B");
      expect(await screen.findByTitle("HTML preview")).toBeInTheDocument();
      expect(document.querySelector('.ok-codeblock[data-language="html"]')).toHaveAttribute("data-code-visible", "false");
      expect(screen.getByRole("button", { name: "Hide HTML preview" })).toBeInTheDocument();
    });

    it("offers Mermaid in the code block language picker", async () => {
      const { onChange } = renderEditor("```text\ngraph TD; A-->B\n```");
      fireEvent.click(await screen.findByRole("button", { name: "Code block language: Plain text. Click to change." }));
      fireEvent.change(await screen.findByPlaceholderText("Filter languages"), { target: { value: "Mermaid" } });
      fireEvent.click(await screen.findByRole("option", { name: "Mermaid" }));
      expect(await screen.findByRole("group", { name: "Mermaid preview" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Hide Mermaid preview" })).toBeInTheDocument();
      await waitFor(() => expect(lastChange(onChange)).toBe("```mermaid\ngraph TD; A-->B\n```"));
    });

    it("keeps Mermaid source editable as an ordinary fenced code block", async () => {
      const { editor, onChange } = renderEditor("```mermaid\ngraph TD; A-->B\n```");
      const sourcePos = nodePos(editor, "graph TD; A-->B");
      expect(sourcePos).toBeGreaterThan(-1);
      editor.view.dispatch(editor.state.tr.replaceWith(sourcePos, sourcePos + "graph TD; A-->B".length, editor.schema.text("graph LR; B-->C")));
      await waitFor(() => expect(onChange).toHaveBeenCalledWith("```mermaid\ngraph LR; B-->C\n```", "```mermaid\ngraph TD; A-->B\n```"));
    });

    it("keeps existing Mermaid and HTML previews mounted across adjacent inserts and controlled Markdown echoes", async () => {
      render(<ControlledEditor initial={["Before", "```mermaid\ngraph TD; A-->B\n```", "```html preview\n<p>Persistent HTML</p>\n```", "Tail"].join("\n\n")} />);
      const { editor } = getSurface();
      const mermaid = await screen.findByRole("group", { name: "Mermaid preview" });
      const html = await screen.findByTitle("HTML preview");
      const htmlBlock = html.closest(".ok-codeblock");
      const heading = editor.schema.nodes.heading.create({ level: 2 }, editor.schema.text("Inserted basic block"));
      act(() => { editor.view.dispatch(editor.state.tr.insert(editor.state.doc.firstChild!.nodeSize, heading)); });
      await waitFor(() => expect(getSurface()).toHaveTextContent("Inserted basic block"));
      expect(screen.getByTitle("HTML preview")).toBe(html);
      expect(html.closest(".ok-codeblock")).toBe(htmlBlock);
      const tailPosition = nodePos(editor, (node) => node.type.name === "paragraph" && node.textContent === "Tail");
      expect(tailPosition).toBeGreaterThanOrEqual(0);
      act(() => addBlockBelow(editor, tailPosition, editor.state.doc.nodeAt(tailPosition)!));
      expect(await screen.findByRole("listbox", { name: "Slash commands" })).toBeInTheDocument();
      await new Promise((resolve) => window.setTimeout(resolve, 300));
      expect(screen.getByRole("group", { name: "Mermaid preview" })).toBe(mermaid);
      expect(screen.getByTitle("HTML preview")).toBe(html);
    });

    it("renders extracted multi-panel paper figures with source slots and alignment", async () => {
      const markdown = [
        '<PaperFigure id="S2.F1">', "", '<PaperFigureRow columns="3 3 3">', "",
        '<PaperFigurePanel id="S2.F1.placeholder">', "</PaperFigurePanel>", "",
        '<PaperFigurePanel id="S2.F1.sf1">', "", "![First panel](paper_assets/first.webp)", "", "*(a) Swiss Roll*", "", "</PaperFigurePanel>", "",
        '<PaperFigurePanel id="S2.F1.sf2">', "", "![Second panel](paper_assets/second.webp)", "", "*(b) Torus*", "", "</PaperFigurePanel>", "",
        "</PaperFigureRow>", "", "*Figure 1: Manifold examples.*", "", "</PaperFigure>",
      ].join("\n");
      const activePath = ".research/papers/2311.03757/paper.md";
      const parsed = parseVisualMarkdown(markdown, activePath);
      const row = parsed.content?.[0]?.content?.[0];
      expect(parsed.content?.[0]?.attrs?.componentName).toBe("PaperFigure");
      expect(row?.attrs?.componentName).toBe("PaperFigureRow");
      expect(row?.attrs?.props).toMatchObject({ columns: "3 3 3" });
      expect(row?.content?.map((node) => node.attrs?.componentName)).toEqual(["PaperFigurePanel", "PaperFigurePanel", "PaperFigurePanel"]);

      const { editor } = renderEditor({ text: markdown, activePath, onLoadAsset: async (path) => `data:image/webp;base64,${path}` });
      const figure = await waitForElement(".paper-figure");
      expect(figure).toHaveAttribute("id", "S2.F1");
      expect(figure.querySelector<HTMLElement>(".paper-figure-row")?.style.getPropertyValue("--paper-figure-columns"))
        .toBe("minmax(0, calc(100% / 3)) minmax(0, calc(100% / 3)) minmax(0, calc(100% / 3))");
      expect(figure.querySelectorAll(".paper-figure-panel")).toHaveLength(3);
      expect(document.getElementById("S2.F1.placeholder")).toBeInTheDocument();
      expect(document.getElementById("S2.F1.sf1")).toHaveTextContent("(a) Swiss Roll");
      expect(document.getElementById("S2.F1.sf2")).toHaveTextContent("(b) Torus");
      expect(await screen.findByRole("img", { name: "First panel" })).toBeInTheDocument();
      expect(screen.getByRole("img", { name: "Second panel" })).toBeInTheDocument();

      editor.commands.insertContentAt(nodePos(editor, (node) => node.type.name === "paragraph" && node.textContent === "(a) Swiss Roll") + 1, "Updated ");
      const edited = editorMarkdown(editor);
      for (const kept of ["<PaperFigure", "*Updated (a) Swiss Roll*", '<PaperFigureRow columns="3 3 3">', '<PaperFigurePanel id="S2.F1.placeholder">']) {
        expect(edited).toContain(kept);
      }
      expect(parseVisualMarkdown(edited, activePath).content?.[0]?.attrs?.componentName).toBe("PaperFigure");
    });

    it.each([
      ["a project-relative Markdown image", "![Plot](../figures/plot.png)", "figures/plot.png", "Plot"],
      ["an Open Knowledge image component", '<img src="../figures/block.png" alt="Block" />', "figures/block.png", "Block"],
    ])("loads %s through the host asset reader", async (_label, text, path, name) => {
      const onLoadAsset = vi.fn(async () => PNG);
      renderEditor({ text, activePath: "notes/results.md", onLoadAsset });
      await waitFor(() => expect(onLoadAsset).toHaveBeenCalledWith(path));
      await waitFor(() => expect(screen.getByRole("img", { name })).toHaveAttribute("src", PNG));
      expect(screen.getByRole("img", { name })).toHaveAttribute("decoding", "async");
    });

    it.each(["above", "below", "far below"] as const)("keeps a loaded Markdown image visible when the plus action inserts %s it", async (side) => {
      const onLoadAsset = vi.fn(async () => PNG);
      render(<ControlledEditor initial={["Before", "![Plot](figures/plot.png)", "After", "Far 1", "Far 2", "Far 3", "Far 4", "Far 5"].join("\n\n")} onLoadAsset={onLoadAsset} />);
      const { editor } = getSurface();
      let canonicalReplacements = 0;
      const dispatch = editor.view.dispatch.bind(editor.view);
      vi.spyOn(editor.view, "dispatch").mockImplementation((transaction) => {
        if (transaction.getMeta("canonicalMarkdownReplace")) canonicalReplacements += 1;
        dispatch(transaction);
      });
      await waitFor(() => expect(screen.getByRole("img", { name: "Plot" })).toHaveAttribute("src", PNG));
      fireEvent.load(screen.getByRole("img", { name: "Plot" }));
      await waitFor(() => expect(screen.queryByTestId("image-loading-skeleton")).not.toBeInTheDocument());
      const image = screen.getByRole("img", { name: "Plot" });
      const imagePosition = nodePos(editor, (node) => node.type.name === "jsxComponent" && node.attrs.componentName === "CommonMarkImage");
      const farPosition = nodePos(editor, (node) => node.type.name === "paragraph" && node.textContent === "Far 5");
      expect(imagePosition).toBeGreaterThanOrEqual(0);
      expect(farPosition).toBeGreaterThan(imagePosition);
      const targetPosition = { above: 0, below: imagePosition, "far below": farPosition }[side];
      const target = editor.state.doc.nodeAt(targetPosition);
      expect(target).not.toBeNull();

      act(() => addBlockBelow(editor, targetPosition, target!));

      expect(screen.getByRole("img", { name: "Plot" })).toBe(image);
      expect(await screen.findByRole("listbox", { name: "Slash commands" })).toBeInTheDocument();
      await new Promise((resolve) => window.setTimeout(resolve, 300));
      expect(canonicalReplacements).toBe(0);
      expect(screen.getByRole("img", { name: "Plot" })).toBe(image);
      expect(image).toHaveAttribute("src", PNG);
      expect(image).toHaveClass("opacity-100");
      expect(screen.queryByTestId("image-loading-skeleton")).not.toBeInTheDocument();
      expect(onLoadAsset).toHaveBeenCalledTimes(1);
    });

    it("expands a Markdown image beyond its rendered editor size", async () => {
      let finishDecode: () => void = () => undefined;
      const decoded = new Promise<void>((resolve) => { finishDecode = resolve; });
      overrideProperty(HTMLImageElement.prototype, "currentSrc", { get(this: HTMLImageElement) { return this.src; } });
      overrideProperty(HTMLImageElement.prototype, "decode", { value: vi.fn(() => decoded) });
      overrideProperty(HTMLDialogElement.prototype, "showModal", { value(this: HTMLDialogElement) { this.setAttribute("open", ""); } });
      overrideProperty(HTMLDialogElement.prototype, "close", { value(this: HTMLDialogElement) { this.removeAttribute("open"); } });
      renderEditor("![Plot](figures/plot.png)");
      const image = await screen.findByRole("img", { name: "Plot" });
      setRect(image, new DOMRect(100, 200, 400, 200));
      await act(async () => {
        finishDecode();
        await decoded;
      });
      fireEvent.load(image);
      await waitForElement("[data-rmiz-btn-zoom]");
      fireEvent.click(image);
      const expanded = document.querySelector<HTMLElement>("[data-rmiz-modal-img]");
      expect(expanded).not.toBeNull();
      await waitFor(() => expect(Number.parseFloat(expanded!.style.width)).toBeGreaterThan(400));
    });

    it("keeps image alignment in the hover toolbar instead of the selection bubble", async () => {
      const { editor, onChange } = renderEditor("![Plot](figures/plot.png)");
      const image = await screen.findByRole("img", { name: "Plot" });
      const component = image.closest<HTMLElement>("[data-jsx-component]");
      expect(component).not.toBeNull();
      expect(image.closest(".ok-image-resizable")).toHaveAttribute("data-image-size", "auto");
      fireEvent.mouseOver(component!);
      expect(screen.getByRole("button", { name: "Align center" })).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(screen.getByRole("button", { name: "Align right" }));
      await waitFor(() => expect(lastChange(onChange)).toContain('align="right"'));
      expect(lastChange(onChange)).toContain('src="figures/plot.png"');
      expect(lastChange(onChange)).not.toContain("sourceUrl=");
      editor.commands.setNodeSelection(0);
      await waitFor(() => expect(component).toHaveAttribute("data-selected", "true"));
      for (const bubbleMenu of screen.queryAllByTestId("bubble-menu-bar")) {
        expect(within(bubbleMenu).queryByRole("button", { name: "Align right" })).toBeNull();
      }
      fireEvent.click(screen.getByRole("button", { name: "Image properties" }));
      await waitForElement("[data-prop-panel]");
      expect(document.querySelector("[data-prop-panel-advanced-trigger]")).toBeNull();
      expect(screen.queryByText("Align")).not.toBeInTheDocument();
    });

    it("resizes a Markdown image and persists its dimensions as an HTML image", async () => {
      const { onChange } = renderEditor("![Plot](figures/plot.png \"Results\")");
      const wrapper = (await screen.findByRole("img", { name: "Plot" })).closest<HTMLElement>(".ok-image-resizable")!;
      expect(wrapper).not.toBeNull();
      setRect(wrapper, new DOMRect(0, 0, 320, 240));
      expect(wrapper.querySelector(".ok-resize-handle--br")).toBeNull();
      const handle = wrapper.querySelector<HTMLElement>(".ok-resize-handle--r");
      expect(handle).not.toBeNull();
      fireEvent.pointerDown(handle!, { pointerId: 1, clientX: 320, clientY: 240 });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 400, clientY: 300 });
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 400, clientY: 300 });
      await waitFor(() => expect(onChange).toHaveBeenCalled());
      await waitFor(() => expect(wrapper).toHaveAttribute("data-image-size", "authored"));
      for (const attribute of ["width={400}", 'src="figures/plot.png"', 'alt="Plot"', 'title="Results"']) expect(lastChange(onChange)).toContain(attribute);
      expect(lastChange(onChange)).not.toContain("height=");
    });
  });

  describe("find and replace", () => {
    it("opens local find, highlights and navigates matches, then clears on Escape", async () => {
      const { surface } = renderEditor("Alpha beta alpha.");
      // The project search shortcut passes through untouched.
      const projectFind = new KeyboardEvent("keydown", { key: "f", metaKey: true, shiftKey: true, bubbles: true, cancelable: true });
      surface.dispatchEvent(projectFind);
      expect(projectFind.defaultPrevented).toBe(false);
      expect(screen.queryByRole("search", { name: "Find in document" })).toBeNull();
      fireEvent.keyDown(surface, { key: "f", metaKey: true });
      const find = screen.getByRole("searchbox", { name: "Find" });
      fireEvent.change(find, { target: { value: "alpha" } });
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("1 of 2"));
      expect(document.querySelectorAll(".ok-find-match")).toHaveLength(2);
      fireEvent.keyDown(find, { key: "Enter" });
      expect(screen.getByRole("status")).toHaveTextContent("2 of 2");
      fireEvent.keyDown(find, { key: "Escape" });
      expect(screen.queryByRole("search", { name: "Find in document" })).toBeNull();
      expect(document.querySelectorAll(".ok-find-match")).toHaveLength(0);
      await waitFor(() => expect(document.activeElement).toBe(surface));
    });

    it("expands replace, replaces matches, and seeds a short text selection", async () => {
      const { surface, editor } = renderEditor("one two one");
      act(() => editor.commands.setTextSelection({ from: 1, to: 4 }));
      fireEvent.keyDown(surface, { key: "f", altKey: true, metaKey: true });
      expect(screen.getByRole("searchbox", { name: "Find" })).toHaveValue("one");
      fireEvent.change(screen.getByRole("textbox", { name: "Replace with" }), { target: { value: "three" } });
      fireEvent.click(screen.getByRole("button", { name: "Replace all matches" }));
      await waitFor(() => expect(editorMarkdown(editor)).toContain("three two three"));
    });
  });
});
