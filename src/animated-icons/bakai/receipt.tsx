import { useId } from "react";

// SVG path coordinates and generated mask/clip IDs are not user-facing text.
/* eslint lingui/no-unlocalized-strings: ["warn", { "ignoreNames": ["RECEIPT", "PAPER", "SLOT", "TEAR_CUT", "mask", "clip"] }] */
const RECEIPT = "M216,40H40A16,16,0,0,0,24,56V208a8,8,0,0,0,11.58,7.15L64,200.94l28.42,14.21a8,8,0,0,0,7.16,0L128,200.94l28.42,14.21a8,8,0,0,0,7.16,0L192,200.94l28.42,14.21A8,8,0,0,0,232,208V56A16,16,0,0,0,216,40ZM176,144H80a8,8,0,0,1,0-16h96a8,8,0,0,1,0,16Zm0-32H80a8,8,0,0,1,0-16h96a8,8,0,0,1,0,16Z";
const PAPER = "M24,-400V208a8,8,0,0,0,11.58,7.15L64,200.94l28.42,14.21a8,8,0,0,0,7.16,0L128,200.94l28.42,14.21a8,8,0,0,0,7.16,0L192,200.94l28.42,14.21A8,8,0,0,0,232,208V-400ZM176,144H80a8,8,0,0,1,0-16h96a8,8,0,0,1,0,16Zm0-32H80a8,8,0,0,1,0-16h96a8,8,0,0,1,0,16Z";
const SLOT = "M216,40H40A16,16,0,0,0,24,56H-40V400H296V56H232A16,16,0,0,0,216,40Z";
const TEAR_CUT = "M24,63.06a8,8,0,0,0,11.58,7.15L64,56l28.42,14.21a8,8,0,0,0,7.16,0L128,56l28.42,14.21a8,8,0,0,0,7.16,0L192,56l28.42,14.21A8,8,0,0,0,232,63.06V-96H24Z";

/** The original sheet tears away while rigid paper feeds through a top-only slot. */
export function ReceiptLive({ size = 16, className }: { size?: number; className?: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const mask = `rcCut-${uid}`;
  const clip = `rcSlot-${uid}`;
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="currentColor" className={className}>
      <mask id={mask} maskUnits="userSpaceOnUse" x="-64" y="-96" width="384" height="384">
        <rect x="-64" y="-96" width="384" height="384" fill="#fff" />
        <path className="rc-cut" d={TEAR_CUT} fill="#000" />
      </mask>
      <clipPath id={clip}><path d={SLOT} /></clipPath>
      <g className="rc-slot" clipPath={`url(#${clip})`}>
        <g className="rc-tense"><g className="rc-feed"><path d={PAPER} /></g></g>
      </g>
      <g className="rc-fall"><g className="rc-rip" mask={`url(#${mask})`}><path d={RECEIPT} /></g></g>
    </svg>
  );
}
