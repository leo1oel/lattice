/**
 * `?names=same`: a second `ch01.tex` and a second `main.tex` in folders of
 * their own, so tabs opened on both of a pair show the folders that tell them
 * apart (src/trellis/tab-names.ts).
 */
export function addSameNames(params: URLSearchParams, files: Map<string, string | Uint8Array>) {
  if (params.get("names") !== "same") return;
  files.set("appendix/ch01.tex", "\\chapter{Appendix}\nThe appendix's own first chapter.\n");
  files.set("drafts/main.tex", "\\documentclass{article}\n\\begin{document}\nAn older draft.\n\\end{document}\n");
}
