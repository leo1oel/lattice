export type MathRegion = {
  from: number;
  to: number;
  source: string;
  display: boolean;
};

const ENVIRONMENTS = ["equation", "equation*", "align", "align*", "gather", "gather*", "multline", "multline*"];

function findDelimited(
  text: string,
  position: number,
  open: string,
  close: string,
  display: boolean,
): MathRegion | null {
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const start = text.indexOf(open, searchFrom);
    if (start < 0) return null;
    const contentStart = start + open.length;
    const end = text.indexOf(close, contentStart);
    if (end < 0) return null;
    if (position >= start && position <= end + close.length) {
      return {
        from: start,
        to: end + close.length,
        source: text.slice(contentStart, end).trim(),
        display,
      };
    }
    searchFrom = end + close.length;
  }
  return null;
}

function findEnvironment(text: string, position: number): MathRegion | null {
  for (const name of ENVIRONMENTS) {
    const open = `\\begin{${name}}`;
    const close = `\\end{${name}}`;
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const start = text.indexOf(open, searchFrom);
      if (start < 0) break;
      const contentStart = start + open.length;
      const end = text.indexOf(close, contentStart);
      if (end < 0) break;
      if (position >= start && position <= end + close.length) {
        return {
          from: start,
          to: end + close.length,
          source: text.slice(contentStart, end).trim(),
          display: true,
        };
      }
      searchFrom = end + close.length;
    }
  }
  return null;
}

export function mathRegionAt(text: string, position: number): MathRegion | null {
  const clamped = Math.max(0, Math.min(position, text.length));
  return (
    findDelimited(text, clamped, "$$", "$$", true)
    ?? findDelimited(text, clamped, "\\[", "\\]", true)
    ?? findDelimited(text, clamped, "\\(", "\\)", false)
    ?? findEnvironment(text, clamped)
    ?? findDelimited(text, clamped, "$", "$", false)
  );
}

function delimiterPairAt(
  text: string,
  region: MathRegion,
): { openFrom: number; openTo: number; closeFrom: number; closeTo: number } | null {
  const candidates: [string, string][] = [
    ["$$", "$$"],
    ["\\[", "\\]"],
    ["\\(", "\\)"],
    ["$", "$"],
  ];
  for (const [open, close] of candidates) {
    if (
      text.startsWith(open, region.from)
      && text.slice(region.to - close.length, region.to) === close
    ) {
      return {
        openFrom: region.from,
        openTo: region.from + open.length,
        closeFrom: region.to - close.length,
        closeTo: region.to,
      };
    }
  }
  for (const name of ENVIRONMENTS) {
    const open = `\\begin{${name}}`;
    const close = `\\end{${name}}`;
    if (text.startsWith(open, region.from) && text.slice(region.to - close.length, region.to) === close) {
      return {
        openFrom: region.from,
        openTo: region.from + open.length,
        closeFrom: region.to - close.length,
        closeTo: region.to,
      };
    }
  }
  return null;
}

/** Jump between the opening and closing delimiters of the math region under the cursor. */
export function matchingMathDelimiter(
  text: string,
  position: number,
): { from: number; to: number } | null {
  const region = mathRegionAt(text, position);
  if (!region) return null;
  const pair = delimiterPairAt(text, region);
  if (!pair) return null;
  if (position >= pair.openFrom && position < pair.openTo) {
    return { from: pair.closeFrom, to: pair.closeTo };
  }
  if (position >= pair.closeFrom && position <= pair.closeTo) {
    return { from: pair.openFrom, to: pair.openTo };
  }
  return { from: pair.openFrom, to: pair.openTo };
}

export type MathDiagnostic = {
  from: number;
  to: number;
  severity: "error";
  message: string;
  source: "math";
};

function pushUnclosed(
  diagnostics: MathDiagnostic[],
  text: string,
  open: string,
  close: string,
  label: string,
) {
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const start = text.indexOf(open, searchFrom);
    if (start < 0) return;
    // Avoid matching single $ inside $$ when scanning for $.
    if (open === "$" && text.startsWith("$$", start)) {
      searchFrom = start + 2;
      continue;
    }
    const contentStart = start + open.length;
    const end = text.indexOf(close, contentStart);
    if (end < 0) {
      diagnostics.push({
        from: start,
        to: start + open.length,
        severity: "error",
        message: `Unclosed ${label}.`,
        source: "math",
      });
      return;
    }
    searchFrom = end + close.length;
  }
}

/** Flag unclosed $, $$, \\(, \\[ delimiters. Math environments are handled by structure lint. */
export function unclosedMathDiagnostics(text: string): MathDiagnostic[] {
  const diagnostics: MathDiagnostic[] = [];
  pushUnclosed(diagnostics, text, "$$", "$$", "display math $$");
  pushUnclosed(diagnostics, text, "\\[", "\\]", "display math \\[");
  pushUnclosed(diagnostics, text, "\\(", "\\)", "inline math \\(");
  pushUnclosed(diagnostics, text, "$", "$", "inline math $");
  return diagnostics;
}
