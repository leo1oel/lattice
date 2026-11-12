/**
 * A large project's libraries, each off unless asked for, so the budgeted
 * scenarios keep the fixture they were set on: `?paperCount=<n>` papers in
 * the library, `?bibEntries=<n>` entries in `references.bib` (the primary
 * bibliography), `?historyEntries=<n>` records in Lattice's own history and
 * `?gitVersions=<n>` versions in a git repository. Deterministic, like the
 * fixture.
 */
const SCALE_WORDS = ["Sparse", "Attention", "Retrieval", "Long-Context", "Diffusion", "Alignment", "Scaling", "Graph", "Contrastive", "Multimodal", "Efficient", "Robust", "Causal", "Federated", "Neural"];
const SCALE_NAMES = ["Chen, Wei", "Garcia, Maria", "Smith, John", "Kumar, Priya", "Müller, Anna", "Tanaka, Hiro", "Okafor, Ngozi", "Dubois, Claire", "Ivanov, Petr", "Silva, Ana"];
const scaleTitle = (index: number) => `${SCALE_WORDS[index % 15]} ${SCALE_WORDS[(index * 7 + 3) % 15]} for ${SCALE_WORDS[(index * 11 + 5) % 15]} Models: Study ${index + 1}`;
const scaleAuthors = (index: number) => [0, 1, 2].slice(0, 1 + (index % 3)).map((offset) => SCALE_NAMES[(index + offset * 3) % 10]).join(" and ");
const scaleKey = (index: number) => `${SCALE_NAMES[index % 10].split(",")[0].toLowerCase().normalize("NFD").replace(/[^a-z]/g, "")}${2000 + (index % 26)}${SCALE_WORDS[(index * 7 + 3) % 15].toLowerCase().replace(/[^a-z]/g, "")}${index}`;

const scaleBibliography = (entries: number) => Array.from({ length: entries }, (_, index) => {
  const article = index % 3 !== 2;
  return [
    `@${article ? "article" : "inproceedings"}{${scaleKey(index)},`,
    `  title = {${scaleTitle(index)}},`,
    `  author = {${scaleAuthors(index)}},`,
    `  year = {${2000 + (index % 26)}},`,
    article ? `  journal = {Journal of ${SCALE_WORDS[index % 15]} Research},` : `  booktitle = {Proceedings of the ${SCALE_WORDS[(index * 5) % 15]} Conference},`,
    `  volume = {${1 + (index % 40)}},`,
    `  pages = {${1 + index}--${12 + index}},`,
    index % 4 === 0 ? `  eprint = {${2100 + (index % 500)}.${String(10000 + index).slice(-5)}},` : `  doi = {10.5555/scale.${index}},`,
    "}",
  ].join("\n");
}).join("\n\n");

/** The scale `params` asks for, and the libraries it makes. */
export function benchScale(params: URLSearchParams) {
  const scale = Object.fromEntries((["paperCount", "bibEntries", "historyEntries", "gitVersions"] as const).map((key) => {
    const value = Number(params.get(key));
    return [key, Number.isFinite(value) && value > 0 ? Math.floor(value) : 0];
  })) as Record<"paperCount" | "bibEntries" | "historyEntries" | "gitVersions", number>;
  const SCALE_PAPERS = Array.from({ length: scale.paperCount }, (_, index) => ({
    arxivId: index % 5 === 4 ? "" : `${2100 + (index % 500)}.${String(10000 + index).slice(-5)}`,
    ...index % 5 === 4 ? { doi: `10.5555/scale.${index}`, url: `https://doi.org/10.5555/scale.${index}` } : {},
    title: scaleTitle(index), citationKey: scaleKey(index), year: String(2000 + (index % 26)), authors: scaleAuthors(index),
    hasFullText: index % 5 !== 4 && index % 3 !== 0, hasBlog: index % 7 === 0,
    ...index % 41 === 0 ? { citationHealth: { kind: "retracted", source: "retraction-watch", date: "2024-06-02", checkedAt: "2026-10-01T00:00:00Z" } } : {},
  }));

  /** The newest record an hour ago, one more every 37 minutes back. */
  const scaleTime = (index: number) => new Date(Date.UTC(2026, 9, 12, 12) - index * 37 * 60_000).toISOString();
  const SCALE_HISTORY = Array.from({ length: scale.historyEntries }, (_, index) => ({
    id: `scale-history-${index}`, label: index % 4 === 0 ? `Agent edit ${index}` : `Edit chapters/ch0${1 + (index % 8)}.tex`,
    timestamp: scaleTime(index), files: [`chapters/ch0${1 + (index % 8)}.tex`],
    actor: index % 4 === 0 ? "agent" : index % 9 === 0 ? "citation" : "user", kind: "edit", source: "editor",
  }));
  const SCALE_VERSIONS = Array.from({ length: scale.gitVersions }, (_, index) => {
    const hash = (index * 2654435761 >>> 0).toString(16).padStart(8, "0").repeat(5);
    return {
      hash, shortHash: hash.slice(0, 7), authorName: SCALE_NAMES[index % 10].split(", ").reverse().join(" "), timestamp: scaleTime(index * 2 + 1),
      message: index % 3 === 0 ? "Auto-saved" : `Revise section ${1 + (index % 30)}`,
      files: [{ path: `chapters/ch0${1 + (index % 8)}.tex`, kind: "modified" }],
    };
  });
  return {
    scale,
    papers: SCALE_PAPERS,
    history: SCALE_HISTORY,
    versions: SCALE_VERSIONS,
    /** `references.bib` with `bibEntries` entries, or null without any. */
    bibliography: scale.bibEntries ? scaleBibliography(scale.bibEntries) : null,
  };
}
