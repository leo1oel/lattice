/** Hover cards for citation keys (also opened from the keyboard), `\ref` labels and `\includegraphics` paths, with a figure preview when one exists. */
import { closeCompletion, completionStatus } from "@codemirror/autocomplete";
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  closeHoverTooltips, EditorView, hoverTooltip, showTooltip, type Command, type Rect, type Tooltip,
} from "@codemirror/view";
import { msg } from "@lingui/core/macro";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { PaperSummary } from "../../app-types";
import { comboText } from "../../app/key-combos";
import { buttonClassName } from "../../components/ui/button-styles";
import infinityLoaderUrl from "../../components/ui/infinity-loader.svg";
import { i18n } from "../../i18n";
import { paperBylineAuthors, paperSourceLabel } from "../../papers/paper-identity";
import { citationHealthParts, citationHealthTitle } from "../../project/citation-health";
import { element } from "../dom-utils";
import { hoverAnchor } from "../hover-anchor";
import { citationUsesSection } from "./citation-card-uses";
import type { CitationReasonsApi } from "./citation-reason-editor";
import { compiledLabels } from "./compiled-labels";
import type { LatexEditorLiveData } from "./latex-editor";
import { citationHoverTarget, graphicsHoverTarget, referenceHoverTarget, resolveProjectPath } from "./latex-symbols";
import { visibleLatexSource } from "./latex-visible-source";
import { referenceKindLabel, type CitationInfo, type DefinitionTarget, type ReferenceInfo } from "./latex-text";
import { mathRegionAt } from "./math-region";

function createHoverCard(className: string, view: EditorView, minWidth: number): HTMLDivElement {
  const dom = element("div", className);
  dom.style.maxWidth = `${Math.max(minWidth, view.dom.clientWidth - 16)}px`;
  return dom;
}

