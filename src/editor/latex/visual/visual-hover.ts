/**
 * What a reference or citation chip in Visual mode offers beyond its number:
 * a hover card for what it points at (the source editor's own cards, one
 * section per key), and ⌘-click (Ctrl-click off a Mac) to go there. A plain
 * click still puts the caret in the chip, which shows its source for editing.
 *
 * The pointer over a chip lands on the command's source boundary, where the
 * source editor's hovers would describe `\cite` itself; `visualDrawnAt` tells
 * them to stand aside there (latex-visual-switch.ts).
 */
import { Facet, type EditorState, type Extension } from "@codemirror/state";
import { closeHoverTooltips, EditorView, hoverTooltip, type Tooltip } from "@codemirror/view";
import { hoverAnchor } from "../../hover-anchor";
import { citationKeysCard, referenceKeysCard } from "../latex-hover-cards";
import { citationHoverTarget } from "../latex-symbols";
import { visualDrawnAt, type LatexVisualHost } from "../latex-visual-switch";
import type { DefinitionTarget } from "../latex-text";
import type { DecorationSet } from "@codemirror/view";
import type { Construct } from "./visual-scan";

type Chip = Extract<Construct, { kind: "citation" } | { kind: "reference" }>;

/** What this module reads of Visual mode's state: what it found and what it draws. */
export type DrawnState = { constructs: readonly Construct[]; replacements: DecorationSet };

/** Whether a drawn range covers the pointer at `position`, on its `side`. */
function drawnRangeAt(replacements: DecorationSet, position: number, side: -1 | 1): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  replacements.between(position, position, (from, to) => {
    if (from === to) return;
    if ((from < position && position < to) || (position === from && side > 0) || (position === to && side < 0)) {
      found = { from, to };
      return false;
    }
  });
  return found;
}

/** The citation or reference chip drawn under the pointer, if any. */
function chipAt(drawn: DrawnState, position: number, side: -1 | 1): Chip | null {
  const range = drawnRangeAt(drawn.replacements, position, side);
  if (!range) return null;
  for (const construct of drawn.constructs) {
    if ((construct.kind === "citation" || construct.kind === "reference") && construct.from === range.from && construct.to === range.to) {
      return construct;
    }
  }
  return null;
}

/** Each key of a citation with its span in the source (and the page its note names), for the card's uses and actions. */
function citationKeySpans(text: string, chip: Chip): { key: string; from: number; to: number; page?: number }[] {
  const source = text.slice(chip.from, chip.to);
  let cursor = source.lastIndexOf("{") + 1;
  return chip.keys.map((key) => {
    const at = source.indexOf(key, cursor);
    if (at < 0) return { key, from: chip.from, to: chip.to };
    cursor = at + key.length;
    const span = citationHoverTarget(text, chip.from + at);
    return span?.key === key ? span : { key, from: chip.from + at, to: chip.from + at + key.length };
  });
}

/** Where a chip's key leads: its `\label`, or its bibliography entry. */
function chipTarget(chip: Chip, key: string, host: LatexVisualHost): DefinitionTarget | null {
  if (chip.kind === "citation") return { kind: "citation", key };
  // The last definition of a label wins, as in the project index and the card.
  const reference = [...host.data().references].reverse().find((item) => item.label === key);
  return reference ? { kind: "reference", path: reference.path, line: reference.line, label: reference.label } : null;
}

/** The chip element and the key under the pointer, for a ⌘-click on a chip. */
function chipUnder(view: EditorView, target: EventTarget | null): { dom: HTMLElement; key: string | undefined } | null {
  if (!(target instanceof Element)) return null;
  const dom = target.closest<HTMLElement>(".lx-tex-cite, .lx-tex-ref");
  if (!dom || !view.contentDOM.contains(dom)) return null;
  return { dom, key: target.closest<HTMLElement>("[data-key]")?.dataset.key };
}

const jumpGesture = (event: MouseEvent) => event.button === 0 && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;

/** The chip drawn under the pointer in `state`, through the Visual mode that draws it. */
const chipLookup = Facet.define<(state: EditorState, position: number, side: -1 | 1) => Chip | null>();

/** The citation or reference chip Visual mode draws at `position` (on the pointer's `side`), or null. */
export function chipUnderPointer(state: EditorState, position: number, side: -1 | 1): Chip | null {
  for (const lookup of state.facet(chipLookup)) {
    const chip = lookup(state, position, side);
    if (chip) return chip;
  }
  return null;
}

/** The hover card for the chip under the pointer: what its keys name, a section per key. */
export function chipHoverSource(host: LatexVisualHost) {
  return (view: EditorView, position: number, side: -1 | 1): Tooltip | null => {
    const chip = chipUnderPointer(view.state, position, side);
    if (!chip) return null;
    return {
      pos: chip.from,
      end: chip.to,
      above: true,
      create() {
        let destroyed = false;
        const close = () => view.dispatch({ effects: closeHoverTooltips });
        const data = host.data();
        const text = view.state.doc.toString();
        const dom = chip.kind === "citation"
          ? citationKeysCard(view, citationKeySpans(text, chip), data, { close, onGotoDefinition: host.open })
          : referenceKeysCard(view, chip.keys, {
            data, text, loadImage: host.loadImage, destroyed: () => destroyed, close, onGotoDefinition: host.open,
          });
        return { dom, getCoords: hoverAnchor(view, chip.from), destroy: () => { destroyed = true; } };
      },
    };
  };
}

export function visualChipNavigation(drawn: (state: EditorState) => DrawnState | undefined, host: LatexVisualHost): Extension {
  /** The chip and key a ⌘-click lands on, read from the drawn chip's own place in the text. */
  const clicked = (view: EditorView, event: MouseEvent) => {
    if (!jumpGesture(event)) return null;
    const under = chipUnder(view, event.target);
    if (!under) return null;
    const chip = chipUnderPointer(view.state, view.posAtDOM(under.dom), 1);
    return chip ? { chip, key: under.key ?? chip.keys[0] } : null;
  };

  return [
    chipLookup.of((state, position, side) => {
      const value = drawn(state);
      return value ? chipAt(value, position, side) : null;
    }),
    hoverTooltip(chipHoverSource(host)),
    visualDrawnAt.of((state, position, side) => {
      const value = drawn(state);
      return Boolean(value && drawnRangeAt(value.replacements, position, side));
    }),
    // Above Visual mode's own press handling and the source editor's
    // ⌘-click: the press must not place a caret or open the chip's source.
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (!clicked(view, event)) return false;
        event.preventDefault();
        return true;
      },
      click(event, view) {
        const hit = clicked(view, event);
        if (!hit) return false;
        event.preventDefault();
        const target = chipTarget(hit.chip, hit.key, host);
        if (target) {
          view.dispatch({ effects: closeHoverTooltips });
          host.open(target);
        }
        return true;
      },
    }),
  ];
}
