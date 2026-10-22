/**
 * `?tree=nested`: folders four deep, cv / sop / sop_samples / drive, holding
 * more rows than the Project panel shows, then a sibling folder, web. Scrolled,
 * the tree pins a stack of open ancestors over the rows passing beneath them,
 * and web pushes drive out of its pinned slot (layout-checks.mjs).
 */
const WORDS = ["Sparse", "Attention", "Retrieval", "Diffusion", "Alignment", "Scaling", "Graph"];
const NAMES = ["Chen", "Garcia", "Kumar", "Müller", "Okafor", "Silva", "Tanaka", "Dubois", "Ivanov"];

export function addNestedTree(params: URLSearchParams, files: Map<string, string | Uint8Array>) {
  if (params.get("tree") !== "nested") return;
  // A file beside each folder keeps Pierre from flattening the chain into one row.
  for (const file of ["cv/cv.tex", "cv/sop/sop.tex", "cv/sop/sop_samples/README.md"]) files.set(file, "");
  for (const [folder, count] of [["drive", 24], ["web", 12]] as const) {
    for (let index = 0; index < count; index += 1) {
      files.set(`cv/sop/sop_samples/${folder}/${2020 + (index % 5)}_${WORDS[index % 7]}_${NAMES[index % 9]}/sop.pdf`, "");
    }
  }
}
