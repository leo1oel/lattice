/**
 * The citation card's "Cited N× here": one row per occurrence of the key,
 * saying where it is (its section), why it cites the paper (the role and
 * line of its citation reason) and the page its note names, each a jump to
 * that occurrence. The open file's rows come from the editor as it is now;
 * the other files' from the saved manuscript, read once per saved revision.
 */
import type { EditorView } from "@codemirror/view";
import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import { i18n } from "../../i18n";
import { baseName } from "../../lib/base-name";
import type { SymbolOccurrence } from "../../project/references-panel";
import { sectionsOf } from "../comments/annotation-sections";
import type { EditorComment } from "../comments/editor-comment-data";
import { element } from "../dom-utils";
import type { CitationReasonsApi } from "./citation-reason-editor";
import { anchorCitationReasons, citationSites, type CitationSite } from "./citation-reasons";
import { citationRoleLabel } from "./citation-roles";
import type { LatexEditorLiveData } from "./latex-editor";

/** One occurrence of the key, as its row shows it. */
export type CitationUse = {
  path: string;
  line: number;
  /** Its offsets in the open file; absent for another file's. */
  from?: number;
  to?: number;
  section: string | null;
  page?: number;
  reason?: EditorComment;
};

/** The manuscript's citations and the files that hold them, scanned once per project and saved revision. */
let scan: {
  root: string | undefined;
  revision: unknown;
  uses: Promise<SymbolOccurrence[] | null>;
  sources: Map<string, Promise<string | null>>;
} | null = null;

function scanned(data: LatexEditorLiveData) {
  if (!scan || scan.root !== data.projectRoot || scan.revision !== data.citationUsageRevision) {
    scan = {
      root: data.projectRoot,
      revision: data.citationUsageRevision,
      uses: invoke<SymbolOccurrence[]>("list_citation_usages").catch(() => null),
      sources: new Map(),
    };
  }
  return scan;
}

function savedSource(data: LatexEditorLiveData, path: string): Promise<string | null> {
  const { sources } = scanned(data);
  let source = sources.get(path);
  if (!source) {
    source = invoke<string>("read_project_file", { path, projectRoot: data.projectRoot }).catch(() => null);
    sources.set(path, source);
  }
  return source;
}

const sameKey = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase();

/** A file's occurrences of `key`, with their sections and reasons. */
function usesIn(
  source: string,
  path: string,
  key: string,
  reasons: { list: readonly EditorComment[]; sites: ReadonlyMap<string, CitationSite> },
): CitationUse[] {
  const sections = sectionsOf(source, path);
  const byFrom = new Map<number, EditorComment>();
  for (const reason of reasons.list) {
    const site = reasons.sites.get(reason.id);
    if (site) byFrom.set(site.from, reason);
  }
  return citationSites(source).filter((site) => sameKey(site.key, key)).map((site) => ({
    path,
    line: site.line,
    from: site.from,
    to: site.to,
    section: sections.filter((item) => item.offset <= site.from).at(-1)?.label ?? null,
    ...site.page ? { page: site.page } : {},
    ...byFrom.has(site.from) ? { reason: byFrom.get(site.from) } : {},
  }));
}

/** The other files' occurrences of `key`, from the saved manuscript. */
async function savedUses(data: LatexEditorLiveData, key: string, currentPath: string): Promise<CitationUse[] | null> {
  const uses = await scanned(data).uses;
  if (!uses) return null;
  const paths = [...new Set(uses.filter((use) => sameKey(use.symbol, key) && use.path !== currentPath).map((use) => use.path))]
    .sort((a, b) => a.localeCompare(b));
  const reasons = data.citationReasons ?? [];
  const files = await Promise.all(paths.map(async (path) => {
    const source = await savedSource(data, path);
    if (source === null) {
      // Unreadable: the scan's line still places the row.
      return uses.filter((use) => use.path === path && sameKey(use.symbol, key)).map((use) => ({ path, line: use.line, section: null }));
    }
    const list = reasons.filter((reason) => reason.path === path && !reason.resolved);
    // Offsets in another file mean nothing to this editor: its rows jump by line.
    return usesIn(source, path, key, { list, sites: anchorCitationReasons(source, path, list) })
      .map(({ from: _from, to: _to, ...use }) => use);
  }));
  return files.flat();
}

/**
 * The rows section of the card for `key`: the open file's rows at once, the
 * other files' added as they are read. `hovered` is the occurrence the card
 * is for; `jump` goes to a row.
 */
export function citationUsesSection(
  view: EditorView,
  key: string,
  options: {
    data: LatexEditorLiveData;
    currentPath: string;
    reasons?: CitationReasonsApi;
    hovered: { from: number; to: number };
    jump: (use: CitationUse) => void;
    openPage?: (page: number) => void;
  },
): HTMLElement {
  const { data, currentPath, reasons } = options;
  const section = element("div", "citation-card-uses");
  const heading = element("span", "citation-card-uses-heading");
  const list = element("ul", "citation-card-uses-list");
  section.append(heading, list);
  const source = view.state.doc.toString();
  const placed = reasons?.placed(view.state);
  const here = currentPath
    ? usesIn(source, currentPath, key, { list: placed?.reasons ?? [], sites: placed?.sites ?? new Map() })
    : [];
  let shown: CitationUse[] = here;
  const render = () => {
    const times = i18n.number(shown.length);
    heading.textContent = i18n._(msg`Cited ${times}× here`);
    list.replaceChildren(...shown.map((use) => row(use, use.from === options.hovered.from && use.path === currentPath)));
    section.hidden = shown.length === 0;
  };
  const row = (use: CitationUse, current: boolean) => {
    const item = element("li", "citation-card-use");
    const button = element("button", "citation-card-use-jump");
    button.type = "button";
    if (current) button.setAttribute("aria-current", "true");
    const where = use.section ?? baseName(use.path);
    const place = use.path === currentPath ? i18n._(msg`Line ${use.line}`) : `${baseName(use.path)}:${use.line}`;
    button.title = use.section ? `${use.section} · ${place}` : place;
    const top = element("span", "citation-card-use-where");
    top.append(element("span", "citation-card-use-section", where), element("span", "citation-card-use-line", place));
    button.append(top);
    const role = use.reason?.citation?.role;
    if (role) {
      const why = element("span", "citation-card-use-why");
      const chip = element("span", "citation-card-use-role", citationRoleLabel(role));
      chip.dataset.role = role;
      why.append(chip);
      if (use.reason?.body) why.append(element("span", "citation-card-use-note", use.reason.body));
      button.append(why);
    }
    button.addEventListener("click", () => options.jump(use));
    item.append(button);
    const { openPage } = options;
    if (use.page) {
      // The page the note names; a jump into the paper when it can be opened.
      const label = i18n._(msg`p. ${use.page}`);
      const target = use.page;
      const page = openPage ? element("button", "citation-card-use-page", label) : element("span", "citation-card-use-page", label);
      if (openPage && page instanceof HTMLButtonElement) {
        page.type = "button";
        page.title = i18n._(msg`Open paper at page ${target}`);
        page.addEventListener("click", () => openPage(target));
      }
      item.append(page);
    }
    return item;
  };
  render();
  void savedUses(data, key, currentPath).then((others) => {
    if (!others?.length) return;
    shown = [...here, ...others];
    render();
  });
  return section;
}
