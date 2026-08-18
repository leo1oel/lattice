/** Extract `\newcommand{\foo}{body}` definitions for KaTeX `macros`. */
const COMMAND_DEF =
  /\\(?:new|renew|provide)command\*?\{(\\[A-Za-z@]+)\}(?:\s*\[[^\]]*\])?\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g;

export function katexMacrosFromSources(sources: string[]): Record<string, string> {
  const macros: Record<string, string> = {};
  for (const source of sources) {
    COMMAND_DEF.lastIndex = 0;
    for (let match = COMMAND_DEF.exec(source); match; match = COMMAND_DEF.exec(source)) {
      const name = match[1];
      const body = match[2].trim();
      if (!name || !body || macros[name]) continue;
      macros[name] = body;
    }
  }
  return macros;
}
