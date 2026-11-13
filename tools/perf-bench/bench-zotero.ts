/**
 * The bench's Zotero library (Add papers → Zotero…), so the browser, the
 * import and the annotations it writes into each paper's note can be driven
 * and looked at end to end over the real frontend.
 *
 * `?zotero=library` holds a library at a working writer's scale: folders
 * nested three deep (with an empty one), 120 papers, one of them with 64
 * annotations over 14 pages, one with none, and one already in Papers (its
 * Zotero PDF kept, as an earlier import left it) with five annotations of its
 * own. `long` gives the folders and titles names long enough to test widths
 * (one of them Chinese); `missing` finds no library, as on a computer without
 * Zotero.
 *
 * The papers' PDF is generated here, its pages holding the sentences the
 * annotations quote, so a note's page link opens the reader on the very
 * passage. Importing answers as the backend does for a Zotero item with a
 * local PDF and no arXiv id: the citation lands, `attach_zotero_pdf` makes
 * the PDF its text and keeps it (`original.pdf`), and `list_papers` lists it.
 */
import { NOT_HANDLED, type Args } from "../mock-backend/tauri-internals";

const MODES = ["library", "long", "missing"] as const;
const PAGES = 14;
const LINES = 18;

const WORDS = [
  "sparse", "attention", "keeps", "long", "documents", "within", "reach", "of", "a", "single", "model", "while",
  "retrieval", "grounds", "each", "claim", "in", "the", "cited", "passage", "and", "evaluation", "measures", "drift",
];

/** The sentence on line `line` of page `page`: what the PDF shows there and an annotation may quote. */
function sentence(page: number, line: number): string {
  const words = Array.from({ length: 11 }, (_, index) => WORDS[(page * 7 + line * 5 + index * 3) % WORDS.length]);
  return `${words.join(" ").replace(/^./, (first) => first.toUpperCase())} (${page}.${line + 1}).`;
}

/** A PDF of `PAGES` pages of text, each line one `sentence`, as PDF.js reads it. */
function papersPdf(title: string): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body);
  const escape = (text: string) => text.replace(/[\\()]/g, (character) => `\\${character}`);
  add("");
  add("");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds: number[] = [];
  for (let page = 1; page <= PAGES; page += 1) {
    const lines = [`BT /F1 14 Tf 72 730 Td (${escape(page === 1 ? title.slice(0, 70) : `Section ${page}`)}) Tj ET`, "BT /F1 10 Tf 72 700 Td 30 TL"];
    for (let line = 0; line < LINES; line += 1) lines.push(`(${escape(sentence(page, line))}) Tj T*`);
    lines.push("ET", `BT /F1 9 Tf 300 50 Td (${page}) Tj ET`);
    const stream = lines.join("\n");
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${PAGES} >>`;
  let output = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(output.length);
    output += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = output.length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(output, (character) => character.charCodeAt(0));
}

/** The full text the import makes of the PDF. */
const paperText = (title: string) => [
  `# ${title}`,
  ...Array.from({ length: PAGES }, (_, page) => Array.from({ length: LINES }, (_, line) => sentence(page + 1, line)).join(" ")),
].join("\n\n");

type Item = { key: string; citationKey: string; title: string; authors: string; year: string; doi?: string; collections: string[]; pdf: string | null; annotations: number };

const NAMES = ["Lee, Ada", "Okafor, Ngozi", "Tanaka, Hiro", "Dubois, Claire", "Kumar, Priya", "Silva, Ana", "Müller, Anna", "Chen, Wei"];
const TOPICS = ["Sparse attention", "Dense retrieval", "Long-context evaluation", "Citation grounding", "Drafting assistants", "Reading notes", "Scholarly search", "Model editing"];

