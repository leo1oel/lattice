/** Height of the document overlay toolbar on Lattice editor surfaces. */
export const EDITOR_TOOLBAR_HEIGHT = 56;

/** Lattice does not mount Open Knowledge's separate note-window shell. */
export function editorToolbarOverlapPx(): number {
  return EDITOR_TOOLBAR_HEIGHT;
}
