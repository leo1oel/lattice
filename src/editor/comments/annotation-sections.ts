/** A heading of the source, as the panel groups annotations under it. */
export type Section = { offset: number; label: string };

/**
 * The top-level headings of `source`: chapters when it has them, else
 * sections, numbered as LaTeX numbers them (a starred one has no number);
 * Markdown's top headings for Markdown.
 */
export function sectionsOf(source: string, path: string): Section[] {
  if (/\.(md|markdown)$/i.test(path)) {
    const headings = [...source.matchAll(/^(#{1,2})\s+(.+)$/gm)];
    const top = Math.min(...headings.map((match) => match[1]!.length));
    return headings.filter((match) => match[1]!.length === top).map((match) => ({ offset: match.index, label: match[2]!.trim() }));
  }
  const commands = [...source.matchAll(/\\(chapter|section)(\*?)\{([^{}]*)\}/g)];
  const level = commands.some((match) => match[1] === "chapter") ? "chapter" : "section";
  let number = 0;
  return commands.filter((match) => match[1] === level).map((match) => {
    const title = match[3]!.replace(/\s+/g, " ").trim();
    if (match[2]) return { offset: match.index, label: title };
    number += 1;
    return { offset: match.index, label: `§${number} ${title}` };
  });
}
