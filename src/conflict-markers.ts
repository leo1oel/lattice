/**
 * Parsing and resolving the conflict markers a three-way merge leaves behind.
 *
 * The markers are the standard `<<<<<<< / ======= / >>>>>>>` form, so a file
 * carrying them is readable in any editor. Understanding them here is what
 * lets the app offer "keep mine / keep theirs / keep both" per spot instead of
 * asking someone to hand-edit around the markers.
 */

export type ConflictHunk = {
  /** Index in the file's block list, so a choice can be applied in place. */
  index: number;
  ours: string;
  theirs: string;
  /** 1-based line where the conflict starts, for jumping to it. */
  line: number;
};

export type ConflictChoice = "ours" | "theirs" | "both";

type Block =
  | { kind: "text"; text: string }
  | { kind: "conflict"; ours: string; theirs: string; line: number };

const START = "<<<<<<<";
const MIDDLE = "=======";
const END = ">>>>>>>";

/**
 * Split a file into plain stretches and conflict blocks. Unterminated markers
 * are treated as ordinary text, so a half-written file is never mangled.
 */
export function parseConflictBlocks(content: string): Block[] {
  const lines = content.split("\n");
  const blocks: Block[] = [];
  let text: string[] = [];
  let index = 0;

  const flushText = () => {
    if (text.length) {
      blocks.push({ kind: "text", text: text.join("\n") });
      text = [];
    }
  };

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.startsWith(START)) {
      text.push(line);
      index += 1;
      continue;
    }
    const startLine = index + 1;
    const ours: string[] = [];
    const theirs: string[] = [];
    let cursor = index + 1;
    let sawMiddle = false;
    let closed = false;
    while (cursor < lines.length) {
      const current = lines[cursor] ?? "";
      if (current.startsWith(MIDDLE)) {
        sawMiddle = true;
        cursor += 1;
        continue;
      }
      if (current.startsWith(END)) {
        closed = true;
        cursor += 1;
        break;
      }
      (sawMiddle ? theirs : ours).push(current);
      cursor += 1;
    }
    if (!closed) {
      // No closing marker: leave the rest exactly as it is.
      text.push(line);
      index += 1;
      continue;
    }
    flushText();
    blocks.push({
      kind: "conflict",
      ours: ours.join("\n"),
      theirs: theirs.join("\n"),
      line: startLine,
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
      hunks.push({ index, ours: block.ours, theirs: block.theirs, line: block.line });
    }
  });
  return hunks;
}

export function hasConflictMarkers(content: string): boolean {
  return conflictHunks(content).length > 0;
}

/**
 * Rebuild the file with a choice applied to each resolved conflict. Blocks left
 * undecided keep their markers, so a partial pass is safe to save.
 */
export function resolveConflicts(
  content: string,
  choices: Map<number, ConflictChoice>,
): string {
  const blocks = parseConflictBlocks(content);
  const parts = blocks.map((block, index) => {
    if (block.kind === "text") return block.text;
    const choice = choices.get(index);
    if (!choice) {
      return [
        `${START} ours`,
        block.ours,
        MIDDLE,
        block.theirs,
        `${END} theirs`,
      ].join("\n");
    }
    if (choice === "ours") return block.ours;
    if (choice === "theirs") return block.theirs;
    return `${block.ours}\n${block.theirs}`;
  });
  return parts.join("\n");
}
