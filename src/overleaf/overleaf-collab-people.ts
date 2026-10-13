/**
 * One colour per person across everything Overleaf collaboration draws: the
 * presence stack and its card, comment threads, suggestions, chat, and the
 * comment marks in the source.
 *
 * Overleaf gives each account a hue (`presence_hue` in
 * `src-tauri/src/overleaf_rt/events.rs`), but only two things carry it here:
 * the people online now and the authors of tracked changes. Comments and chat
 * messages name their author and, at most, an email. So the hues that are
 * known are collected under both keys and looked up by email first, then by
 * name; someone with no known hue falls back to the palette colour of their
 * email or name, the same key the editor's comment marks have always used.
 *
 * Pure and dependency-light on purpose: the workspace hook builds this map on
 * every render to project the editor's comment marks.
 */
import { hueColor, peerColorForKey, type PeerColor } from "../components/ui/collab-colors";
import type { TrackedChange } from "./overleaf-realtime-model";

/** Overleaf's hue for "you": the blue its own editor reserves for the account looking at it. */
const OWN_HUE = 200;

/** Name/email to hue, keyed `email:<lowercased>` and `name:<as written>`. */
export type PeopleHues = ReadonlyMap<string, number>;

type CollabAuthor = { name: string; email?: string | null; mine?: boolean };

const emailKey = (email: string) => `email:${email.trim().toLowerCase()}`;
const nameKey = (name: string) => `name:${name.trim()}`;

/** Every hue the live channel told us about: who is online, then who suggested changes. */
export function collabPeopleHues(
  peers: ReadonlyArray<{ name: string; email: string | null; hue: number }>,
  changes: ReadonlyArray<Pick<TrackedChange, "userId" | "hue">>,
  authorName: (userId: string | null) => string,
): PeopleHues {
  const hues = new Map<string, number>();
  for (const change of changes) {
    if (change.userId) hues.set(nameKey(authorName(change.userId)), change.hue);
  }
  // Presence is the live account, so it wins over a name that merely matches.
  for (const peer of peers) {
    if (peer.name.trim()) hues.set(nameKey(peer.name), peer.hue);
    if (peer.email) hues.set(emailKey(peer.email), peer.hue);
  }
  return hues;
}

/** A stable string for `hues`, for memoizing on what it says rather than its identity. */
export function peopleHuesKey(hues: PeopleHues): string {
  return [...hues].map(([key, hue]) => `${key}=${hue}`).sort().join("\n");
}

export function peopleHuesFromKey(key: string): PeopleHues {
  return new Map(key ? key.split("\n").map((entry) => {
    const at = entry.lastIndexOf("=");
    return [entry.slice(0, at), Number(entry.slice(at + 1))] as const;
  }) : []);
}

/** The person's Overleaf hue, when one is known. */
function personHue(hues: PeopleHues, author: CollabAuthor): number | undefined {
  if (author.mine) return OWN_HUE;
  return (author.email ? hues.get(emailKey(author.email)) : undefined) ?? hues.get(nameKey(author.name));
}

/** As strong as the palette's own light colours, so a hue and a fallback mark read alike. */
const PERSON_TINT_ALPHA = 0.28;

/**
 * The person's colour and its soft tint: their Overleaf hue, else the palette
 * colour Lattice gives that email or name.
 */
export function personColor(hues: PeopleHues, author: CollabAuthor): PeerColor {
  const hue = personHue(hues, author);
  if (hue === undefined) return peerColorForKey(author.email || author.name);
  return { color: hueColor(hue), colorLight: hueColor(hue, PERSON_TINT_ALPHA) };
}
