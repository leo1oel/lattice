import type { CSSProperties } from "react";

// Static path data follows the ISC-licensed Lucide glyphs already shipped by
// Lattice. Part names and every animation are original to this review page.
export type SettingsIconKind =
  | "appearance"
  | "editor"
  | "agent"
  | "mcp"
  | "subscriptions"
  | "overleaf"
  | "api"
  | "doctor";

export function SettingsIcon(props: {
  kind: SettingsIconKind;
  size?: number;
  playing?: boolean;
  reducedMotion?: boolean;
  speed?: "normal" | "slow";
  playId?: number;
  className?: string;
}) {
  const size = props.size ?? 20;
  const className = [
    "settings-lab-icon",
    `icon-${props.kind}`,
    props.playing ? "is-playing" : "",
    props.reducedMotion ? "is-reduced" : "",
    props.className ?? "",
  ].filter(Boolean).join(" ");
  const style = { "--icon-duration": props.speed === "slow" ? "1.9s" : "1.05s" } as CSSProperties;

  return (
    <svg
      key={props.playId}
      className={className}
      style={style}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {props.kind === "appearance" && <>
        <circle className="icon-core" cx="12" cy="12" r="4" />
        <g className="icon-rays">
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </g>
      </>}
      {props.kind === "editor" && <>
        <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
        <path d="M14 2v5a1 1 0 0 0 1 1h5" />
        <g className="icon-code"><path d="M10 12.5 8 15l2 2.5" /><path d="m14 12.5 2 2.5-2 2.5" /></g>
      </>}
      {props.kind === "agent" && <>
        <path className="icon-antenna" d="M12 8V4H8" />
        <rect width="16" height="12" x="4" y="8" rx="2" />
        <path d="M2 14h2M20 14h2" />
        <g className="icon-eyes"><path d="M15 13v2M9 13v2" /></g>
      </>}
      {props.kind === "mcp" && <>
        <g className="icon-plug"><path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z" /><path d="m2 22 3-3M7.5 13.5 10 11M10.5 16.5 13 14" /></g>
        <path className="icon-zap" d="m18 3-4 4h6l-4 4" />
      </>}
      {props.kind === "subscriptions" && <>
        <rect width="20" height="14" x="2" y="5" rx="2" />
        <line className="icon-stripe" x1="2" x2="22" y1="10" y2="10" />
      </>}
      {props.kind === "overleaf" && <>
        <path className="icon-leaf" d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z" />
        <path className="icon-vein" d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12" />
      </>}
      {props.kind === "api" && <>
        <g className="icon-key"><path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" /><circle cx="16.5" cy="7.5" r=".5" fill="currentColor" /></g>
      </>}
      {props.kind === "doctor" && <>
        <path d="M11 2v2M5 2v2M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1M8 15a6 6 0 0 0 12 0v-3" />
        <circle className="icon-chestpiece" cx="20" cy="10" r="2" />
      </>}
    </svg>
  );
}
