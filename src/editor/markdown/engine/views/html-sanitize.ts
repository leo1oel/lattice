/**
 * The allowlist an HTML block passes before the editor renders it (R-BLK-16).
 * Markdown files arrive from collaborators, clones and the web, so the
 * preview is a picture of the markup and nothing more: no script, no event
 * handler, nothing that loads from the network, nothing that navigates, and
 * no stylesheet that could restyle the app. DOMPurify (Apache-2.0) parses and
 * filters; the rules below narrow its defaults to plain HTML structure and
 * SVG drawing.
 *
 * A file can also hang the app without any script: SVG references (`<use>`,
 * markers) stamp their target out again, so a kilobyte of chained `<use>`s
 * draws a million shapes, and a stack of CSS blurs costs seconds per paint.
 * Filters are dropped, and a drawing whose references expand past a budget is
 * not drawn at all.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import DOMPurify, { type Config, type DOMPurify as Purifier } from "dompurify";

const HTML_TAGS = [
  "a", "abbr", "article", "aside", "b", "bdi", "bdo", "blockquote", "br", "caption", "center", "cite", "code", "col",
  "colgroup", "dd", "del", "details", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "footer", "h1", "h2",
  "h3", "h4", "h5", "h6", "header", "hr", "i", "img", "ins", "kbd", "li", "mark", "ol", "p", "pre", "q", "s", "samp",
  "section", "small", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr",
  "u", "ul", "var", "wbr",
];

/** Drawing only: no `foreignObject`, `image`, `animate`/`set` (which can rewrite an href), or `style`. */
const SVG_TAGS = [
  "svg", "g", "defs", "symbol", "use", "title", "desc", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "path", "text", "tspan", "textPath", "marker", "linearGradient", "radialGradient", "stop", "pattern", "clipPath", "mask",
];

const HTML_ATTRIBUTES = [
  "align", "alt", "border", "cellpadding", "cellspacing", "class", "colspan", "dir", "height", "hidden", "id", "lang",
  "open", "rowspan", "scope", "src", "start", "style", "title", "valign", "width", "role", "aria-label", "aria-hidden",
];

const SVG_ATTRIBUTES = [
  "viewBox", "preserveAspectRatio", "xmlns", "version", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry",
  "fx", "fy", "fr", "d", "points", "pathLength", "transform", "fill", "fill-opacity", "fill-rule", "stroke",
  "stroke-width", "stroke-dasharray", "stroke-dashoffset", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit",
  "stroke-opacity", "opacity", "color", "display", "visibility", "vector-effect", "paint-order", "shape-rendering",
  "text-rendering", "font-family", "font-size", "font-style", "font-weight", "font-variant", "letter-spacing",
  "word-spacing", "text-anchor", "text-decoration", "dominant-baseline", "alignment-baseline", "baseline-shift",
  "dx", "dy", "rotate", "textLength", "lengthAdjust", "startOffset", "markerWidth", "markerHeight", "markerUnits",
  "refX", "refY", "orient", "marker-start", "marker-mid", "marker-end", "gradientUnits", "gradientTransform",
  "spreadMethod", "offset", "stop-color", "stop-opacity", "patternUnits", "patternContentUnits", "patternTransform",
  "clip-path", "clip-rule", "clipPathUnits", "mask", "maskUnits", "maskContentUnits", "href", "xlink:href",
];

const CONFIG: Config = {
  ALLOWED_TAGS: [...HTML_TAGS, ...SVG_TAGS],
  ALLOWED_ATTR: [...HTML_ATTRIBUTES, ...SVG_ATTRIBUTES],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  // The text of removed elements (a <script>'s body, say) goes with them.
  KEEP_CONTENT: true,
  FORBID_CONTENTS: ["script", "style", "template", "noscript", "textarea", "iframe", "object", "embed", "foreignObject"],
  RETURN_DOM_FRAGMENT: true,
};

