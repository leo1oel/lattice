/**
 * Conflicts resolved where they are: each spot a merge could not decide
 * (standard `<<<<<<<` markers, from an Overleaf sync, Git or an Agent Undo)
 * carries its own Keep mine, Keep theirs and Keep both above it in the
 * editor, and its two sides are tinted apart. Choosing rewrites only that
 * spot, as one undoable edit; the file saves and syncs as any edit does, and
 * a sync holds a file back only while markers are left in it.
 *
 * The sides are read by `parseConflictBlocks`, the parser the resolver dialog
 * uses, so the diff3 base section (`|||||||`, which Overleaf sync writes) is
 * never kept by either choice.
 */
import { msg } from "@lingui/core/macro";
import { StateField, type EditorState, type Extension, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { parseConflictBlocks, type ConflictChoice } from "../history/conflict-markers";
import { i18n } from "../i18n";

/** One spot in the document: where it starts and ends, and each side's lines. */
type Spot = { from: number; to: number; ours: string[]; theirs: string[] };

/** The spots in `doc`, with the document range each covers (the trailing line break included). */
export function conflictSpots(doc: Text): Spot[] {
  const spots: Spot[] = [];
  for (const block of parseConflictBlocks(doc.toString())) {
    if (block.kind !== "conflict") continue;
    const first = doc.line(block.line);
    const last = doc.line(block.line + block.raw.length - 1);
    spots.push({
      from: first.from,
      to: last.number < doc.lines ? last.to + 1 : last.to,
      ours: block.ours,
      theirs: block.theirs,
    });
  }
  return spots;
}

/** The text a choice leaves in place of `spot` in `doc`. */
function choiceText(doc: Text, spot: Spot, choice: ConflictChoice): string {
  const lines = choice === "ours" ? spot.ours : choice === "theirs" ? spot.theirs : [...spot.ours, ...spot.theirs];
  if (!lines.length) return "";
  const endsLine = doc.sliceString(spot.to - 1, spot.to) === "\n";
  return lines.join("\n") + (endsLine ? "\n" : "");
}

/** Resolve the spot starting at `from` with `choice`; false when no spot starts there now. */
export function chooseSide(view: EditorView, from: number, choice: ConflictChoice): boolean {
  const spot = conflictSpots(view.state.doc).find((candidate) => candidate.from === from);
  if (!spot) return false;
  view.dispatch({ changes: { from: spot.from, to: spot.to, insert: choiceText(view.state.doc, spot, choice) }, userEvent: "input.conflict" });
  return true;
}

class ChoiceBar extends WidgetType {
  constructor(readonly from: number) {
    super();
  }

  eq(other: ChoiceBar) {
    return other.from === this.from;
  }

  toDOM(view: EditorView) {
    const bar = document.createElement("div");
    bar.className = "cm-conflict-choices";
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", i18n._(msg`Conflict: choose what to keep`));
    const choices: [ConflictChoice, string][] = [
      ["ours", i18n._(msg`Keep mine`)],
      ["theirs", i18n._(msg`Keep theirs`)],
      ["both", i18n._(msg`Keep both`)],
    ];
    for (const [choice, label] of choices) {
      const button = bar.appendChild(document.createElement("button"));
      button.type = "button";
      button.textContent = label;
      button.dataset.choice = choice;
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        chooseSide(view, view.posAtDOM(bar), choice);
        view.focus();
      });
    }
    return bar;
  }

  ignoreEvent() {
    return true;
  }
}

function decorations(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const doc = state.doc;
  for (const spot of conflictSpots(doc)) {
    ranges.push(Decoration.widget({ widget: new ChoiceBar(spot.from), block: true, side: -1 }).range(spot.from));
    let section: "marker" | "ours" | "base" | "theirs" = "ours";
    for (let at = spot.from; at < spot.to;) {
      const line = doc.lineAt(at);
      const text = line.text;
      const marker = /^(<{7}|\|{7}|={7}|>{7})( |$)/.exec(text)?.[1];
      if (marker) section = marker.startsWith("|") ? "base" : marker.startsWith("=") ? "theirs" : "ours";
      ranges.push(Decoration.line({ class: marker ? "cm-conflict-marker" : `cm-conflict-${section}` }).range(line.from));
      at = line.to + 1;
    }
  }
  return Decoration.set(ranges, true);
}

const spotsField = StateField.define<DecorationSet>({
  create: decorations,
  update: (value, transaction) => (transaction.docChanged ? decorations(transaction.state) : value),
  provide: (field) => EditorView.decorations.from(field),
});

/** The inline choices, for an editable source editor. */
export function conflictChoices(): Extension {
  return spotsField;
}
