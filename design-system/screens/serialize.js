// @ratchet-files-ignore: one function that page.evaluate injects as a single
// self-contained source string; split, no part would parse or run on its own.
// Runs in a page (page.evaluate): turns what is rendered into Paper HTML, the
// subset Paper's write_html takes. A container whose children sit at regular
// spacing becomes a flex row or column with that gap; any other is laid out
// absolutely at the measured places. Colours, fonts and radii are bound to the
// design-system tokens (a colour that is a token at reduced opacity becomes
// color-mix() of that token); what matches no token stays literal and is
// counted in stats.unmapped. Text keeps its runs, truncation and the scale of
// a transformed ancestor; SVG sprites (<use>), mask icons and fill-opacity are
// flattened into shapes Paper draws; images and canvases come back as PNG data
// for the caller to save; an iframe leaves a __FRAME_n__ slot for the caller
// to fill from that frame, and opts.inject a __INJECT_key__ slot.
// Returns { html, images, frames, injected, stats, background, width, height }.
(opts) => {
  const { colors, fonts, radii, rootSelector, skipSelectors = [], names = {} } = opts;
  const stats = { boxes: 0, texts: 0, svgs: 0, images: 0, absolute: 0, flex: 0, unmapped: {} };
  const images = [];
  const frames = [];
  const injected = [];
  const ctx = document.createElement("canvas").getContext("2d");

  // ------------------------------------------------------------ colours
  const rgbaOf = (value) => {
    if (!value || value === "transparent" || value === "none") return null;
    const srgb = /^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.e-]+%?))?\)$/.exec(value.trim());
    if (srgb) {
      const a = srgb[4] === undefined ? 1 : srgb[4].endsWith("%") ? parseFloat(srgb[4]) / 100 : parseFloat(srgb[4]);
      return [parseFloat(srgb[1]) * 255, parseFloat(srgb[2]) * 255, parseFloat(srgb[3]) * 255, a];
    }
    if (/^url\(/.test(value.trim())) return null;
    ctx.fillStyle = "#040506";
    ctx.fillStyle = value;
    const probe = ctx.fillStyle;
    ctx.fillStyle = "#010203";
    ctx.fillStyle = value;
    let v = ctx.fillStyle;
    if (probe !== v) return null; // the canvas kept each sentinel: not a colour it parses
    if (v === "#010203" && !/^#010203/i.test(value)) {
      // Not parsable by canvas (e.g. color(srgb ...) in some builds): paint and read.
      ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    }
    if (v.startsWith("#")) return [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16), 1];
    const m = /rgba?\(([^)]+)\)/.exec(v);
    if (!m) {
      ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    }
    const p = m[1].split(",").map((s) => parseFloat(s));
    return [p[0], p[1], p[2], p[3] ?? 1];
  };
  const hex = (n) => Math.round(n).toString(16).padStart(2, "0");
  const literal = (c) => { if (!c) return "#000000"; const [r, g, b, a] = c; return litStr(r, g, b, a); };
  const litStr = (r, g, b, a) => (a >= 0.999 ? `#${hex(r)}${hex(g)}${hex(b)}` : `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${+a.toFixed(3)})`);
  const PREFER = {
    text: [/^--color(-dark)?-(text|accent|danger|warning|success|info|syntax)/],
    bg: [/^--color(-dark)?-(window|chrome|titlebar|panel|raised|sunken|control|hover|selected|press|wash|accent|tint)/],
    line: [/^--color(-dark)?-(line|border|separator|divider|focus)/],
  };
  const color = (value, role = "bg") => {
    const c = rgbaOf(value);
    if (!c || c[3] === 0) return null;
    const hits = colors.filter((t) => t.rgba.every((v, k) => Math.abs(v - c[k]) <= (k === 3 ? 0.012 : 1.01)));
    if (hits.length) {
      const pref = hits.find((t) => PREFER[role].some((re) => re.test(t.name)));
      return `var(${(pref ?? hits[0]).name})`;
    }
    // A token at reduced opacity (a wash, a muted mark): Paper's color-mix keeps the token bound.
    if (c[3] < 0.999) {
      const base = colors.filter((t) => t.rgba[3] >= 0.999 && t.rgba.slice(0, 3).every((v, k) => Math.abs(v - c[k]) <= 1.01));
      if (base.length) {
        const pref = base.find((t) => PREFER[role].some((re) => re.test(t.name))) ?? base[0];
        return `color-mix(in srgb, var(${pref.name}) ${+(c[3] * 100).toFixed(1)}%, transparent)`;
      }
    }
    const key = literal(c);
    stats.unmapped[key] = (stats.unmapped[key] ?? 0) + 1;
    return key;
  };
  const fontFamily = (stack) => {
    const first = stack.split(",")[0].trim().replace(/^["']|["']$/g, "");
    const hit = fonts.find((f) => f.first === first);
    if (hit) return `var(${hit.name})`;
    if (/^KaTeX/.test(first)) return "'STIX Two Text'";
    // A page asking for the system face (an HTML document) gets Paper's system face: Inter runs wider.
    if (first === "system-ui" || first === "-apple-system" || first === "BlinkMacSystemFont") return "'System Sans-Serif'";
    if (first === "sans-serif") return "var(--font-ui)";
    if (first === "monospace" || first === "ui-monospace") return "var(--font-editor)";
    return `'${first}'`;
  };
  const radius = (px) => {
    const hit = radii.find((r) => r.px === px);
    return hit ? `var(${hit.name})` : `${px}px`;
  };

  // ------------------------------------------------------------ tree walking
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "LINK", "META", "TEMPLATE", "NOSCRIPT", "HEAD", "TITLE"]);
  const kids = (node) => {
    if (node.nodeType !== 1) return [];
    if (node.tagName === "SLOT") { const a = node.assignedNodes({ flatten: true }); return a.length ? a : [...node.childNodes]; }
    if (node.shadowRoot) return [...node.shadowRoot.childNodes];
    return [...node.childNodes];
  };
  const skipped = (el) => skipSelectors.some((s) => el.matches?.(s));
  const visibleStyle = (cs) => cs.display !== "none" && cs.visibility !== "hidden" && cs.visibility !== "collapse" && parseFloat(cs.opacity) > 0.01;
  const R = (r) => ({ x: r.left, y: r.top, w: r.width, h: r.height });
  const intersects = (a, clip) => !clip || (a.x < clip.x + clip.w && a.x + a.w > clip.x && a.y < clip.y + clip.h && a.y + a.h > clip.y);
  const px = (v) => parseFloat(v) || 0;
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const attr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const r1 = (n) => Math.round(n * 10) / 10;

  const clipsText = (cs) => cs.backgroundClip === "text" || cs.webkitBackgroundClip === "text";
  const hasBoxStyle = (cs) =>
    (!clipsText(cs) && (rgbaOf(cs.backgroundColor)?.[3] ?? 0) > 0) || (!clipsText(cs) && cs.backgroundImage && cs.backgroundImage !== "none") ||
    ["Top", "Right", "Bottom", "Left"].some((s) => px(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== "none") ||
    (cs.boxShadow && cs.boxShadow !== "none");

  // Rendered-to-layout ratio: slides and thumbnails are drawn under CSS scale transforms.
  const scaleOf = (el) => {
    let n = el;
    while (n && !(n instanceof HTMLElement && n.offsetWidth > 0)) n = n.parentElement;
    if (!n) return 1;
    // CSS zoom (the HTML preview fits its page with it) scales boxes but not the computed font size.
    let zoom = 1;
    for (let z = n; z; z = z.parentElement) zoom *= parseFloat(getComputedStyle(z).zoom) || 1;
    const r = (n.getBoundingClientRect().width / n.offsetWidth) * zoom;
    return Math.abs(r - 1) < 0.01 ? 1 : r;
  };
  let currentScale = 1;
  const sz = (v) => (currentScale === 1 || !/px$/.test(v) ? v : `${r1(parseFloat(v) * currentScale)}px`);
  const textStyle = (cs, base) => {
    const out = [];
    const put = (k, v) => { if (!base || base[k] !== v) out.push(`${k}:${v}`); };
    put("color", color(cs.color, "text") ?? "transparent");
    put("font-family", fontFamily(cs.fontFamily));
    put("font-size", sz(cs.fontSize));
    put("font-weight", cs.fontWeight);
    if (cs.fontStyle !== "normal") put("font-style", cs.fontStyle);
    if (cs.lineHeight !== "normal") put("line-height", sz(cs.lineHeight));
    if (cs.letterSpacing !== "normal" && px(cs.letterSpacing) !== 0) put("letter-spacing", sz(cs.letterSpacing));
    if (cs.textTransform !== "none") put("text-transform", cs.textTransform);
    if (clipsText(cs) && cs.backgroundImage !== "none") { out.push(`background-image:${cs.backgroundImage}`, "background-clip:text", "-webkit-background-clip:text", "color:transparent"); }
    const deco = cs.textDecorationLine;
    if (deco && deco !== "none") put("text-decoration", deco);
    return out;
  };
  const textBase = (cs) => ({
    color: color(cs.color, "text") ?? "transparent", "font-family": fontFamily(cs.fontFamily), "font-size": sz(cs.fontSize),
    "font-weight": cs.fontWeight, "font-style": cs.fontStyle, "line-height": sz(cs.lineHeight),
  });

  // An element whose content is only text and plain inline styling becomes one Paper Text node.
  const isTextLeaf = (el) => {
    let text = false;
    const walk = (node, top) => {
      for (const child of kids(node)) {
        if (child.nodeType === 3) { if (child.data.trim()) text = true; continue; }
        if (child.nodeType !== 1 || SKIP_TAGS.has(child.tagName)) continue;
        const cs = getComputedStyle(child);
        if (cs.display === "none") continue;
        if (["SVG", "svg", "IMG", "CANVAS", "INPUT", "TEXTAREA", "VIDEO", "IFRAME"].includes(child.tagName)) return false;
        if (!(cs.display === "inline" || (top && child.tagName === "BR"))) return false;
        if (hasBoxStyle(cs) || px(cs.paddingLeft) + px(cs.paddingRight) > 0 || cs.position === "absolute" || cs.position === "fixed") return false;
        if (!walk(child, false)) return false;
      }
      return true;
    };
    return walk(el, true) && text;
  };
  const richText = (el, base) => {
    let html = "";
    const walk = (node) => {
      for (const child of kids(node)) {
        if (child.nodeType === 3) { html += esc(child.data); continue; }
        if (child.nodeType !== 1) continue;
        if (child.tagName === "BR") { html += "\n"; continue; }
        const cs = getComputedStyle(child);
        if (cs.display === "none" || !visibleStyle(cs)) continue;
        const own = textStyle(cs, base);
        if (own.length) { html += `<span style="${own.join(";")}">`; walkWithPseudo(child); html += "</span>"; } else walkWithPseudo(child);
      }
    };
    const pseudoText = (node, which) => {
      const c = getComputedStyle(node, which).content;
      if (!c || !/^["']/.test(c)) return "";
      const ps = getComputedStyle(node, which);
      const sp = (v) => (px(v) >= 2 ? " " : "");
      return sp(ps.marginLeft) + esc(c.slice(1, -1).replace(/\\a/g, "\n")) + sp(ps.marginRight);
    };
    const walkWithPseudo = (node) => { html += pseudoText(node, "::before"); walk(node); html += pseudoText(node, "::after"); };
    walkWithPseudo(el);
    return html;
  };

  const nameOf = (el) => {
    for (const [sel, name] of Object.entries(names)) if (el.matches?.(sel)) return name;
    const label = el.getAttribute?.("aria-label") || el.getAttribute?.("data-testid") || el.getAttribute?.("data-item-path");
    if (label) return label.slice(0, 60);
    const UTIL = new RegExp("^(?:[a-z]+-\\[|(?:" + "flex grid items justify gap p px py pt pr pb pl m mx my mt mr mb ml w h min max text font bg border rounded shadow relative absolute inline overflow truncate shrink grow size leading tracking opacity z top left right bottom select cursor transition duration ease outline ring hover focus data group peer sr pointer block hidden contents isolate self place whitespace break col row space order basis aspect object origin scale rotate translate motion animate will fill stroke underline italic not in out ms me ps pe dark light lg md sm xl".split(" ").join("|") + ")(?:-|:|$))");
    const cls = typeof el.className === "string" ? el.className.split(/\s+/).find((c) => c && !UTIL.test(c)) : null;
    if (cls) return cls;
    return (el.getAttribute?.("role") || el.tagName.toLowerCase());
  };

  // ------------------------------------------------------------ box styles
  const boxStyle = (el, cs, size) => {
    const s = [];
    const bg = clipsText(cs) ? null : color(cs.backgroundColor, "bg");
    if (bg) s.push(`background-color:${bg}`);
    if (!clipsText(cs) && cs.backgroundImage && cs.backgroundImage !== "none" && !cs.backgroundImage.includes("url(")) s.push(`background-image:${cs.backgroundImage}`);
    const k = el && el.nodeType === 1 ? scaleOf(el) : 1;
    const sides = ["Top", "Right", "Bottom", "Left"].map((side) => {
      const w = r1(px(cs[`border${side}Width`]) * k) || (px(cs[`border${side}Width`]) > 0 ? 0.5 : 0);
      const st = cs[`border${side}Style`];
      return w > 0 && st !== "none" ? `${w}px ${st} ${color(cs[`border${side}Color`], "line") ?? "transparent"}` : null;
    });
    if (sides.every((x) => x && x === sides[0])) s.push(`border:${sides[0]}`);
    else ["top", "right", "bottom", "left"].forEach((side, k) => { if (sides[k]) s.push(`border-${side}:${sides[k]}`); });
    const sz = size ?? { w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height };
    const corners = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius]
      .map((v) => (String(v).trim().split(" ")[0].endsWith("%") ? Math.min(sz.w, sz.h) * parseFloat(v) / 100 : px(v) * k));
    if (corners.some((c) => c > 0)) {
      const maxR = Math.min(sz.w, sz.h) / 2;
      const rr = corners.map((c) => (c >= maxR - 0.5 && c > 8 ? "999px" : radius(r1(c))));
      s.push(rr.every((x) => x === rr[0]) ? `border-radius:${rr[0]}` : `border-radius:${rr.join(" ")}`);
    }
    if (cs.boxShadow && cs.boxShadow !== "none") s.push(`box-shadow:${cs.boxShadow}`);
    if (parseFloat(cs.opacity) < 0.999) s.push(`opacity:${cs.opacity}`);
    if (cs.backdropFilter && cs.backdropFilter !== "none") s.push(`backdrop-filter:${cs.backdropFilter}`);
    return s;
  };

  // Paper draws fill-opacity solid: split such shapes into a faded fill copy and the stroke.
  const splitFillOpacity = (root) => {
    for (const n of [...root.querySelectorAll("[fill-opacity]")]) {
      const op = n.getAttribute("fill-opacity"); n.removeAttribute("fill-opacity");
      const fillCopy = n.cloneNode(true); fillCopy.setAttribute("stroke", "none");
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g"); g.setAttribute("opacity", op); g.appendChild(fillCopy);
      n.setAttribute("fill", "none"); n.parentNode.insertBefore(g, n);
    }
    return root;
  };
  // ------------------------------------------------------------ leaves
  const svgLeaf = (el, rect) => {
    stats.svgs++;
    const clone = el.cloneNode(true);
    // Inline <use href="#id"> sprite references: Paper cannot follow them.
    const uses = [...el.querySelectorAll("use")];
    [...clone.querySelectorAll("use")].forEach((u, k) => {
      const ref = (u.getAttribute("href") || u.getAttribute("xlink:href") || "").replace(/^#/, "");
      const rootNode = el.getRootNode();
      const target = rootNode.getElementById?.(ref) ?? rootNode.querySelector?.(`#${CSS.escape(ref)}`) ?? document.getElementById(ref);
      if (!target) { u.remove(); return; }
      const ucs = getComputedStyle(uses[k]);
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      for (const child of target.children) {
        const copy = child.cloneNode(true);
        const ccs = getComputedStyle(child);
        const styled = /fill|stroke/.test(child.getAttribute("style") ?? "");
        copy.removeAttribute("style"); copy.removeAttribute("class");
        if (styled) {
          for (const prop of ["fill", "stroke"]) {
            const v = ccs[prop];
            if (!v || v === "none") { copy.setAttribute(prop, "none"); continue; }
            const rgba = rgbaOf(v); if (!rgba) continue;
            copy.setAttribute(prop, rgba[3] < 0.999 ? literal([...rgba.slice(0, 3), 1]) : (color(v, "text") ?? literal(rgba)));
            if (rgba[3] < 0.999) copy.setAttribute("data-wrap-opacity", String(+rgba[3].toFixed(3)));
          }
          if (ccs.stroke !== "none") { copy.setAttribute("stroke-width", ccs.strokeWidth.replace("px", "")); copy.setAttribute("stroke-linecap", ccs.strokeLinecap); copy.setAttribute("stroke-linejoin", ccs.strokeLinejoin); }
        }
        g.appendChild(copy);
      }
      const paint = (prop, v) => {
        if (!v || v === "none") return "none";
        const rgba = rgbaOf(v); if (!rgba) return null;
        return color(v, "text") ?? literal(rgba);
      };
      for (const n of [g, ...g.querySelectorAll("*")]) {
        for (const prop of ["fill", "stroke"]) {
          const a = n.getAttribute(prop);
          if (a && a.toLowerCase() === "currentcolor") n.setAttribute(prop, paint(prop, ucs.color));
        }
      }
      if (!g.getAttribute("fill")) { const f = paint("fill", ucs.fill); if (f) g.setAttribute("fill", f); }
      if (!g.getAttribute("stroke")) { const st = paint("stroke", ucs.stroke); if (st && st !== "none") { g.setAttribute("stroke", st); g.setAttribute("stroke-width", ucs.strokeWidth.replace("px", "")); g.setAttribute("stroke-linecap", ucs.strokeLinecap); g.setAttribute("stroke-linejoin", ucs.strokeLinejoin); } }
      u.replaceWith(g);
    });
    const orig = uses.length ? [el] : [el, ...el.querySelectorAll("*")];
    const copies = uses.length ? [clone] : [clone, ...clone.querySelectorAll("*")];
    orig.forEach((o, k) => {
      const c = copies[k];
      const cs = getComputedStyle(o);
      if (cs.display === "none") { c.remove?.(); return; }
      c.removeAttribute("class"); c.removeAttribute("style");
      if (o === el) return;
      if (o.tagName.toLowerCase() === "stop") {
        const stop = rgbaOf(cs.stopColor);
        if (stop) c.setAttribute("stop-color", literal([...stop.slice(0, 3), 1]));
        const opacity = (stop?.[3] ?? 1) * parseFloat(cs.stopOpacity || "1");
        if (opacity < 0.999) c.setAttribute("stop-opacity", String(+opacity.toFixed(3)));
        return;
      }
      for (const prop of ["fill", "stroke"]) {
        const v = cs[prop];
        if (!v || v === "none") { if (o.getAttribute(prop) != null || prop === "fill") c.setAttribute(prop, "none"); continue; }
        const ref = /url\("?#([^")]+)"?\)/.exec(v);
        if (ref) { c.setAttribute(prop, `url(#${ref[1]})`); continue; }
        const rgba = rgbaOf(v);
        if (!rgba) continue;
        const op = rgba[3] * (prop === "fill" ? parseFloat(cs.fillOpacity) : parseFloat(cs.strokeOpacity));
        c.setAttribute(prop, op < 0.999 ? literal([...rgba.slice(0, 3), 1]) : (color(v, "text") ?? literal(rgba)));
        if (op < 0.999) c.setAttribute("data-wrap-opacity", String(+op.toFixed(3)));
      }
      if (cs.strokeWidth && cs.stroke !== "none") c.setAttribute("stroke-width", cs.strokeWidth.replace("px", ""));
      if (parseFloat(cs.opacity) < 1) c.setAttribute("opacity", cs.opacity);
    });
    const root = getComputedStyle(el);
    for (const prop of ["fill", "stroke"]) {
      const v = el.getAttribute(prop);
      if (v && v.toLowerCase() === "currentcolor") clone.setAttribute(prop, color(root.color, "text") ?? literal(rgbaOf(root.color)));
    }
    if (root.strokeWidth && el.getAttribute("stroke-width") == null && root.stroke !== "none") clone.setAttribute("stroke-width", root.strokeWidth.replace("px", ""));
    clone.setAttribute("width", r1(rect.w)); clone.setAttribute("height", r1(rect.h));
    const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(el).transform);
    const deg = m ? Math.round(Math.atan2(parseFloat(m[1].split(",")[1]), parseFloat(m[1].split(",")[0])) * 180 / Math.PI) : 0;
    clone.setAttribute("style", `width:${r1(rect.w)}px;height:${r1(rect.h)}px;flex-shrink:0${deg ? `;transform:rotate(${deg}deg)` : ""}`);
    if (!clone.getAttribute("viewBox") && el.viewBox?.baseVal?.width) clone.setAttribute("viewBox", `0 0 ${el.viewBox.baseVal.width} ${el.viewBox.baseVal.height}`);
    clone.setAttribute("layer-name", nameOf(el));
    // Paper draws no SVG mask. A radial luminance fade (the welcome lattice) becomes an
    // overlay in the ground colour: where the mask hides, the overlay covers.
    let overlay = "";
    for (const masked of [...clone.querySelectorAll("[mask]")]) {
      const id = /url\(#([^)]+)\)/.exec(masked.getAttribute("mask"))?.[1];
      masked.removeAttribute("mask");
      const maskEl = id && el.querySelector(`[id="${CSS.escape(id)}"]`);
      const gradId = maskEl && /url\(#([^)]+)\)/.exec(maskEl.querySelector("[fill]")?.getAttribute("fill") ?? "")?.[1];
      const grad = gradId && el.querySelector(`[id="${CSS.escape(gradId)}"]`);
      if (!grad || grad.tagName.toLowerCase() !== "radialgradient") continue;
      let ground = null, n = el.parentElement;
      while (n && !ground) { const bg = getComputedStyle(n).backgroundColor; if ((rgbaOf(bg)?.[3] ?? 0) > 0.99) ground = bg; n = n.parentElement; }
      const g = rgbaOf(ground ?? "#ffffff");
      const token = color(ground ?? "#ffffff", "bg");
      const stops = [...grad.querySelectorAll("stop")].map((stop) => {
        const lum = (rgbaOf(stop.getAttribute("stop-color") ?? "#000")?.[0] ?? 0) / 255;
        const cover = 1 - lum * parseFloat(stop.getAttribute("stop-opacity") ?? "1");
        const offset = parseFloat(stop.getAttribute("offset") ?? "0") * (stop.getAttribute("offset")?.endsWith("%") ? 1 : 100);
        const paint = cover >= 0.999 ? token : cover <= 0.001 ? "transparent" : `color-mix(in srgb, ${token} ${Math.round(cover * 100)}%, transparent)`;
        return `${paint} ${r1(offset)}%`;
      });
      void g;
      overlay = `<div layer-name="fade" style="position:absolute;left:0px;top:0px;width:${r1(rect.w)}px;height:${r1(rect.h)}px;background-image:radial-gradient(ellipse 50% 50% at 50% 50%, ${stops.join(", ")})"></div>`;
    }
    for (const m of [...clone.querySelectorAll("mask")]) m.remove();
    splitFillOpacity(clone);
    for (const n of [...clone.querySelectorAll("[data-wrap-opacity]")]) {
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("opacity", n.getAttribute("data-wrap-opacity")); n.removeAttribute("data-wrap-opacity");
      n.replaceWith(g); g.appendChild(n);
    }
    const markup = clone.outerHTML.replace(/ xmlns:xlink="[^"]*"/g, "");
    if (!overlay) return markup;
    return `<div layer-name="${attr(nameOf(el))}" data-svgwrap="1" style="width:${r1(rect.w)}px;height:${r1(rect.h)}px;flex-shrink:0;display:flex">${markup.replace("<svg", '<svg data-inner="1"')}${overlay}</div>`;
  };
  const imageLeaf = (el, rect, cs) => {
    let data = null;
    try {
      if (el.tagName === "CANVAS") data = el.toDataURL("image/png");
      else {
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(rect.w * 2)); c.height = Math.max(1, Math.round(rect.h * 2));
        c.getContext("2d").drawImage(el, 0, 0, c.width, c.height);
        data = c.toDataURL("image/png");
      }
    } catch { data = null; }
    if (!data) return null;
    stats.images++;
    const id = `img${images.length}`;
    images.push({ id, data });
    const rad = px(cs.borderTopLeftRadius) ? `;border-radius:${radius(px(cs.borderTopLeftRadius))}` : "";
    return `<img layer-name="${attr(nameOf(el))}" src="__${id}__" style="width:${r1(rect.w)}px;height:${r1(rect.h)}px;flex-shrink:0;object-fit:cover${rad}">`;
  };

  // The text a clamped or ellipsised element shows, with its ellipsis; null when nothing is cut.
  const visibleText = (el, rect) => {
    if (!el || el.nodeType !== 1) return null;
    const cs = getComputedStyle(el);
    const clamped = (cs.webkitLineClamp && cs.webkitLineClamp !== "none") || cs.textOverflow === "ellipsis";
    if (!clamped || (el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1)) return null;
    let out = "";
    const range = document.createRange();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (let i = 0; i < node.data.length; i++) {
        range.setStart(node, i); range.setEnd(node, i + 1);
        const r = range.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) { out += node.data[i]; continue; }
        if (r.bottom > rect.y + rect.h + 1 || r.right > rect.x + rect.w + 1) return out.replace(/\s*\S?$/, "").trimEnd() + "…";
        out += node.data[i];
      }
    }
    return null;
  };
  // ------------------------------------------------------------ boxes
  // Each item: { rect, html(posStyle) } where posStyle is the parent's placement.
  const textItem = (el, cs, rect, text) => {
    stats.texts++;
    const itemScale = scaleOf(el);
    const prevScale = currentScale; currentScale = itemScale;
    const base = textBase(cs);
    const own = textStyle(cs, null);
    const singleLine = rect.h <= px(cs.lineHeight === "normal" ? cs.fontSize : cs.lineHeight) * itemScale * 1.5 || cs.whiteSpace === "nowrap" || cs.whiteSpace === "pre";
    const ws = cs.whiteSpace === "pre" || cs.whiteSpace === "pre-wrap" ? cs.whiteSpace : singleLine ? "nowrap" : "normal";
    const align = cs.textAlign && !["start", "left"].includes(cs.textAlign) ? `;text-align:${cs.textAlign}` : "";
    const cut = visibleText(el, rect);
    const body = cut != null ? esc(cut) : text != null ? esc(text) : richText(el, base);
    const ownStyle = own.join(";");
    currentScale = prevScale;
    return {
      rect,
      // A function, not an arrow: a caller may move the item (this.rect) after it is made.
      html(pos) {
        const w = this.rect.w;
        return `<div layer-name="${attr((text ?? el.textContent).trim().slice(0, 40) || nameOf(el))}" style="${pos};width:${r1(w + (singleLine ? (align ? 0 : Math.ceil(w * 0.04) + 1) : 1))}px;${ownStyle};white-space:${ws}${align}">${body}</div>`;
      },
    };
  };

  const build = (el, clip, depth) => {
    if (el.nodeType !== 1 || SKIP_TAGS.has(el.tagName) || skipped(el)) return [];
    const cs = getComputedStyle(el);
    if (!visibleStyle(cs) && cs.display === "none") return [];
    if (cs.visibility === "hidden" || parseFloat(cs.opacity) <= 0.01) return [];
    const rect = R(el.getBoundingClientRect());
    if ((rect.w <= 1 && rect.h <= 1 && cs.overflow !== "visible") || cs.clip === "rect(0px, 0px, 0px, 0px)" || /inset\(50%\)/.test(cs.clipPath)) return [];
    const absolute = cs.position === "absolute" || cs.position === "fixed";
    const mark = (items) => { if (absolute) items.forEach((it) => (it.abs = true)); return items; };
    if (tag0(el) === "dialog" && el.open && el.matches(":modal")) {
      // A modal's ::backdrop (the scrim) is drawn under it, over the whole window.
      const back = color(getComputedStyle(el, "::backdrop").backgroundColor, "bg");
      const items = mark(buildInner(el, cs, rect, clip, depth));
      if (!back) return items;
      return [{ rect: { x: 0, y: 0, w: innerWidth, h: innerHeight }, abs: true, html: (pos) => `<div layer-name="scrim" style="${pos};width:${innerWidth}px;height:${innerHeight}px;background-color:${back}"></div>` }, ...items];
    }
    return mark(buildInner(el, cs, rect, clip, depth));
  };
  const pseudoBoxes = (el, cs, rect) => {
    const out = [];
    for (const which of ["::before", "::after"]) {
      const ps = getComputedStyle(el, which);
      if (!ps.content || ps.content === "none" || ps.display === "none") continue;
      const maskUrl = /^url\("data:image\/svg\+xml,?([^"]*)"\)/.exec(ps.maskImage || ps.webkitMaskImage || "");
      if (maskUrl) {
        let svg = decodeURIComponent(maskUrl[1]);
        const w = px(ps.width) || 14, h = px(ps.height) || 14;
        const ink = color(ps.backgroundColor, "text") ?? "#000000";
        let x, y;
        if (ps.position === "absolute") { x = rect.x + px(cs.borderLeftWidth) + (ps.left !== "auto" ? px(ps.left) : 0); y = rect.y + px(cs.borderTopWidth) + (ps.top !== "auto" ? px(ps.top) : 0); }
        else {
          x = which === "::before" ? rect.x + px(cs.borderLeftWidth) + px(cs.paddingLeft) : rect.x + rect.w - px(cs.paddingRight) - w;
          y = cs.display.includes("flex") && cs.alignItems === "center" ? rect.y + (rect.h - h) / 2 : rect.y + px(cs.paddingTop);
        }
        svg = svg.replace(/(fill|stroke)=(["'])(black|#000|#000000|currentColor|currentcolor)\2/g, `$1="${ink}"`);
        if (!/fill=/.test(svg.split(">")[0] + svg) ) svg = svg.replace("<svg", `<svg fill="${ink}"`);
        const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
        svg = splitFillOpacity(doc.documentElement).outerHTML;
        svg = svg.replace(/<svg([^>]*)>/, (all, attrs) => `<svg${attrs.replace(/\s(width|height)="[^"]*"/g, "")} width="${w}" height="${h}" style="width:${w}px;height:${h}px" layer-name="icon">`);
        out.push({ rect: { x, y, w, h }, abs: true, html: (pos) => svg.replace('style="', `style="${pos};`) });
        continue;
      }
      if (ps.maskImage && ps.maskImage !== "none") continue;
      if (ps.position !== "absolute") continue;
      const bg = color(ps.backgroundColor, "bg");
      const hasBorder = px(ps.borderTopWidth) + px(ps.borderLeftWidth) + px(ps.borderBottomWidth) + px(ps.borderRightWidth) > 0;
      if (!bg && !hasBorder && !(ps.backgroundImage && ps.backgroundImage !== "none" && !ps.backgroundImage.includes("url("))) continue;
      const pad = { x: rect.x + px(cs.borderLeftWidth), y: rect.y + px(cs.borderTopWidth), w: rect.w - px(cs.borderLeftWidth) - px(cs.borderRightWidth), h: rect.h - px(cs.borderTopWidth) - px(cs.borderBottomWidth) };
      const w = ps.width.endsWith("px") ? px(ps.width) : pad.w - (ps.left !== "auto" ? px(ps.left) : 0) - (ps.right !== "auto" ? px(ps.right) : 0);
      const h = ps.height.endsWith("px") ? px(ps.height) : pad.h - (ps.top !== "auto" ? px(ps.top) : 0) - (ps.bottom !== "auto" ? px(ps.bottom) : 0);
      const x = pad.x + (ps.left !== "auto" ? px(ps.left) : ps.right !== "auto" ? pad.w - px(ps.right) - w : 0);
      const y = pad.y + (ps.top !== "auto" ? px(ps.top) : ps.bottom !== "auto" ? pad.h - px(ps.bottom) - h : 0);
      if (w <= 0 || h <= 0) continue;
      const style = boxStyle(el, ps, { w, h });
      out.push({ rect: { x, y, w, h }, abs: true, html: (pos) => `<div layer-name="${which.slice(2)}" style="${pos};width:${r1(w)}px;height:${r1(h)}px;${style.join(";")}"></div>` });
    }
    return out;
  };
  const tag0 = (el) => el.tagName.toLowerCase();
  const buildInner = (el, cs, rect, clip, depth) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "svg") {
      if (!(rect.w > 0 && intersects(rect, clip))) return [];
      return [{ rect, html: (pos) => {
        const leaf = svgLeaf(el, rect);
        if (!leaf.includes('data-svgwrap="1"')) return leaf.replace("<svg", `<svg data-pos="${attr(pos)}"`);
        return leaf.replace('data-svgwrap="1" style="', `style="${pos};`).replace('<svg data-inner="1"', '<svg data-pos="position:absolute;left:0px;top:0px"');
      } }];
    }
    if (tag === "img" || tag === "canvas" || tag === "video") {
      if (!(rect.w > 0 && rect.h > 0 && intersects(rect, clip))) return [];
      const leaf = imageLeaf(el, rect, cs);
      return leaf ? [{ rect, html: (pos) => leaf.replace("<img", `<img data-pos="${attr(pos)}"`) }] : [];
    }
    for (const [sel, key] of Object.entries(opts.inject ?? {})) {
      if (el.matches?.(sel)) {
        injected.push({ key, x: rect.x, y: rect.y, w: rect.w, h: rect.h });
        return [{ rect, html: (pos) => `<div layer-name="${attr(key)}" style="${pos};width:${r1(rect.w)}px;height:${r1(rect.h)}px;flex-shrink:0;display:flex;overflow:hidden;${boxStyle(el, cs).join(";")}">__INJECT_${key}__</div>` }];
      }
    }
    if (tag === "iframe") {
      if (!(rect.w > 0 && rect.h > 0)) return [];
      const k = frames.length;
      frames.push({ k, x: rect.x, y: rect.y, w: rect.w, h: rect.h, title: el.title || el.name || "" });
      return [{ rect, html: (pos) => `<div layer-name="${attr(el.title || "frame")}" style="${pos};width:${r1(rect.w)}px;height:${r1(rect.h)}px;flex-shrink:0;display:flex;overflow:hidden;__FRAMEBG_${k}__">__FRAME_${k}__</div>` }];
    }
    if (cs.display === "contents" || (rect.w === 0 && rect.h === 0)) return childrenOf(el, clip, depth);
    if (!intersects(rect, clip) && !(cs.overflow === "visible" && rect.w * rect.h === 0)) return [];
    const elMask = cs.maskImage && cs.maskImage !== "none" ? cs.maskImage : (cs.webkitMaskImage && cs.webkitMaskImage !== "none" ? cs.webkitMaskImage : null);
    if (elMask && /^url\(/.test(elMask)) {
      let svgText = null;
      const url = /^url\("?([^")]*)"?\)/.exec(elMask)[1];
      if (url.startsWith("data:image/svg+xml")) svgText = decodeURIComponent(url.replace(/^data:image\/svg\+xml(;utf8|;charset=utf-8)?,/, ""));
      else { try { const x = new XMLHttpRequest(); x.open("GET", url, false); x.send(); if (x.status < 400) svgText = x.responseText; } catch { svgText = null; } }
      if (!svgText || !/<svg/.test(svgText)) return [];
      const ink = color(cs.backgroundColor, "text") ?? "#000000";
      const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
      const root = doc.documentElement;
      for (const n of [root, ...root.querySelectorAll("*")]) for (const prop of ["fill", "stroke"]) {
        const a = n.getAttribute(prop); if (a && a !== "none") n.setAttribute(prop, ink);
      }
      if (!root.getAttribute("fill")) root.setAttribute("fill", ink);
      splitFillOpacity(root);
      root.removeAttribute("width"); root.removeAttribute("height"); root.removeAttribute("style"); root.removeAttribute("class");
      stats.svgs++;
      const markup = root.outerHTML.replace(/<svg/, `<svg width="${r1(rect.w)}" height="${r1(rect.h)}" layer-name="${attr(nameOf(el))}"`);
      return [{ rect, html: (pos) => markup.replace(/<svg/, `<svg style="${pos};width:${r1(rect.w)}px;height:${r1(rect.h)}px;flex-shrink:0"`) }];
    }
    const box = hasBoxStyle(cs);
    if (tag === "input" && el.type === "range") {
      // A slider: track, the filled run to the value, and the thumb, in the system's colours.
      const min = parseFloat(el.min || "0"), max = parseFloat(el.max || "100");
      const at = Math.max(0, Math.min(1, (parseFloat(el.value) - min) / ((max - min) || 1)));
      const thumb = 16, track = 4, ty = (rect.h - track) / 2, run = thumb / 2 + at * (rect.w - thumb);
      const ink = color(getComputedStyle(el).accentColor, "text") ?? "var(--color-accent)";
      return [{ rect, html: (pos) => `<div layer-name="slider" style="${pos};width:${r1(rect.w)}px;height:${r1(rect.h)}px;flex-shrink:0;display:flex">`
        + `<div layer-name="track" style="position:absolute;left:0px;top:${r1(ty)}px;width:${r1(rect.w)}px;height:${track}px;border-radius:999px;background-color:${color("rgba(28,28,31,0.14)", "line") ?? "var(--color-line-strong)"}"></div>`
        + `<div layer-name="value" style="position:absolute;left:0px;top:${r1(ty)}px;width:${r1(run)}px;height:${track}px;border-radius:999px;background-color:${ink === "auto" ? "var(--color-accent)" : ink}"></div>`
        + `<div layer-name="thumb" style="position:absolute;left:${r1(run - thumb / 2)}px;top:${r1((rect.h - thumb) / 2)}px;width:${thumb}px;height:${thumb}px;border-radius:999px;background-color:var(--color-raised);box-shadow:0 1px 3px rgba(0,0,0,0.25)"></div></div>` }];
    }
    if (tag === "input" && (el.type === "checkbox" || el.type === "radio")) return box ? [container(el, cs, rect, [], true)] : [];
    if ((tag === "input" || tag === "textarea") && (el.value || el.placeholder)) {
      // Form fields: draw the box, then their value or placeholder as text.
      const inner = { x: rect.x + px(cs.borderLeftWidth) + px(cs.paddingLeft), y: rect.y, w: rect.w - px(cs.paddingLeft) - px(cs.paddingRight), h: rect.h };
      const ph = !el.value;
      if (tag === "textarea") {
        const tcs0 = ph ? getComputedStyle(el, "::placeholder") : cs;
        const top = rect.y + px(cs.borderTopWidth) + px(cs.paddingTop);
        const t = textItem(el, tcs0, { x: inner.x, y: top, w: inner.w, h: rect.h - px(cs.paddingTop) - px(cs.paddingBottom) - 2 }, el.value || el.placeholder);
        return [container(el, cs, rect, [t], box)];
      }
      const tcs = ph ? getComputedStyle(el, "::placeholder") : cs;
      const t = textItem(el, tcs, { x: inner.x, y: rect.y + (rect.h - px(tcs.lineHeight === "normal" ? cs.fontSize : tcs.lineHeight)) / 2, w: inner.w, h: px(tcs.lineHeight === "normal" ? cs.fontSize : tcs.lineHeight) }, el.value || el.placeholder);
      return [container(el, cs, rect, [t], box)];
    }
    if (el.hasAttribute("data-truncate-group-container")) {
      const text = [...el.querySelectorAll('[data-truncate-content="visible"]')].map((n) => n.textContent).join("");
      const first = el.querySelector('[data-truncate-content="visible"]');
      return [textItem(el, getComputedStyle(first ?? el), rect, text)];
    }
    if (isTextLeaf(el)) {
      if (!box && (rgbaOf(cs.color)?.[3] ?? 0) === 0 && !clipsText(cs)) return [];
      const t = textItem(el, cs, rect);
      const pseudo = pseudoBoxes(el, cs, rect);
      if (!box && !pseudo.length && px(cs.paddingLeft) + px(cs.paddingTop) === 0) return [t];
      // A text leaf with its own box: a box holding the text at its content position.
      const q = scaleOf(el), P = (v) => px(v) * q;
      const inner = { x: rect.x + P(cs.borderLeftWidth) + P(cs.paddingLeft), y: rect.y + P(cs.borderTopWidth) + P(cs.paddingTop), w: rect.w - P(cs.paddingLeft) - P(cs.paddingRight) - P(cs.borderLeftWidth) - P(cs.borderRightWidth), h: rect.h - P(cs.paddingTop) - P(cs.paddingBottom) - P(cs.borderTopWidth) - P(cs.borderBottomWidth) };
      // Place the text where it is drawn: a label wider than its content box overflows it
      // (centred labels spill both ways), so the content box is only the fallback.
      const range = document.createRange(); range.selectNodeContents(el);
      const drawn = range.getBoundingClientRect();
      const lines = range.getClientRects().length;
      const placed = drawn.width > 0 && lines <= 1 ? textItem(el, cs, { x: drawn.left, y: drawn.top, w: drawn.width, h: drawn.height }) : Object.assign(t, { rect: inner });
      return [container(el, cs, rect, [...pseudoBoxes(el, cs, rect), placed], true)];
    }
    const clips = cs.overflowX !== "visible" || cs.overflowY !== "visible";
    const childClip = clips ? intersectClip(clip, rect) : clip;
    const children = [...pseudoBoxes(el, cs, rect).filter((b) => b.rect.w * b.rect.h > 0), ...childrenOf(el, childClip, depth + 1)];
    if (!box && !clips && children.length === 1 && Math.abs(children[0].rect.w - rect.w) < 0.5 && Math.abs(children[0].rect.h - rect.h) < 0.5 && Math.abs(children[0].rect.x - rect.x) < 0.5 && Math.abs(children[0].rect.y - rect.y) < 0.5) return children;
    if (!box && !clips && cs.position === "static" && !el.getAttribute("aria-label") && depth > 2) {
      // A plain wrapper: let its children join the parent's layout directly.
      if (children.length <= 1) return children;
    }
    if (!children.length && !box) return [];
    return [container(el, cs, rect, children, box, clips)];
  };
  const intersectClip = (clip, r) => {
    if (!clip) return { ...r };
    const x = Math.max(clip.x, r.x), y = Math.max(clip.y, r.y);
    return { x, y, w: Math.max(0, Math.min(clip.x + clip.w, r.x + r.w) - x), h: Math.max(0, Math.min(clip.y + clip.h, r.y + r.h) - y) };
  };
  const childrenOf = (el, clip, depth) => {
    const out = [];
    for (const child of kids(el)) {
      if (child.nodeType === 3) {
        if (!child.data.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(child);
        const rect = R(range.getBoundingClientRect());
        if (rect.w === 0 || !intersects(rect, clip)) continue;
        const pcs = getComputedStyle(child.parentElement);
        if ((rgbaOf(pcs.color)?.[3] ?? 0) === 0 && !clipsText(pcs)) continue;
        if (range.getClientRects().length > 1) {
          // A wrapped run beside inline boxes: one text item per line, at its own place.
          const lines = [];
          const r1c = document.createRange();
          for (let i = 0; i < child.data.length; i++) {
            r1c.setStart(child, i); r1c.setEnd(child, i + 1);
            const cr = r1c.getClientRects()[0];
            if (!cr) { if (lines.length) lines.at(-1).text += child.data[i]; continue; }
            const last = lines.at(-1);
            if (last && Math.abs(cr.top - last.top) < cr.height / 2) { last.text += child.data[i]; last.right = Math.max(last.right, cr.right); }
            else lines.push({ top: cr.top, left: cr.left, right: cr.right, height: cr.height, text: child.data[i] });
          }
          for (const line of lines) {
            const t = line.text.trim();
            if (!t) continue;
            out.push(textItem(child.parentElement, pcs, { x: line.left, y: line.top, w: line.right - line.left, h: line.height }, t));
          }
          continue;
        }
        out.push(textItem(child.parentElement, pcs, rect, child.data.trim()));
        continue;
      }
      out.push(...build(child, clip, depth));
    }
    return out;
  };

  // Lay out children: flex when their spacing is regular, absolute otherwise.
  const container = (el, cs, rect, allChildren, box, clips = false) => {
    stats.boxes++;
    const children = allChildren.filter((c) => !c.abs);
    const outOfFlow = allChildren.filter((c) => c.abs);
    const ks = scaleOf(el), B = (v) => px(v) * ks;
    const content = {
      x: rect.x + B(cs.borderLeftWidth), y: rect.y + B(cs.borderTopWidth),
      w: rect.w - B(cs.borderLeftWidth) - B(cs.borderRightWidth), h: rect.h - B(cs.borderTopWidth) - B(cs.borderBottomWidth),
    };
    const style = boxStyle(el, cs);
    let layout = null;
    const tryAxis = (dir) => {
      if (!children.length) return null;
      const main = dir === "row" ? ["x", "w"] : ["y", "h"];
      const cross = dir === "row" ? ["y", "h"] : ["x", "w"];
      const ordered = children;
      for (let i = 1; i < ordered.length; i++) if (ordered[i].rect[main[0]] < ordered[i - 1].rect[main[0]] + ordered[i - 1].rect[main[1]] - 0.75) return null;
      const lead = ordered[0].rect[main[0]] - content[main[0]];
      if (lead < -0.5) return null;
      const gaps = ordered.slice(1).map((c, i) => c.rect[main[0]] - (ordered[i].rect[main[0]] + ordered[i].rect[main[1]]));
      const gap = gaps.length ? gaps[0] : 0;
      let between = false;
      if (gaps.some((g) => Math.abs(g - gap) > 0.75)) {
        // space-between: first at the start, last at the end.
        const tail = content[main[0]] + content[main[1]] - (ordered.at(-1).rect[main[0]] + ordered.at(-1).rect[main[1]]);
        if (ordered.length === 2 || cs.justifyContent === "space-between") between = { tail };
        else return null;
      }
      const offsets = ordered.map((c) => c.rect[cross[0]] - content[cross[0]]);
      const ends = ordered.map((c) => content[cross[0]] + content[cross[1]] - (c.rect[cross[0]] + c.rect[cross[1]]));
      let align, padCross, padCrossEnd = 0;
      if (offsets.every((o) => Math.abs(o - offsets[0]) <= 0.75) && offsets[0] >= -0.5) { align = "flex-start"; padCross = offsets[0]; }
      else if (ordered.every((c, i) => Math.abs((offsets[i] - ends[i]) - (offsets[0] - ends[0])) <= 1.2)) {
        align = "center"; const skew = offsets[0] - ends[0]; padCross = Math.max(0, skew); padCrossEnd = Math.max(0, -skew);
      } else if (ends.every((o) => Math.abs(o - ends[0]) <= 0.75) && ends[0] >= -0.5) { align = "flex-end"; padCross = 0; padCrossEnd = ends[0]; }
      else return null;
      return { dir, lead, gap: Math.max(0, gap), align, padCross, padCrossEnd, between };
    };
    if (children.length) {
      const preferRow = cs.display.includes("flex") ? !cs.flexDirection.startsWith("column") : false;
      layout = (preferRow ? tryAxis("row") ?? tryAxis("column") : tryAxis("column") ?? tryAxis("row"));
      if (layout && children.length === 1) layout.dir = preferRow ? "row" : layout.dir;
    }
    const sized = `width:${r1(rect.w)}px;height:${r1(rect.h)}px;flex-shrink:0`;
    let inner = "";
    let lay;
    if (layout) {
      stats.flex++;
      const { dir, lead, gap, align, padCross, padCrossEnd, between } = layout;
      const pads = dir === "row"
        ? { t: padCross, r: between ? between.tail : 0, b: padCrossEnd, l: lead }
        : { t: lead, r: padCrossEnd, b: between ? between.tail : 0, l: padCross };
      lay = `display:flex;flex-direction:${dir};align-items:${align};${between ? "justify-content:space-between;" : gap ? `gap:${r1(gap)}px;` : ""}padding:${r1(pads.t)}px ${r1(pads.r)}px ${r1(pads.b)}px ${r1(pads.l)}px`;
      inner = children.map((c) => c.html("position:relative")).join("");
    } else {
      stats.absolute += children.length;
      lay = "display:flex";
      inner = children.map((c) => c.html(`position:absolute;left:${r1(c.rect.x - content.x)}px;top:${r1(c.rect.y - content.y)}px`)).join("");
    }
    if (outOfFlow.length) {
      stats.absolute += outOfFlow.length;
      inner = outOfFlow.filter((c) => c.html.length !== undefined).map((c) => c.html(`position:absolute;left:${r1(c.rect.x - content.x)}px;top:${r1(c.rect.y - content.y)}px`)).join("") + inner;
    }
    // Clip only what overflows in the browser (or is rounded): Paper's text runs a little wider and would be cut.
    const overflows = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
    const rounded = px(cs.borderTopLeftRadius) > 0 || px(cs.borderBottomRightRadius) > 0;
    const clip = clips && (overflows || rounded) ? ";overflow:hidden" : "";
    return {
      rect,
      html: (pos) => `<div layer-name="${attr(nameOf(el))}" style="${pos};${sized};${lay};${style.join(";")}${clip}">${inner}</div>`,
    };
  };

  const root = document.querySelector(rootSelector ?? "body");
  const rootRect = R(root.getBoundingClientRect());
  const items = childrenOf(root, { x: 0, y: 0, w: innerWidth, h: innerHeight }, 0);
  const html = items.map((c) => c.html(`position:absolute;left:${r1(c.rect.x - rootRect.x)}px;top:${r1(c.rect.y - rootRect.y)}px`)).join("\n");
  // Move the placeholder data-pos onto the style attribute for svg and img leaves.
  const fixed = html.replace(/<(svg|img) data-pos="([^"]*)"([^>]*?) style="([^"]*)"/g, (_, tag, pos, rest, style) => `<${tag}${rest} style="${pos.replace(/&quot;/g, '"')};${style}"`);
  const bodyBg = color(getComputedStyle(document.body).backgroundColor, "bg");
  const docBg = color(getComputedStyle(document.documentElement).backgroundColor, "bg");
  const bgImage = [document.body, document.documentElement].map((n) => getComputedStyle(n).backgroundImage).find((v) => v && v !== "none" && !v.includes("url("));
  return { html: fixed, images, frames, injected, stats, background: bodyBg ?? docBg, backgroundImage: bgImage ?? null, width: innerWidth, height: innerHeight };
}
