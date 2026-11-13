// The HTML viewer's page: the Tauri app's HtmlPreview
// (src/canvas/html-preview.tsx) as an island. The host (html_preview.rs)
// sends the document's source as the writer types; this page builds the same
// sandboxed srcdoc the Tauri app builds (project images and embedded project
// pages loaded, relative links disabled, a bridge script for scrolling and
// zoom), shows it in an opaque-origin frame, and reports the frame's scroll
// metrics so the host draws Lattice's own scrollbar and keeps the reading
// position.
//
// Differences from the iframe in the Tauri app, all at the seam:
// - project images load through the island's asset protocol (granted one by
//   one by the host) instead of being inlined as data URLs;
// - the app's shortcuts pressed in the authored page are handed to the host
//   (the frame relays them to this page, which claims only the app's own);
// - links to the web go to the system browser through the host.
(() => {
  const host = window.latticeHost;
  const frame = document.getElementById("frame");

  const OPEN_EXTERNAL = "lattice:html-preview-open-external";
  const SCROLL = "lattice:html-preview-scroll";
  const SET_SCROLL_TOP = "lattice:html-preview-set-scroll-top";
  const SET_ZOOM = "lattice:html-preview-set-zoom";
  const RELAY = "lattice:island-relay";
  const KEY = "lattice:island-key";
  const PRESS = "lattice:island-pointerdown";

  const SCROLLBAR_STYLES = `
@media (pointer: fine) {
  html, body { scrollbar-width: none; }
  html::-webkit-scrollbar, body::-webkit-scrollbar { display: none; width: 0; height: 0; }
}`;

  // src/project/document-relative-path.ts
  function documentRelativeProjectPath(path, documentPath) {
    const target = path.replace(/\\/g, "/");
    if (!target || target.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(target)) return null;
    const parts = target.startsWith("/") ? [] : documentPath.replace(/\\/g, "/").split("/").slice(0, -1).filter(Boolean);
    for (const part of target.split("/")) {
      if (!part || part === ".") continue;
      if (part !== "..") parts.push(part);
      else if (!parts.pop()) return null;
    }
    return parts.length ? parts.join("/") : null;
  }

  function htmlPreviewProjectPath(target, documentPath) {
    const rawPath = target.trim().split(/[?#]/, 1)[0];
    if (!rawPath || rawPath.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(rawPath)) return null;
    let decoded;
    try {
      decoded = decodeURIComponent(rawPath).replace(/\\/g, "/");
    } catch {
      return null;
    }
    return documentRelativeProjectPath(decoded, documentPath);
  }

  function htmlSourceFromDataUrl(dataUrl) {
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return null;
    const metadata = dataUrl.slice(0, comma).split(";");
    if (metadata.shift()?.toLocaleLowerCase() !== "data:text/html") return null;
    const payload = dataUrl.slice(comma + 1);
    try {
      if (!metadata.some((part) => part.toLocaleLowerCase() === "base64")) return decodeURIComponent(payload);
      const binary = atob(payload);
      return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
    } catch {
      return null;
    }
  }

  /** Project images, and project HTML the document embeds in iframes, that the preview must load. */
  function referencedProjectResources(source, path) {
    const parsed = new DOMParser().parseFromString(source, "text/html");
    const projectPaths = new Set();
    for (const element of parsed.querySelectorAll("img[src], iframe[src]")) {
      const projectPath = htmlPreviewProjectPath(element.getAttribute("src") ?? "", path);
      const loaded = element.localName === "img" || projectPath?.toLocaleLowerCase().endsWith(".html");
      if (projectPath && loaded) projectPaths.add(projectPath);
    }
    return projectPaths;
  }

  // The scripts the srcdoc carries. The first three are the Tauri app's; the
  // last relays the app's shortcuts and presses to this page.
  const FRAGMENT_NAVIGATION = `document.addEventListener("click",(event)=>{const link=event.target instanceof Element?event.target.closest("a[href]"):null;if(!link||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;const href=link.getAttribute("href");if(!href)return;if(/^(?:https?:|mailto:)/i.test(href)){event.preventDefault();parent.postMessage({type:${JSON.stringify(OPEN_EXTERNAL)},href},"*");return}if(href==="#"||!href.startsWith("#"))return;let id;try{id=decodeURIComponent(href.slice(1))}catch{return}const target=document.getElementById(id);if(!target)return;event.preventDefault();target.scrollIntoView()});`;
  const SCROLLBAR_BRIDGE = `(()=>{const type=${JSON.stringify(SCROLL)};const scrollType=${JSON.stringify(SET_SCROLL_TOP)};const zoomType=${JSON.stringify(SET_ZOOM)};let frame=0;const send=()=>{frame=0;const root=document.scrollingElement||document.documentElement;parent.postMessage({type,clientHeight:root.clientHeight,scrollHeight:root.scrollHeight,scrollTop:root.scrollTop},"*")};const schedule=()=>{if(!frame)frame=requestAnimationFrame(send)};window.addEventListener("scroll",schedule,{passive:true});window.addEventListener("resize",schedule,{passive:true});window.addEventListener("message",(event)=>{if(event.source!==parent||!event.data)return;const root=document.scrollingElement||document.documentElement;if(event.data.type===scrollType&&typeof event.data.scrollTop==="number")root.scrollTop=event.data.scrollTop;else if(event.data.type===zoomType&&typeof event.data.scale==="number"&&event.data.scale>0)document.documentElement.style.zoom=String(event.data.scale);else return;schedule()});new ResizeObserver(schedule).observe(document.documentElement);new ResizeObserver(schedule).observe(document.body);new MutationObserver(schedule).observe(document.documentElement,{attributes:true,childList:true,subtree:true});schedule()})();`;
  const KEY_RELAY = `(()=>{let relay=new Set();const combo=(e)=>(e.metaKey?"meta+":"")+(e.ctrlKey?"ctrl+":"")+(e.altKey?"alt+":"")+(e.shiftKey?"shift+":"")+e.code;window.addEventListener("message",(event)=>{if(event.source===parent&&event.data&&event.data.type===${JSON.stringify(RELAY)}&&Array.isArray(event.data.combos))relay=new Set(event.data.combos)});window.addEventListener("keydown",(e)=>{if(e.isComposing||!relay.has(combo(e)))return;e.preventDefault();e.stopImmediatePropagation();parent.postMessage({type:${JSON.stringify(KEY)},code:e.code,key:e.key,metaKey:e.metaKey,ctrlKey:e.ctrlKey,altKey:e.altKey,shiftKey:e.shiftKey},"*")},true);window.addEventListener("pointerdown",()=>parent.postMessage({type:${JSON.stringify(PRESS)}},"*"),true)})();`;

  /**
   * The sandboxed srcdoc for an authored HTML file: project resources loaded,
   * relative links disabled, and bridge scripts for scrolling, zoom and keys,
   * since the opaque-origin frame is otherwise unreachable from the host.
   */
  function buildPreviewDocument(source, path, resources, relativeLinkTitle) {
    const parsed = new DOMParser().parseFromString(source, "text/html");
    const resourceAt = (src) => {
      const projectPath = htmlPreviewProjectPath(src, path);
      return projectPath ? resources.get(projectPath) : undefined;
    };
    const inject = (parent, tag, name, text) => {
      const element = parsed.createElement(tag);
      element.dataset.latticePreview = name;
      element.textContent = text;
      parent.append(element);
    };
    for (const image of parsed.querySelectorAll("img[src]")) {
      const resource = resourceAt(image.getAttribute("src") ?? "");
      if (resource?.url) image.setAttribute("src", resource.url);
    }
    for (const embedded of parsed.querySelectorAll("iframe[src]")) {
      const frameSource = embedded.getAttribute("src") ?? "";
      const resource = resourceAt(frameSource);
      const embeddedHtml = htmlSourceFromDataUrl(frameSource) ?? resource?.html ?? null;
      if (embeddedHtml == null) continue;
      embedded.removeAttribute("src");
      embedded.srcdoc = embeddedHtml;
      // The outer preview is already opaque-origin sandboxed. Reassert the
      // boundary on authored child frames so they cannot opt themselves into
      // same-origin access while retaining interactive Plotly scripts.
      embedded.setAttribute("sandbox", "allow-scripts");
      embedded.setAttribute("referrerpolicy", "no-referrer");
    }
    for (const base of parsed.querySelectorAll("base")) base.remove();
    const isolatedBase = parsed.createElement("base");
    isolatedBase.href = "about:blank";
    parsed.head.prepend(isolatedBase);
    inject(parsed.head, "style", "scrollbar", SCROLLBAR_STYLES);
    for (const link of parsed.querySelectorAll("a[href]")) {
      const href = link.getAttribute("href")?.trim() ?? "";
      if (/^(?:#|\/\/|[a-z][a-z0-9+.-]*:)/i.test(href)) continue;
      link.removeAttribute("href");
      if (!link.title) link.title = relativeLinkTitle;
    }
    inject(parsed.body, "script", "fragment-navigation", FRAGMENT_NAVIGATION);
    inject(parsed.body, "script", "scrollbar-bridge", SCROLLBAR_BRIDGE);
    inject(parsed.body, "script", "key-relay", KEY_RELAY);
    return `<!doctype html>${parsed.documentElement.outerHTML}`;
  }

  const scrollRange = (metrics) => Math.max(0, metrics.scrollHeight - metrics.clientHeight);

  let source = "";
  let path = "";
  let relativeLinkTitle = "";
  let scale = 1;
  // Project path -> { url } for an image, { html } for an embedded page.
  let resources = new Map();
  const requested = new Set();
  let shown = "";
  // The srcdoc the frame is loading, until its load event. WebKit drops a
  // srcdoc set while another is still loading (the frame keeps the first and
  // fires one load), so the document with its granted images, which comes a
  // moment after the first, would never show: the next one waits for this.
  let loading = null;
  let pageLoaded = false;
  // Republishing srcdoc reloads the frame at the top; carry the reading position across.
  let restoreScrollTop = 0;
  let awaitingInitialRestore = false;

  const postToFrame = (message) => frame.contentWindow?.postMessage(message, "*");
  const setScrollTop = (scrollTop) => postToFrame({ type: SET_SCROLL_TOP, scrollTop });

  function render() {
    const html = buildPreviewDocument(source, path, resources, relativeLinkTitle);
    if (html === shown) return;
    shown = html;
    if (loading === null) show();
  }

  function show() {
    loading = shown;
    frame.srcdoc = shown;
  }

  function loadResources() {
    const wanted = [...referencedProjectResources(source, path)].filter((projectPath) => !requested.has(projectPath));
    if (!wanted.length) return;
    for (const projectPath of wanted) requested.add(projectPath);
    host.request("html:resources", { paths: wanted }).then((answer) => {
      let changed = false;
      for (const [projectPath, resource] of Object.entries(answer || {})) {
        if (!resource) continue;
        const current = resources.get(projectPath);
        if (current?.url === resource.url && current?.html === resource.html) continue;
        resources = new Map(resources).set(projectPath, resource);
        changed = true;
      }
      if (changed) render();
    }).catch(() => undefined);
  }

  host.on("html:render", (message) => {
    if (!message) return;
    const first = !path;
    if (typeof message.relativeLinkTitle === "string") relativeLinkTitle = message.relativeLinkTitle;
    if (message.path !== path) {
      path = message.path;
      resources = new Map();
      requested.clear();
    }
    if (first) {
      if (typeof message.scale === "number" && message.scale > 0) scale = message.scale;
      restoreScrollTop = typeof message.scrollTop === "number" ? message.scrollTop : 0;
      awaitingInitialRestore = restoreScrollTop > 0;
    }
    source = typeof message.source === "string" ? message.source : "";
    render();
    loadResources();
  });

  // The project's files changed: load the document's resources again.
  host.on("html:assets-changed", () => {
    requested.clear();
    resources = new Map();
    loadResources();
  });

  host.on("html:set-scroll-top", (message) => {
    if (typeof message?.scrollTop === "number") setScrollTop(message.scrollTop);
  });

  host.on("html:set-zoom", (message) => {
    if (typeof message?.scale !== "number" || message.scale <= 0) return;
    scale = message.scale;
    postToFrame({ type: SET_ZOOM, scale });
  });

  const sendRelay = (combos) => postToFrame({ type: RELAY, combos: combos ?? host.relay() });
  host.on("host:relay", sendRelay);

  frame.addEventListener("load", () => {
    const stale = loading !== null && loading !== shown;
    loading = null;
    // A newer document waited for this load: show it, and settle on its load.
    if (stale) {
      show();
      return;
    }
    postToFrame({ type: SET_ZOOM, scale });
    if (restoreScrollTop > 0) setScrollTop(restoreScrollTop);
    sendRelay();
    if (!pageLoaded && shown) {
      pageLoaded = true;
      host.post("html:loaded", null);
    }
  });

  window.addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) return;
    const data = event.data;
    if (!data || typeof data !== "object" || !("type" in data)) return;
    if (data.type === SCROLL) {
      const { clientHeight, scrollHeight, scrollTop } = data;
      if (typeof clientHeight !== "number" || typeof scrollHeight !== "number" || typeof scrollTop !== "number") return;
      // A reloaded frame reports 0 before the restore lands; keep the last
      // real position so the restore has something to aim at.
      if (scrollTop > 0 || scrollHeight <= clientHeight) awaitingInitialRestore = false;
      const settled = !awaitingInitialRestore;
      if (settled) restoreScrollTop = scrollTop;
      host.post("html:scroll", { clientHeight, scrollHeight, scrollTop, scrollRange: scrollRange(data), settled });
      return;
    }
    if (data.type === OPEN_EXTERNAL && typeof data.href === "string") {
      host.post("html:open-external", { href: data.href });
      return;
    }
    if (data.type === KEY) {
      host.forwardKey(data);
      return;
    }
    if (data.type === PRESS) host.pointerdown();
  });

  host.ready();
})();
