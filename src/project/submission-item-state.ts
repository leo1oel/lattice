import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SubmissionItem } from "../app-types";

export type LinkedFileStat = { exists: boolean; mtimeMs: number };

/**
 * Where an item stands once its linked file is taken into account: a file
 * that is gone, or that changed after the item was confirmed (a rebuilt PDF,
 * a replaced supplement), asks to be looked at again whatever the stored
 * status says. "pending" is a confirmed item whose file has not been read yet.
 */
export type ItemCondition = SubmissionItem["status"] | "missing" | "changed" | "pending";

export function itemCondition(item: SubmissionItem, stat: LinkedFileStat | undefined): ItemCondition {
  if (!item.file) return item.status;
  if (stat && !stat.exists) return "missing";
  if (item.status !== "confirmed") return item.status;
  if (!stat) return "pending";
  return stat.mtimeMs === item.confirmedMtimeMs ? "confirmed" : "changed";
}

/** The item's result for the checklist verdict: only a confirmation that still holds passes. */
export function itemPasses(condition: ItemCondition): boolean | null {
  return condition === "confirmed" ? true : condition === "pending" ? null : false;
}

/**
 * The linked files' disk state, read again whenever the project's tree (after
 * a file event) or its last build changes. Answers that arrive for an older
 * list or another project are dropped.
 */
export function useLinkedFileStats(scope: string, paths: string[], tree: unknown, build: unknown): Record<string, LinkedFileStat> {
  const key = JSON.stringify([scope, ...paths]);
  const [read, setRead] = useState<{ key: string; stats: Record<string, LinkedFileStat> } | null>(null);
  useEffect(() => {
    // The paths come back out of `key`, which changes only when they do.
    const [, ...linked] = JSON.parse(key) as string[];
    if (linked.length === 0) return;
    let current = true;
    void Promise.all(linked.map((path) => invoke<LinkedFileStat>("stat_project_file", { path }).then(
      (stat) => [path, stat] as const,
      // A path the backend refuses to read is as good as gone to the writer.
      () => [path, { exists: false, mtimeMs: 0 }] as const,
    ))).then((entries) => {
      if (current) setRead({ key, stats: Object.fromEntries(entries) });
    });
    return () => { current = false; };
    // The tree and the build are only signals to read again.
  }, [key, tree, build]);
  return read?.key === key ? read.stats : {};
}
