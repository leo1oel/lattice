/**
 * The live preview of the math the caret is in: KaTeX's picture of it in a
 * card just above the formula, where the eye already is while typing it.
 *
 * The card sits above the formula's first line, so it never covers the line
 * being edited, even deep in a multi-line `align`; with no room there it
 * goes below the formula's last line instead. It follows the caret from one
 * formula to the next, takes no focus, and goes when the caret leaves math,
 * when the editor loses focus, or on Escape (until the caret leaves that
 * formula). Half-typed math that KaTeX cannot set keeps the last good
 * picture, dimmed, rather than flashing an error on every keystroke.
 */
import { completionStatus } from "@codemirror/autocomplete";
import { Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, showTooltip, type Rect, type Tooltip, type TooltipView, type ViewUpdate } from "@codemirror/view";
import { msg } from "@lingui/core/macro";
import { i18n } from "../../i18n";
import { element } from "../dom-utils";
import type * as EquationCard from "./equation-card";
import { mathRegionInDocument, type MathRegion } from "./math-region";

type Renderer = typeof EquationCard;

/** KaTeX stays out of the editor's own chunk until the caret first enters math. */
let renderer: Renderer | null = null;
let loading: Promise<Renderer> | null = null;
const loadRenderer = () => (loading ??= import("./equation-card").then((module) => (renderer = module)));

type PreviewState = {
  /** The formula around the caret. */
  region: MathRegion | null;
  /** Where the formula Escape closed the preview on starts; it stays closed until the caret leaves it. */
  dismissed: number | null;
  tooltip: Tooltip | null;
};

const dismissPreview = StateEffect.define<null>();

/** The gap between the card and the formula it shows. */
const GAP = 4;

/**
 * `macros` gives the project's `\newcommand`s at render time. Each formula
 * gets its own card (a fresh `create`): moving to another formula brings the
 * card in again, while typing in one updates the card in place.
 */
export function mathPreview(macros: () => Record<string, string> | undefined): Extension {
  const field: StateField<PreviewState> = StateField.define<PreviewState>({
    create: (state) => resolve(null, mathRegionInDocument(state.doc, state.selection.main.head), null),
    update(value, transaction) {
      let dismissed = value.dismissed === null ? null : transaction.changes.mapPos(value.dismissed);
      for (const effect of transaction.effects) {
        if (effect.is(dismissPreview) && value.region) dismissed = transaction.changes.mapPos(value.region.from);
      }
      if (!transaction.docChanged && !transaction.selection && dismissed === value.dismissed) return value;
      const region = mathRegionInDocument(transaction.state.doc, transaction.state.selection.main.head);
      const previous = value.region && value.tooltip
        ? { from: transaction.changes.mapPos(value.region.from), tooltip: value.tooltip }
        : null;
      return resolve(previous, region, region && dismissed === region.from ? dismissed : null);
    },
    provide: (self) => showTooltip.from(self, (value) => value.tooltip),
  });

  function resolve(previous: { from: number; tooltip: Tooltip } | null, region: MathRegion | null, dismissed: number | null): PreviewState {
    if (!region || dismissed !== null) return { region, dismissed, tooltip: null };
    // Still the same formula: keep its card (and its side), only re-anchored.
    const create = previous?.from === region.from ? previous.tooltip.create : (view: EditorView) => previewCard(view, field, macros);
    return { region, dismissed, tooltip: { pos: region.from, end: region.to, above: true, create } };
  }

  return [
    field,
    // Highest, so it sees the state before Escape closes a completion menu: that
    // Escape is the menu's alone. It never handles the key, so Escape still
    // does whatever else it does (leaves Vim's insert mode, say).
    Prec.highest(EditorView.domEventHandlers({
      keydown(event, view) {
        if (event.key !== "Escape" || !view.state.field(field).tooltip || completionStatus(view.state)) return false;
        view.dispatch({ effects: dismissPreview.of(null) });
        return false;
      },
    })),
  ];
}

function previewCard(view: EditorView, field: StateField<PreviewState>, macros: () => Record<string, string> | undefined): TooltipView {
  const dom = element("div", "math-preview-card");
  dom.setAttribute("role", "group");
  dom.setAttribute("aria-label", i18n._(msg`Math preview`));
  dom.style.setProperty("--math-preview-room", `${Math.max(160, view.dom.clientWidth - 16)}px`);
  const body = element("div", "math-preview-body");
  dom.append(body);
  // Nothing to show until KaTeX has set this formula once.
  dom.hidden = true;
  // Scrolling a tall formula's card must leave the caret where it is.
  dom.addEventListener("mousedown", (event) => event.preventDefault());
  let shown: { source: string; display: boolean; macros: unknown } | null = null;
  let destroyed = false;

  const render = () => {
    const region = view.state.field(field, false)?.region;
    if (!region || destroyed) return;
    const project = macros();
    if (shown?.source === region.source && shown.display === region.display && shown.macros === project) return;
    if (!renderer) {
      void loadRenderer().then(render);
      return;
    }
    shown = { source: region.source, display: region.display, macros: project };
    const html = region.source.trim() ? renderer.equationHtml(region.source, project, region.display) : null;
    if (html) {
      body.innerHTML = html;
      dom.hidden = false;
      delete dom.dataset.stale;
      // KaTeX may have arrived after the caret moved: follow it once the picture is in.
      view.requestMeasure(followRequest);
    } else if (!region.source.trim()) {
      // An emptied formula has nothing left to picture.
      dom.hidden = true;
    } else {
      dom.dataset.stale = "";
    }
  };

  /**
   * The formula's extent on screen: from the top of its first line to the
   * bottom of its last, so the card above or below never covers any of it.
   * When it fills the editor's height (a long `align`), or its start has
   * scrolled away, the caret's own line stands in for it.
   */
  const getCoords = (): Rect => {
    const region = view.state.field(field).region;
    const head = view.state.selection.main.head;
    const caret = view.coordsAtPos(head) ?? view.coordsAtPos(head, -1);
    const start = region && view.coordsAtPos(region.from, 1);
    const end = region && view.coordsAtPos(region.to, -1);
    const visible = view.scrollDOM.getBoundingClientRect();
    const height = dom.getBoundingClientRect().height + GAP;
    if (start && end && (start.top - height >= visible.top || end.bottom + height <= visible.bottom)) {
      return { left: start.left, right: start.left, top: start.top, bottom: end.bottom };
    }
    if (caret) return { left: start?.left ?? caret.left, right: start?.left ?? caret.left, top: caret.top, bottom: caret.bottom };
    return { left: 0, right: 0, top: -1e4, bottom: -1e4 };
  };

  /**
   * A card too tall for its cap scrolls with the caret: as far through the
   * picture as the caret is through the formula's source, so the row being
   * typed in a long `align` stays in view.
   */
  const followRequest = {
    key: dom,
    read: () => {
      const region = view.state.field(field, false)?.region;
      const room = dom.scrollHeight - dom.clientHeight;
      if (!region || room <= 0 || region.to <= region.from) return null;
      return room * Math.min(1, Math.max(0, (view.state.selection.main.head - region.from) / (region.to - region.from)));
    },
    write: (top: number | null) => {
      if (top !== null && !destroyed) dom.scrollTop = top;
    },
  };

  render();
  return {
    dom,
    offset: { x: 0, y: GAP },
    getCoords,
    update(update: ViewUpdate) {
      if (!update.docChanged && !update.selectionSet) return;
      render();
      update.view.requestMeasure(followRequest);
    },
    destroy() {
      destroyed = true;
    },
  };
}
