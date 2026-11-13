/**
 * `?visualFloats=1`: adds `floats.tex` and its `figures/` (visual-floats/), a
 * paper's floats and front matter for LaTeX Visual mode: side-by-side
 * minipages of PDF figures with their own captions, a plain figure,
 * subfigures, booktabs, multicolumn/multirow and tabularx tables, wrapped
 * tables, and a title block whose authors use the preamble's own macros.
 * The PDFs are real (pdflatex output), so the reference-image loader renders
 * them through PDF.js as the app does.
 */
const text = import.meta.glob<string>(["./visual-floats/*.tex", "./visual-floats/section/*.tex"], { query: "?raw", import: "default", eager: true });
const binary = import.meta.glob<string>("./visual-floats/figures/*", { query: "?url", import: "default", eager: true });

export async function addVisualFloats(params: URLSearchParams, files: Map<string, string | Uint8Array>) {
  if (params.get("visualFloats") !== "1") return;
  const local = (path: string) => path.slice("./visual-floats/".length);
  for (const [path, contents] of Object.entries(text)) files.set(local(path), contents);
  await Promise.all(Object.entries(binary).map(async ([path, url]) => {
    files.set(local(path), new Uint8Array(await (await fetch(url)).arrayBuffer()));
  }));
}
