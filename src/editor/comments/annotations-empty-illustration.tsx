/**
 * The Annotations panel's empty-list drawing, in the line work of
 * `components/ui/empty-illustration.tsx`, kept with the panel so the eager
 * bundle does not carry it: the panel loads on first open.
 */
import { Line } from "../../components/ui/empty-illustration";

/** A manuscript page right of its margin, its top corner turned down. */
const MANUSCRIPT = "M24 6.5a2.5 2.5 0 0 1 2.5-2.5h16.5l7 7v30.5a2.5 2.5 0 0 1-2.5 2.5h-21a2.5 2.5 0 0 1-2.5-2.5z";
const FOLD = "M43 4v4.5a2.5 2.5 0 0 0 2.5 2.5h4.5";
/** An annotation's pin in the margin, centred on `y`. */
const pin = (y: number) => `M14 ${y - 4.75}a4.75 4.75 0 1 1 0 9.5a4.75 4.75 0 1 1 0-9.5z`;

/**
 * A manuscript page and the margin beside it, as an annotated PDF reads:
 * two passages still carry their band and their pins stand in the margin.
 * Every open note dealt with, each pin holds a check; with none settled
 * yet, the pins are open rings on the thread.
 */
function drawManuscript(settled: boolean) {
  const marks = [{ y: 17, band: 20, order: 4 }, { y: 31, band: 13, order: 5 }];
  return (
    <>
      <path className="empty-illustration-paper" d={MANUSCRIPT} />
      {marks.map(({ y, band }) => <rect key={y} className="empty-illustration-band" x="27" y={y - 3} width={band} height="6" rx=".75" />)}
      <Line d={MANUSCRIPT} i={0} />
      <Line d={FOLD} i={0.5} />
      <Line d="M29 11h9" i={1} className="empty-illustration-strong" />
      <Line d="M29 17h16M29 31h9" i={2} />
      <Line d="M29 24h17M29 38h12" i={3} className="empty-illustration-faint" />
      {marks.map(({ y, order }) => (
        <g key={y} className="empty-illustration-badge" style={{ transformOrigin: `14px ${y}px` }}>
          <Line d={`M19.5 ${y}H24`} i={order} className="empty-illustration-faint empty-illustration-dashed" />
          <path className="empty-illustration-paper" d={pin(y)} />
          {settled ? (
            <>
              <Line d={pin(y)} i={order} />
              <Line d={`M11.9 ${y + 0.1}l1.5 1.5l2.8-3`} i={order + 1} className="empty-illustration-warp" />
            </>
          ) : (
            <Line d={pin(y)} i={order} className="empty-illustration-weft" />
          )}
        </g>
      ))}
    </>
  );
}

/** An empty Open list (`settled`: every note dealt with) or an empty Resolved one. */
export function AnnotationsEmptyIllustration({ settled, size }: { settled: boolean; size: "compact" | "default" }) {
  return (
    <svg className="empty-illustration" data-kind={settled ? "annotations-clear" : "annotations-unsettled"} data-size={size} viewBox="0 0 64 48" fill="none" aria-hidden="true" focusable="false">
      {drawManuscript(settled)}
    </svg>
  );
}
