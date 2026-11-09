/**
 * The allowlist an HTML block passes before the editor renders it (R-BLK-16).
 * Markdown files arrive from collaborators, clones and the web, so the
 * preview is a picture of the markup and nothing more: no script, no event
 * handler, nothing that loads from the network, nothing that navigates, and
 * no stylesheet that could restyle the app. DOMPurify (Apache-2.0) parses and
 * filters; the rules below narrow its defaults to plain HTML structure and
 * SVG drawing.
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

function attributeAllowed(element: Element, name: string, value: string): boolean {
  const tag = element.localName;
  if (name === "href" || name === "xlink:href") {
    // Only a <use> or <textPath> pointing into the same drawing; links never navigate.
    return (tag === "use" || tag === "textPath") && /^#[\w:.-]+$/.test(value.trim());
  }
  if (name === "src") return tag === "img" && RASTER_DATA_URL.test(value.trim());
  // Every url() must be a local fragment; anything else that could fetch is dropped.
  const withoutLocal = value.replace(CSS_URL, (whole, _quote, target: string) => (/^#[\w:.-]+$/.test(target.trim()) ? "" : whole));
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

/** The HTML as a fragment safe to place in the preview, or null when no DOM is available. */
export function sanitizeHtmlPreview(source: string): DocumentFragment | null {
  if (typeof window === "undefined") return null;
  const result = instance().sanitize(source, CONFIG);
  return result as unknown as DocumentFragment;
}
