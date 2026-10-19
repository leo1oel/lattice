/**
 * The agent panel's placeholder while the Agent starts: the panel the Agent
 * opens on, measured from the rendered Synara embed. That is a new thread:
 * the thread menu and two controls at the top, the "Work on this paper"
 * suggestions centred in the room left, the composer and the model at the
 * foot. A panel wide enough for the suggestions' descriptions (Synara's own
 * container query) gets taller suggestion rows, as the embed does.
 */
import { useLoadingReveal } from "../components/ui/loading-reveal";
import "./agent-panel-skeleton.css";

/** Title widths (%) of the four suggestions: Polish, Revise, Proofread, Check references. */
const SUGGESTIONS = [24, 26, 38, 66];

export function AgentPanelSkeleton({ bodyHidden }: {
  /** The room the suggestions take is lent to a note (the Agent being slow). */
  bodyHidden?: boolean;
}) {
  const reveal = useLoadingReveal("agent");
  return (
    <div className="agent-skeleton loading-sheen loading-reveal" style={reveal} aria-hidden="true">
      <div className="agent-skeleton-header">
        <span className="agent-skeleton-thread" />
        <span className="agent-skeleton-chip" data-end />
        <span className="agent-skeleton-square" />
      </div>
      <div className="agent-skeleton-body" data-hidden={bodyHidden || undefined}>
        <span className="agent-skeleton-heading" />
        <span className="agent-skeleton-description"><span /><span /></span>
        {SUGGESTIONS.map((width, index) => (
          <div key={index} className="agent-skeleton-suggestion">
            <span className="agent-skeleton-tile" />
            <span className="agent-skeleton-lines"><span style={{ width: `${width}%` }} /><span /></span>
          </div>
        ))}
      </div>
      <div className="agent-skeleton-composer">
        <span className="agent-skeleton-round" />
        <span className="agent-skeleton-placeholder" />
        <span className="agent-skeleton-round" data-end />
        <span className="agent-skeleton-round" />
      </div>
      <span className="agent-skeleton-model" />
    </div>
  );
}
