import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BOARD_ASSETS_DIR, boardAssetPath } from "./board-asset-urls";

describe("board assets", () => {
  it("loads Excalidraw's fonts from the files the build ships, never a CDN", () => {
    expect(boardAssetPath("tauri://localhost/assets/board-editor-abc.js", false)).toBe("tauri://localhost/excalidraw-assets/");
    expect(boardAssetPath("lattice://island/bundle/assets/board-abc.js", false)).toBe("lattice://island/bundle/excalidraw-assets/");
    expect(boardAssetPath("http://localhost:1420/src/editor/board/board-asset-urls.ts", true)).toBe("/excalidraw-assets/");
    expect(window.EXCALIDRAW_ASSET_PATH).toBe("/excalidraw-assets/");
  });

  it("names the folder the build plugin emits the fonts into", () => {
    const plugin = readFileSync("scripts/excalidraw-assets.ts", "utf8");
    expect(plugin).toContain(`const EXCALIDRAW_ASSETS_DIR = "${BOARD_ASSETS_DIR}";`);
  });
});
