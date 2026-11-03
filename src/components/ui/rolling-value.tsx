import { useReducer, type ReactNode } from "react";
import "./rolling-value.css";

type Shown = { value: number; of: unknown; roll?: "up" | "down" };

function show(shown: Shown, next: { value: number; of: unknown }): Shown {
  const roll = next.of !== shown.of ? undefined : next.value > shown.value ? "up" : "down";
  return { ...next, roll };
}

/**
 * A count that rolls to its next value: the new one comes up from below when
 * it rose and down from above when it fell, as an odometer's wheel turns. It
 * rolls only when the same thing's count changes (`of`, a paper's key when
 * a recycled row shows another paper), never when it is first drawn.
 */
export function RollingValue(props: { value: number; of?: unknown; children: ReactNode }) {
  const { value, of } = props;
  const [shown, dispatch] = useReducer(show, { value, of });
  // Seen in the render that brings the change, so the new value rolls in from its first frame.
  if (value !== shown.value || of !== shown.of) dispatch({ value, of });
  return <span key={value} className="ui-rolling-value" data-roll={shown.value === value && shown.of === of ? shown.roll : undefined}>{props.children}</span>;
}
