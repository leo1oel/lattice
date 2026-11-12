/**
 * `?versions=compare`: a paper's saved versions, for comparing two of them
 * (History → Compare…): named ones with automatic syncs between, one with a
 * long name. A compared file's older side is the open project's with three of
 * the tutorial's rewritten sentences put back, and `?export=failed` makes the
 * PDF with changes marked fail as it does without latexdiff.
 */
export const compareVersions = (params: URLSearchParams) => params.get("versions") === "compare"
  ? [
    ["Rebuttal draft", "You", "2026-08-01T09:12:00Z"],
    ["Overleaf sync", "Lattice", "2026-07-20T16:40:00Z"],
    ["Overleaf sync", "Lattice", "2026-07-20T11:05:00Z"],
    ["Camera-ready for NeurIPS 2026, after the area chair’s second round of comments", "Mina Park", "2026-06-02T18:30:00Z"],
    ["Submitted to NeurIPS", "You", "2026-05-15T21:58:00Z"],
  ].map(([message, authorName, timestamp], index) => {
    const hash = `c0ffee${index}`.padEnd(40, "0");
    return { hash, shortHash: hash.slice(0, 7), authorName, timestamp, message, files: [{ path: "main.tex", kind: "modified" }] };
  })
  : null;
const OLDER_SENTENCES: Array<[string, string]> = [
  ["a learned alignment mechanism that let a decoder retrieve different encoder states instead of compressing an entire source sentence into one fixed vector", "an alignment mechanism that let a decoder look at encoder states instead of compressing a source sentence into one vector"],
  ["Attention visualizations describe routing weights inside a model, not a causal explanation of the model's final prediction.", "Attention maps explain what the model attends to and why it made its prediction."],
  ["FlashAttention computes exact attention while tiling operations to reduce expensive transfers between levels of GPU memory", "FlashAttention is a faster approximation of attention for GPUs"],
];
export const olderText = (text: string) => OLDER_SENTENCES.reduce((older, [now, before]) => older.replace(now, before), text);
