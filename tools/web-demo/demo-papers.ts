/**
 * The demo's paper library and literature search. Only papers whose text may
 * be shared are readable: three CC BY 4.0 papers from the ACL Anthology, each
 * as its abstract and introduction (content/papers/). The rest are listed by
 * title, authors and year, which are facts, never with their abstracts.
 *
 * Add papers looks up and adds what the demo holds: the works its
 * bibliography cites and the papers its library and literature search know,
 * by arXiv ID, DOI, link or title. Anything else needs the Mac, and says so.
 */
import type { PaperSummary } from "../../src/app-types";
import { bibEntries, entryKey, rawField } from "../mock-backend/bibliography";
import type { ProjectFiles } from "../mock-backend/project";
import bert from "./content/papers/devlin2019bert.md?raw";
import jain from "./content/papers/jain2019attention.md?raw";
import clark from "./content/papers/clark2019what.md?raw";

/** The readable papers' texts, by the id the library knows them by (their arXiv id). */
const TEXTS = new Map<string, string>([
  ["1810.04805", bert],
  ["1902.10186", jain],
  ["1906.04341", clark],
]);

const BERT: PaperSummary = {
  arxivId: "1810.04805", doi: "10.18653/v1/N19-1423", url: "https://aclanthology.org/N19-1423/", citationKey: "devlin2019bert", year: "2019",
  title: "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding",
  authors: "Devlin, Jacob and Chang, Ming-Wei and Lee, Kenton and Toutanova, Kristina", hasFullText: true, hasBlog: false,
};
const JAIN: PaperSummary = {
  arxivId: "1902.10186", doi: "10.18653/v1/N19-1357", url: "https://aclanthology.org/N19-1357/", citationKey: "jain2019attention", year: "2019",
  title: "Attention is not Explanation", authors: "Jain, Sarthak and Wallace, Byron C.", hasFullText: true, hasBlog: false,
};
const CLARK: PaperSummary = {
  arxivId: "1906.04341", doi: "10.18653/v1/W19-4828", url: "https://aclanthology.org/W19-4828/", citationKey: "clark2019what", year: "2019",
  title: "What Does BERT Look at? An Analysis of BERT's Attention",
  authors: "Clark, Kevin and Khandelwal, Urvashi and Levy, Omer and Manning, Christopher D.", hasFullText: true, hasBlog: false,
};
/** Cited by the tutorial, listed without a text: opening one says the download needs the Mac. */
const CITED_ONLY: PaperSummary[] = [
  {
    arxivId: "1706.03762", citationKey: "vaswani2017attention", year: "2017", title: "Attention Is All You Need", hasFullText: false, hasBlog: false,
    authors: "Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob and Jones, Llion and Gomez, Aidan N. and Kaiser, Lukasz and Polosukhin, Illia",
  },
  {
    arxivId: "1409.0473", citationKey: "bahdanau2015neural", year: "2015", title: "Neural Machine Translation by Jointly Learning to Align and Translate",
    authors: "Bahdanau, Dzmitry and Cho, Kyunghyun and Bengio, Yoshua", hasFullText: false, hasBlog: false,
  },
];

const library: PaperSummary[] = [BERT, JAIN, ...CITED_ONLY];

/** Discover literature's hits for any query: the readable papers first, then works by title alone. */
const HITS = [
  { source: "openalex", arxivId: CLARK.arxivId, title: CLARK.title, year: 2019, authors: ["Kevin Clark", "Urvashi Khandelwal", "Omer Levy", "Christopher D. Manning"],
    doi: CLARK.doi, landingUrl: CLARK.url, abstract: abstractOf(clark) },
  { source: "openalex", arxivId: JAIN.arxivId, title: JAIN.title, year: 2019, authors: ["Sarthak Jain", "Byron C. Wallace"],
    doi: JAIN.doi, landingUrl: JAIN.url, abstract: abstractOf(jain) },
  { source: "openalex", arxivId: BERT.arxivId, title: BERT.title, year: 2019, authors: ["Jacob Devlin", "Ming-Wei Chang", "Kenton Lee", "Kristina Toutanova"],
    doi: BERT.doi, landingUrl: BERT.url, abstract: abstractOf(bert) },
  { source: "alphaxiv", arxivId: "1706.03762", title: "Attention Is All You Need", year: 2017, authors: [] },
  { source: "openalex", title: "Attention is not not Explanation", year: 2019, authors: ["Sarah Wiegreffe", "Yuval Pinter"],
    doi: "10.18653/v1/D19-1002", landingUrl: "https://aclanthology.org/D19-1002/" },
  { source: "openalex", title: "Effective Approaches to Attention-based Neural Machine Translation", year: 2015,
    authors: ["Minh-Thang Luong", "Hieu Pham", "Christopher D. Manning"], doi: "10.18653/v1/d15-1166", landingUrl: "https://doi.org/10.18653/v1/d15-1166" },
];

function abstractOf(text: string): string {
  return /## Abstract\n\n([^\n]+)/.exec(text)?.[1] ?? "";
}

