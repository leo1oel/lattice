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

/** The source file of the figure at the point, or null when the point is not on a figure. */
async function figureSourceAt(page: HTMLElement, x: number, y: number): Promise<string | null> {
  const scale = Number.parseFloat(getComputedStyle(page).getPropertyValue("--scale-factor"));
  if (!(scale > 0)) return null;
  const bounds = page.getBoundingClientRect();
  const target = await invoke<SyncTexTarget>("synctex_edit", {
    page: Number.parseInt(page.dataset.pageNumber ?? "", 10),
    x: Number(((x - bounds.left) / scale).toFixed(3)),
    y: Number(((y - bounds.top) / scale).toFixed(3)),
  });
  // SyncTeX lands in Inkscape's own `.pdf_tex`; the entry that names the source is beside it.
  const entry = target.path.replace(/\.pdf_tex$/i, ".tex");
  const { figureSourcePath } = await import("../editor/insert/editable-figure");
  return figureSourcePath(entry, await invoke<string>("read_project_file", { path: entry }));
}

export function PdfFigureSourceOpen({ host }: { host: HTMLElement }) {
  useEffect(() => addListeners(host, {
    dblclick: (event: MouseEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      const page = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-page-number]") : null;
      if (!page) return;
      // Ahead of the viewer's own double-click, the jump to the source line.
      event.stopPropagation();
      event.preventDefault();
      void figureSourceAt(page, event.clientX, event.clientY)
        .catch(() => null)
        .then((source) => source ? openFigureSource(source) : undefined);
    },
  }, { capture: true }), [host]);

  return null;
}
