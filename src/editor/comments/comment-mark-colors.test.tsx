/**
 * One comment, one colour: the source (editor-comments.ts) and the PDF
 * (pdf-annotations.tsx) mark the same comment in the same colour, for every
 * kind and state that draws a mark. An Overleaf thread was marked in its
 * author's colour in the source but amber on the PDF, and a proposal or a
 * question blue or violet in the source but amber on the PDF.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnnotationRounds } from "../../app/annotation-rounds";
import PdfAnnotationLayer from "../../pdf/pdf-annotations";
import type { PdfRenderCount } from "../../pdf/use-pdf-document";
import type { ActiveViewerRef } from "../../pdf/use-pdf-view";
import { createEditorComment, type EditorComment } from "./editor-comment-data";
import { buildCommentDecorations } from "./editor-comments";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("../../pdf/pdf-slick", () => ({
  pdfPageView: (_slick: unknown, page: number) => ({
    viewport: { width: 600, height: 800, scale: 1 },
    div: document.querySelector(`[data-page-number="${page}"]`),
  }),
}));

afterEach(() => document.body.replaceChildren());

const SRC = join(__dirname, "../..");
const MARKS_CSS = readFileSync(join(__dirname, "comment-marks.css"), "utf8");
const SOURCE = "Scaled dot-product attention divides the scores by a constant.";
const QUOTE = "divides the scores";

function note(id: string, extra: Partial<EditorComment>): EditorComment {
  const from = SOURCE.indexOf(QUOTE);
  return {
    ...createEditorComment({ path: "main.tex", source: SOURCE, from, to: from + QUOTE.length, body: "Why?", authorId: "me", authorName: "Ada" })!,
    pdf: { page: 1, rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.013 }], text: QUOTE },
    id,
    ...extra,
  };
}

const KINDS: [string, EditorComment, string][] = [
  ["an open annotation", note("open", { number: 1 }), "var(--annotation-ink)"],
  ["an accepted annotation", note("accepted", { number: 2, revision: { round: 2, state: "accepted" } } as Partial<EditorComment>), "var(--annotation-ink)"],
  ["an annotation whose proposal waits", note("proposed", { number: 3, revision: { round: 2, state: "proposed" } } as Partial<EditorComment>), "var(--annotation-proposed-ink)"],
  ["an annotation whose question waits", note("asked", { number: 4, revision: { round: 2, state: "asked" } } as Partial<EditorComment>), "var(--annotation-asked-ink)"],
  ["an Overleaf thread", note("overleaf:t1", { number: 0, authorColor: { color: "hsl(210, 70%, 50%)", colorLight: "hsl(210 70% 50% / 0.3)" } }), "hsl(210, 70%, 50%)"],
  ["an Overleaf thread with no Overleaf hue", note("overleaf:t2", { number: 0, authorId: "mina@example.org" }), "#"],
];

/** The ink comment-marks.css gives an element: its inline property, else its status's rule, else the base rule. */
function resolvedInk(status: string | undefined, inline: (name: string) => string): string {
  const own = inline("--comment-mark-ink");
  if (own) return own;
  const rule = status && new RegExp(`\\[data-annotation-status="${status}"\\]\\s*\\{[^}]*--comment-mark-ink:\\s*([^;]+);`).exec(MARKS_CSS);
  if (rule) return rule[1]!.trim();
  return /\.pdf-annotation-mark\s*\{[^}]*--comment-mark-ink:\s*([^;]+);/.exec(MARKS_CSS)![1]!.trim();
}

function sourceInk(comment: EditorComment): string {
  const marks: Record<string, string>[] = [];
  buildCommentDecorations(SOURCE, "main.tex", [comment]).between(0, SOURCE.length, (_from, _to, deco) => {
    marks.push((deco.spec as { attributes: Record<string, string> }).attributes);
  });
  expect(marks).toHaveLength(1);
  const probe = document.createElement("span");
  probe.setAttribute("style", marks[0]!.style ?? "");
  return resolvedInk(marks[0]!["data-annotation-status"], (name) => probe.style.getPropertyValue(name).trim());
}

/** A one-page PDF whose text is SOURCE, as PDF.js gives it. */
const PDF = {
  numPages: 1,
  getPage: async () => ({
    view: [0, 0, 612, 792],
    getTextContent: async () => ({ items: [{ str: SOURCE, transform: [10, 0, 0, 10, 72, 700], width: 300, height: 10 }] }),
  }),
};

async function pdfInk(comment: EditorComment): Promise<string> {
  const root = document.createElement("div");
  root.innerHTML = `<div data-page-number="1"></div>`;
  document.body.append(root);
  const renderCount: PdfRenderCount = { subscribe: () => () => {}, pages: () => 1, textLayers: () => 1 };
  const rounds = { canAnnotatePdf: () => false, readSource: async () => SOURCE } as unknown as AnnotationRounds;
  const view = render(
    <PdfAnnotationLayer
      recordRef={{ current: { root, slick: { document: PDF } } } as unknown as ActiveViewerRef}
      previewRef={createRef()} rounds={rounds} annotations={[comment]} generation={1} renderCount={renderCount} scale={1}
    />,
  );
  const layer = await waitFor(() => {
    const found = root.querySelector<HTMLElement>(`.pdf-annotation-mark[data-annotation-id="${comment.id}"]`);
    expect(found).not.toBeNull();
    return found!;
  });
  const ink = resolvedInk(layer.dataset.annotationStatus, (name) => layer.style.getPropertyValue(name).trim());
  view.unmount();
  return ink;
}

describe("a comment's mark colour", () => {
  it.each(KINDS)("is the same in the source and on the PDF for %s", async (_kind, comment, expected) => {
    const source = sourceInk(comment);
    expect(await pdfInk(comment)).toBe(source);
    expect(source.startsWith(expected)).toBe(true);
  });

  it("paints both sides, at rest, hovered and open, from the comment's own mark colour", () => {
    const rule = (selector: string) => new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(MARKS_CSS)?.[2] ?? "";
    expect(rule(".source-editor .cm-editor-comment")).toMatch(/background:\s*var\(--comment-mark-tint\)/);
    expect(rule(".pdf-annotation-highlight")).toMatch(/background:\s*var\(--comment-mark-tint\)/);
    expect(rule(".pdf-annotation-highlight")).toMatch(/var\(--comment-mark-rule\)/);
    expect(rule(".source-editor .cm-annotation")).toMatch(/var\(--comment-mark-rule\)/);
    expect(rule(".pdf-annotation-mark:is([data-hovered], [data-active]) .pdf-annotation-highlight"))
      .toMatch(/background:\s*color-mix\(in srgb, var\(--comment-mark-rule\) \d+%, var\(--comment-mark-tint\)\)/);
  });

  it("is chosen in comment-marks.css alone", () => {
    // Another stylesheet colouring a mark is how the two sides drifted apart.
    const sheets = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sheets(path);
      return entry.name.endsWith(".css") ? [path] : [];
    });
    const offenders = sheets(SRC).filter((path) => !path.endsWith("comment-marks.css")).flatMap((path) => {
      const css = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      return [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
        .filter(([, selector, body]) => /\.(pdf-annotation-highlight|cm-editor-comment|cm-annotation)(?![-\w])/.test(selector!)
          && /(^|;)\s*(background|box-shadow|border-bottom)\b/.test(body!))
        .map(([, selector]) => `${relative(SRC, path)}: ${selector!.trim()}`);
    });
    expect(offenders).toEqual([]);
  });
});
