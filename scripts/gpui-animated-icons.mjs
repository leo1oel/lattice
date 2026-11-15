#!/usr/bin/env node
/**
 * `node scripts/gpui-animated-icons.mjs`: write the GPUI app's animated
 * product icons (`gpui/crates/lattice-ui/src/animated_icon/catalog.rs`)
 * from the Tauri app's (`src/animated-icons/`); `--check` fails instead
 * when the Rust file is not what the icons make.
 *
 * The Tauri app draws each icon as an SVG whose pieces CSS keyframes move
 * (`bakai-icons.css`). The icons stay the one source: the generator renders
 * each one's React component to its SVG markup, reads the stylesheet's rules
 * and keyframes, and writes for every icon the markup with each animated
 * piece marked, and for each piece what it moves: the transform (with its
 * origin), opacity, visibility, path data or dash offset at each keyframe,
 * with the keyframe's timing function. The GPUI app replays those tracks
 * itself, frame by frame, and rasterizes the frame's SVG
 * (`lattice-ui/src/animated_icon.rs`).
 *
 * CSS semantics kept: a property interpolates between the keyframes that
 * name it, its value outside them being the piece's own (its static rule,
 * else the identity); a segment eases by the timing function of the
 * keyframe it starts at, `ease` when that names none; a transform list
 * interpolates function by function, a shorter list padded with
 * identities; `animation-fill-mode: both`. The key's toss (`api-key`) is 3D
 * (layers in depth under a perspective), which an SVG cannot say, so its
 * layers are written as data and drawn by hand. Anything else the
 * stylesheet says that this does not understand stops the script.
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = "gpui/crates/lattice-ui/src/animated_icon/catalog.rs";
const CSS = "src/animated-icons/bakai-icons.css";
const KINDS = [
  "faders", "chat", "cloud-upload", "api-key", "git-branch", "plugs",
  "logs", "robot", "sparkle", "clock-back", "receipt", "package",
];
/** The titlebar's variants: [kind, the icon drawn, converted]. */
const TITLEBAR = [["chat-outline", "chat", true], ["git-branch-titlebar", "git-branch", false], ["clock-back-titlebar", "clock-back", false]];
/** The titlebar's own strokes: `.canvas-actions .animated-product-icon--<icon drawn> …`. */
const SHELL_CSS = "src/styles/app-shell.css";
const SHELL_SCOPE = ".canvas-actions .animated-product-icon--";
const PLAYING = ".bakai-icon.is-playing:not(.is-reduced)";
/** Declarations a frame writes; anything else in a rule is markup. */
const ANIMATED = new Set(["transform", "opacity", "visibility", "d", "stroke-dashoffset"]);
/** Declarations that only place the box or are the browser's layout. */
const LAYOUT = new Set(["position", "inset", "left", "top", "display", "flex", "transform-style", "transition", "overflow", "--converted-ink", "animation"]);

function fail(message) {
  throw new Error(`gpui-animated-icons: ${message}`);
}

// ── Markup ──────────────────────────────────────────────────────────────

