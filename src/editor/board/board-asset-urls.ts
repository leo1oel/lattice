/** `EXCALIDRAW_ASSETS_DIR` in scripts/excalidraw-assets.ts, which emits the files. */
export const BOARD_ASSETS_DIR = "excalidraw-assets";

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

/**
 * Where Excalidraw loads its fonts from: the package's own files, which the
 * build ships beside the app's JavaScript (`scripts/excalidraw-assets.ts`),
 * never its CDN. A built chunk sits in `assets/`, so the files are one folder
 * up from it, in the app and in the GPUI board island alike; the dev server
 * serves them at its root.
 */
export function boardAssetPath(moduleUrl: string = import.meta.url, dev: boolean = import.meta.env.DEV): string {
  return dev ? `/${BOARD_ASSETS_DIR}/` : new URL(`../${BOARD_ASSETS_DIR}/`, moduleUrl).href;
}

// Before Excalidraw's module registers its font faces: board-editor.tsx
// imports this module first.
window.EXCALIDRAW_ASSET_PATH = boardAssetPath();
