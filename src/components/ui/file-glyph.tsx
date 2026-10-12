import { fileGlyphParts, type FileGlyphKind } from "./file-glyphs";

/** A file's coloured glyph, the same one the Project tree draws beside it. */
export function FileGlyph({ kind, size = 14 }: { kind: FileGlyphKind; size?: number }) {
  const { paths, circles } = fileGlyphParts(kind);
  return (
    <svg className="file-glyph" data-kind={kind} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {paths.map(({ d, paint }, index) => <path key={index} d={d} style={paint} />)}
      {circles.map(({ cx, cy, r, paint }, index) => <circle key={`c${index}`} cx={cx} cy={cy} r={r} style={paint} />)}
    </svg>
  );
}
