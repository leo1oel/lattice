import { useEffect, useReducer } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { EditorComment } from "../editor/comments/editor-comment-data";
import { anchorCitationReasons, citationSites } from "../editor/latex/citation-reasons";
import type { SymbolOccurrence } from "./references-panel";

/** What a use of a paper says beyond its line: why it cites the paper, and the page its note names. */
export type CitationUseDetail = { reason?: EditorComment; page?: number };

const sameKey = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase();

/**
 * Each use's detail, in the order of `usages` (the manuscript scan's uses of
 * one key). A use is matched to its occurrence by file, line and its place
 * among the key's uses on that line, in the saved text the scan read.
 */
export function citationUseDetails(
  usages: readonly SymbolOccurrence[],
  sources: ReadonlyMap<string, string>,
  reasons: readonly EditorComment[],
): CitationUseDetail[] {
  const byPath = new Map<string, Map<string, CitationUseDetail>>();
  const detailsIn = (path: string, key: string) => {
    const cached = byPath.get(path);
    if (cached) return cached;
    const details = new Map<string, CitationUseDetail>();
    byPath.set(path, details);
    const source = sources.get(path);
    if (source === undefined) return details;
    const open = reasons.filter((reason) => reason.path === path && !reason.resolved);
    const placed = anchorCitationReasons(source, path, open);
    const reasonAt = new Map(open.flatMap((reason) => {
      const site = placed.get(reason.id);
      return site ? [[site.from, reason] as const] : [];
    }));
    const seen = new Map<number, number>();
    for (const site of citationSites(source)) {
      if (!sameKey(site.key, key)) continue;
      const ordinal = seen.get(site.line) ?? 0;
      seen.set(site.line, ordinal + 1);
      details.set(`${site.line}:${ordinal}`, { reason: reasonAt.get(site.from), page: site.page });
    }
    return details;
  };
  const seen = new Map<string, number>();
  return usages.map((usage) => {
    const place = `${usage.path}:${usage.line}`;
    const ordinal = seen.get(place) ?? 0;
    seen.set(place, ordinal + 1);
    return detailsIn(usage.path, usage.symbol).get(`${usage.line}:${ordinal}`) ?? {};
  });
}

/**
 * The saved text of every file `usages` cite from, read for the project
 * and scan revision `revision`; empty until read.
 */
export function useCitationUseSources(
  projectKey: string,
  usages: readonly SymbolOccurrence[] | null,
  revision: unknown,
): ReadonlyMap<string, string> {
  const paths = [...new Set((usages ?? []).map((usage) => usage.path))].sort().join("\n");
  type Read = { projectKey: string; paths: string; revision: unknown; sources: Map<string, string> };
  const [read, setRead] = useReducer((_current: Read | null, next: Read) => next, null);
  useEffect(() => {
    if (!paths) return;
    let disposed = false;
    const list = paths.split("\n");
    void Promise.all(list.map((path) => invoke<string>("read_project_file", { path, projectRoot: projectKey }).catch(() => null)))
      .then((texts) => {
        if (disposed) return;
        const sources = new Map<string, string>();
        list.forEach((path, index) => {
          const text = texts[index];
          if (typeof text === "string") sources.set(path, text);
        });
        setRead({ projectKey, paths, revision, sources });
      });
    return () => { disposed = true; };
  }, [paths, projectKey, revision]);
  return read && read.projectKey === projectKey && read.paths === paths && read.revision === revision ? read.sources : EMPTY;
}

const EMPTY: ReadonlyMap<string, string> = new Map();