/** A raster image carried in the file itself; anything else (SVG included) could fetch or script. */
const RASTER_DATA_URL = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]*$/i;
/** `url(…)` is only a reference inside the drawing (`url(#arrow)`), never a fetch. */
const CSS_URL = /url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
const CSS_FETCH = /@import|image-set\s*\(|expression\s*\(|\burl\s*\(|\\/i;
/** Inline-style effects whose paint cost the markup controls (a few blurs take seconds). */
const CSS_COSTLY = /filter\s*:|box-reflect/i;

function attributeAllowed(element: Element, name: string, value: string): boolean {
  const tag = element.localName;
  if (name === "href" || name === "xlink:href") {
    // Only a <use> or <textPath> pointing into the same drawing; links never navigate.
    return (tag === "use" || tag === "textPath") && /^#[\w:.-]+$/.test(value.trim());
  }
  if (name === "src") return tag === "img" && RASTER_DATA_URL.test(value.trim());
  // Every url() must be a local fragment; anything else that could fetch is dropped.
  const withoutLocal = value.replace(CSS_URL, (whole, _quote, target: string) => (/^#[\w:.-]+$/.test(target.trim()) ? "" : whole));
  if (name === "style" && CSS_COSTLY.test(value)) return false;
  return !CSS_FETCH.test(withoutLocal);
}

let purifier: Purifier | null = null;

function instance(): Purifier {
  if (purifier) return purifier;
  // An instance of its own, so these hooks never reach another caller's DOMPurify.
  purifier = DOMPurify(window);
  purifier.addHook("uponSanitizeAttribute", (element, data) => {
    if (!attributeAllowed(element, data.attrName, data.attrValue)) data.keepAttr = false;
  });
  return purifier;
}

/** Beyond this many drawn nodes, references counted as many times as they stamp, the markup is not drawn. */
export const MAX_RENDERED_NODES = 50_000;
/** Deeper than this, the walk below stops and counts the markup as over the budget. */
const MAX_DEPTH = 1_000;
const LOCAL_URL = /url\(\s*['"]?#([\w:.-]+)/g;
const MARKER_PROPERTY = /(?:^|[;\s])marker(?:-mid)?\s*:/i;

/** How many times a reference in `attribute` stamps its target: once, or once per vertex for a mid marker. */
function stamps(element: Element, attribute: Attr): number {
  if (attribute.name !== "marker-mid" && !(attribute.name === "style" && MARKER_PROPERTY.test(attribute.value))) return 1;
  const numbers = (element.getAttribute("points") ?? element.getAttribute("d") ?? "").match(/-?\d*\.?\d+/g)?.length ?? 2;
  return Math.max(1, Math.ceil(numbers / 2)) + 2;
}

/**
 * The nodes the renderer draws for `fragment`: each element, plus its local
 * references' targets as often as they are stamped. Memoized per element, so
 * the count itself stays linear; a reference cycle is infinite.
 */
function renderedNodes(fragment: DocumentFragment): number {
  const byId = new Map<string, Element>();
  for (const element of fragment.querySelectorAll("[id]")) if (!byId.has(element.id)) byId.set(element.id, element);
  const memo = new Map<Element, number>();
  const visiting = new Set<Element>();
  const cost = (element: Element): number => {
    const known = memo.get(element);
    if (known !== undefined) return known;
    if (visiting.has(element) || visiting.size > MAX_DEPTH) return Infinity;
    visiting.add(element);
    let total = 1;
    for (const child of element.children) {
      total += cost(child);
      if (total > MAX_RENDERED_NODES) break;
    }
    for (const attribute of element.attributes) {
      if (total > MAX_RENDERED_NODES) break;
      const href = attribute.name === "href" || attribute.name === "xlink:href" ? /^#(.+)$/.exec(attribute.value.trim())?.[1] : undefined;
      const targets = href ? [href] : [...attribute.value.matchAll(LOCAL_URL)].map((match) => match[1]!);
      for (const id of targets) {
        const target = byId.get(id);
        if (target) total += stamps(element, attribute) * cost(target);
      }
    }
    visiting.delete(element);
    memo.set(element, total);
    return total;
  };
  let total = 0;
  for (const child of fragment.children) {
    total += cost(child);
    if (total > MAX_RENDERED_NODES) break;
  }
  return total;
}

export type HtmlPreview = { kind: "drawn"; fragment: DocumentFragment } | { kind: "too-complex" };

/** The HTML as a fragment safe to place in the preview, or null when no DOM is available. */
export function sanitizeHtmlPreview(source: string): HtmlPreview | null {
  if (typeof window === "undefined") return null;
  const fragment = instance().sanitize(source, CONFIG) as unknown as DocumentFragment;
  return renderedNodes(fragment) > MAX_RENDERED_NODES ? { kind: "too-complex" } : { kind: "drawn", fragment };
}