export function citationTooltipSpace(bounds: Rect): Rect {
  const inset = 8;
  return { left: bounds.left + inset, right: bounds.right - inset, top: bounds.top + inset, bottom: bounds.bottom - inset };
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
    badge = fact(i18n._(msg`Verified by Crossref`), "success");
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
  host: {
    keyboard: boolean;
    close: () => void;
    onGotoDefinition?: (target: DefinitionTarget) => void;
    /** The key's span here, and the page its note names. */
    target: { from: number; to: number; page?: number };
    reasons?: CitationReasonsContext;
  },
): HTMLDivElement {
  const dom = createHoverCard("citation-hover-card", view, 160);
  const { onOpenCitation } = data;
  const openPaper: CardAction | undefined = onOpenCitation && data.canOpenCitation?.(citation.key)
    ? { label: i18n._(msg`Open paper`), lead: true, run: () => { host.close(); onOpenCitation(citation.key, host.target.page); } }
    : undefined;
  const { onGotoDefinition } = host;
  const gotoEntry: CardAction | undefined = onGotoDefinition
    ? { label: i18n._(msg`Go to entry`), run: () => { host.close(); onGotoDefinition({ kind: "citation", key: citation.key }); } }
    : undefined;
  const heading = citation.title || citation.key;
  dom.setAttribute("role", "group");
  dom.setAttribute("aria-label", heading);
  if (citation.title) dom.append(element("span", "citation-card-key", citation.key));
  // The title runs Open paper, or Go to entry when there is no paper to open.
  const titleAction = openPaper ?? gotoEntry;
  let title: HTMLElement;
  if (titleAction) {
    const button = element("button", "citation-card-title", heading);
    button.type = "button";
    button.addEventListener("click", () => void titleAction.run(button));
    title = button;
  } else title = element("strong", "citation-card-title", heading);
  title.title = heading;
  dom.append(title);
  const paper = data.papers?.find((item) => item.citationKey?.toLocaleLowerCase() === citation.key.toLocaleLowerCase());
  // The library's author field keeps BibTeX's braces, which mark a corporate author.
  const authors = paperBylineAuthors({ authors: paper?.authors || citation.authors });
  if (authors) dom.append(element("span", "citation-card-authors", authors));
  // No-break spaces keep the year with the venue's last word when the line wraps.
  const publication = [citation.venue, citation.year].filter(Boolean).join(",\u00a0");
  if (publication) dom.append(Object.assign(element("em", "citation-card-venue", publication), { title: publication }));

  const facts = element("div", "citation-card-facts");
  const health = healthFact(paper);
  if (health) facts.append(health);
  const source = paperSourceLabel({ arxivId: citation.arxivId ?? "", doi: citation.doi, url: citation.url });
  if (source) facts.append(fact(source));
  dom.append(facts);
  const { reasons } = host;
  const canOpen = Boolean(onOpenCitation && data.canOpenCitation?.(citation.key));
  dom.append(citationUsesSection(view, citation.key, {
    data,
    currentPath: reasons?.currentPath ?? "",
    reasons: reasons?.api,
    hovered: host.target,
    openPage: canOpen ? (page) => { host.close(); onOpenCitation?.(citation.key, page); } : undefined,
    jump: (use) => {
      host.close();
      if (use.from !== undefined && use.to !== undefined) {
        view.dispatch({ selection: { anchor: use.from, head: use.to }, scrollIntoView: true });
        view.focus();
      } else data.onOpenCitationUse?.(use.path, use.line);
    },
  }));

  const read = citationHoverTarget(visibleLatexSource(view.state.doc.toString()), host.target.from);
  const whyCited: CardAction | undefined = reasons && data.onSaveCitationReason && read
    ? {
      label: i18n._(msg`Why cited`),
      run: () => {
        host.close();
        reasons.api.edit(view, { from: host.target.from, to: host.target.to, key: citation.key });
      },
    }
    : undefined;
  const actions: CardAction[] = [openPaper, whyCited, gotoEntry].filter((action) => action !== undefined);
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

/** The open file and its citation reasons, which the card lists and edits. */
export type CitationReasonsContext = { currentPath: string; api: CitationReasonsApi };

/** The card on hover, and the field that holds the one ⌥⌘K opens (see `citationCardAtCursor`). */
export function citationTooltips(
  live: () => LatexEditorLiveData,
  onGotoDefinition?: (target: DefinitionTarget) => void,
  reasons?: CitationReasonsContext,
): Extension {
  return [keyboardCard, hoverTooltip((view, position) => {
    // The suggestion menu and the card would stack over the same key, and
    // the card would vanish as the pointer crossed into the menu.
    if (reasons?.api.editing(view.state) || completionStatus(view.state) !== null) return null;
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
        return {
          dom: citationCard(view, citation, data, { keyboard: false, close, onGotoDefinition, target, reasons }),
          // Rises straight from the key, even under a comment (hover-anchor.ts).
          getCoords: hoverAnchor(view, target.from),
        };
      },
    };
  }), EditorView.updateListener.of((update) => {
    // Typing into the key under a card opens the menu; the menu takes its place.
    if (completionStatus(update.state) !== null && completionStatus(update.startState) === null) {
      update.view.dispatch({ effects: closeHoverTooltips });
    }
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
  reasons?: CitationReasonsContext,
): Command {
  return (view) => {
    const target = citationHoverTarget(view.state.doc.toString(), view.state.selection.main.head);
    const data = live();
    const citation = target && citationFor(data, target.key);
    if (!target || !citation) return false;
    // A menu open from typing in the key gives way to the card.
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
          const dom = citationCard(view, citation, data, { keyboard: true, close, onGotoDefinition, target, reasons });
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
          // The first action takes focus, not the title, so Return runs the lead action its hint names.
          return { dom, mount: () => dom.querySelector<HTMLButtonElement>(".citation-card-actions button")?.focus() };
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

let equationModule: typeof import("./equation-card") | null = null;

/**
 * The equation a label names, set by KaTeX once it has loaded; until then,
 * and when KaTeX cannot set it, its source.
 */
function equationPreview(body: string, macros: Record<string, string> | undefined, destroyed: () => boolean): HTMLElement {
  const preview = element("div", "reference-hover-equation");
  preview.append(element("pre", "", body));
  const settle = (module: typeof import("./equation-card")) => {
    equationModule = module;
    const html = module.equationHtml(body, macros);
    if (!html || destroyed()) return;
    const math = element("div", "reference-hover-math");
    math.innerHTML = html;
    preview.replaceChildren(math);
  };
  if (equationModule) settle(equationModule);
  else void import("./equation-card").then(settle);
  return preview;
}

/**
 * The math around the label's own `\label` in the edited file, which may not
 * be saved yet; else the project index's snippet of a saved equation.
 */
function equationBody(text: string, reference: ReferenceInfo): string | null {
  const at = text.indexOf(`\\label{${reference.label}}`);
  if (at < 0) return reference.kind === "equation" ? reference.snippet : null;
  const region = mathRegionAt(text, at);
  return region?.display ? region.source : null;
}

/** "(3), page 4 in the last build": what the last build numbered the label, once its `.aux` is read. */
function compiledFact(data: LatexEditorLiveData, reference: ReferenceInfo, destroyed: () => boolean): HTMLElement | null {
  if (!data.compiledBuild) return null;
  const line = element("span", "reference-hover-number");
  line.hidden = true;
  void compiledLabels(data.projectRoot, data.compiledBuild).then((labels) => {
    const compiled = labels.get(reference.label);
    if (!compiled?.number || destroyed()) return;
    const number = reference.kind === "equation" ? `(${compiled.number})` : compiled.number;
    const { page } = compiled;
    line.textContent = page ? i18n._(msg`${number}, page ${page} in the last build`) : number;
    line.hidden = false;
  });
  return line;
}

export function referenceTooltips(live: () => LatexEditorLiveData, loadImage?: (path: string) => Promise<string | null>) {
  return hoverTooltip((view, position) => {
    const text = view.state.doc.toString();
    const target = referenceHoverTarget(text, position);
    const data = live();
    // The last definition of a label wins, as in the project index.
    const reference = target && new Map(data.references.map((item) => [item.label, item])).get(target.key);
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
          element("small", "", `${referenceKindLabel(reference.kind)} ${reference.label}`),
          element("strong", "", reference.title || reference.label),
        );
        const fact = compiledFact(data, reference, () => destroyed);
        if (fact) dom.append(fact);
        const equation = equationBody(text, reference);
        if (equation) dom.append(equationPreview(equation, data.katexMacros, () => destroyed));
        else if (reference.snippet) dom.append(element("pre", "", reference.snippet));
        dom.append(element("em", "", reference.path));
        return { dom, getCoords: hoverAnchor(view, target.from), destroy: () => { destroyed = true; } };
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
    const resolved = resolveProjectPath(target.path, data.projectPaths, "graphics", data.graphicsRoots, data.rootDocumentPath);
    if (!resolved) return null;
    return {
      pos: target.from,
      end: target.to,
      above: true,
      create() {
        let destroyed = false;
        const dom = createHoverCard("reference-hover-card", view, 180);
        dom.append(figurePreview(resolved, resolved, loadImage, () => destroyed), element("em", "", resolved));
        return { dom, getCoords: hoverAnchor(view, target.from), destroy: () => { destroyed = true; } };
      },
    };
  });
}