async function renderIcons() {
  const require = createRequire(join(ROOT, "package.json"));
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { createServer } = await import(join(ROOT, "node_modules/vite/dist/node/index.js"));
  const server = await createServer({
    root: ROOT, configFile: false, appType: "custom", logLevel: "error",
    server: { middlewareMode: true }, ssr: { external: true },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { BakaiAnimatedIcon } = await server.ssrLoadModule("/src/animated-icons/bakai-icons.tsx");
    const render = (kind, converted) => renderToStaticMarkup(
      React.createElement(BakaiAnimatedIcon, { kind, size: 16, converted }),
    );
    const icons = KINDS.map((kind) => ({ kind, markup: render(kind, false) }));
    // The titlebar's copies (`.canvas-actions` in app-shell.css): the chat
    // as an outline, and heavier strokes at 14px.
    const shell = parseCss(readFileSync(join(ROOT, SHELL_CSS), "utf8"));
    for (const [kind, from, converted] of TITLEBAR) icons.push({ kind, markup: render(from, converted), overrides: overrides(shell, from) });
    return icons;
  } finally {
    await server.close();
  }
}

/** The tags of well-formed markup, as [open|close|self, name, attrs, start, end]. */
function tags(markup) {
  const found = [];
  const pattern = /<(\/?)([a-zA-Z]+)((?:\s+[a-zA-Z:-]+="[^"]*")*)\s*(\/?)>/g;
  for (const match of markup.matchAll(pattern)) {
    const attrs = new Map([...match[3].matchAll(/([a-zA-Z:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    found.push({ close: match[1] === "/", self: match[4] === "/", name: match[2], attrs, start: match.index, end: match.index + match[0].length });
  }
  return found;
}

function writeTag(tag) {
  const attrs = [...tag.attrs].map(([name, value]) => ` ${name}="${value}"`).join("");
  return `<${tag.name}${attrs}>`;
}

/**
 * The rules app-shell.css scopes to the titlebar's copy of icon `from`:
 * attributes set on the element of a class (or on its children of a tag,
 * for `.class > tag`).
 */
function overrides(shell, from) {
  const scope = `${SHELL_SCOPE}${from} `;
  const found = [];
  for (const rule of shell.rules) {
    for (const selector of rule.selectors) {
      if (!selector.startsWith(scope)) continue;
      const match = /^\.([\w-]+)(?: > ([a-z]+))?$/.exec(selector.slice(scope.length));
      if (!match) fail(`${SHELL_CSS}: ${selector}`);
      found.push({ cls: match[1], child: match[2], attrs: Object.fromEntries(rule.decls) });
    }
  }
  if (!found.length) fail(`${SHELL_CSS}: no ${scope}rules`);
  return found;
}

// ── Stylesheet ──────────────────────────────────────────────────────────

function parseCss(text) {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const keyframes = new Map();
  const rules = [];
  let at = 0;
  while (at < css.length) {
    const open = css.indexOf("{", at);
    if (open < 0) break;
    const head = css.slice(at, open).trim();
    if (head.startsWith("@")) {
      let depth = 1;
      let index = open + 1;
      while (depth > 0) {
        if (index >= css.length) fail(`unclosed ${head}`);
        if (css[index] === "{") depth += 1;
        if (css[index] === "}") depth -= 1;
        index += 1;
      }
      if (head.startsWith("@keyframes")) {
        const name = head.slice("@keyframes".length).trim();
        keyframes.set(name, parseKeyframes(css.slice(open + 1, index - 1), name));
      }
      at = index;
    } else {
      if (/[@{};]/.test(head)) fail(`rule head ${head}`);
      const close = css.indexOf("}", open);
      rules.push({ selectors: head.split(",").map((s) => s.trim().replace(/\s+/g, " ")), decls: declarations(css.slice(open + 1, close)) });
      at = close + 1;
    }
  }
  return { keyframes, rules };
}

function declarations(body) {
  const decls = new Map();
  for (const part of body.split(/;(?![^(]*\))/)) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    decls.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s*!important$/, ""));
  }
  return decls;
}

function parseKeyframes(body, name) {
  const frames = [];
  for (const match of body.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const decls = declarations(match[2]);
    for (const offset of match[1].split(",")) {
      const text = offset.trim();
      const at = text === "from" ? 0 : text === "to" ? 1 : Number.parseFloat(text) / 100;
      if (!Number.isFinite(at)) fail(`${name}: keyframe ${text}`);
      frames.push({ at, decls });
    }
  }
  return frames.sort((a, b) => a.at - b.at);
}

// ── Values ──────────────────────────────────────────────────────────────

const number = (text, where) => {
  const value = Number.parseFloat(text);
  if (!Number.isFinite(value)) fail(`${where}: ${text}`);
  return value;
};

/** A transform list as [kind, a, b] functions: t (translate), s (scale), r (rotate, degrees). */
function transformList(text, where) {
  if (text === "none") return [];
  return [...text.matchAll(/([a-zA-Z]+)\(([^)]*)\)/g)].map(([, fn, args]) => {
    const values = args.split(/[\s,]+/).filter(Boolean).map((arg) => number(arg, where));
    switch (fn) {
      case "translate": return ["t", values[0], values[1] ?? 0];
      case "translateX": return ["t", values[0], 0];
      case "translateY": return ["t", 0, values[0]];
      case "scale": return ["s", values[0], values[1] ?? values[0]];
      case "scaleX": return ["s", values[0], 1];
      case "scaleY": return ["s", 1, values[0]];
      case "rotate": return ["r", values[0], 0];
      case "rotateX": return ["x", values[0], 0];
      default: return fail(`${where}: transform ${fn}`);
    }
  });
}

const IDENTITY = { t: [0, 0], s: [1, 1], r: [0, 0], x: [0, 0] };

/** Pad each list of a track to the same function sequence. */
function alignTransforms(lists, where) {
  const longest = lists.reduce((a, b) => (b.length > a.length ? b : a), []);
  return lists.map((list) => {
    list.forEach((fn, i) => {
      if (fn[0] !== longest[i][0]) fail(`${where}: transform lists differ in shape`);
    });
    return longest.map((fn, i) => list[i] ?? [fn[0], ...IDENTITY[fn[0]]]);
  });
}

function easing(text, where) {
  if (!text || text === "ease") return [0.25, 0.1, 0.25, 1];
  if (text === "linear") return [0, 0, 1, 1];
  if (text === "ease-in-out") return [0.42, 0, 0.58, 1];
  if (text === "ease-out") return [0, 0, 0.58, 1];
  if (text === "ease-in") return [0.42, 0, 1, 1];
  const match = /^cubic-bezier\(([^)]*)\)$/.exec(text);
  if (!match) fail(`${where}: timing ${text}`);
  return match[1].split(",").map((value) => number(value, where));
}

function seconds(text, where) {
  if (text.endsWith("ms")) return number(text, where) / 1000;
  if (text.endsWith("s")) return number(text, where);
  return fail(`${where}: time ${text}`);
}

/** `name 0.89s 0s both` */
function animationShorthand(text, where) {
  const parts = text.split(/\s+/);
  const times = parts.filter((part) => /^[\d.]+m?s$/.test(part));
  const fill = parts.find((part) => ["both", "forwards", "backwards", "none"].includes(part));
  if (fill !== "both") fail(`${where}: only fill-mode both is drawn`);
  const name = parts.find((part) => !times.includes(part) && part !== fill && !/^(ease|linear|cubic)/.test(part));
  const timing = parts.find((part) => /^(ease|linear|cubic)/.test(part));
  return { name, duration: seconds(times[0], where), delay: times[1] ? seconds(times[1], where) : 0, timing };
}

/** The numbers of a path, and the path with each replaced by `#`. */
function pathShape(d) {
  const numbers = [...d.matchAll(/-?\d*\.?\d+(?:e-?\d+)?/g)].map((m) => Number(m[0]));
  return { shape: d.replace(/-?\d*\.?\d+(?:e-?\d+)?/g, "#"), numbers };
}

/**
 * The length of a shape in user units: a circle's circumference, or a
 * path of absolute lines and circular arcs.
 */
function shapeLength(tag, where) {
  const a = (name) => number(tag.attrs.get(name) ?? fail(`${where}: length needs ${name}`), where);
  if (tag.name === "circle") return 2 * Math.PI * a("r");
  if (tag.name !== "path") fail(`${where}: length of a ${tag.name}`);
  let [x, y] = [0, 0];
  let length = 0;
  for (const [, command, args] of (tag.attrs.get("d") ?? fail(`${where}: length needs d`)).matchAll(/([A-Za-z])([^A-Za-z]*)/g)) {
    const values = args.split(/[\s,]+/).filter(Boolean).map((arg) => number(arg, where));
    let next;
    if (command === "M") next = [values[0], values[1]];
    else if (command === "L") next = [values[0], values[1]];
    else if (command === "H") next = [values[0], y];
    else if (command === "V") next = [x, values[0]];
    else if (command === "A") {
      const [rx, ry, , large, , ex, ey] = values;
      if (rx !== ry) fail(`${where}: elliptical arc`);
      const chord = Math.hypot(ex - x, ey - y);
      const sweep = 2 * Math.asin(Math.min(1, chord / (2 * rx)));
      length += rx * (large ? 2 * Math.PI - sweep : sweep);
      [x, y] = [ex, ey];
      continue;
    } else fail(`${where}: path command ${command}`);
    if (command !== "M") length += Math.hypot(next[0] - x, next[1] - y);
    [x, y] = next;
  }
  return length;
}

// ── Icons ───────────────────────────────────────────────────────────────

/** Whether a selector picks an element of class list `classes` in icon `root`. */
function selects(selector, root, classes) {
  const parts = selector.split(" ");
  const last = parts.at(-1);
  const own = last.split(".").filter(Boolean);
  if (!own.every((name) => classes.includes(name))) return false;
  const context = parts.slice(0, -1).filter((part) => part !== PLAYING);
  return context.every((part) => part.split(".").filter(Boolean).every((name) => root.includes(name)));
}

function iconParts(icon, css) {
  const all = tags(icon.markup);
  const rootSvg = all.find((tag) => tag.name === "svg");
  const rootClasses = (rootSvg.attrs.get("class") ?? "").split(" ");
  const parts = [];
  let markup = "";
  let last = 0;
  // The span wrapper is the browser's; the frame is the root svg's.
  const start = rootSvg.start;
  const end = icon.markup.lastIndexOf("</svg>") + "</svg>".length;
  const parents = [];
  for (const tag of all) {
    if (tag.start < start || tag.end > end) continue;
    if (tag.close) {
      parents.pop();
      continue;
    }
    const classes = (tag.attrs.get("class") ?? "").split(" ").filter(Boolean);
    const parent = parents.at(-1) ?? [];
    if (!tag.self) parents.push(classes);
    const overrides = (icon.overrides ?? []).filter((o) => (o.child ? o.child === tag.name && parent.includes(o.cls) : classes.includes(o.cls)));
    for (const override of overrides) for (const [name, value] of Object.entries(override.attrs)) tag.attrs.set(name, value);
    if (!classes.length) {
      if (overrides.length) {
        markup += icon.markup.slice(last, tag.start) + writeTag(tag);
        last = tag.end;
      }
      continue;
    }
    const isRoot = tag === rootSvg;
    const statics = new Map();
    const animations = [];
    let delay = null;
    for (const rule of css.rules) {
      for (const selector of rule.selectors) {
        if (selector.startsWith(".bakai-icon") && !selector.startsWith(PLAYING)) continue;
        if (isRoot) continue;
        if (!selects(selector, rootClasses, classes)) continue;
        const playing = selector.startsWith(PLAYING);
        for (const [name, value] of rule.decls) {
          if (playing && name === "animation") animations.push(animationShorthand(value, selector));
          else if (playing && name === "animation-delay") delay = seconds(value, selector);
          else if (!playing) statics.set(name, value);
        }
      }
    }
    tag.attrs.delete("class");
    const where = `${icon.kind} .${classes.join(".")}`;
    // GPUI's SVG renderer ignores `pathLength`, so dash lengths in its
    // units are written in user units.
    const unit = tag.attrs.has("pathLength") ? shapeLength(tag, where) / number(tag.attrs.get("pathLength"), where) : 1;
    tag.attrs.delete("pathLength");
    for (const [name, value] of statics) {
      if (ANIMATED.has(name) || name === "transform-box" || name === "transform-origin") continue;
      if (name === "stroke-dasharray") tag.attrs.set(name, value.split(/[\s,]+/).map((dash) => String(Number((number(dash, where) * unit).toFixed(3)))).join(" "));
      else if (!LAYOUT.has(name)) fail(`${where}: static ${name}`);
    }
    if (!animations.length && ![...statics.keys()].some((name) => ANIMATED.has(name))) {
      markup += icon.markup.slice(last, tag.start) + writeTag(tag);
      last = tag.end;
      continue;
    }
    if (delay !== null) animations.forEach((animation) => { animation.delay = delay; });
    const box = statics.get("transform-box") ?? "view-box";
    const originText = statics.get("transform-origin") ?? (box === "fill-box" ? "50% 50%" : "0 0");
    const [ox, oy] = originText.split(/\s+/);
    // A fill-box origin is a share of the piece's own box, which is known
    // here for the shapes that have one written out.
    let origin = [number(ox, where), number(oy, where)];
    if (box === "fill-box") {
      const [fx, fy] = [origin[0] / 100, origin[1] / 100];
      const a = (name) => number(tag.attrs.get(name) ?? fail(`${where}: fill-box needs ${name}`), where);
      if (tag.name === "circle") origin = [a("cx") - a("r") + 2 * a("r") * fx, a("cy") - a("r") + 2 * a("r") * fy];
      else if (tag.name === "rect") origin = [a("x") + a("width") * fx, a("y") + a("height") * fy];
      else fail(`${where}: fill-box on a ${tag.name}`);
    }
    const base = {
      transform: transformList(statics.get("transform") ?? "none", where),
      opacity: statics.has("opacity") ? number(statics.get("opacity"), where) : 1,
      visible: statics.get("visibility") !== "hidden",
      d: tag.attrs.get("d") ?? null,
      dash: statics.has("stroke-dashoffset") ? number(statics.get("stroke-dashoffset"), where) * unit : 0,
    };
    const index = parts.length;
    tag.attrs.set("data-part", String(index));
    if (base.d !== null) tag.attrs.delete("d");
    parts.push({ origin, base, animations: animations.map((animation) => tracks(animation, base, css, where, unit)) });
    markup += icon.markup.slice(last, tag.start) + writeTag(tag);
    last = tag.end;
  }
  markup += icon.markup.slice(last, end);
  markup = markup.slice(markup.indexOf("<svg"));
  // The frame is drawn at its pixel size from the 256 view box; the ink is
  // the control's, and the outline variant's ink is the same.
  markup = markup.replace(/^<svg width="\d+" height="\d+"/, "<svg").replace(/var\(--converted-ink\)/g, "currentColor");
  return { kind: icon.kind, svg: markup, parts };
}

/** One animation's tracks, a property each. */
function tracks(animation, base, css, where, unit = 1) {
  const frames = css.keyframes.get(animation.name) ?? fail(`${where}: no @keyframes ${animation.name}`);
  const props = new Set(frames.flatMap((frame) => [...frame.decls.keys()]));
  const result = [];
  for (const prop of props) {
    if (prop === "animation-timing-function") continue;
    if (!ANIMATED.has(prop)) fail(`${where}: ${animation.name} animates ${prop}`);
    const named = frames.filter((frame) => frame.decls.has(prop));
    const stops = named.map((frame) => ({
      at: frame.at,
      raw: frame.decls.get(prop),
      ease: easing(frame.decls.get("animation-timing-function") ?? animation.timing, where),
    }));
    // A property's value outside the keyframes naming it is the piece's own.
    const own = { transform: "", opacity: String(base.opacity), visibility: base.visible ? "visible" : "hidden", d: base.d ? `path("${base.d}")` : null, "stroke-dashoffset": String(base.dash) }[prop];
    if (stops[0].at > 0) stops.unshift({ at: 0, raw: own ?? stops[0].raw, ease: easing(animation.timing, where), own: true });
    if (stops.at(-1).at < 1) stops.push({ at: 1, raw: own ?? stops.at(-1).raw, ease: easing(animation.timing, where), own: true });
    let values;
    if (prop === "transform") {
      const lists = stops.map((stop) => (stop.own ? base.transform : transformList(stop.raw, where)));
      values = alignTransforms(lists, where).map((list) => ({ transform: list }));
    } else if (prop === "d") {
      const shapes = stops.map((stop) => pathShape(/^path\("(.*)"\)$/.exec(stop.raw)?.[1] ?? fail(`${where}: d ${stop.raw}`)));
      if (shapes.some((shape) => shape.shape !== shapes[0].shape)) fail(`${where}: paths differ in shape`);
      values = shapes.map((shape) => ({ path: shape }));
    } else if (prop === "visibility") {
      values = stops.map((stop) => ({ visible: stop.raw !== "hidden" }));
    } else if (prop === "stroke-dashoffset") {
      values = stops.map((stop) => ({ number: stop.own ? base.dash : number(stop.raw, where) * unit }));
    } else {
      values = stops.map((stop) => ({ number: number(stop.raw, where) }));
    }
    result.push({ prop, stops: stops.map((stop, i) => ({ at: stop.at, ease: stop.ease, value: values[i] })) });
  }
  return { duration: animation.duration, delay: animation.delay, tracks: result };
}

// ── The key's toss ──────────────────────────────────────────────────────

function keyToss(icon, css) {
  const all = tags(icon.markup);
  const layers = all.filter((tag) => tag.name === "svg" && !tag.close).map((tag) => {
    const style = tag.attrs.get("style") ?? "";
    const z = number(/translateZ\(([^)]*)px\)/.exec(style)?.[1] ?? fail("api-key: layer depth"), "api-key");
    const scale = number(/scale\(([^)]*)\)/.exec(style)?.[1] ?? fail("api-key: layer scale"), "api-key");
    const fill = tag.attrs.get("fill");
    const shade = fill === "currentColor" ? 0 : number(/#fff (\d+)%/.exec(fill)?.[1] ?? fail(`api-key: fill ${fill}`), "api-key") / 100;
    return { z, scale, shade };
  });
  const path = /<path d="([^"]*)"/.exec(icon.markup)?.[1] ?? fail("api-key: no path");
  const perspective = number(/perspective:(\d+)px/.exec(icon.markup)?.[1] ?? fail("api-key: no perspective"), "api-key");
  const size = number(/width:(\d+)px/.exec(icon.markup)?.[1], "api-key");
  const animation = (selector) => {
    const rule = css.rules.find((r) => r.selectors.includes(`${PLAYING} ${selector}`)) ?? fail(`api-key: ${selector}`);
    return tracks(animationShorthand(rule.decls.get("animation"), selector), { transform: [], opacity: 1, visible: true, d: null, dash: 0 }, css, selector);
  };
  return {
    layers, path, perspective: perspective / size,
    arc: animation(".lg-toss"), spin: animation(".lg-toss .lgk-spin"), tilt: animation(".lg-toss .lgk-tilt"),
  };
}

