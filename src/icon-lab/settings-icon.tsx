import type { CSSProperties } from "react";

// Static path data follows the ISC-licensed Lucide glyphs already shipped by
// Lattice. Part names and every animation are original to this review page.
export type AnimatedIconKind =
  | "appearance"
  | "editor"
  | "agent"
  | "mcp"
  | "subscriptions"
  | "overleaf"
  | "api"
  | "doctor"
  | "faders"
  | "users"
  | "list-checks"
  | "kanban"
  | "folder"
  | "gear"
  | "chat"
  | "trash"
  | "cloud-upload"
  | "git-branch"
  | "logs"
  | "sparkle";

export function AnimatedIcon(props: {
  kind: AnimatedIconKind;
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
      {props.kind === "faders" && <>
        <path d="M10 5H3M21 5h-7M8 12H3M21 12h-9M12 19H3M21 19h-5" />
        <g className="icon-fader-knobs"><path d="M14 3v4M8 10v4M16 17v4" /></g>
      </>}
      {props.kind === "users" && <>
        <g className="icon-user-primary"><path d="M18 21a8 8 0 0 0-16 0" /><circle cx="10" cy="8" r="5" /></g>
        <path className="icon-user-secondary" d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3" />
      </>}
      {props.kind === "list-checks" && <>
        <path d="M13 5h8M13 12h8M13 19h8" />
        <g className="icon-checks"><path d="m3 7 2 2 4-4" /><path d="m3 17 2 2 4-4" /></g>
      </>}
      {props.kind === "kanban" && <>
        <rect width="18" height="18" x="3" y="3" rx="2" /><path d="M3 9h18M9 21V9" />
        <g className="icon-kanban-card"><rect x="12" y="12" width="6" height="3.5" rx="1" /></g>
      </>}
      {props.kind === "folder" && <>
        <path d="M3 8V5a2 2 0 0 1 2-2h3l2 3h9a2 2 0 0 1 2 2v2" />
        <path className="icon-folder-paper" d="M7 11h10v7H7z" />
        <path className="icon-folder-front" d="M3 9h18l-2 11H5Z" />
      </>}
      {props.kind === "gear" && <>
        <g className="icon-gear"><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" /><circle cx="12" cy="12" r="3" /></g>
      </>}
      {props.kind === "chat" && <>
        <path d="M21 15a4 4 0 0 1-4 4H8l-5 3 1.7-5A7 7 0 0 1 3 12V8a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" />
        <g className="icon-chat-dots" fill="currentColor" stroke="none"><circle cx="8" cy="11.5" r="1" /><circle cx="12" cy="11.5" r="1" /><circle cx="16" cy="11.5" r="1" /></g>
      </>}
      {props.kind === "trash" && <>
        <g className="icon-trash-lid"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></g>
        <path d="M10 11v6M14 11v6M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      </>}
      {props.kind === "cloud-upload" && <>
        <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
        <g className="icon-upload-arrow"><path d="M12 13v8M8 17l4-4 4 4" /></g>
      </>}
      {props.kind === "git-branch" && <>
        <path className="icon-branch" d="M15 6a9 9 0 0 0-9 9V3" />
        <circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" />
      </>}
      {props.kind === "logs" && <>
        <path d="M3 5h1M3 12h1M3 19h1M8 5h1M8 12h1M8 19h1" />
        <g className="icon-log-lines"><path d="M13 5h8M13 12h8M13 19h8" /></g>
      </>}
      {props.kind === "sparkle" && <>
        <path className="icon-sparkle-main" d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" />
        <g className="icon-sparkle-small"><path d="M20 2v4M22 4h-4" /><circle cx="4" cy="20" r="2" /></g>
      </>}
    </svg>
  );
}
