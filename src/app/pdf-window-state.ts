/**
 * Whether a project's compiled PDF is in a window of its own rather than its
 * panel, for a writer who keeps the editor on one screen and the PDF on
 * another; and where that window was last left. Both are remembered per
 * project in this Mac's storage. The panel stays the default.
 *
 * Detaching closes the PDF panel so the documents get its room, and the
 * titlebar shows a chip that brings it back. While detached, what would bring
 * the panel up (a build, a jump to the PDF) leaves it to the window: see
 * `showProjectPdf`. The window itself is opened, fed and closed by
 * `src/canvas/project-pdf-window.tsx`, which the PDF panel's chunk renders.
 */
import { useSyncExternalStore } from "react";
import { isBrowserHosted } from "../platform/browser-runtime";
import type { TrellisController } from "../trellis/trellis-controller";

/** The window's outer corner and content size, in logical points (`pdf_window.rs`). */
export type PdfWindowFrame = { x: number; y: number; width: number; height: number };

type Remembered = { open?: boolean; frame?: PdfWindowFrame };

const STORAGE_PREFIX = "lattice.pdf-window.v1:";
const listeners = new Set<() => void>();
const openByRoot = new Map<string, boolean>();
/** The project whose window was just asked for, which then comes forward: a restored one opens behind the editor. */
let focusRoot: string | null = null;

function read(root: string): Remembered {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_PREFIX + root) ?? "null");
    return value && typeof value === "object" ? value as Remembered : {};
  } catch {
    return {};
  }
}

function write(root: string, update: Remembered) {
  try {
    localStorage.setItem(STORAGE_PREFIX + root, JSON.stringify({ ...read(root), ...update }));
  } catch {
    // Session-only without storage.
  }
}

/** Only the Mac app has windows to give the PDF: not a browser tab, nor the website's demo. */
export function pdfWindowsAvailable(): boolean {
  return !import.meta.env.LATTICE_WEB_DEMO && !isBrowserHosted();
}

export function pdfWindowOpen(root: string): boolean {
  let open = openByRoot.get(root);
  if (open === undefined) {
    open = pdfWindowsAvailable() && read(root).open === true;
    openByRoot.set(root, open);
  }
  return open;
}

function setOpen(root: string, open: boolean) {
  if (pdfWindowOpen(root) === open) return false;
  openByRoot.set(root, open);
  write(root, { open });
  for (const listener of [...listeners]) listener();
  return true;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePdfWindowOpen(root: string | null | undefined): boolean {
  return useSyncExternalStore(subscribe, () => Boolean(root) && pdfWindowOpen(root!));
}

/** Move `root`'s PDF into its own window: its panel closes (in focus mode, the PDF beside the documents goes). */
export function detachPdf(trellis: TrellisController, root: string) {
  if (!pdfWindowsAvailable() || !setOpen(root, true)) return;
  focusRoot = root;
  if (trellis.ui.get().focus) trellis.setFocusPdf(false);
  else if (trellis.ws?.view("pdf")) void trellis.ws.close("pdf", { force: true });
}

/** Bring `root`'s PDF back into its panel; its window closes. */
export function dockPdf(trellis: TrellisController, root: string) {
  if (setOpen(root, false)) trellis.showPanel("pdf", { focus: false });
}

/** Whether the open project's PDF is in its own window, which shows a build or a jump where it stands. */
export function pdfInWindow(trellis: TrellisController): boolean {
  const root = trellis.app.get().projectRoot;
  return Boolean(root) && pdfWindowOpen(root);
}

/**
 * An explicit build (button, palette) brings a closed or hidden PDF panel back
 * under Trellis, unless the PDF is in its own window; in focus mode the PDF
 * stays as the writer set it.
 */
export function showProjectPdf(trellis: TrellisController) {
  if (!trellis.ui.get().focus && !pdfInWindow(trellis)) trellis.showPanel("pdf", { focus: false });
}

/** Whether `root`'s window should come forward as it opens, asked once. */
export function takePdfWindowFocus(root: string): boolean {
  const focus = focusRoot === root;
  if (focus) focusRoot = null;
  return focus;
}

export function pdfWindowFrame(root: string): PdfWindowFrame | null {
  const frame = read(root).frame;
  const sane = frame && [frame.x, frame.y, frame.width, frame.height].every((value) => typeof value === "number" && Number.isFinite(value));
  return sane ? frame : null;
}

export function rememberPdfWindowFrame(root: string, frame: PdfWindowFrame) {
  write(root, { frame });
}

/** The PDF's file name, from the root document it is compiled from. */
export function compiledPdfName(rootDocument: string | null | undefined): string {
  const name = rootDocument?.split("/").at(-1) ?? "";
  return name ? `${name.replace(/\.[^.]*$/, "")}.pdf` : "paper.pdf";
}