// ── Rust ────────────────────────────────────────────────────────────────

const f = (value) => {
  const text = Number(value.toFixed(5)).toString();
  return text.includes(".") || text.includes("e") ? text : `${text}.`;
};
const rust = (text) => JSON.stringify(text).replace(/\\u([0-9a-fA-F]{4})/g, "\\u{$1}");

function rustValue(value) {
  if ("transform" in value) {
    const fns = value.transform.map(([kind, a, b]) => ({ t: `TransformFn::Translate(${f(a)}, ${f(b)})`, s: `TransformFn::Scale(${f(a)}, ${f(b)})`, r: `TransformFn::Rotate(${f(a)})`, x: `TransformFn::RotateX(${f(a)})` })[kind]);
    return `Value::Transform(&[${fns.join(", ")}])`;
  }
  if ("path" in value) return `Value::Path(${rust(value.path.shape)}, &[${value.path.numbers.map(f).join(", ")}])`;
  if ("visible" in value) return `Value::Visible(${value.visible})`;
  return `Value::Number(${f(value.number)})`;
}

function rustAnimation(animation, pad) {
  const props = { transform: "Prop::Transform", opacity: "Prop::Opacity", visibility: "Prop::Visibility", d: "Prop::D", "stroke-dashoffset": "Prop::DashOffset" };
  const trackText = animation.tracks.map((track) => {
    const stops = track.stops.map((stop) => `${pad}            Stop { at: ${f(stop.at)}, ease: [${stop.ease.map(f).join(", ")}], value: ${rustValue(stop.value)} },`).join("\n");
    return `${pad}        Track {\n${pad}            prop: ${props[track.prop]},\n${pad}            stops: &[\n${stops.replaceAll(`${pad}            Stop`, `${pad}                Stop`)}\n${pad}            ],\n${pad}        },`;
  }).join("\n");
  return `Animation {\n${pad}    duration: ${f(animation.duration)},\n${pad}    delay: ${f(animation.delay)},\n${pad}    tracks: &[\n${trackText}\n${pad}    ],\n${pad}}`;
}

