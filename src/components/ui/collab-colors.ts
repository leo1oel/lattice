/** Shared palette for peer carets and editor-comment marks. */

export type PeerColor = {
  color: string;
  colorLight: string;
};

const PEER_COLORS: PeerColor[] = [
  { color: "#0b6e4f", colorLight: "rgba(11, 110, 79, 0.28)" },
  { color: "#1d4ed8", colorLight: "rgba(29, 78, 216, 0.28)" },
  { color: "#b45309", colorLight: "rgba(180, 83, 9, 0.30)" },
  { color: "#7c3aed", colorLight: "rgba(124, 58, 237, 0.28)" },
  { color: "#be123c", colorLight: "rgba(190, 18, 60, 0.28)" },
  { color: "#0e7490", colorLight: "rgba(14, 116, 144, 0.28)" },
  { color: "#a16207", colorLight: "rgba(161, 98, 7, 0.30)" },
  { color: "#c026d3", colorLight: "rgba(192, 38, 211, 0.28)" },
];

/** Stable color from any identity string (author id, name+clientId, …). */
export function peerColorForKey(key: string): PeerColor {
  const seed = key.trim() || "anonymous";
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return PEER_COLORS[(hash >>> 0) % PEER_COLORS.length]!;
}

export function peerColorForName(name: string): PeerColor {
  return peerColorForKey(name);
}
