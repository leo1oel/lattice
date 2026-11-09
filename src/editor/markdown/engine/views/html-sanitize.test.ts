/**
 * What survives the HTML preview's allowlist (R-BLK-16): drawing and plain
 * structure do; script, handlers, fetches and navigation do not.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { describe, expect, it } from "vitest";
import { MAX_RENDERED_NODES, sanitizeHtmlPreview } from "./html-sanitize";

function sanitized(source: string): HTMLElement {
  const preview = sanitizeHtmlPreview(source);
  if (preview?.kind !== "drawn") throw new Error(`not drawn: ${preview?.kind}`);
  const holder = document.createElement("div");
  holder.append(preview.fragment);
  return holder;
}

/** Groups that each `<use>` the previous one ten times: 10^levels rects from about a kilobyte. */
function useChain(levels: number): string {
  let defs = `<g id="l0"><rect width="1" height="1"/></g>`;
  for (let level = 1; level <= levels; level += 1) {
    defs += `<g id="l${level}">${`<use href="#l${level - 1}"/>`.repeat(10)}</g>`;
  }
  return `<svg width="9" height="9"><defs>${defs}</defs><use href="#l${levels}"/></svg>`;
}

/** Markers whose shapes carry the previous marker at every vertex. */
function markerChain(levels: number): string {
  const points = Array.from({ length: 10 }, (_, index) => `${index},${index % 2}`).join(" ");
  let defs = `<marker id="m0"><circle r="1"/></marker>`;
  for (let level = 1; level <= levels; level += 1) {
    defs += `<marker id="m${level}"><polyline points="${points}" marker-mid="url(#m${level - 1})"/></marker>`;
  }
  return `<svg width="9" height="9"><defs>${defs}</defs><polyline points="${points}" marker-mid="url(#m${levels})"/></svg>`;
}

const FIGURE = `<div>

<svg xmlns="http://www.w3.org/2000/svg" width="790" height="312" viewBox="0 0 790 312">
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#333"/></marker>
    <linearGradient id="fade"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#ccc"/></linearGradient>
  </defs>
  <rect x="20" y="40" width="180" height="80" rx="8" fill="url(#fade)" stroke="#3b6fd8"/>
  <text x="110" y="85" text-anchor="middle" font-size="16">Encoder<tspan dy="1">s</tspan></text>
  <line x1="200" y1="80" x2="300" y2="80" stroke="#333" marker-end="url(#arrow)"/>
  <use href="#arrow" x="4"/>
</svg>

</div>`;

describe("HTML preview sanitizer", () => {
  it("keeps the drawing: shapes, labels, markers, gradients and local references", () => {
    const html = sanitized(FIGURE);
    const svg = html.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 790 312");
    expect(svg.getAttribute("width")).toBe("790");
    for (const tag of ["rect", "text", "tspan", "line", "path", "marker", "linearGradient", "stop", "use"]) {
      expect(html.getElementsByTagName(tag).length, tag).toBeGreaterThan(0);
    }
    expect(html.querySelector("text")!.textContent).toBe("Encoders");
    expect(html.querySelector("line")!.getAttribute("marker-end")).toBe("url(#arrow)");
    expect(html.querySelector("rect")!.getAttribute("fill")).toBe("url(#fade)");
    expect(html.querySelector("use")!.getAttribute("href")).toBe("#arrow");
  });

  it("keeps plain structure and inline raster images", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const html = sanitized(`<details open><summary>More</summary><table><tr><td colspan="2">a<sub>1</sub> <kbd>K</kbd></td></tr></table><img src="${png}" alt="Plot" width="40"></details>`);
    expect(html.querySelector("details summary")!.textContent).toBe("More");
    expect(html.querySelector("td")!.getAttribute("colspan")).toBe("2");
    expect(html.querySelector("kbd, sub")).not.toBeNull();
    expect(html.querySelector("img")!.getAttribute("src")).toBe(png);
  });

  it("drops script, handlers, embedded documents and stylesheets", () => {
    const html = sanitized(`<div onclick="steal()">x<script>steal()</script><style>@import url(https://e.test/a.css); body{display:none}</style>
      <iframe src="https://e.test"></iframe><object data="a.swf"></object><embed src="a.swf"><form action="https://e.test"><input></form>
      <svg onload="steal()"><foreignObject><div>html</div></foreignObject><animate attributeName="href" to="javascript:steal()"/><set attributeName="href"/>
      <image href="https://e.test/i.png"/><rect onmouseover="steal()" width="1" height="1"/></svg></div>`);
    expect(html.querySelector("script, style, iframe, object, embed, form, input, foreignObject, animate, set, image")).toBeNull();
    expect(html.innerHTML).not.toMatch(/\bon\w+=|steal|@import|e\.test/);
    expect(html.querySelector("rect")).not.toBeNull();
  });

  it("drops links, network fetches and script URLs", () => {
    const html = sanitized(`<a href="https://e.test" target="_blank">site</a><a href="javascript:steal()">js</a>
      <img src="https://e.test/track.png"><img src="figure.png"><img src="data:image/svg+xml;base64,PHN2Zz4=">
      <svg><use href="https://e.test/s.svg#a"/><use xlink:href="data:image/svg+xml,x#a"/><a href="#x"><text>t</text></a>
      <rect fill="url(https://e.test/p.svg#g)" width="1" height="1"/><circle style="fill:red;background:url('https://e.test/b.png')" r="1"/>
      <ellipse style="fill:url(#ok)" rx="1" ry="1"/></svg>`);
    expect(html.querySelectorAll("[href], [src], [target]").length).toBe(0);
    expect(html.querySelector("rect")!.hasAttribute("fill")).toBe(false);
    expect(html.querySelector("circle")!.hasAttribute("style")).toBe(false);
    expect(html.querySelector("ellipse")!.getAttribute("style")).toBe("fill:url(#ok)");
    expect(html.textContent).toContain("site");
    expect(html.innerHTML).not.toMatch(/e\.test|javascript:/);
  });

  it("drops inline filters, whose paint cost the markup controls", () => {
    const html = sanitized(`<div style="filter:blur(200px) drop-shadow(0 0 90px red)">a</div><div style="backdrop-filter:blur(9px)">b</div>
      <div style="-webkit-box-reflect:below">c</div><div style="color:red">d</div>`);
    const styles = [...html.querySelectorAll("div")].map((div) => div.getAttribute("style"));
    expect(styles).toEqual([null, null, null, "color:red"]);
  });

  it("does not draw markup whose references would expand past the budget", () => {
    expect(sanitizeHtmlPreview(useChain(3))?.kind).toBe("drawn");
    expect(useChain(6).length).toBeLessThan(2_000);
    expect(10 ** 6).toBeGreaterThan(MAX_RENDERED_NODES);
    expect(sanitizeHtmlPreview(useChain(6))?.kind).toBe("too-complex");
    expect(sanitizeHtmlPreview(markerChain(2))?.kind).toBe("drawn");
    expect(sanitizeHtmlPreview(markerChain(6))?.kind).toBe("too-complex");
  });

  it("refuses a reference cycle and stays fast on deep nesting", () => {
    expect(sanitizeHtmlPreview(`<svg><g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g></svg>`)?.kind).toBe("too-complex");
    expect(sanitizeHtmlPreview(`<svg><g id="a"><use href="#a"/></g></svg>`)?.kind).toBe("too-complex");
    const started = performance.now();
    sanitizeHtmlPreview(`${"<div>".repeat(1_500)}x${"</div>".repeat(1_500)}`);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
