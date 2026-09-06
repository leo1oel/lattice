/** Versionless arXiv id, mirroring Rust `papers::arxiv_base_id`. */
export function baseArxivId(id: string): string {
  const match = /^(.*?)v\d+$/.exec(id.trim());
  return match ? match[1] : id.trim();
}

/** Only explicit identifiers/official URLs, never a title containing digits. */
export function explicitArxivId(input: string): string | undefined {
  const match = /^(?:https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf|html)\/)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[a-z]{2})?\/\d{7}(?:v\d+)?)(?:\.pdf)?(?:[?#].*)?$/i.exec(input.trim());
  return match ? baseArxivId(match[1].toLowerCase()) : undefined;
}
