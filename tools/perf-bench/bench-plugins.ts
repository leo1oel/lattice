/**
 * The bench's plugins (Settings › Plugins and the palette's plugin commands),
 * so their steps can be driven and looked at over the real frontend.
 *
 * `?plugins=installed` holds three plugins: Zotero search (on, a text input,
 * items), Bib check (on, no input, diagnostics) and Crossref lookup (off, a
 * URL install that asks for a network origin and a secret). `review` turns
 * Crossref lookup on and has its update ask for more. Without the parameter no
 * plugin is installed. A run reports a progress line, then answers after a
 * moment (`?pluginDelay=<ms>`, default 600), so the progress row shows.
 */
import { NOT_HANDLED, type Args } from "../mock-backend/tauri-internals";

type Permissions = { projectRead: string[]; networkLocal: number[]; network: string[]; secrets: string[] };

const ZOTERO_PERMISSIONS: Permissions = { projectRead: ["bibliography"], networkLocal: [23119], network: [], secrets: [] };
const CHECK_PERMISSIONS: Permissions = { projectRead: ["context", "bibliography"], networkLocal: [], network: [], secrets: [] };
const CROSSREF_PERMISSIONS: Permissions = { projectRead: ["context"], networkLocal: [], network: ["https://api.crossref.org"], secrets: ["mailto"] };

function installed(mode: string) {
  const review = mode === "review";
  return [
    {
      id: "dev.lattice.zotero-search", name: "Zotero search", version: "0.1.0", description: "Search your Zotero library and cite from it.",
      license: "MIT", repository: "https://github.com/leo1oel/lattice-plugins", runtime: "node",
      source: { kind: "folder", path: "/Users/bench/plugins/zotero-search" }, enabled: true, permissions: ZOTERO_PERMISSIONS,
      granted: ZOTERO_PERMISSIONS, needsReview: false, secrets: [], error: null,
      commands: [{ id: "search", title: "Search Zotero…", description: "Find an item and cite it.", input: { kind: "text", placeholder: "Title, author or citation key" } }],
    },
    {
      id: "dev.lattice.bib-check", name: "Bib check", version: "0.1.0", description: "Find duplicate keys and missing fields in the project's .bib files.",
      license: "MIT", repository: null, runtime: "node", source: { kind: "folder", path: "/Users/bench/plugins/bib-check" }, enabled: true,
      permissions: CHECK_PERMISSIONS, granted: CHECK_PERMISSIONS, needsReview: false, secrets: [], error: null,
      commands: [{ id: "check", title: "Check bibliography", description: "Duplicate keys, DOIs and missing fields.", input: { kind: "none" } }],
    },
    {
      id: "org.example.crossref-lookup", name: "Crossref lookup", version: review ? "0.3.0" : "0.2.1", description: "Complete entries from Crossref by DOI.",
      license: "Apache-2.0", repository: null, runtime: "node",
      source: { kind: "url", url: "https://github.com/example/crossref-lookup/releases/download/v0.2.1/crossref-lookup.zip", sha256: "9f".repeat(32) },
      enabled: review, permissions: CROSSREF_PERMISSIONS, granted: review ? { ...CROSSREF_PERMISSIONS, network: [], secrets: [] } : null,
      needsReview: review, secrets: [{ name: "mailto", saved: false }], error: null,
      commands: [{ id: "complete", title: "Complete entry", input: { kind: "none" } }],
    },
  ];
}

function result(command: string, input: string | null) {
  if (command === "search") {
    const query = input || "attention";
    return {
      kind: "items", summary: `3 items for “${query}”`, items: [
        { id: "1", title: "Attention Is All You Need", subtitle: "Vaswani, Shazeer, Parmar et al. · 2017", detail: "Advances in Neural Information Processing Systems 30",
          badges: ["In bibliography"], actions: [{ type: "insertCitation", key: "vaswani2017attention" }, { type: "copy", text: "vaswani2017attention", title: "Copy key" }] },
        { id: "2", title: "Neural Machine Translation by Jointly Learning to Align and Translate", subtitle: "Bahdanau, Cho, Bengio · 2015", detail: "ICLR 2015",
          badges: [], actions: [{ type: "addBibEntry", bibtex: "@inproceedings{bahdanau2015neural,\n  title = {Neural Machine Translation by Jointly Learning to Align and Translate},\n  author = {Bahdanau, Dzmitry and Cho, Kyunghyun and Bengio, Yoshua},\n  booktitle = {ICLR},\n  year = {2015}\n}", title: "Add and cite" },
            { type: "openUrl", url: "https://arxiv.org/abs/1409.0473" }] },
        { id: "3", title: "Effective Approaches to Attention-based Neural Machine Translation", subtitle: "Luong, Pham, Manning · 2015", badges: ["Preprint"],
          actions: [{ type: "addBibEntry", bibtex: "@article{luong2015effective,\n  title = {Effective Approaches to Attention-based Neural Machine Translation},\n  author = {Luong, Minh-Thang and Pham, Hieu and Manning, Christopher D.},\n  year = {2015}\n}" }] },
      ],
    };
  }
  if (command === "check") {
    return {
      kind: "diagnostics", summary: "3 problems in 2 files", items: [
        { id: "a", file: "references.bib", line: 12, severity: "error", code: "duplicate-key", message: "The key vaswani2017attention is defined twice (also on line 48).", fixes: [] },
        { id: "b", file: "references.bib", line: 31, severity: "warning", code: "missing-field", message: "@article is missing the journal field.",
          fixes: [{ type: "reveal", file: "references.bib", line: 31, title: "Show entry" }] },
        { id: "c", file: "chapters/related.bib", line: 4, severity: "info", code: "arxiv-published", message: "This preprint has a published version (ICLR 2015).", fixes: [] },
      ],
    };
  }
  return { kind: "message", summary: "Entry complete", markdown: "Filled **3 fields** from [Crossref](https://www.crossref.org)." };
}

export function pluginsAnswer(
  command: string,
  args: Args,
  params: URLSearchParams,
  send: (channel: unknown, message: unknown) => void,
): unknown {
  if (!command.startsWith("plugins_")) return NOT_HANDLED;
  const mode = params.get("plugins") ?? "";
  const plugins = mode ? installed(mode) : [];
  switch (command) {
    case "plugins_list": return { available: true, plugins };
    case "plugins_commands":
      return plugins.filter((plugin) => plugin.enabled && !plugin.needsReview).flatMap((plugin) => plugin.commands.map((spec) => ({
        pluginId: plugin.id, pluginName: plugin.name, commandId: spec.id, title: spec.title, description: "description" in spec ? spec.description : null, input: spec.input,
      })));
    case "plugins_run": {
      const { commandId, input, onEvent } = args as { commandId: string; input: string | null; onEvent: unknown };
      const delay = Number(params.get("pluginDelay")) || 600;
      send(onEvent, { type: "progress", message: commandId === "search" ? "Asking Zotero…" : "Reading references.bib…" });
      return new Promise((resolve) => setTimeout(() => resolve(result(commandId, input)), delay));
    }
    case "plugins_cancel": return null;
    default: return plugins[0];
  }
}
