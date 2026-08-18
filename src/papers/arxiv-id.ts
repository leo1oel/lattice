/** Versionless arXiv id, mirroring Rust `papers::arxiv_base_id`. */
export function baseArxivId(id: string): string {
  const match = /^(.*?)v\d+$/.exec(id.trim());
  return match ? match[1] : id.trim();
}
