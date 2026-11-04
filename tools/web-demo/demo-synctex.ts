/**
 * SyncTeX for the demo's precompiled PDF, from the map
 * scripts/web-demo-content.mjs recorded with `synctex view`: where each line
 * of main.tex is typeset. Forward search reads it directly; a click in the
 * PDF goes to the line whose rectangle holds the point, else the nearest one
 * on that page, and Lattice then finds the clicked words near that line.
 */
import map from "./content/compiled/synctex.json";
import { NOT_HANDLED, type Args } from "../mock-backend/tauri-internals";

type Box = [page: number, x: number, y: number, width: number, height: number];
const LINES = Object.entries(map.lines as unknown as Record<string, Box>).map(([line, box]) => ({ line: Number(line), box }));

/** The line's own box, or the next typeset line's (a blank or command-only line has none). */
function boxAt(line: number): Box | null {
  return LINES.find((entry) => entry.line >= line)?.box ?? null;
}

function distance([, x, y, width, height]: Box, px: number, py: number) {
  const dx = Math.max(x - px, px - (x + width), 0);
  const dy = Math.max(y - py, py - (y + height), 0);
  return Math.hypot(dx, dy);
}

/** `synctex_view`, `synctex_edit` and the outline's page lookups; `NOT_HANDLED` for any other command. */
export function synctexAnswer(command: string, args: Args): unknown {
  switch (command) {
    case "synctex_view": {
      if (String(args?.path ?? "") !== map.file) return null;
      const box = boxAt(Math.max(1, Number(args?.line ?? 1)));
      return box && { page: box[0], x: box[1], y: box[2], width: box[3], height: box[4] };
    }
    case "synctex_edit": {
      const page = Number(args?.page);
      const [x, y] = [Number(args?.x), Number(args?.y)];
      const candidates = LINES.filter(({ box }) => box[0] === page);
      if (!candidates.length) throw new Error("No LaTeX source was found for this PDF position.");
      const inside = candidates.filter(({ box }) => distance(box, x, y) === 0);
      const best = inside.length
        ? inside.reduce((a, b) => (a.box[3] * a.box[4] <= b.box[3] * b.box[4] ? a : b))
        : candidates.reduce((a, b) => (distance(a.box, x, y) <= distance(b.box, x, y) ? a : b));
      return { path: map.file, line: best.line };
    }
    case "synctex_heading_pages":
      return (args?.headings as Array<{ path: string; line: number }> | undefined ?? [])
        .map(({ path, line }) => (path === map.file ? boxAt(line)?.[0] ?? null : null));
    case "synctex_body_pages":
      return null;
    default:
      return NOT_HANDLED;
  }
}
