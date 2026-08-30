/**
 * Local seam — not upstream code.
 *
 * Open Knowledge runs in Electron and restores a title-bar drag band over
 * modal overlays. Lattice's host window is Tauri, so neither Electron's
 * `window.okDesktop` marker nor its app-region workaround applies here.
 */
export function electronDragBandClearance(): undefined {
  return undefined;
}

export function ElectronDragStrip({ testId: _testId }: { testId: string }) {
  return null;
}
