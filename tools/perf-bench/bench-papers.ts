/**
 * The bench's paper library and literature search: the Papers rows `?papers=1`
 * (and `fulltext`, `library`) lists, and what Discover literature finds.
 */
/** A library Paper with both a full text and a blog, so its panel carries the Blog / Paper switch. */
export const BENCH_PAPERS = [
  {
    arxivId: "1706.03762v7", title: "Attention Is All You Need", citationKey: "vaswani2017attention", year: "2017", hasFullText: true, hasBlog: true,
    authors: "Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob and Jones, Llion and Gomez, Aidan N. and Kaiser, Lukasz and Polosukhin, Illia",
  },
];

/**
 * `?papers=library`: the rows a real library mixes — a long title, a captured
 * webpage, a citation with only a DOI, an advisory citation-health notice, and
 * a Paper with a very long DOI and corporate author (perf-bench/layout-checks.mjs),
 * a retraction whose notice links out, and an arXiv preprint not yet fetched.
 * Everything but the first paper is fictional.
 */
export const LIBRARY_PAPERS = [
  // Crossref found no notice for it, so its citation card says Verified.
  ...BENCH_PAPERS.map((paper) => ({ ...paper, citationHealth: { kind: "unknown", checkedAt: "2026-10-01T00:00:00Z" } })),
  {
    arxivId: "2409.01234", title: "Grounded Visual Reasoning in Long Contexts with Sparse Multimodal Supervision", citationKey: "example2024grounded", year: "2024",
    authors: "Example, Ada and Sample, Grace", hasFullText: true, hasBlog: false,
    citationHealth: { kind: "expressionOfConcern", source: "publisher", date: "2025-03-14", checkedAt: "2026-10-01T00:00:00Z" },
  },
  {
    arxivId: "web-0123456789abcdef", url: "https://www.example.org/research/notes-on-sparse-retrieval", title: "Notes on sparse retrieval",
    citationKey: "notes2025sparse", hasFullText: true, hasBlog: false,
  },
  {
    arxivId: "", doi: "10.5555/example.2021.42", url: "https://doi.org/10.5555/example.2021.42", title: "A citation that only names its DOI",
    citationKey: "doe2021citation", year: "2021", authors: "Doe, Jane", hasFullText: false, hasBlog: false,
  },
  {
    arxivId: "doi-10.5555-proceedings.2023.long-form", doi: "10.5555/proceedings.international-symposium-on-scholarly-communication.2023.volume-12.issue-4.part-b.supplementary-material.long-form-chapter-identifier.version-of-record",
    url: "https://publisher.example.org/content/proceedings-2023/long-form-chapter.pdf", title: "Reading the original of a paper with a very long DOI",
    citationKey: "consortium2023reading", year: "2023", authors: "{International Consortium for Long-Form Persistent Identifiers in Scholarly Communication and Research Infrastructure}", hasFullText: true, hasBlog: false,
  },
  {
    arxivId: "2311.04567", title: "Self-Correcting Language Models Through Iterative Retrieval-Augmented Verification", citationKey: "placeholder2023selfcorrecting", year: "2023",
    authors: "Placeholder, Kim and Instance, Lee and Demo, Sam", hasFullText: true, hasBlog: false,
    citationHealth: { kind: "retracted", source: "retraction-watch", date: "2024-06-02", link: "https://example.org/retraction-notice", checkedAt: "2026-10-01T00:00:00Z" },
  },
  {
    arxivId: "2502.07890", title: "Scaling Laws for Sparse Mixture-of-Experts Decoders", citationKey: "specimen2025scaling", year: "2025",
    authors: "Specimen, Ray and Mock, Ivy", hasFullText: false, hasBlog: false,
  },
];

/**
 * What Discover literature finds: alphaXiv hits (year and votes, no authors)
 * ahead of OpenAlex works (authors, citation counts, DOIs), as the backend
 * merges them, with abstracts as OpenAlex gives them. Fictional apart from
 * the first and the last (a six-figure citation count, for the row's width).
 */
export const LITERATURE_HITS = [
  { source: "alphaxiv", arxivId: "1706.03762", title: "Attention Is All You Need", year: 2017, authors: [], votes: 412,
    snippet: "We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely." },
  { source: "alphaxiv", arxivId: "2410.05258", title: "Differential Attention for Long-Context Retrieval with Sparse Multimodal Supervision", year: 2024, authors: [], votes: 87 },
  { source: "alphaxiv", arxivId: "2502.07890", title: "Scaling Laws for Sparse Mixture-of-Experts Decoders", year: 2025, authors: [], votes: 9 },
  { source: "openalex", title: "Effective Approaches to Attention-based Neural Machine Translation", year: 2015,
    authors: ["Minh-Thang Luong", "Hieu Pham", "Christopher D. Manning"], citedByCount: 9214, doi: "10.18653/v1/d15-1166", landingUrl: "https://doi.org/10.18653/v1/d15-1166",
    abstract: "An attentional mechanism has lately been used to improve neural machine translation (NMT) by selectively focusing on parts of the source sentence during translation. This paper examines two simple and effective classes of attentional mechanism: a global approach which always attends to all source words and a local one that only looks at a subset of source words at a time." },
  { source: "openalex", title: "A Survey of Attention in Long-Form Document Understanding for the Proceedings of the International Symposium on Scholarly Communication", year: 2023,
    authors: ["Ada Example", "Grace Sample", "Kim Placeholder", "Lee Instance"], citedByCount: 31, doi: "10.5555/proceedings.international-symposium-on-scholarly-communication.2023.volume-12.issue-4" },
  { source: "openalex", arxivId: "1512.03385", title: "Deep Residual Learning for Image Recognition", year: 2016,
    authors: ["Kaiming He", "Xiangyu Zhang", "Shaoqing Ren", "Jian Sun"], citedByCount: 228417, doi: "10.48550/arxiv.1512.03385", landingUrl: "https://arxiv.org/abs/1512.03385",
    abstract: "Deeper neural networks are more difficult to train. We present a residual learning framework to ease the training of networks that are substantially deeper than those used previously." },
];
