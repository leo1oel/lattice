import type { ProjectVenue } from "../app-types";

/**
 * The templates a new project starts from, by the names their venues go by in
 * every language. `edition` is the year the bundled style is for, and
 * `preprint` marks a template that starts in the style's non-anonymous
 * preprint mode. A thesis template has neither.
 */
export const PROJECT_VENUES: { id: ProjectVenue; label: string; edition?: string; preprint?: boolean }[] = [
  { id: "neurips", label: "NeurIPS", edition: "2026", preprint: true },
  { id: "icml", label: "ICML", edition: "2026", preprint: true },
  { id: "iclr", label: "ICLR", edition: "2026" },
  // acl.sty is not versioned by year: every *ACL venue and ARR use it.
  { id: "acl", label: "ACL / ARR", preprint: true },
  { id: "cvpr", label: "CVPR", edition: "2027" },
  { id: "aaai", label: "AAAI", edition: "2027", preprint: true },
  { id: "thuthesis", label: "ThuThesis" },
  { id: "ustcthesis", label: "ustcthesis" },
];
