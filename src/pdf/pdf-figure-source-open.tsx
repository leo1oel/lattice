/**
 * Cmd/Ctrl+double-click on a figure in the compiled PDF opens the drawing it
 * was made from (docs/editable-figures.md). A plain double-click stays the
 * reverse SyncTeX jump to the source line.
 */
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SyncTexTarget } from "../app-types";
import { openFigureSource } from "../project/figure-source-open";
import { addListeners } from "./pdf-viewer-utils";
import { syncTexDocument } from "./pdf-document-context";

/** The source file of the figure at the point, or null when the point is not on a figure. */
async function figureSourceAt(page: HTMLElement, x: number, y: number, document: string | null): Promise<string | null> {
  const scale = Number.parseFloat(getComputedStyle(page).getPropertyValue("--scale-factor"));
  if (!(scale > 0)) return null;
  const bounds = page.getBoundingClientRect();
  const target = await invoke<SyncTexTarget>("synctex_edit", {
    page: Number.parseInt(page.dataset.pageNumber ?? "", 10),
    x: Number(((x - bounds.left) / scale).toFixed(3)),
    y: Number(((y - bounds.top) / scale).toFixed(3)),
    ...syncTexDocument(document),
  });
  // SyncTeX lands in Inkscape's own `.pdf_tex`; the entry that names the source is beside it.
  const entry = target.path.replace(/\.pdf_tex$/i, ".tex");
  const { figureSourcePath } = await import("../editor/insert/editable-figure");
  return figureSourcePath(entry, await invoke<string>("read_project_file", { path: entry }));
}

/** `document`: the root document whose own tab this is, when it is not the compiled document's PDF. */
export function PdfFigureSourceOpen({ host, document = null }: { host: HTMLElement; document?: string | null }) {
  useEffect(() => addListeners(host, {
    dblclick: (event: MouseEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      const page = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-page-number]") : null;
      if (!page) return;
      // Ahead of the viewer's own double-click, the jump to the source line.
      // Whether a figure is here takes a host call, so off a figure that
      // double-click is given back, as a plain one this listener lets through.
      event.stopPropagation();
      event.preventDefault();
      const { target, clientX, clientY } = event;
      void figureSourceAt(page, clientX, clientY, document)
        .catch(() => null)
        .then((source) => {
          if (source) return openFigureSource(source);
          target?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX, clientY, detail: 2 }));
        });
    },
  }, { capture: true }), [document, host]);

  return null;
}
