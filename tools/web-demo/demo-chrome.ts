/**
 * The demo's own words around the app: the bar above it (what is simulated,
 * Reset, the download) and, on a screen too narrow for the workspace, the
 * page that stands in for it. Plain DOM, drawn before the app loads, in the
 * page's language.
 */
import "./demo-chrome.css";

const DOWNLOAD_URL = "https://github.com/leo1oel/lattice/releases/latest";
/** The website, one level up from the demo's folder (gh-pages /demo/). */
const SITE_URL = "../";

type Words = {
  label: string; note: string; reset: string; download: string; site: string;
  narrowTitle: string; narrowBody: string;
};
const WORDS: Record<"en" | "zh-CN", Words> = {
  en: {
    label: "Lattice demo",
    note: "The real app in your browser. Build and AI answers are simulated, and your edits stay in this tab.",
    reset: "Start over",
    download: "Download for Mac",
    site: "Back to the website",
    narrowTitle: "Try Lattice on a larger screen",
    narrowBody: "The demo runs the real Lattice workspace, which needs a desktop or laptop window at least 900 pixels wide.",
  },
  "zh-CN": {
    label: "Lattice 演示",
    note: "浏览器里运行的真实应用。编译和 AI 的回答是模拟的，你的修改只留在这个标签页里。",
    reset: "重新开始",
    download: "下载 Mac 版",
    site: "返回网站",
    narrowTitle: "请在更大的屏幕上试用 Lattice",
    narrowBody: "演示运行的是真实的 Lattice 工作区，需要至少 900 像素宽的桌面或笔记本窗口。",
  },
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string }, ...children: Array<Node | string>) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/** The bar above the app. `reset` starts the demo over. */
export function showDemoBar(lang: "en" | "zh-CN", reset: () => void) {
  const words = WORDS[lang];
  const resetButton = element("button", { type: "button", className: "web-demo-bar-reset" }, words.reset);
  resetButton.addEventListener("click", reset);
  const bar = element("header", { className: "web-demo-bar" },
    element("a", { className: "web-demo-bar-label", href: SITE_URL, title: words.site }, words.label),
    element("span", { className: "web-demo-bar-note" }, words.note),
    resetButton,
    element("a", { className: "web-demo-bar-download", href: DOWNLOAD_URL, target: "_blank", rel: "noopener" }, words.download),
  );
  bar.setAttribute("lang", lang);
  document.body.prepend(bar);
}

/**
 * The page shown instead of the app on a narrow screen, in the appearance the
 * website asked for (`system` follows the browser's).
 */
export function showNarrowScreenPage(lang: "en" | "zh-CN", theme: "light" | "dark" | "system") {
  const words = WORDS[lang];
  document.getElementById("root")?.remove();
  document.body.classList.add("web-demo-narrow");
  document.body.append(element("main", { className: "web-demo-narrow-page" },
    element("h1", {}, words.narrowTitle),
    element("p", {}, words.narrowBody),
    element("p", { className: "web-demo-narrow-actions" },
      element("a", { className: "web-demo-bar-download", href: DOWNLOAD_URL }, words.download),
      element("a", { href: SITE_URL }, words.site),
    ),
  ));
  document.documentElement.lang = lang;
  if (theme !== "system") document.documentElement.dataset.webDemoTheme = theme;
}
