/**
 * `?crossrefs=1` starts in a small paper for Visual mode's reference and
 * citation cards (crossrefs/): sections, an equation, a figure of two
 * minipages each with its own label, a table in an `\input` file, multi-key
 * `\cite` and `\cref`, and a key and a label nothing defines. Its `.bib` and
 * figures are the tutorial's; its `.aux` files number the labels as a build
 * would. `list_references` answers with crossrefs/index.json, which a Rust
 * test (lattice-core's project/references.rs) keeps equal to what the backend
 * reports for these files.
 */
import { filesUnder } from "../mock-backend/project";
import { tutorialFiles } from "./bench-tutorial";

export const CROSSREFS_ROOT = "/bench/Cross-references";

const crossrefsText = import.meta.glob<string>(["./crossrefs/**/*.tex", "./crossrefs/**/*.aux"], { query: "?raw", import: "default", eager: true });

/** The label index the backend reports for the project. */
export const crossrefsIndex: unknown = Object.values(import.meta.glob<unknown>("./crossrefs/index.json", { import: "default", eager: true }))[0];

/** The project's contents: crossrefs/, with the tutorial's `.bib` and figures. */
export async function crossrefsProject() {
  const files = await tutorialFiles((path) => path === "references.bib" || path.endsWith(".png"));
  for (const [path, text] of filesUnder("crossrefs", crossrefsText)) files.set(path, text);
  return { root: CROSSREFS_ROOT, id: "cross-references", name: "Cross-references", files };
}
