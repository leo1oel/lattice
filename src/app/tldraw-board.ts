import { invoke } from "@tauri-apps/api/core";

/** A tldraw board from before boards moved to Excalidraw. */
export const isTldrawBoardPath = (path: string) => /\.tldr$/i.test(path);

/**
 * The board a `.tldr` opens as: the `.excalidraw` beside it, made by
 * converting it the first time and opened as it is after that
 * (`convert_tldr_board`); the `.tldr` stays as it was.
 */
export const excalidrawBoardFor = (path: string, projectRoot: string) => (
  invoke<string>("convert_tldr_board", { path, projectRoot })
);
