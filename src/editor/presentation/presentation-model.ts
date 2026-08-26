export const PRESENTATION_THEMES = ["lattice", "paper", "midnight"] as const;
export const PRESENTATION_TRANSITIONS = ["none", "fade", "slide", "convex", "concave", "zoom"] as const;
export type PresentationTheme = (typeof PRESENTATION_THEMES)[number];
export type PresentationTransition = (typeof PRESENTATION_TRANSITIONS)[number];

export type PresentationSlide = {
  source: string;
  body: string;
  notes: string;
  start: number;
  end: number;
  bodyStart: number;
};

export type PresentationDeck = {
  source: string;
  theme: PresentationTheme;
  transition: PresentationTransition;
  frontmatter: { start: number; end: number } | null;
  slides: PresentationSlide[];
};

type Line = { start: number; contentEnd: number; end: number; text: string };

function linesOf(source: string): Line[] {
  const lines: Line[] = [];
  const re = /[^\r\n]*(?:\r\n|\r|\n|$)/g;
  for (const match of source.matchAll(re)) {
    if (match[0] === "" && match.index === source.length) break;
    const newline = match[0].match(/(?:\r\n|\r|\n)$/)?.[0] ?? "";
    lines.push({ start: match.index!, contentEnd: match.index! + match[0].length - newline.length, end: match.index! + match[0].length, text: match[0].slice(0, match[0].length - newline.length) });
  }
  return lines;
}

function frontmatterRange(lines: Line[]) {
  if (lines[0]?.text.trim() !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].text.trim() === "---") return { start: 0, end: lines[i].end, closeLine: i };
  }
  return null;
}

export function parsePresentation(source: string): PresentationDeck {
  const lines = linesOf(source);
  const fm = frontmatterRange(lines);
  let theme: PresentationTheme = "lattice";
  let transition: PresentationTransition = "fade";
  if (fm) {
    const yaml = source.slice(lines[0].end, lines[fm.closeLine].start);
    const themeValue = /^\s*theme\s*:\s*([^#\r\n]+?)(?:\s+#.*)?$/im.exec(yaml)?.[1].trim().replace(/^['"]|['"]$/g, "");
    const transitionValue = /^\s*transition\s*:\s*([^#\r\n]+?)(?:\s+#.*)?$/im.exec(yaml)?.[1].trim().replace(/^['"]|['"]$/g, "");
    if (PRESENTATION_THEMES.includes(themeValue as PresentationTheme)) theme = themeValue as PresentationTheme;
    if (PRESENTATION_TRANSITIONS.includes(transitionValue as PresentationTransition)) transition = transitionValue as PresentationTransition;
  }

  const contentStart = fm?.end ?? 0;
  const boundaries = [contentStart];
  let fence: string | null = null;
  for (const line of lines) {
    if (line.start < contentStart) continue;
    // An unclosed leading frontmatter marker is malformed metadata, not an
    // empty first slide followed by the document body.
    if (!fm && line.start === 0 && line.text.trim() === "---") continue;
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line.text);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (!fence && line.text.trim() === "---") boundaries.push(line.end);
  }
  boundaries.push(source.length);
  const slides: PresentationSlide[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = i + 1 < boundaries.length - 1 ? lines.find((line) => line.end === boundaries[i + 1])!.start : source.length;
    const raw = source.slice(start, end);
    const localLines = linesOf(raw);
    let noteAt = -1;
    let noteEnd = -1;
    let localFence: string | null = null;
    for (const line of localLines) {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line.text)?.[1];
      if (marker) {
        if (!localFence) localFence = marker;
        else if (marker[0] === localFence[0] && marker.length >= localFence.length) localFence = null;
        continue;
      }
      if (!localFence && line.text.trim() === "Notes:") { noteAt = line.start; noteEnd = line.end; break; }
    }
    slides.push({ source: raw, body: raw.slice(0, noteAt < 0 ? raw.length : noteAt).trim(), notes: noteAt < 0 ? "" : raw.slice(noteEnd).trim(), start, end, bodyStart: start });
  }
  if (slides.length === 0) slides.push({ source: "", body: "", notes: "", start: contentStart, end: contentStart, bodyStart: contentStart });
  return { source, theme, transition, frontmatter: fm ? { start: fm.start, end: fm.end } : null, slides };
}

export function slideSummary(slide: PresentationSlide): {
  title: string;
  excerpt: string;
  imageSource: string | null;
} {
  const visibleBody = slide.body.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, " ");
  const headingMatch = /^\s*#{1,6}\s+(.+)$/m.exec(visibleBody);
  const imageMatch = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/.exec(visibleBody);
  const plainText = (value: string) => value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/[#>*_`[\]()~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const plain = plainText(visibleBody);
  const excerptBody = headingMatch?.index === undefined
    ? visibleBody
    : visibleBody.slice(0, headingMatch.index) + visibleBody.slice(headingMatch.index + headingMatch[0].length);
  const heading = headingMatch?.[1].replace(/[*_`]/g, "").trim();
  const imageSource = imageMatch?.[1] ?? imageMatch?.[2] ?? null;
  return {
    title: heading || plain.slice(0, 48) || "Untitled slide",
    excerpt: plainText(excerptBody).slice(0, 100),
    imageSource,
  };
}

export function updateFrontmatterSetting(source: string, key: "theme" | "transition", value: string): string {
  const lines = linesOf(source);
  const fm = frontmatterRange(lines);
  const newline = source.includes("\r\n") ? "\r\n" : source.includes("\r") ? "\r" : "\n";
  if (!fm) return `---${newline}${key}: ${value}${newline}---${newline}${source}`;
  const innerStart = lines[0].end;
  const innerEnd = lines[fm.closeLine].start;
  const inner = source.slice(innerStart, innerEnd);
  const pattern = new RegExp(`^(\\s*${key}\\s*:\\s*)([^#\\r\\n]*?)(\\s*(?:#.*)?)$`, "mi");
  const next = pattern.test(inner)
    ? inner.replace(pattern, (_, prefix: string, _previous: string, comment: string) => `${prefix}${value}${comment}`)
    : `${inner}${inner.endsWith(newline) || inner === "" ? "" : newline}${key}: ${value}${newline}`;
  return source.slice(0, innerStart) + next + source.slice(innerEnd);
}

export function insertSlideAfter(source: string, slideIndex: number, content = "# New slide"): string {
  if (source === "") return `${content}\n`;
  const deck = parsePresentation(source);
  const index = Math.max(0, Math.min(slideIndex, deck.slides.length - 1));
  const at = deck.slides[index].end;
  const newline = source.includes("\r\n") ? "\r\n" : source.includes("\r") ? "\r" : "\n";
  const prefix = at > 0 && !/[\r\n]$/.test(source.slice(0, at)) ? newline : "";
  const suffix = at < source.length && !/^[\r\n]/.test(source.slice(at)) ? newline : "";
  return source.slice(0, at) + `${prefix}---${newline}${content}${newline}${suffix}` + source.slice(at);
}

export function deleteSlide(source: string, slideIndex: number): string {
  const deck = parsePresentation(source);
  if (deck.slides.length <= 1) return source;
  const index = Math.max(0, Math.min(slideIndex, deck.slides.length - 1));
  const slide = deck.slides[index];
  if (index === 0) {
    return source.slice(0, slide.start) + source.slice(deck.slides[1].start);
  }
  return source.slice(0, deck.slides[index - 1].end) + source.slice(slide.end);
}
