/**
 * The link schemes the visual engine keeps on a link (Tiptap blanks the href
 * of a scheme it does not know): a paper's note links each Zotero annotation
 * into Zotero's reader (papers/zotero-annotations.ts), and an unsafe scheme
 * still never reaches the DOM.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { LatticeVisualMarkdownEditor } from "./lattice-visual-editor";

afterEach(cleanup);

it("keeps a link into Zotero's reader, and still refuses an unsafe one", async () => {
  const zotero = "zotero://open-pdf/library/items/PDF00001?page=3&annotation=ANNHIGH1";
  render(
    <LatticeVisualMarkdownEditor
      text={`> quoted [Zotero](${zotero}) and [bad](javascript:alert(1))`}
      activePath="notes/Lee2024Sparse.md" onChangeMarkdown={() => true} onUndo={() => true} onRedo={() => true}
    />,
  );
  expect(await screen.findByText("Zotero")).toHaveAttribute("href", zotero);
  expect(screen.getByText("bad").getAttribute("href") ?? "").not.toMatch(/^javascript:/);
});
