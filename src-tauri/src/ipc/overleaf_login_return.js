// Injected into every top-level page of the Overleaf sign-in window, which is
// a bare webview with no browser chrome. Once the user follows "Log in with
// Google" (or ORCID, IEEE, any SSO) they land on the provider's page and have
// no back button; this adds one that returns to Overleaf's login page so they
// can pick another method. `overleaf_begin_login` calls this expression with
// `{ url, label }`: the login page and the control's localized text.
//
// It runs on third-party pages, so it touches nothing of theirs: the control
// lives in a closed shadow root (the page's CSS cannot reach it, and ours
// cannot leak out) and talks to no Lattice IPC — it only navigates.
(({ url, label }) => {
  const login = new URL(url);
  const onLoginPage = () =>
    location.origin === login.origin && location.pathname.replace(/\/+$/, "") === login.pathname;

  // ⌘[ and ⌘← are the standard Back keys a browser would give.
  addEventListener("keydown", (event) => {
    if (!event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
    if (event.key !== "[" && event.key !== "ArrowLeft") return;
    const target = event.target;
    // ⌘← in a text field moves the caret to the line start.
    if (event.key === "ArrowLeft" && target instanceof Element && target.closest("input, textarea, [contenteditable]")) return;
    event.preventDefault();
    history.back();
  }, true);

  // Built through the DOM and CSSOM, never markup: Google's sign-in pages
  // enforce Trusted Types (an innerHTML string would throw) and a strict
  // style-src (a <style> element would be dropped); neither governs these.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host { all: initial; position: fixed; top: 12px; left: 12px; z-index: 2147483647; }
    button {
      display: inline-flex; align-items: center; gap: 6px; margin: 0; padding: 7px 12px 7px 9px;
      font: 500 13px/1.2 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
      color: #fff; background: rgba(28, 28, 30, 0.86); border: 0; border-radius: 999px;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18), 0 4px 14px rgba(0, 0, 0, 0.16); cursor: pointer;
      -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
    }
    button:hover { background: rgba(44, 44, 46, 0.92); }
    button:focus-visible { outline: 2px solid #0a84ff; outline-offset: 2px; }
    svg { width: 14px; height: 14px; flex: none; }
  `);
  const svg = (name, attributes) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    return node;
  };

  const mount = () => {
    if (onLoginPage() || !document.documentElement) return;
    const host = document.createElement("lattice-overleaf-login-return");
    const root = host.attachShadow({ mode: "closed" });
    root.adoptedStyleSheets = [sheet];
    const button = document.createElement("button");
    button.type = "button";
    const chevron = svg("svg", {
      viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", "stroke-width": "1.8",
      "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
    });
    chevron.append(svg("path", { d: "M10 3.5 5.5 8l4.5 4.5" }));
    button.append(chevron, label);
    button.addEventListener("click", () => location.assign(login.href));
    root.append(button);
    document.documentElement.append(host);
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
})
