import { useId, type CSSProperties } from "react";
import "./lattice-icons.css";

export type LatticeIconKind = "editor-comments" | "live-collaboration" | "overleaf-messages";

type IconProps = { size: number };

function EditorCommentsIcon({ size }: IconProps) {
  const clipId = `lattice-comment-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const rows = [
    { y: -5, x2: 15 }, { y: -1, x2: 17 }, { y: 3, x2: 13 },
    { y: 7, x2: 15 }, { y: 11, x2: 17 }, { y: 15, x2: 13 },
  ];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <defs><clipPath id={clipId}><rect x="6" y="5.5" width="12" height="11" /></clipPath></defs>
      <path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" />
      <g className="li-comment-feed" clipPath={`url(#${clipId})`}>
        {rows.map((row) => <path key={row.y} d={`M7 ${row.y}h${row.x2 - 7}`} />)}
      </g>
    </svg>
  );
}

function LiveCollaborationIcon({ size }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path className="li-radio-inner li-radio-right" d="M16.247 7.761a6 6 0 0 1 0 8.478" />
      <path className="li-radio-outer li-radio-right" d="M19.075 4.933a10 10 0 0 1 0 14.134" />
      <path className="li-radio-outer li-radio-left" d="M4.925 19.067a10 10 0 0 1 0-14.134" />
      <path className="li-radio-inner li-radio-left" d="M7.753 16.239a6 6 0 0 1 0-8.478" />
      <circle className="li-radio-core" cx="12" cy="12" r="2" />
    </svg>
  );
}

function OverleafMessagesIcon({ size }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path className="li-message-back" d="M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
      <path className="li-message-front" d="M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1" />
      <g className="li-message-dots" fill="currentColor" stroke="none">
        <circle className="li-message-dot li-message-dot-one" cx="12" cy="15.5" r=".8" />
        <circle className="li-message-dot li-message-dot-two" cx="15" cy="15.5" r=".8" />
        <circle className="li-message-dot li-message-dot-three" cx="18" cy="15.5" r=".8" />
      </g>
    </svg>
  );
}

const icons: Record<LatticeIconKind, (props: IconProps) => React.JSX.Element> = {
  "editor-comments": EditorCommentsIcon,
  "live-collaboration": LiveCollaborationIcon,
  "overleaf-messages": OverleafMessagesIcon,
};

export function LatticeAnimatedIcon({ kind, size = 20, playing, reducedMotion, speed = "normal", className }: { kind: LatticeIconKind; size?: number; playing?: boolean; reducedMotion?: boolean; speed?: "normal" | "slow"; playId?: number; className?: string }) {
  const Icon = icons[kind];
  const classes = ["lattice-animated-icon", playing && "is-playing", reducedMotion && "is-reduced", className].filter(Boolean).join(" ");
  const style = { "--li-speed": speed === "slow" ? 1.9 : 1 } as CSSProperties;
  return <span className={classes} style={style}><Icon size={size} /></span>;
}