function library(mode: string) {
  const long = mode === "long";
  const folder = (key: string, name: string, longName: string, parent: string | null) => ({ key, name: long ? longName : name, parent });
  const collections = [
    folder("THESIS01", "Thesis", "Thesis: reading for every chapter, kept since the first year of the programme", null),
    folder("CHAP0002", "Chapter 2 — Background", "Chapter 2 — Background on retrieval, attention and the evaluation of long documents", "THESIS01"),
    folder("SPARSE01", "Sparse attention", "稀疏注意力与长文档检索的相关文献（第二章第三节，含会议与期刊版本）", "CHAP0002"),
    folder("CHAP0003", "Chapter 3 — Method", "Chapter 3 — Method", "THESIS01"),
    folder("READING1", "Reading group", "Reading group", null),
    folder("EMPTY001", "Empty folder", "Empty folder", null),
  ];
  const items: Item[] = [
    {
      key: "ANNOT064", citationKey: "lee2024sparse", year: "2024", doi: "10.1000/sparse.2024", collections: ["SPARSE01"], pdf: "PDFKEY01", annotations: 64,
      title: long
        ? "Sparse attention for long documents: keeping every cited passage within reach of a single model, with an evaluation on theses and survey articles"
        : "Sparse attention for long documents", authors: "Lee, Ada and Okafor, Ngozi",
    },
    {
      key: "NOANNOT1", citationKey: "okafor2023dense", year: "2023", doi: "10.1000/dense.2023", collections: ["SPARSE01"], pdf: "PDFKEY02", annotations: 0,
      title: long ? "面向长篇学术写作的稠密检索：引用定位、段落对齐与评测方法的系统研究" : "Dense retrieval for drafting", authors: "Okafor, Ngozi",
    },
    {
      key: "INPAPER1", citationKey: "tanaka2022grounding", year: "2022", doi: "10.1000/grounding.2022", collections: ["SPARSE01", "READING1"], pdf: "PDFKEY03", annotations: 5,
      title: "Grounding claims in cited passages", authors: "Tanaka, Hiro and Lee, Ada",
    },
  ];
  // The rest of a working library: papers in Chapter 3, the reading group and no folder.
  for (let index = 0; index < 117; index += 1) {
    const collections = index % 3 === 0 ? ["CHAP0003"] : index % 3 === 1 ? ["READING1"] : [];
    items.push({
      key: `ITEM${String(index).padStart(4, "0")}`, citationKey: `paper${index}`, year: String(2010 + (index % 15)), collections,
      pdf: index % 2 ? `PDFI${String(index).padStart(4, "0")}` : null, annotations: index % 5 === 0 ? index % 9 : 0,
      title: `${TOPICS[index % TOPICS.length]} in practice, study ${index + 1}`, authors: NAMES[index % NAMES.length],
    });
  }
  return { collections, items };
}

const bibtex = (item: Item) => [
  `@article{${item.citationKey},`,
  `  title = {${item.title}},`,
  `  author = {${item.authors}},`,
  `  year = {${item.year}}${item.doi ? `,\n  doi = {${item.doi}}` : ""}`,
  "}",
].join("\n");

const KINDS = ["highlight", "highlight", "underline", "note", "highlight", "image"] as const;
const COMMENTS = ["", "Key claim for §2.3", "", "Compare with <b>dense</b> retrieval before citing", "<i>Check</i> the ablation on page 9", "Figure: drift over length"];

/** The `count` annotations of item `key`, in Zotero's reading order, quoting the PDF's lines. */
function annotationsOf(item: Item) {
  const out = Array.from({ length: item.annotations }, (_, index) => {
    const page = 1 + Math.floor(index * PAGES / Math.max(1, item.annotations));
    const kind = KINDS[index % KINDS.length];
    const quoted = kind === "highlight" || kind === "underline";
    return {
      key: `${item.key.slice(0, 4)}${String(index).padStart(4, "0")}`, attachment: item.pdf ?? "", kind,
      text: quoted ? sentence(page, (index * 5) % LINES) : "",
      comment: COMMENTS[index % COMMENTS.length] || (quoted ? "" : "Note"),
      page, pageLabel: item.key === "ANNOT064" ? String(410 + page) : String(page), color: "#ffd400",
    };
  });
  return out;
}