const macOnly = (zh: boolean) => new Error(zh
  ? "下载论文需要 Mac 上的 Lattice。在这个演示里，可以添加来自 ACL Anthology 的论文。"
  : "Downloading papers needs Lattice on your Mac. In this demo, the papers from the ACL Anthology can be added.");
const unknownWork = (zh: boolean) => new Error(zh
  ? "添加新论文需要 Mac 上的 Lattice。这个演示只认得它的参考文献和论文库里的论文。"
  : "Adding new papers needs Lattice on your Mac. This demo knows only the papers in its bibliography and library.");
const noFullText = (zh: boolean) => (zh ? "下载全文需要 Mac 上的 Lattice。" : "Downloading the full text needs Lattice on your Mac.");

/** A work the demo can look up: its record as the resolver gives it, and its entry. */
type Work = {
  key: string; entryType: string; title: string; author: string; year: string; booktitle: string; journal: string;
  arxivId: string; doi: string; url: string; bibtex: string;
};

/** The ACL papers the library reads and the literature search finds, with their venues, as BibTeX. */
const ACL_WORKS: Array<Omit<Work, "bibtex" | "entryType" | "journal">> = [
  { key: CLARK.citationKey!, title: CLARK.title, author: CLARK.authors!, year: "2019", arxivId: CLARK.arxivId, doi: CLARK.doi!, url: CLARK.url!,
    booktitle: "Proceedings of the 2019 ACL Workshop BlackboxNLP: Analyzing and Interpreting Neural Networks for NLP" },
  { key: JAIN.citationKey!, title: JAIN.title, author: JAIN.authors!, year: "2019", arxivId: JAIN.arxivId, doi: JAIN.doi!, url: JAIN.url!,
    booktitle: "Proceedings of the 2019 Conference of the North American Chapter of the Association for Computational Linguistics" },
  { key: "wiegreffe2019attention", title: "Attention is not not Explanation", author: "Wiegreffe, Sarah and Pinter, Yuval", year: "2019", arxivId: "1908.04626",
    doi: "10.18653/v1/D19-1002", url: "https://aclanthology.org/D19-1002/",
    booktitle: "Proceedings of the 2019 Conference on Empirical Methods in Natural Language Processing" },
];

function entryOf(work: Omit<Work, "bibtex">): string {
  const fields: Array<[string, string]> = [
    ["author", work.author], ["title", work.title], ["booktitle", work.booktitle], ["journal", work.journal], ["year", work.year],
    ["doi", work.doi], ["url", work.arxivId ? "" : work.url], ["eprint", work.arxivId], ["archiveprefix", work.arxivId ? "arXiv" : ""],
  ];
  const body = fields.filter(([, value]) => value).map(([name, value]) => `  ${name.padEnd(13)} = {${value}},`).join("\n");
  return `@${work.entryType}{${work.key},\n${body}\n}`;
}

/** Every work the demo knows: its bibliography's entries as written, then the ACL papers it does not cite. */
function knownWorks(files: ProjectFiles): Work[] {
  const cited = bibEntries(files).flatMap(({ bibtex }): Work[] => {
    const key = entryKey(bibtex);
    if (!key) return [];
    const field = (name: string) => rawField(bibtex, name).replace(/\s+/g, " ").trim();
    const arxivId = field("eprint");
    return [{
      key, entryType: /^\s*@(\w+)/.exec(bibtex)?.[1]?.toLowerCase() ?? "misc", title: field("title"), author: field("author"), year: field("year"),
      booktitle: field("booktitle"), journal: field("journal"), arxivId, doi: field("doi"),
      url: arxivId ? `https://arxiv.org/abs/${arxivId}` : field("url"), bibtex: bibtex.trim(),
    }];
  });
  const uncited = ACL_WORKS.filter((work) => !cited.some((entry) => entry.key === work.key)).map((work) => {
    const full = { ...work, entryType: "inproceedings", journal: "" };
    return { ...full, bibtex: entryOf(full) };
  });
  return [...cited, ...uncited];
}

