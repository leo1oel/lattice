/**
 * The demo's paper library and literature search. Only papers whose text may
 * be shared are readable: three CC BY 4.0 papers from the ACL Anthology, each
 * as its abstract and introduction (content/papers/). The rest are listed by
 * title, authors and year, which are facts, never with their abstracts.
 */
import type { PaperSummary } from "../../src/app-types";
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

/** The paper commands' answers, or `notFound` for any other; `zh` answers in Simplified Chinese. */
export function papersAnswer(command: string, args: Record<string, unknown> | undefined, notFound: symbol, zh: boolean): unknown {
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
    default:
      return notFound;
  }
}

/** Library papers whose title holds every term, as Find in project lists them after files. */
export function paperHits(matches: (text: string) => boolean) {
  return library.filter((paper) => paper.hasFullText && matches(paper.title)).map((paper) => ({
    kind: "paper", path: `.research/papers/${paper.arxivId}/paper.md`, title: paper.title, snippet: paper.title, line: null, arxivId: paper.arxivId,
  }));
}
