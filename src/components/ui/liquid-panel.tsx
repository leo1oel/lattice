import * as React from "react"

import "./liquid-panel.css"

/** Decorative surface only. The Radix Content remains the layout, focus and hit-test owner. */
function LiquidPanelSurface() {
  const filterId = `liquid-goo-${React.useId().replace(/:/g, "")}`

  return (
    <svg
      className="liquid-panel-surface"
      aria-hidden="true"
      focusable="false"
      pointerEvents="none"
      preserveAspectRatio="none"
      viewBox="0 0 100 100"
    >
      <defs>
        <filter id={filterId} x="-40%" y="-40%" width="180%" height="180%" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceGraphic" stdDeviation="4.5" result="blur" />
          <feColorMatrix in="blur" result="threshold" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -9" />
          <feMorphology in="threshold" operator="erode" radius="1" result="eroded" />
          <feComposite in="threshold" in2="eroded" operator="out" result="outline" />
          <feFlood floodColor="var(--liquid-outline, #DFE2E8)" result="outline-color" />
          <feComposite in="outline-color" in2="outline" operator="in" result="colored-outline" />
          <feMerge><feMergeNode in="threshold" /><feMergeNode in="colored-outline" /></feMerge>
        </filter>
      </defs>
      <g className="liquid-panel-shadow">
        <rect className="liquid-panel-shadow-sheet" x="1" y="1" width="98" height="98" rx="7" />
        <LiquidPanelNecks />
      </g>
      <g className="liquid-panel-goo" style={{ filter: `url(#${filterId})` }}>
        <rect className="liquid-panel-sheet" x="1" y="1" width="98" height="98" rx="7" />
        <LiquidPanelNecks />
      </g>
    </svg>
  )
}

function LiquidPanelNecks() {
  return (
    <>
      <rect className="liquid-panel-neck liquid-panel-neck-top" x="38" y="92" width="24" height="16" rx="8" />
      <rect className="liquid-panel-neck liquid-panel-neck-bottom" x="38" y="-8" width="24" height="16" rx="8" />
      <rect className="liquid-panel-neck liquid-panel-neck-left" x="92" y="38" width="16" height="24" rx="8" />
      <rect className="liquid-panel-neck liquid-panel-neck-right" x="-8" y="38" width="16" height="24" rx="8" />
    </>
  )
}

function LiquidPanelViewport({ children }: { children: React.ReactNode }) {
  return <div className="liquid-panel-viewport">{children}</div>
}

const liquidPanelClassName = "liquid-panel"

export { LiquidPanelSurface, LiquidPanelViewport, liquidPanelClassName }
