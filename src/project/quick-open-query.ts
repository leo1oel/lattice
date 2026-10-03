/**
 * A query split into the file it names and the line it asks for:
 * `intro.tex:120` (or `intro.tex:120:4`, as compilers print) opens intro.tex at line 120.
 */
export function splitQuickOpenQuery(query: string): { file: string; line?: number } {
  const match = /^(.*?):(\d+)(?::\d+)?$/.exec(query);
  const line = match ? Number(match[2]) : 0;
  return match && line > 0 ? { file: match[1]!, line } : { file: query };
}
