/** Hover cards for citation keys (also opened from the keyboard), `\ref` labels and `\includegraphics` paths, with a figure preview when one exists. */
import { closeCompletion } from "@codemirror/autocomplete";
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  closeHoverTooltips, hoverTooltip, showTooltip, type Command, type EditorView, type Rect, type Tooltip,
} from "@codemirror/view";
import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { PaperSummary } from "../../app-types";
import { comboText } from "../../app/key-combos";
import { buttonClassName } from "../../components/ui/button-styles";
import infinityLoaderUrl from "../../components/ui/infinity-loader.svg";
import { i18n } from "../../i18n";
import { paperBylineAuthors, paperSourceLabel } from "../../papers/paper-identity";
import { citationHealthParts, citationHealthTitle } from "../../project/citation-health";
import type { SymbolOccurrence } from "../../project/references-panel";
import { element } from "../dom-utils";
import type { LatexEditorLiveData } from "./latex-editor";
import { citationHoverTarget, graphicsHoverTarget, referenceHoverTarget, resolveProjectPath } from "./latex-symbols";
import { referenceKindLabel, type CitationInfo, type DefinitionTarget } from "./latex-text";

function createHoverCard(className: string, view: EditorView, minWidth: number): HTMLDivElement {
  const dom = element("div", className);
  dom.style.maxWidth = `${Math.max(minWidth, view.dom.clientWidth - 16)}px`;
  return dom;
}

export function citationTooltipSpace(bounds: Rect): Rect {
  const inset = 8;
  return { left: bounds.left + inset, right: bounds.right - inset, top: bounds.top + inset, bottom: bounds.bottom - inset };
}

/** Where the manuscript cites each key, scanned once per project and saved revision. */
let usageScan: { root: string | undefined; revision: unknown; counts: Promise<Map<string, number> | null> } | null = null;

