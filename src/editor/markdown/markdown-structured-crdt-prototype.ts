import { Editor, type JSONContent } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { Image } from "@tiptap/extension-image";
import { TableKit } from "@tiptap/extension-table";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import * as Y from "yjs";

/* Isolated Phase 9 candidate. Production code must not import this module;
   see docs/markdown-structured-crdt-evaluation.md for the NO-GO decision. */

type StructuredDraft = {
  source: string;
  reason: string;
  recoverable: true;
};

export type BridgeFaults = {
  parse?: () => void | Promise<void>;
  serialize?: () => void | Promise<void>;
  afterParse?: () => void | Promise<void>;
  timeoutMs?: number;
};

export type ConversionResult =
  | { ok: true; markdown: string }
  | { ok: false; draft: StructuredDraft; stale?: boolean };

const extensions = [
  StarterKit.configure({ link: false }),
  Markdown,
  Image,
  TableKit,
  TaskList,
  TaskItem.configure({ nested: true }),
];

function editorFor(content: string | JSONContent, contentType?: "markdown") {
  return new Editor({ extensions, content, ...(contentType ? { contentType } : {}) });
}

export function parseMarkdownCandidate(source: string): JSONContent {
  const editor = editorFor(source, "markdown");
  try {
    return editor.getJSON();
  } finally {
    editor.destroy();
  }
}

export function serializeMarkdownCandidate(content: JSONContent): string {
  const editor = editorFor(content);
  try {
    return editor.getMarkdown();
  } finally {
    editor.destroy();
  }
}

function writeJson(parent: Y.XmlFragment | Y.XmlElement, value: JSONContent) {
  const element = new Y.XmlElement(value.type ?? "unknown");
  // Integrate first. Reading or mutating nested preliminary Y types emits
  // warnings and does not model the order used by a real shared fragment.
  parent.push([element]);
  if (value.attrs) element.setAttribute("attrs", JSON.stringify(value.attrs));
  for (const mark of value.marks ?? []) {
    const markElement = new Y.XmlElement("mark");
    element.push([markElement]);
    markElement.setAttribute("value", JSON.stringify(mark));
  }
  if (value.text !== undefined) element.push([new Y.XmlText(value.text)]);
  for (const child of value.content ?? []) writeJson(element, child);
}

function readJson(element: Y.XmlElement): JSONContent {
  const result: JSONContent = { type: element.nodeName };
  const attrs = element.getAttribute("attrs");
  if (attrs) result.attrs = JSON.parse(attrs) as Record<string, unknown>;
  const marks: NonNullable<JSONContent["marks"]> = [];
  const content: JSONContent[] = [];
  let text = "";
  for (const child of element.toArray()) {
    if (child instanceof Y.XmlText) text += child.toString();
    else if (child instanceof Y.XmlElement) {
      if (child.nodeName === "mark") marks.push(JSON.parse(child.getAttribute("value") ?? "{}"));
      else content.push(readJson(child));
    }
  }
  if (marks.length) result.marks = marks;
  if (text) result.text = text;
  if (content.length) result.content = content;
  return result;
}

function readStructuredJson(fragment: Y.XmlFragment): JSONContent {
  const root = fragment.toArray().find((node): node is Y.XmlElement => node instanceof Y.XmlElement);
  if (!root) return { type: "doc", content: [] };
  return readJson(root);
}

export function replaceStructuredJson(fragment: Y.XmlFragment, json: JSONContent) {
  fragment.doc?.transact(() => {
    if (fragment.length) fragment.delete(0, fragment.length);
    writeJson(fragment, json);
  }, "structured-markdown-prototype");
}

export function serializeFragment(fragment: Y.XmlFragment): string {
  return serializeMarkdownCandidate(readStructuredJson(fragment));
}

function draft(source: string, reason: unknown): ConversionResult {
  return {
    ok: false,
    draft: { source, reason: reason instanceof Error ? reason.message : String(reason), recoverable: true },
  };
}

async function bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Markdown bridge timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Source mode is an explicit guarded replacement transaction.
 * Lossy input, bridge failure, timeout, and a remote update during conversion
 * leave the sole authoritative XmlFragment untouched and return the full draft.
 */
export async function applySourceTransaction(
  doc: Y.Doc,
  fragment: Y.XmlFragment,
  source: string,
  faults: BridgeFaults = {},
): Promise<ConversionResult> {
  const before = Y.encodeStateVector(doc);
  try {
    const json = await bounded((async () => {
      await faults.parse?.();
      const parsed = parseMarkdownCandidate(source);
      await faults.afterParse?.();
      await faults.serialize?.();
      const serialized = serializeMarkdownCandidate(parsed);
      if (serialized !== source) throw new Error("Bridge is not byte-lossless");
      return parsed;
    })(), faults.timeoutMs ?? 5_000);
    if (!Uint8Array.from(Y.encodeStateVector(doc)).every((byte, index) => byte === before[index])
      || Y.encodeStateVector(doc).length !== before.length) {
      return {
        ok: false,
        stale: true,
        draft: { source, reason: "Remote state changed during conversion", recoverable: true },
      };
    }
    replaceStructuredJson(fragment, json);
    return { ok: true, markdown: source };
  } catch (error) {
    return draft(source, error);
  }
}

export function mapSourceCursorAfterRoundTrip(source: string, offset: number): number | null {
  const json = parseMarkdownCandidate(source);
  if (serializeMarkdownCandidate(json) !== source) return null;
  return Math.max(0, Math.min(offset, source.length));
}

export type PrototypeBenchmark = {
  fixture: string;
  yTextMs: number;
  xmlMs: number;
  timeRatio: number;
  yTextUpdateBytes: number;
  xmlUpdateBytes: number;
  byteRatio: number;
};

export function benchmarkStructuredCandidate(fixtures: Record<string, string>, iterations = 10): PrototypeBenchmark[] {
  return Object.entries(fixtures).map(([fixture, source]) => {
    const startText = performance.now();
    let textBytes = 0;
    for (let index = 0; index < iterations; index += 1) {
      const doc = new Y.Doc();
      doc.getText("content").insert(0, source);
      textBytes = Y.encodeStateAsUpdate(doc).byteLength;
    }
    const yTextMs = performance.now() - startText;
    const startXml = performance.now();
    let xmlBytes = 0;
    for (let index = 0; index < iterations; index += 1) {
      const doc = new Y.Doc();
      replaceStructuredJson(doc.getXmlFragment("content"), parseMarkdownCandidate(source));
      serializeFragment(doc.getXmlFragment("content"));
      xmlBytes = Y.encodeStateAsUpdate(doc).byteLength;
    }
    const xmlMs = performance.now() - startXml;
    return {
      fixture, yTextMs, xmlMs, timeRatio: xmlMs / Math.max(yTextMs, 0.001),
      yTextUpdateBytes: textBytes, xmlUpdateBytes: xmlBytes,
      byteRatio: xmlBytes / Math.max(textBytes, 1),
    };
  });
}
