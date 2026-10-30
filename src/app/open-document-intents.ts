import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";
import type { AssetPreview, PaperSummary, SyncTexWord } from "../app-types";
import { isPaperTabKey } from "../app-utils";
import { addAppLog } from "../telemetry/app-log-store";

/** Which reader a tab key opens through: a Paper's, an asset preview's, or the text editor's. */
export function documentKind(key: string, assetPaths: ReadonlySet<string>): "paper" | "asset" | "file" {
  return isPaperTabKey(key) ? "paper" : assetPaths.has(key) ? "asset" : "file";
}

/** Run the canvas's deferred-edit flush: published, refused (a text composition is open), or what it threw. */
export function publishDeferredEdits(flush: (() => boolean) | null): "published" | "refused" | { error: unknown } {
  try {
    return flush?.() === false ? "refused" : "published";
  } catch (error) {
    return { error };
  }
}

export function recordNavigationTiming(
  kind: "file" | "paper",
  path: string,
  startedAt: number,
  phases: Record<string, number>,
): void {
  const endedAt = performance.now();
  const detail = { kind, path, totalMs: endedAt - startedAt, ...phases };
  try {
    performance.measure("lattice:document-switch", { start: startedAt, end: endedAt, detail });
  } catch {
    // Older WebKit builds do not support PerformanceMeasureOptions.detail.
  }
  if (detail.totalMs < 100) return;
  addAppLog({
    level: "info",
    source: i18n._(msg`Navigation performance`),
    title: kind === "paper" ? i18n._(msg`Paper switch`) : i18n._(msg`File switch`),
    detail: `${path}\n${Object.entries(detail)
      .filter(([key]) => key.endsWith("Ms"))
      .map(([key, value]) => `${key}=${Number(value).toFixed(1)}`)
      .join(" ")}`,
    toast: false,
  });
}

/** Which buffer owns the canvas: a Paper's, an asset preview (no buffer), or the text file's. */
export type SurfaceOwner = "file" | "paper" | "asset";

export const ownerOf = (state: { paper: PaperSummary | null; asset: AssetPreview | null }): SurfaceOwner => (
  state.paper ? "paper" : state.asset ? "asset" : "file"
);

/** An open that resolves its document later (a Paper fetched first); `isCurrent` turns false once anything else opens. */
export type OpenClaim = { isCurrent(): boolean };

/** Generations behind the claims `claim()` handed out; private to the open-documents store. */
export const claimGenerations = new WeakMap<OpenClaim, number>();

export type LoadOptions = {
  restoreView?: boolean;
  revealSource?: boolean;
  expectedProjectRoot?: string;
  projectGeneration?: number;
  /**
   * A prerequisite (the previous file's save) the load may overlap with
   * its own disk read but must confirm before committing state. Resolving
   * false — or rejecting — aborts the switch, preserving the old
   * "save failure keeps the current file" semantics without paying
   * write + read serially.
   */
  gate?: Promise<boolean>;
  /** Primary-surface intent reserved by a caller before it awaited save. */
  loadGeneration?: number;
  /** Re-check the old owner's deferred edits immediately before commit. */
  canCommit?: () => boolean;
  /**
   * Where in the freshly loaded file to land. Requesting it here, rather
   * than after this load resolves, keeps the content and the jump in one
   * React commit: setting it afterwards paints the new document at its top
   * first and only scrolls to the line on the next frame, which a SyncTeX
   * jump out of the PDF shows as a flash.
   */
  navigateToLine?: number;
  /** The word on that line to land on (see OpenFileOptions.word). */
  navigateToWord?: SyncTexWord;
};

/** Load a file from disk into the editor now, replacing its buffer (a reload, or a programmatic replacement). */
export type LoadFile = (
  path: string,
  options?: Pick<LoadOptions, "restoreView" | "expectedProjectRoot" | "projectGeneration" | "canCommit">,
) => Promise<boolean>;
