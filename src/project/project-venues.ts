import type { ProjectVenue } from "../app-types";

/** The conference templates a new project starts from, by the names their venues go by in every language. */
export const PROJECT_VENUES: { id: ProjectVenue; label: string }[] = [
  { id: "neurips", label: "NeurIPS" },
  { id: "icml", label: "ICML" },
  { id: "iclr", label: "ICLR" },
];
