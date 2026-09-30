/** Hover cards for citation keys and `\ref` labels (with a figure preview when one exists). */
import { hoverTooltip, type EditorView, type Rect } from "@codemirror/view";
import { msg } from "@lingui/core/macro";
import infinityLoaderUrl from "../../components/ui/infinity-loader.svg";
import { i18n } from "../../i18n";
import { element } from "../dom-utils";
import type { LatexEditorLiveData } from "./latex-editor";
import { citationHoverTarget, referenceHoverTarget } from "./latex-symbols";
import { referenceKindLabel, type ReferenceInfo } from "./latex-text";

function hoverCard(className: string, view: EditorView, minWidth: number): HTMLDivElement {
  const dom = element("div", className);
  dom.style.maxWidth = `${Math.max(minWidth, view.dom.clientWidth - 16)}px`;
  return dom;
}

export function citationTooltipSpace(bounds: Rect): Rect {
  const inset = 8;
  return { left: bounds.left + inset, right: bounds.right - inset, top: bounds.top + inset, bottom: bounds.bottom - inset };
}

export function citationTooltips(live: () => LatexEditorLiveData) {
  return hoverTooltip((view, position) => {
    const target = citationHoverTarget(view.state.doc.toString(), position);
    const data = live();
    const citation = target && data.citations.find((item) => item.key.toLocaleLowerCase() === target.key.toLocaleLowerCase());
    if (!target || !citation) return null;
    return {
      pos: target.from,
      end: target.to,
      above: true,
      create() {
        const dom = hoverCard("citation-hover-card", view, 160);
        const heading = citation.title || citation.key;
        let title: HTMLElement = element("strong", "", heading);
        if (data.canOpenCitation?.(citation.key)) {
          const button = element("button", "citation-hover-open", heading);
          button.type = "button";
          button.addEventListener("click", () => data.onOpenCitation?.(citation.key));
          title = button;
        }
        dom.append(element("small", "", citation.key), title);
        if (citation.authors) dom.append(element("span", "", citation.authors.replace(/ and /g, " · ")));
        const publication = [citation.venue, citation.year].filter(Boolean).join(" · ");
        if (publication) dom.append(element("em", "", publication));
        return { dom };
      },
    };
  });
}

function figurePreview(
  reference: ReferenceInfo & { imagePath: string },
  loadImage: (path: string) => Promise<string | null>,
  destroyed: () => boolean,
): HTMLElement {
  const mediaClassName = "reference-hover-media loading";
  const media = element("div", mediaClassName);
  media.setAttribute("role", "status");
  const loader = element("img", "reference-hover-loader");
  loader.src = infinityLoaderUrl;
  loader.alt = "";
  media.append(loader, element("span", "", i18n._(msg`Loading figure preview…`)));
  const settle = (content: string | Node) => {
    if (destroyed()) return;
    media.classList.remove("loading");
    media.replaceChildren(content);
  };
  void loadImage(reference.imagePath).then((source) => {
    if (!source) return settle(i18n._(msg`Preview unavailable for this figure format.`));
    const image = element("img");
    image.src = source;
    image.alt = reference.title || reference.label;
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
        const dom = hoverCard("reference-hover-card", view, 180);
        const { imagePath } = reference;
        if (imagePath && loadImage) dom.append(figurePreview({ ...reference, imagePath }, loadImage, () => destroyed));
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
