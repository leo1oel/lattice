const ARROW = "M224,128A96,96,0,0,1,62.11,197.82a8,8,0,1,1,11-11.64A80,80,0,1,0,71.43,71.43C67.9,75,64.58,78.51,61.35,82L77.66,98.34A8,8,0,0,1,72,112H32a8,8,0,0,1-8-8V64a8,8,0,0,1,13.66-5.66L50,70.7c3.22-3.49,6.54-7,10.06-10.55A96,96,0,0,1,224,128Z";

/** Exact Clock Back component from bakai.me's author-provided copy-code payload. */
export function ClockBackLive({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="currentColor" className={className}>
      <path className="ck-arrow" d={ARROW} />
      <path className="ck-hour" d="M128,128L168,152" fill="none" stroke="currentColor" strokeWidth="16" strokeLinecap="round" />
      <path className="ck-min" d="M128,128L128,80" fill="none" stroke="currentColor" strokeWidth="16" strokeLinecap="round" />
    </svg>
  );
}
