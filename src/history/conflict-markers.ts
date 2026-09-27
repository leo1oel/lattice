/**
 * Parsing and resolving the conflict markers a three-way merge leaves behind.
 *
 * The markers are the standard `<<<<<<< / ======= / >>>>>>>` form, optionally
 * with a diff3 `|||||||` section carrying the last common version between the
 * two sides. Overleaf sync writes the diff3 form (diffy's default style), so
 * the base section is not an edge case: treating it as part of "ours" put the
 * previous synced text back into the file whenever someone kept their side.
 *
 * Everything works on line arrays rather than joined strings, so an empty side
 * (one side deleted the whole region) resolves to no lines at all instead of
 * leaving a stray blank line where the region used to be.
 */

export type ConflictHunk = {
  /** Index in the file's block list, so a choice can be applied in place. */
  index: number;
  ours: string;
  theirs: string;
  /** The last synced version of this spot, when the markers carry one. */
  base: string | null;
  oursLines: string[];
  theirsLines: string[];
  baseLines: string[] | null;
  /** 1-based line where the conflict starts, for jumping to it. */
  line: number;
};

export type ConflictChoice = "ours" | "theirs" | "both";

type Block =
  | { kind: "text"; lines: string[] }
  | {
    kind: "conflict";
    ours: string[];
    base: string[] | null;
    theirs: string[];
    /** The marker lines and body exactly as found, kept for undecided spots. */
    raw: string[];
    line: number;
  };

const START = "<<<<<<<";
const BASE = "|||||||";
const MIDDLE = "=======";
const END = ">>>>>>>";

const isMarker = (line: string, marker: string) => (
  line === marker || line.startsWith(`${marker} `)
);

/**
 * Split a file into plain stretches and conflict blocks. Unterminated or
 * malformed markers are treated as ordinary text, so a half-written file is
 * never mangled.
 */
export function parseConflictBlocks(content: string): Block[] {
  const lines = content.split("\n");
  const blocks: Block[] = [];
  let text: string[] = [];
  let index = 0;

  const flushText = () => {
    if (text.length) {
      blocks.push({ kind: "text", lines: text });
      text = [];
    }
  };

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!isMarker(line, START)) {
      text.push(line);
      index += 1;
      continue;
    }
    const ours: string[] = [];
    let base: string[] | null = null;
    const theirs: string[] = [];
    let section: "ours" | "base" | "theirs" = "ours";
    let cursor = index + 1;
    let closed = false;
    while (cursor < lines.length) {
      const current = lines[cursor] ?? "";
      if (section === "ours" && isMarker(current, BASE)) {
        section = "base";
        base = [];
      } else if (section !== "theirs" && isMarker(current, MIDDLE)) {
        section = "theirs";
      } else if (section === "theirs" && isMarker(current, END)) {
        closed = true;
        cursor += 1;
        break;
      } else if (isMarker(current, START)) {
        // A nested start means this one was never closed.
        break;
      } else {
        (section === "ours" ? ours : section === "base" ? base! : theirs).push(current);
      }
      cursor += 1;
    }
    if (!closed) {
      text.push(line);
      index += 1;
      continue;
    }
    flushText();
    blocks.push({
      kind: "conflict",
      ours,
      base,
      theirs,
      raw: lines.slice(index, cursor),
      line: index + 1,
    });
    index = cursor;
  }
  flushText();
  return blocks;
}

export function conflictHunks(content: string): ConflictHunk[] {
  const hunks: ConflictHunk[] = [];
  parseConflictBlocks(content).forEach((block, index) => {
    if (block.kind === "conflict") {
      hunks.push({
        index,
        ours: block.ours.join("\n"),
        theirs: block.theirs.join("\n"),
        base: block.base?.join("\n") ?? null,
        oursLines: block.ours,
        theirsLines: block.theirs,
        baseLines: block.base,
        line: block.line,
      });
    }
  });
  return hunks;
}

export function hasConflictMarkers(content: string): boolean {
  return conflictHunks(content).length > 0;
}

/**
 * Rebuild the file with a choice applied to each resolved conflict. Blocks left
 * undecided keep their original markers (base section included), so a partial
 * pass is safe to save and can be finished later.
 */
export function resolveConflicts(
  content: string,
  choices: ReadonlyMap<number, ConflictChoice>,
): string {
  return parseConflictBlocks(content).flatMap((block, index) => {
    if (block.kind === "text") return block.lines;
    const choice = choices.get(index);
    if (choice === "ours") return block.ours;
    if (choice === "theirs") return block.theirs;
    if (choice === "both") return [...block.ours, ...block.theirs];
    return block.raw;
  }).join("\n");
}