function rustIcon(icon) {
  const parts = icon.parts.map((part) => {
    const origin = `[${f(part.origin[0])}, ${f(part.origin[1])}]`;
    const base = part.base;
    const d = base.d === null ? "None" : `Some(${rust(base.d)})`;
    const animations = part.animations.map((animation) => `                ${rustAnimation(animation, "                ")},`).join("\n");
    return `            Part {\n                origin: ${origin},\n                base: Base { transform: ${rustValue({ transform: base.transform }).replace("Value::Transform(", "").replace(/\)$/, "")}, opacity: ${f(base.opacity)}, visible: ${base.visible}, d: ${d}, dash: ${f(base.dash)} },\n                animations: &[\n${animations}\n                ],\n            },`;
  }).join("\n");
  return `    IconData {\n        kind: ${rust(icon.kind)},\n        svg: ${rust(icon.svg)},\n        parts: &[\n${parts}\n        ],\n    },`;
}

function rustToss(toss) {
  const layers = toss.layers.map((layer) => `        Layer { z: ${f(layer.z)}, scale: ${f(layer.scale)}, shade: ${f(layer.shade)} },`).join("\n");
  return `pub(super) static KEY_TOSS: KeyToss = KeyToss {
    path: ${rust(toss.path)},
    perspective: ${f(toss.perspective)},
    layers: &[
${layers}
    ],
    arc: ${rustAnimation(toss.arc, "    ")},
    spin: ${rustAnimation(toss.spin, "    ")},
    tilt: ${rustAnimation(toss.tilt, "    ")},
};`;
}

async function generate() {
  const css = parseCss(readFileSync(join(ROOT, CSS), "utf8"));
  const icons = await renderIcons();
  const svgIcons = icons.filter((icon) => icon.kind !== "api-key").map((icon) => iconParts(icon, css));
  const toss = keyToss(icons.find((icon) => icon.kind === "api-key"), css);
  return `// Generated by \`node scripts/gpui-animated-icons.mjs\` from the Tauri app's
// \`src/animated-icons/\`; do not edit. Run it again after changing those
// icons (\`pnpm gate:changed\` checks it is current).

use super::{Animation, Base, IconData, KeyToss, Layer, Part, Prop, Stop, Track, TransformFn, Value};

pub(super) static ICONS: &[IconData] = &[
${svgIcons.map(rustIcon).join("\n")}
];

${rustToss(toss)}
`;
}

const output = await generate();
const target = join(ROOT, OUTPUT);
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {
    // No file yet: it is not current.
  }
  if (current !== output) {
    console.error(`${OUTPUT} is not current: run node scripts/gpui-animated-icons.mjs`);
    process.exit(1);
  }
} else {
  writeFileSync(target, output);
  console.log(`wrote ${OUTPUT}`);
}
