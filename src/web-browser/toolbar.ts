/** This independent window never mounts App or receives project/agent state. */
/* eslint-disable lingui/no-unlocalized-strings -- Independent toolbar's complete English/Chinese dictionary; avoids loading the workspace bootstrap into this window. */
interface Bridge { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> }
interface Status { url: string; title: string; loading: boolean }
const WORDS = {
  en: { back: "Back", forward: "Forward", reload: "Reload", address: "Web address", go: "Go", external: "Open in default browser", close: "Close browser", loading: "Loading…", error: "The browser action failed. Check the address or open this page in your default browser." },
  "zh-CN": { back: "后退", forward: "前进", reload: "重新加载", address: "网页地址", go: "前往", external: "在默认浏览器中打开", close: "关闭浏览器", loading: "正在加载…", error: "浏览器操作失败。请检查地址，或在默认浏览器中打开此页面。" },
};

export function mountBrowserToolbar(root: HTMLElement, bridge: Bridge, locale: string): () => void {
  const words = WORDS[locale === "zh-CN" ? "zh-CN" : "en"];
  document.documentElement.lang = locale === "zh-CN" ? "zh-CN" : "en";
  const form = document.createElement("form");
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  let alive = true;
  let polling = false;
  let failed = false;
  let revision = 0;
  const error = (attempt: number) => { if (alive && attempt === revision) { failed = true; status.textContent = words.error; } };
  const action = (value: string) => {
    const attempt = ++revision;
    failed = false;
    void bridge.invoke("web_browser_action", { action: value }).catch(() => error(attempt));
  };
  const button = (label: string, text: string, run: () => void) => {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = text;
    element.title = label;
    element.setAttribute("aria-label", label);
    element.onclick = run;
    form.append(element);
  };
  button(words.back, "←", () => action("back"));
  button(words.forward, "→", () => action("forward"));
  button(words.reload, "↻", () => action("reload"));
  const address = document.createElement("input");
  address.type = "text";
  address.inputMode = "url";
  address.spellcheck = false;
  address.autocomplete = "off";
  address.setAttribute("aria-label", words.address);
  form.append(address);
  const go = document.createElement("button");
  go.type = "submit";
  go.textContent = words.go;
  form.append(go);
  button(words.external, "↗", () => action("external"));
  button(words.close, "×", () => action("close"));
  form.onsubmit = (event) => {
    event.preventDefault();
    failed = false;
    const attempt = ++revision;
    void bridge.invoke("web_browser_navigate", { url: address.value }).catch(() => error(attempt));
    address.blur();
  };
  root.replaceChildren(form, status);
  const refresh = async () => {
    if (!alive || polling) return;
    polling = true;
    const attempt = revision;
    try {
      const current = await bridge.invoke<Status>("web_browser_status");
      if (!alive || attempt !== revision) return;
      if (document.activeElement !== address) address.value = current.url;
      if (!failed) status.textContent = current.loading ? words.loading : current.title;
      document.title = current.title ? `${current.title} — Lattice` : "Lattice Browser";
    } catch { error(attempt); }
    finally { polling = false; }
  };
  void refresh();
  const timer = window.setInterval(() => void refresh(), 600);
  return () => { alive = false; window.clearInterval(timer); root.replaceChildren(); };
}