function citationUses(data: LatexEditorLiveData, key: string): Promise<number | null> {
  if (!usageScan || usageScan.root !== data.projectRoot || usageScan.revision !== data.citationUsageRevision) {
    const counts = invoke<SymbolOccurrence[]>("list_citation_usages").then((list) => {
      const byKey = new Map<string, number>();
      for (const { symbol } of list) {
        const id = symbol.toLocaleLowerCase();
        byKey.set(id, (byKey.get(id) ?? 0) + 1);
      }
      return byKey;
    }).catch(() => null);
    usageScan = { root: data.projectRoot, revision: data.citationUsageRevision, counts };
  }
  return usageScan.counts.then((counts) => counts && (counts.get(key.toLocaleLowerCase()) ?? 0));
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** A 12px Lucide glyph for a fact: a check, or a warning triangle. */
function factIcon(paths: string[]): SVGSVGElement {
  const icon = document.createElementNS(SVG_NS, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    icon.append(path);
  }
  return icon;
}

/** A badge whose words give way to an ellipsis (a DOI can be long); its title keeps them whole. */
function fact(text: string, tone?: "success" | "warning"): HTMLSpanElement {
  const badge = element("span", "citation-card-fact");
  badge.classList.add("ui-badge");
  badge.dataset.slot = "badge";
  badge.dataset.tone = tone ?? "neutral";
  badge.append(element("span", "", text));
  badge.title = text;
  return badge;
}

/**
 * Crossref's word on the entry, from the library paper cited by this key:
 * a correction or retraction as a warning, a lookup that found none as
 * verified. Nothing when the paper was never checked or Crossref was down.
 */
function healthFact(paper: PaperSummary | undefined): HTMLSpanElement | null {
  const health = paper?.citationHealth;
  const title = citationHealthTitle(health);
  const warning = citationHealthParts(health);
  let badge: HTMLSpanElement | null = null;
  if (warning) {
    badge = fact(warning.kind, "warning");
    badge.prepend(factIcon(["m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3", "M12 9v4", "M12 17h.01"]));
  } else if (health?.kind === "unknown") {
    badge = fact(i18n._(msg`Verified · Crossref`), "success");
    badge.prepend(factIcon(["M20 6 9 17l-5-5"]));
  }
  if (badge && title) badge.title = title;
  return badge;
}

type CardAction = { label: string; run: (button: HTMLButtonElement) => void | Promise<void>; lead?: boolean };

function cardButton(action: CardAction, keyboard: boolean): HTMLButtonElement {
  const button = element("button", buttonClassName({ variant: action.lead ? "tinted" : "ghost", size: "compact" }), action.label);
  button.type = "button";
  // Opened from the keyboard, the lead action holds focus, so Return runs it.
  if (action.lead && keyboard) button.append(element("kbd", "", comboText({ key: "Enter" })));
  button.addEventListener("click", () => void action.run(button));
  return button;
}

/**
 * A citation key's card: the key, the entry as a reference list sets it
 * (serif title, authors, italic venue and year), what is known about it
 * (Crossref health, uses in this paper, its arXiv id or DOI) and its actions.
 * `close` ends the card before an action leaves the editor.
 */
function citationCard(
  view: EditorView,
  citation: CitationInfo,
  data: LatexEditorLiveData,
  host: { keyboard: boolean; close: () => void; onGotoDefinition?: (target: DefinitionTarget) => void },
): HTMLDivElement {
  const dom = createHoverCard("citation-hover-card", view, 160);
  const heading = citation.title || citation.key;
  dom.setAttribute("role", "group");
  dom.setAttribute("aria-label", heading);
  if (citation.title) dom.append(element("span", "citation-card-key", citation.key));
  const title = element("strong", "citation-card-title", heading);
  title.title = heading;
  dom.append(title);
  const paper = data.papers?.find((item) => item.citationKey?.toLocaleLowerCase() === citation.key.toLocaleLowerCase());
  // The library's author field keeps BibTeX's braces, which mark a corporate author.
  const authors = paperBylineAuthors({ authors: paper?.authors || citation.authors });
  if (authors) dom.append(element("span", "citation-card-authors", authors));
  // No-break spaces keep the year with the venue's last word when the line wraps.
  const publication = [citation.venue, citation.year].filter(Boolean).join("\u00a0·\u00a0");
  if (publication) dom.append(Object.assign(element("em", "citation-card-venue", publication), { title: publication }));

  const facts = element("div", "citation-card-facts");
  const health = healthFact(paper);
  if (health) facts.append(health);
  // The count arrives after the card opens; until then it holds no place.
  const uses = fact("");
  uses.hidden = true;
  facts.append(uses);
  void citationUses(data, citation.key).then((count) => {
    if (!count) return;
    const times = i18n.number(count);
    const label = i18n._(msg`Cited ${times}× here`);
    uses.replaceChildren(element("span", "", label));
    uses.title = label;
    uses.hidden = false;
  });
  const source = paperSourceLabel({ arxivId: citation.arxivId ?? "", doi: citation.doi, url: citation.url });
  if (source) facts.append(fact(source));
  dom.append(facts);

  const actions: CardAction[] = [];
  if (data.canOpenCitation?.(citation.key)) {
    actions.push({ label: i18n._(msg`Open paper`), lead: true, run: () => { host.close(); data.onOpenCitation?.(citation.key); } });
  }
  const { onGotoDefinition } = host;
  if (onGotoDefinition) {
    actions.push({ label: i18n._(msg`Go to entry`), run: () => { host.close(); onGotoDefinition({ kind: "citation", key: citation.key }); } });
  }
  const copyLabel = i18n._(msg`Copy key`);
  actions.push({
    label: copyLabel,
    // The card stays, and says so in the button for a moment.
    run: async (button) => {
      if (!await writeText(citation.key).then(() => true, () => false)) return;
      button.textContent = i18n._(msg`Copied`);
      setTimeout(() => { button.textContent = copyLabel; }, 1600);
    },
  });
  const bar = element("div", "citation-card-actions");
  bar.append(...actions.map((action) => cardButton(action, host.keyboard)));
  dom.append(bar);
  return dom;
}

const citationFor = (data: LatexEditorLiveData, key: string) =>
  data.citations.find((item) => item.key.toLocaleLowerCase() === key.toLocaleLowerCase());

const setKeyboardCard = StateEffect.define<Tooltip | null>();

/** The citation card ⌥⌘K opened; any edit or caret move closes it. */
const keyboardCard = StateField.define<Tooltip | null>({
  create: () => null,
  update(card, transaction) {
    for (const effect of transaction.effects) if (effect.is(setKeyboardCard)) return effect.value;
    return card && (transaction.docChanged || transaction.selection) ? null : card;
  },
  provide: (field) => showTooltip.from(field),
});

/** The card on hover, and the field that holds the one ⌥⌘K opens (see `citationCardAtCursor`). */
export function citationTooltips(live: () => LatexEditorLiveData, onGotoDefinition?: (target: DefinitionTarget) => void): Extension {
  return [keyboardCard, hoverTooltip((view, position) => {
    const target = citationHoverTarget(view.state.doc.toString(), position);
    const data = live();
    const citation = target && citationFor(data, target.key);
    if (!target || !citation) return null;
    return {
      pos: target.from,
      end: target.to,
      above: true,
      create() {
        const close = () => view.dispatch({ effects: closeHoverTooltips });
        return { dom: citationCard(view, citation, data, { keyboard: false, close, onGotoDefinition }) };
      },
    };
  })];
}

/**
 * Opens the card for the citation key at the caret with its first action
 * focused, so the keyboard reaches what a pointer reaches on hover. Tab walks
 * the actions; Escape, or focus leaving the card, closes it and Escape gives
 * the caret back.
 */
export function citationCardAtCursor(
  live: () => LatexEditorLiveData,
  onGotoDefinition?: (target: DefinitionTarget) => void,
): Command {
  return (view) => {
    const target = citationHoverTarget(view.state.doc.toString(), view.state.selection.main.head);
    const data = live();
    const citation = target && citationFor(data, target.key);
    if (!target || !citation) return false;
    // The caret in a key opens the citation menu; the card takes its place.
    closeCompletion(view);
    const close = () => {
      if (view.state.field(keyboardCard, false)) view.dispatch({ effects: setKeyboardCard.of(null) });
    };
    view.dispatch({
      effects: setKeyboardCard.of({
        pos: target.from,
        end: target.to,
        above: true,
        create() {
          const dom = citationCard(view, citation, data, { keyboard: true, close, onGotoDefinition });
          dom.addEventListener("keydown", (event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            close();
            view.focus();
          });
          // A click keeps focus where it is (WebKit would otherwise blur
          // the focused action on mousedown and close the card under it).
          dom.addEventListener("mousedown", (event) => event.preventDefault());
          dom.addEventListener("focusout", (event) => {
            if (!(event.relatedTarget instanceof Node && dom.contains(event.relatedTarget))) close();
          });
          return { dom, mount: () => dom.querySelector("button")?.focus() };
        },
      }),
    });
    return true;
  };
}

function figurePreview(
  imagePath: string,
  alt: string,
  loadImage: (path: string) => Promise<string | null>,
  destroyed: () => boolean,
): HTMLElement {
  const mediaClassName = "reference-hover-media loading";
  const media = element("div", mediaClassName);
  media.setAttribute("role", "status");
  // The loader stands alone; its words are the status's name, not a caption.
  media.setAttribute("aria-label", i18n._(msg`Loading figure preview…`));
  const loader = element("img", "reference-hover-loader");
  loader.src = infinityLoaderUrl;
  loader.alt = "";
  media.append(loader);
  const settle = (content: string | Node) => {
    if (destroyed()) return;
    media.classList.remove("loading");
    media.removeAttribute("aria-label");
    media.replaceChildren(content);
  };
  void loadImage(imagePath).then((source) => {
    if (!source) return settle(i18n._(msg`Preview unavailable for this figure format.`));
    const image = element("img");
    image.src = source;
    image.alt = alt;
    settle(image);
  }).catch(() => settle(i18n._(msg`Figure preview could not be loaded.`)));
  return media;
}

export function referenceTooltips(live: () => LatexEditorLiveData, loadImage?: (path: string) => Promise<string | null>) {
  return hoverTooltip((view, position) => {
    const target = referenceHoverTarget(view.state.doc.toString(), position);
    // The last definition of a label wins, as in the project index.
    const reference = target && new Map(live().references.map((item) => [item.label, item])).get(target.key);
    if (!target || !reference) return null;
    return {
      pos: target.from,
      end: target.to,
      above: true,
      create() {
        let destroyed = false;
        const dom = createHoverCard("reference-hover-card", view, 180);
        const { imagePath } = reference;
        if (imagePath && loadImage) dom.append(figurePreview(imagePath, reference.title || reference.label, loadImage, () => destroyed));
        dom.append(
          element("small", "", `${referenceKindLabel(reference.kind)} · ${reference.label}`),
          element("strong", "", reference.title || reference.label),
        );
        if (reference.snippet) dom.append(element("pre", "", reference.snippet));
        dom.append(element("em", "", reference.path));
        return { dom, destroy: () => { destroyed = true; } };
      },
    };
  });
}

/**
 * The figure an `\includegraphics` path names, resolved the way the build
 * resolves it (extensions, \graphicspath). A path that names no project file
 * gets no card: the missing-figure diagnostic already says so.
 */
export function graphicsTooltips(live: () => LatexEditorLiveData, loadImage: (path: string) => Promise<string | null>) {
  return hoverTooltip((view, position) => {
    const target = graphicsHoverTarget(view.state.doc.toString(), position);
    if (!target || /^https?:/.test(target.path)) return null;
    const data = live();
    const resolved = resolveProjectPath(target.path, data.projectPaths, "graphics", data.graphicsRoots);
    if (!resolved) return null;
    return {
      pos: target.from,
      end: target.to,
      above: true,
      create() {
        let destroyed = false;
        const dom = createHoverCard("reference-hover-card", view, 180);
        dom.append(figurePreview(resolved, resolved, loadImage, () => destroyed), element("em", "", resolved));
        return { dom, destroy: () => { destroyed = true; } };
      },
    };
  });
}
