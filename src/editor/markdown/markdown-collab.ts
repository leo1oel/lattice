export type TextPatch = {
  from: number;
  to: number;
  insert: string;
};

export function minimalMarkdownPatch(base: string, draft: string): TextPatch {
  let from = 0;
  while (from < base.length && from < draft.length && base[from] === draft[from]) from += 1;
  let suffix = 0;
  while (
    suffix < base.length - from
    && suffix < draft.length - from
    && base[base.length - suffix - 1] === draft[draft.length - suffix - 1]
  ) suffix += 1;
  return {
    from,
    to: base.length - suffix,
    insert: draft.slice(from, draft.length - suffix),
  };
}

/** Rebase one visual edit over one canonical edit, refusing ambiguous touching ranges. */
export function rebaseMarkdownDraft(base: string, draft: string, canonical: string): string | null {
  if (canonical === base) return draft;
  if (draft === base) return canonical;
  const local = minimalMarkdownPatch(base, draft);
  const remote = minimalMarkdownPatch(base, canonical);
  if (local.from === local.to && local.insert === "") return canonical;
  if (remote.from === remote.to && remote.insert === "") return draft;

  if (remote.to < local.from || (remote.to === local.from && remote.from !== remote.to)) {
    const delta = remote.insert.length - (remote.to - remote.from);
    return `${canonical.slice(0, local.from + delta)}${local.insert}${canonical.slice(local.to + delta)}`;
  }
  if (local.to < remote.from || (local.to === remote.from && local.from !== local.to)) {
    return `${canonical.slice(0, local.from)}${local.insert}${canonical.slice(local.to)}`;
  }
  return null;
}