type Paper = { arxivId: string; title: string; authors: string; year: string; doi?: string; citationKey: string; hasFullText: boolean; hasBlog: boolean; hasLocalPdf?: boolean };

export function zoteroAnswer(command: string, args: Args, { params, files }: { params: URLSearchParams; files: () => Map<string, unknown> }): unknown {
  const mode = params.get("zotero");
  if (!mode || !(MODES as readonly string[]).includes(mode)) return NOT_HANDLED;
  const { collections, items } = library(mode);
  const byKey = new Map(items.map((item) => [item.key, item]));
  const state = zoteroState(items, files());
  switch (command) {
    case "zotero_library":
      if (mode === "missing") throw new Error("Lattice couldn't find a Zotero library on this computer.");
      return {
        collections,
        items: items.map(({ key, citationKey, pdf, collections: within, annotations }, index) => ({
          key, citationKey, pdf, collections: within, annotations, bibtex: bibtex(items[index]),
        })),
      };
    case "zotero_annotations":
      return Object.fromEntries((args?.items as string[] ?? []).flatMap((key) => {
        const item = byKey.get(key);
        return item?.annotations ? [[key, annotationsOf(item)]] : [];
      }));
    case "import_reference": {
      const item = items.find((candidate) => candidate.citationKey === /@\w+\{([^,]+),/.exec(String(args?.input))?.[1]);
      if (!item) return NOT_HANDLED;
      const held = state.papers.has(item.citationKey);
      if (!held) state.papers.set(item.citationKey, { arxivId: "", title: item.title, authors: item.authors, year: item.year, doi: item.doi, citationKey: item.citationKey, hasFullText: false, hasBlog: false });
      return { arxivId: "", title: item.title, citationKey: item.citationKey, alreadyImported: held, paperPath: "" };
    }
    case "attach_zotero_pdf": {
      const paper = state.papers.get(String(args?.citationKey));
      if (!paper) throw new Error("A PDF can only be attached to a cited paper.");
      keepPdf(paper, files());
      return { arxivId: paper.arxivId, paperPath: `.research/papers/${paper.arxivId}/paper.md`, reused: false };
    }
    case "list_papers":
      return [...state.papers.values()];
    case "read_paper": {
      const paper = [...state.papers.values()].find((candidate) => candidate.arxivId === args?.arxivId);
      return paper ? paperText(paper.title) : NOT_HANDLED;
    }
    case "read_paper_blog_local":
      return [...state.papers.values()].some((candidate) => candidate.arxivId === args?.arxivId) ? null : NOT_HANDLED;
    case "open_zotero_link":
      state.opened.push(String(args?.url));
      return null;
    default:
      return NOT_HANDLED;
  }
}

/** The PDF Zotero holds, made the paper's text and kept beside it, as papers/attach.rs does. */
function keepPdf(paper: Paper, files: Map<string, unknown>) {
  paper.arxivId = `web-${paper.citationKey.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
  paper.hasFullText = true;
  paper.hasLocalPdf = true;
  files.set(`.research/papers/${paper.arxivId}/paper.md`, paperText(paper.title));
  files.set(`.research/papers/${paper.arxivId}/original.pdf`, papersPdf(paper.title));
}

let shared: { papers: Map<string, Paper>; opened: string[] } | null = null;

/** The library's papers so far: the one an earlier import left in Papers, and what the writer adds. */
function zoteroState(items: Item[], files: Map<string, unknown>) {
  if (shared) return shared;
  const held = items.find((item) => item.key === "INPAPER1")!;
  const paper: Paper = { arxivId: "", title: held.title, authors: held.authors, year: held.year, doi: held.doi, citationKey: held.citationKey, hasFullText: false, hasBlog: false };
  keepPdf(paper, files);
  shared = { papers: new Map([[held.citationKey, paper]]), opened: [] };
  (window as unknown as { __latticeZotero?: unknown }).__latticeZotero = shared;
  return shared;
}
