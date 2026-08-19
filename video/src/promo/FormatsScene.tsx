import {
  BookMarked,
  FileCode2,
  FileCog,
  FileText,
  FileType2,
  Globe,
  Image as ImageIcon,
  PenTool,
  Settings2,
  Table2,
} from "lucide-react";
import { Easing, interpolate, Sequence, useCurrentFrame } from "remotion";
import { ACCENT_TEXT, FG, MUTED } from "./constants";
import { Stage } from "./Stage";
import { TextReveal } from "./TextReveal";

/* ------------------------------------------------------------------ *
 * EVERYTHING TUNABLE LIVES HERE.
 *
 * Content: edit FORMATS — add, remove or reorder rows freely, the layout
 * flows from `COLUMNS`. Icons are lucide names; browse them at lucide.dev
 * and add the import at the top.
 *
 * Size and position: edit LAYOUT. All values are pixels on the 1280x720
 * canvas, so `rowHeight: 54` really is 54px.
 *
 * The Studio hot-reloads on save, and the standalone `Formats` composition
 * renders just this scene so you can tune it without scrubbing the film.
 * ------------------------------------------------------------------ */

/** The real extensions from the demo project's file tree — the viewer sees
 *  these same names in the sidebar seconds later. */
const FORMATS: { ext: string; name: string; Icon: typeof FileText }[] = [
  { ext: ".tex", name: "LaTeX", Icon: FileCode2 },
  { ext: ".md", name: "Markdown", Icon: FileText },
  { ext: ".bib", name: "Citations", Icon: BookMarked },
  { ext: ".toml", name: "Project", Icon: Settings2 },
  { ext: ".sty", name: "Styles", Icon: FileCog },
  { ext: ".html", name: "Interactive", Icon: Globe },
  { ext: ".tldr", name: "Canvas", Icon: PenTool },
  { ext: ".lattice-sheet", name: "Spreadsheet", Icon: Table2 },
  { ext: ".pdf", name: "Output", Icon: FileType2 },
  { ext: ".png", name: "Figures", Icon: ImageIcon },
];

const LAYOUT = {
  columns: 2,
  /** Width of one column's rail, in px. */
  /** Wide enough for `.lattice-sheet`, the longest extension, on one line. */
  columnWidth: 334,
  /** Space between the two columns. */
  columnGap: 76,
  rowHeight: 54,
  /** Top of the first row. */
  top: 206,
  iconSize: 21,
  /** The `.ext` text. */
  extSize: 21,
  /** The muted type name on the right of the rail. */
  nameSize: 15,
  /** Hairline under each row; set to "none" to remove. */
  rule: "1px solid rgba(17,17,20,0.09)",
  headline: "All of it, in one project",
  headlineSize: 36,
  headlineTop: 536,
  /** Frames between each row arriving, and how long one takes. */
  stagger: 3,
  rowIn: 13,
  firstRow: 6,
  /** Frame the headline lands on. */
  headlineAt: 58,
};

const ROWS = Math.ceil(FORMATS.length / LAYOUT.columns);
const GRID_W =
  LAYOUT.columns * LAYOUT.columnWidth + (LAYOUT.columns - 1) * LAYOUT.columnGap;
const GRID_LEFT = (1280 - GRID_W) / 2;

/**
 * The establishing beat: every kind of file this project holds, before the tour
 * shows any of them working.
 *
 * Deliberately not cards — boxed chips on a light stage read as a settings
 * screen. A plain two-column rail with hairlines reads as a file list, which is
 * what it is.
 */
export const FormatsScene: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <Stage glowAt="42%">
      {FORMATS.map((format, i) => {
        // Fill down each column, so the eye reads top-to-bottom then across.
        const col = Math.floor(i / ROWS);
        const row = i % ROWS;
        const local = frame - (LAYOUT.firstRow + i * LAYOUT.stagger);
        return (
          <div
            key={format.ext}
            style={{
              position: "absolute",
              left: GRID_LEFT + col * (LAYOUT.columnWidth + LAYOUT.columnGap),
              top: LAYOUT.top + row * LAYOUT.rowHeight,
              width: LAYOUT.columnWidth,
              height: LAYOUT.rowHeight,
              display: "flex",
              alignItems: "center",
              gap: 14,
              borderBottom: LAYOUT.rule,
              opacity: interpolate(local, [0, LAYOUT.rowIn], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: Easing.bezier(0.16, 1, 0.3, 1),
              }),
              translate: interpolate(
                local,
                [0, LAYOUT.rowIn],
                ["-10px 0px", "0px 0px"],
                {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                  easing: Easing.bezier(0.16, 1, 0.3, 1),
                },
              ),
            }}
          >
            <format.Icon
              size={LAYOUT.iconSize}
              color={ACCENT_TEXT}
              strokeWidth={1.9}
            />
            <span
              style={{
                fontFamily: "var(--font-geist-mono)",
                fontSize: LAYOUT.extSize,
                fontWeight: 500,
                color: FG,
                letterSpacing: "-0.02em",
                whiteSpace: "nowrap",
              }}
            >
              {format.ext}
            </span>
            <span
              style={{
                marginLeft: "auto",
                fontFamily: "var(--font-geist-sans)",
                fontSize: LAYOUT.nameSize,
                fontWeight: 500,
                color: MUTED,
                whiteSpace: "nowrap",
              }}
            >
              {format.name}
            </span>
          </div>
        );
      })}
      <Sequence from={LAYOUT.headlineAt} name="All of it">
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: LAYOUT.headlineTop,
            height: 46,
          }}
        >
          <TextReveal
            text={LAYOUT.headline}
            style="rise"
            fontSize={LAYOUT.headlineSize}
            color={FG}
            fontWeight={600}
            duration={10}
          />
        </div>
      </Sequence>
    </Stage>
  );
};
