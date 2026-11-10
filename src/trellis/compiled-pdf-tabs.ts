/**
 * One PDF tab per compiled root document: a manuscript and its supplement
 * built in turn both stay open, each in a tab named for its file, and a
 * build updates (or opens) only its own document's tab.
 *
 * The `pdf` view stays what it always was, the live PDF: the build
 * pipeline's, with its diagnostics, live preview, review marks and separate
 * window. Every other root document built keeps a `root-pdf` tab showing the
 * last PDF this copy built of it. When a build makes another document the
 * live one, the two trade places: the document leaving gets a `root-pdf` tab
 * where the live tab stood, and the live tab takes the arriving document's
 * tab (or a new one beside), so each tab keeps its place and its file name.
 *
 * Only a build the writer asks for brings a tab forward or back: any other
 * build (autosave, the agent's, a sync's) updates open tabs in place, adds a
 * tab in back for a document that had none, and never changes which tab is
 * in front or reopens one the writer closed.
 * Switching tabs builds nothing. Eager, as the controller that holds it:
 * nothing from Trellis at runtime.
 */
import type { LayoutDocument, LayoutNode, PanelNode, ViewInfo, WorkspaceHandle } from "@danfessler/trellis";
import { SmallStore } from "./trellis-small-store";
import type { TrellisController } from "./trellis-controller";

export const ROOT_PDF = "root-pdf";
export const rootPdfId = (document: string) => `${ROOT_PDF}:${document}`;

export type RootPdfParams = { document: string };

/** A `root-pdf` tab mounted in the workspace, as App renders into it. */
export type RootPdfTab = Readonly<{ document: string; visible: boolean }>;

type Slot = { panel: string; index: number; selected: boolean; hidden: boolean; front: string };

/** Where view `id` sits in `doc`: its panel, its place among the tabs, whether it is in front, and the panel's tab that is. */
export function slotOf(doc: LayoutDocument, id: string): Slot | null {
  const find = (node: LayoutNode | null | undefined): PanelNode | null => {
    if (!node) return null;
    if (node.kind === "panel") return node.views.includes(id) ? node : null;
    if (node.kind === "stage") return find(node.child);
    for (const child of node.children) {
      const found = find(child);
      if (found) return found;
    }
    return null;
  };
  const docked = find(doc.root) ?? doc.floating.find((entry) => entry.panel.views.includes(id))?.panel;
  const panel = docked ?? doc.hidden.find((entry) => entry.panel.views.includes(id))?.panel;
  if (!panel) return null;
  return { panel: panel.id, index: panel.views.indexOf(id), selected: panel.selected === id, hidden: !docked, front: panel.selected };
}

/**
 * A tab's name: the PDF's file name, with its folder when another open
 * document's PDF has the same name (`cvpr/main.pdf`, `arxiv/main.pdf`).
 */
export function pdfTabLabel(document: string, documents: readonly string[]): string {
  const pdf = (path: string) => path.replace(/\.tex$/i, ".pdf");
  const name = (path: string) => pdf(path).split("/").at(-1) ?? path;
  const clash = documents.some((other) => other !== document && name(other) === name(document));
  return clash ? pdf(document).split("/").slice(-2).join("/") : name(document);
}

export class CompiledPdfTabs {
  /** The document whose PDF the live tab shows, once one is known. */
  private live: string | null = null;
  private root = "";
  private readonly hosts = new Map<string, HTMLDivElement>();
  /** The `root-pdf` tabs mounted now; App renders a viewer into each one on screen. */
  readonly mounted = new SmallStore<{ tabs: readonly RootPdfTab[] }>({ tabs: [] });

  constructor(private readonly controller: Pick<TrellisController, "ws" | "ui" | "bridge" | "showPanel">) {}

  private ws(): WorkspaceHandle | null {
    return this.controller.ws;
  }

  /** Bring the live tab up where a closed one belongs; in focus mode the PDF stays as the writer set it. */
  private showLive() {
    if (!this.controller.ui.get().focus) this.controller.showPanel("pdf", { focus: false });
  }

  /** Build `document`, as its tab's menu and its empty state offer. */
  build(document: string) {
    this.controller.bridge?.build(document);
  }

  /** The element a `root-pdf` tab adopts, which App portals its viewer into. */
  host(document: string): HTMLDivElement {
    let host = this.hosts.get(document);
    if (!host) {
      host = window.document.createElement("div");
      host.className = "canvas-body trellis-pdf-host";
      host.setAttribute("data-trellis-owns-gestures", "");
      this.hosts.set(document, host);
    }
    return host;
  }

  private views(ws: WorkspaceHandle): ViewInfo[] {
    return ws.views({ type: ROOT_PDF });
  }

