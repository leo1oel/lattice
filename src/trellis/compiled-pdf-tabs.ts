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
 * A tab the writer closes stays closed until that document is built again on
 * request: autosave's builds update open tabs and never bring one back.
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

type Slot = { panel: string; index: number; selected: boolean; hidden: boolean };

/** Where view `id` sits in `doc`: its panel, its place among the tabs, and whether it is in front. */
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
  return { panel: panel.id, index: panel.views.indexOf(id), selected: panel.selected === id, hidden: !docked };
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
  /** Documents whose tab the writer closed (see the module comment). */
  private readonly closed = new Set<string>();
  /** Tabs closed here, by a trade of places, not by the writer. */
  private readonly quiet = new Set<string>();
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

  private documentOf(view: ViewInfo): string {
    return String(view.params.document ?? "");
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
   * when the writer asked for the build (it reopens a tab they closed and
   * brings it to the front).
   */
  shown(root: string, document: string, { requested = false }: { requested?: boolean } = {}) {
    if (root !== this.root) {
      this.root = root;
      this.live = null;
      this.closed.clear();
      this.quiet.clear();
    }
    const previous = this.live;
    this.live = document;
    this.place(previous, document, requested);
  }

  private place(previous: string | null, document: string, requested: boolean) {
    const ws = this.ws();
    if (!ws) return;
    const live = ws.view("pdf");
    const own = ws.view(rootPdfId(document));
    let keepReading = false;
    if (live && previous && previous !== document && !ws.view(rootPdfId(previous))) {
      // The document leaving keeps a tab where the live one stood.
      const left = slotOf(ws.getDocument(), "pdf");
      if (left && !left.hidden) {
        // Still showing the document they were reading when the arriving one has a tab of its own in back.
        keepReading = left.selected && Boolean(own) && !requested && !slotOf(ws.getDocument(), own!.id)?.selected;
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
    if (own) {
      this.quiet.add(own.id);
      void ws.close(own.id, { force: true });
    }
    if (!ws.view("pdf")) {
      // A closed live tab comes back for a build asked for, or, among the other
      // documents' tabs, for any build of a document whose tab was not closed.
      if (!requested && (this.closed.has(document) || !this.anyTab())) return;
      this.showLive();
    }
    this.closed.delete(document);
    // In front for a build asked for, in its own tab's place when that was, or as a new tab.
    const arrived = !own && previous !== null && previous !== document;
    const view = ws.view("pdf");
    if (keepReading) ws.select(rootPdfId(previous!));
    else if (view && view.placement !== "hidden" && (requested || slot?.selected || arrived)) ws.select("pdf");
  }

  /** Trellis closed a compiled PDF's tab: the writer's close keeps it closed through autosave's builds. */
  onClose(view: ViewInfo) {
    if (this.quiet.delete(view.id)) return;
    const document = view.type === ROOT_PDF ? this.documentOf(view) : this.live;
    if (document) this.closed.add(document);
  }

  /** A `root-pdf` tab mounted, moved on or off screen, or (null) unmounted. */
  report(document: string, visible: boolean | null) {
    const tabs = this.mounted.get().tabs.filter((tab) => tab.document !== document);
    this.mounted.set({ tabs: visible === null ? tabs : [...tabs, { document, visible }] });
    // A layout restored with a tab for the document now live: the live tab takes its place.
    if (visible !== null && document === this.live) queueMicrotask(() => this.live && this.place(this.live, this.live, false));
  }
}