const ARXIV = /^(?:arxiv:\s*|https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf|html)\/)?(\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?$/i;
const DOI = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/\S+)$/i;
/** Titles compare by their letters and digits alone, braces and case aside. */
const titleKey = (title: string) => title.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** The work `query` names (an arXiv ID, a DOI, a link, a BibTeX entry or a title), if the demo knows it. */
function findWork(files: ProjectFiles, query: string): Work | undefined {
  const value = query.trim();
  const works = knownWorks(files);
  if (value.startsWith("@")) {
    const key = entryKey(value);
    const arxivId = rawField(value, "eprint");
    const title = titleKey(rawField(value, "title"));
    return works.find((work) => work.key === key || (arxivId && work.arxivId === arxivId) || (title && titleKey(work.title) === title));
  }
  const arxivId = ARXIV.exec(value)?.[1] ?? /^10\.48550\/arxiv\.(\d{4}\.\d{4,5})$/i.exec(DOI.exec(value)?.[1] ?? "")?.[1];
  if (arxivId) return works.find((work) => work.arxivId === arxivId);
  const doi = DOI.exec(value)?.[1].toLowerCase();
  if (doi) return works.find((work) => work.doi.toLowerCase() === doi);
  if (/^https?:\/\//i.test(value)) return works.find((work) => work.url && value.replace(/\/?$/, "/") === work.url.replace(/\/?$/, "/"));
  const words = titleKey(value);
  if (words.length < 6) return undefined;
  return works.find((work) => titleKey(work.title) === words) ?? works.find((work) => titleKey(work.title).includes(words));
}

/** `resolve_citation_query`'s record for a work (models.rs `ResolvedCitation`). */
function resolved(work: Work) {
  return {
    key: work.key, title: work.title, author: work.author, year: work.year, journal: work.journal, booktitle: work.booktitle,
    publisher: "", url: work.url, doi: work.doi, entryType: work.entryType, bibtex: work.bibtex, candidates: [],
    extraFields: work.arxivId ? { eprint: work.arxivId, archiveprefix: "arXiv" } : {},
  };
}

/** What the paper commands need from the page: the project's files and how to cite a new entry. */
export type PapersContext = {
  notFound: symbol;
  zh: boolean;
  files: ProjectFiles;
  /** Adds an entry to the project's bibliography. */
  cite: (key: string, bibtex: string) => void;
};

/** `import_reference` for a work the demo knows: cited, and in the library with its text when it has one. */
function importWork(work: Work, context: PapersContext) {
  const title = work.title.replace(/[{}]/g, "");
  const inLibrary = library.some((paper) => paper.citationKey === work.key || (work.arxivId && paper.arxivId === work.arxivId));
  if (!bibEntries(context.files).some(({ bibtex }) => entryKey(bibtex)?.toLowerCase() === work.key.toLowerCase())) context.cite(work.key, work.bibtex);
  const readable = [BERT, JAIN, CLARK].find((paper) => paper.arxivId === work.arxivId);
  if (!inLibrary) {
    library.unshift(readable ?? {
      arxivId: work.arxivId, citationKey: work.key, year: work.year, title, authors: work.author.replace(/[{}]/g, ""),
      hasFullText: false, hasBlog: false, ...work.doi ? { doi: work.doi } : {}, ...work.url ? { url: work.url } : {},
    });
  }
  return {
    arxivId: work.arxivId, title, citationKey: work.key, alreadyImported: inLibrary,
    ...readable ? { paperPath: `.research/papers/${work.arxivId}/paper.md` } : work.arxivId && !inLibrary ? { fetchError: noFullText(context.zh) } : {},
  };
}

/** The paper commands' answers, or `context.notFound` for any other; `context.zh` answers in Simplified Chinese. */
export function papersAnswer(command: string, args: Record<string, unknown> | undefined, context: PapersContext): unknown {
  const { zh } = context;
  switch (command) {
    case "list_papers":
      return library;
    case "refresh_citation_health":
      return {};
    case "search_literature":
      return { hits: (args?.page ?? 0) === 0 ? HITS : [], hasMore: false };
    case "read_paper": {
      const text = TEXTS.get(String(args?.arxivId ?? ""));
      if (!text) throw macOnly(zh);
      return text;
    }
    case "read_paper_blog_local":
      return null;
    // Adding a readable paper takes a moment, as a download does; anything else needs the Mac.
    case "fetch_paper": {
      const arxivId = String(args?.arxivId ?? "");
      const paper = [BERT, JAIN, CLARK].find((candidate) => candidate.arxivId === arxivId);
      if (!paper) return Promise.reject(macOnly(zh));
      return new Promise((resolve) => setTimeout(() => {
        if (!library.includes(paper)) library.unshift(paper);
        resolve({ arxivId, paperPath: `.research/papers/${arxivId}/paper.md`, blogPath: null });
      }, 1_200));
    }
    case "fetch_web_reference":
      return Promise.reject(macOnly(zh));
    case "cancel_paper_fetch":
      return false;
    // Add papers: a lookup, then the import, each a moment later, as the network would answer.
    case "resolve_citation_query": {
      const work = findWork(context.files, String(args?.query ?? ""));
      return later(() => {
        if (!work) throw unknownWork(zh);
        return resolved(work);
      }, 500);
    }
    case "import_reference": {
      const work = findWork(context.files, String(args?.input ?? ""));
      return later(() => {
        if (!work) throw unknownWork(zh);
        return importWork(work, context);
      }, 900);
    }
    default:
      return context.notFound;
  }
}

function later<T>(answer: () => T, ms: number): Promise<T> {
  return new Promise((resolve, reject) => setTimeout(() => {
    try {
      resolve(answer());
    } catch (error) {
      reject(error);
    }
  }, ms));
}

/** Library papers whose title holds every term, as Find in project lists them after files. */
export function paperHits(matches: (text: string) => boolean) {
  return library.filter((paper) => paper.hasFullText && matches(paper.title)).map((paper) => ({
    kind: "paper", path: `.research/papers/${paper.arxivId}/paper.md`, title: paper.title, snippet: paper.title, line: null, arxivId: paper.arxivId,
  }));
}