  /**
   * Every document with a tab: the live one, then the others. Read from the
   * layout's records, not `ws.views()`: tab titles are computed from this,
   * and `views()` computes every title.
   */
  private documents(ws: WorkspaceHandle): string[] {
    const records = Object.values(ws.getDocument().views);
    const others = records.filter((record) => record.type === ROOT_PDF).map((record) => String(record.params?.document ?? ""));
    return this.live && records.some((record) => record.type === "pdf") ? [this.live, ...others] : others;
  }

  /** The live tab's name once other documents have tabs too; null leaves it "PDF". */
  liveLabel(): string | null {
    const ws = this.ws();
    const documents = ws ? this.documents(ws) : [];
    return this.live && documents.length > 1 && documents[0] === this.live ? pdfTabLabel(this.live, documents) : null;
  }

  label(document: string): string {
    const ws = this.ws();
    return pdfTabLabel(document, ws ? this.documents(ws) : [document]);
  }

  /** A view that is a compiled PDF's tab, to receive the live tab when it is closed. */
  anyTab(): string | null {
    const ws = this.ws();
    return ws ? this.views(ws).find((view) => view.placement !== "hidden")?.id ?? null : null;
  }

  /**
   * The pipeline's PDF is now `document`'s, in project `root`; `requested`
   * when the writer asked for the build (it brings the live tab back and to
   * the front).
   */
  shown(root: string, document: string, { requested = false }: { requested?: boolean } = {}) {
    if (root !== this.root) {
      this.root = root;
      this.live = null;
    }
    const previous = this.live ?? this.recorded();
    this.live = document;
    this.place(previous, document, requested);
  }

  /** The document the live tab showed when the layout was saved: what it shows on reopening until a build. */
  private recorded(): string | null {
    const document = this.ws()?.view("pdf")?.params.document;
    return typeof document === "string" && document ? document : null;
  }

  private place(previous: string | null, document: string, requested: boolean) {
    const ws = this.ws();
    if (!ws) return;
    const live = ws.view("pdf");
    const own = ws.view(rootPdfId(document));
    const ownSlot = own && slotOf(ws.getDocument(), own.id);
    let keepReading = false;
    let left: Slot | null = null;
    if (live && previous && previous !== document && !ws.view(rootPdfId(previous))) {
      // The document leaving keeps a tab where the live one stood.
      const stood = slotOf(ws.getDocument(), "pdf");
      if (stood && !stood.hidden) {
        left = stood;
        // A build not asked for leaves the reader on the document they were reading, unless the arriving one's own tab was in front.
        keepReading = left.selected && !requested && !ownSlot?.selected;
        ws.open(ROOT_PDF, {
          id: rootPdfId(previous), params: { document: previous }, focus: false, placement: { into: left.panel, index: left.index },
        });
      }
    }
    const slot = own && slotOf(ws.getDocument(), own.id);
    if (own && slot && !slot.hidden) {
      // The live tab takes the arriving document's place.
      if (live) ws.dock("pdf", { into: slot.panel, index: slot.index });
      else ws.open("pdf", { id: "pdf", focus: false, placement: { into: slot.panel, index: slot.index } });
    }
    if (!ws.view("pdf")) {
      // A closed live tab comes back only for a build asked for; the document's own tab stays meanwhile.
      if (!requested) return;
      this.showLive();
    }
    if (own) void ws.close(own.id, { force: true });
    if (this.recorded() !== document) ws.setParams("pdf", { document });
    // Docked into the arriving document's place, the live tab came to the front of that panel.
    if (!requested && ownSlot && !ownSlot.selected && ws.view(ownSlot.front)) ws.select(ownSlot.front);
    // In front for a build asked for, or in its own tab's place when that was;
    // otherwise the tab the reader had in front stays there.
    const view = ws.view("pdf");
    const bringLive = Boolean(view && view.placement !== "hidden" && (requested || ownSlot?.selected));
    if (keepReading) {
      ws.select(rootPdfId(previous!));
      return;
    }
    if (left && ws.view(left.front) && (!bringLive || slotOf(ws.getDocument(), "pdf")?.panel !== left.panel)) ws.select(left.front);
    if (bringLive) ws.select("pdf");
  }

  /**
   * The live tab mounted in project `root`, or its record changed to name
   * `recorded`: however it came back (a build, the panel's menu, a layout),
   * it names the document it shows, for the project's next opening.
   */
  liveMounted(root: string, recorded: unknown) {
    const ws = this.ws();
    if (ws && root === this.root && this.live && recorded !== this.live && ws.view("pdf")) ws.setParams("pdf", { document: this.live });
  }

  /** A `root-pdf` tab mounted, moved on or off screen, or (null) unmounted. */
  report(document: string, visible: boolean | null) {
    const tabs = this.mounted.get().tabs.filter((tab) => tab.document !== document);
    this.mounted.set({ tabs: visible === null ? tabs : [...tabs, { document, visible }] });
    // A layout restored with a tab for the document now live: the live tab takes its place.
    if (visible !== null && document === this.live) queueMicrotask(() => this.live && this.place(this.live, this.live, false));
  }
}
