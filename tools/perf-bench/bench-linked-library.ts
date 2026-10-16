/**
 * The bench's answers for the linked library (Add papers → Linked library…),
 * so its sheet can be looked at in each of its states.
 *
 * `?linkedBib=ready` links a Zotero export whose changes since the last
 * update cover every kind: a paper added there, one whose year and pages it
 * filled in, one whose title both sides changed, and three it dropped (one
 * of them cited). `unlinked` starts with no link, and choosing a file picks the
 * same export; `missing` links a file that is no longer there; `long` gives
 * the file and the titles 60-character names, for width checks. Applying
 * writes `references.bib` through the bench's own file store, and the link
 * remembers what was taken in, so reopening finds it up to date.
 */
import { NOT_HANDLED } from "./bench-overleaf";

type Args = Record<string, unknown> | undefined;

const MODES = ["ready", "unlinked", "missing", "long"] as const;
const LONG = "a-rather-long-file-name-for-the-narrow-window-check";

const entry = (type: string, key: string, fields: Record<string, string>) => [
  `@${type}{${key},`,
  ...Object.entries(fields).map(([name, value]) => `  ${name} = {${value}},`),
  "}",
].join("\n");

function texts(mode: string) {
  const long = mode === "long" ? ` ${LONG.replaceAll("-", " ")}` : "";
  const vaswani = { title: `Attention Is All You Need${long}`, author: "Vaswani, Ashish and Shazeer, Noam", year: "2017", doi: "10.5555/3295222.3295349" };
  const kingma = { title: "Adam: A Method for Stochastic Optimization", author: "Kingma, Diederik P. and Ba, Jimmy", year: "2014", eprint: "1412.6980", archivePrefix: "arXiv" };
  const devlin = { title: "BERT: Pre-training of Deep Bidirectional Transformers", author: "Devlin, Jacob and Chang, Ming-Wei", year: "2019", booktitle: "NAACL" };
  const he = { title: "Deep Residual Learning for Image Recognition", author: "He, Kaiming and Zhang, Xiangyu", year: "2016", booktitle: "CVPR" };
  const lecun = { title: "Gradient-Based Learning Applied to Document Recognition", author: "LeCun, Yann and Bottou, Léon", year: "1998", journal: "Proceedings of the IEEE" };
  const base = [
    entry("article", "vaswani2017", vaswani), entry("misc", "kingma2014", kingma), entry("inproceedings", "devlin2019", devlin),
    entry("inproceedings", "he2016", he), entry("article", "lecun1998", lecun),
  ].join("\n\n");
  const library = [
    entry("inproceedings", "vaswani2017", { ...vaswani, year: "2017", booktitle: "Advances in Neural Information Processing Systems", pages: "5998--6008" }),
    entry("inproceedings", "kingma2014", { ...kingma, title: "Adam: a method for stochastic optimization", year: "2015", booktitle: "ICLR" }),
    entry("article", "ho2020", { title: `Denoising Diffusion Probabilistic Models${long}`, author: "Ho, Jonathan and Jain, Ajay and Abbeel, Pieter", year: "2020", journal: "NeurIPS" }),
  ].join("\n\n");
  const local = [
    entry("article", "vaswani2017", vaswani),
    entry("misc", "kingma2014", { ...kingma, title: "{Adam}: A Method for Stochastic Optimization" }),
    entry("inproceedings", "devlin2019", devlin), entry("inproceedings", "he2016", he), entry("article", "lecun1998", lecun),
  ].join("\n\n");
  return { base: `${base}\n`, library: `${library}\n`, local: `${local}\n` };
}

/** The project's `references.bib` the mode starts from, or null outside it. */
export function linkedLibraryBibliography(params: URLSearchParams): string | null {
  const mode = params.get("linkedBib");
  return mode && (MODES as readonly string[]).includes(mode) ? texts(mode).local : null;
}

let link: { source: string; target: string; updatedAt: number; baseline: string } | null | undefined;

export function linkedLibraryAnswer(command: string, args: Args, { params }: { params: URLSearchParams }): unknown {
  const mode = params.get("linkedBib");
  if (!mode || !(MODES as readonly string[]).includes(mode)) return NOT_HANDLED;
  const source = mode === "long" ? `/Users/writer/Library/CloudStorage/Dropbox/${LONG}/${LONG}.bib` : "/Users/writer/Zotero/My Library.bib";
  if (link === undefined) {
    link = mode === "unlinked" ? null : {
      source: mode === "missing" ? "/Volumes/Backup/Zotero/My Library.bib" : source,
      target: "references.bib",
      updatedAt: Date.now() - 3 * 3_600_000,
      baseline: texts(mode).base,
    };
  }
  switch (command) {
    case "read_linked_bibliography":
      return link;
    case "read_bibliography_source":
      if (String(args?.source).startsWith("/Volumes/")) throw new Error("No such file or directory (os error 2)");
      return texts(mode).library;
    case "save_linked_bibliography":
      link = { source: String(args?.source), target: String(args?.target), updatedAt: Date.now(), baseline: String(args?.baseline) };
      return link;
    case "unlink_bibliography":
      link = null;
      return null;
    case "plugin:dialog|open":
      return source;
    // devlin2019 is cited in the paper; he2016 is not.
    case "list_citation_usages":
      return [{ kind: "citation", symbol: "devlin2019", role: "reference", path: "main.tex", line: 12, snippet: "\\cite{devlin2019}" }];
    default:
      return NOT_HANDLED;
  }
}
