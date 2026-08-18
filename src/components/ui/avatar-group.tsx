import { type MouseEvent, type ReactNode, useRef } from "react";
import "./avatar-group.css";

const DEFAULT_LIFT = -2;
const DEFAULT_FALLOFF = 0.35;
const DEFAULT_SCALE = 1.025;
const EASE_IN = "cubic-bezier(0.22, 1, 0.36, 1)";
const EASE_OUT = "cubic-bezier(0.2, 0.8, 0.2, 1.05)";

/** A compact avatar stack whose neighbors rise gently with the hovered avatar. */
export function AvatarGroup(props: {
  children: ReactNode;
  className?: string;
  ariaLabel: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  const setShifts = (activeIndex: number | null, phase: "in" | "out") => {
    const root = rootRef.current;
    if (!root) return;

    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    const styles = getComputedStyle(root);
    const numberProperty = (name: string, fallback: number) => {
      const value = Number.parseFloat(styles.getPropertyValue(name));
      return Number.isFinite(value) ? value : fallback;
    };
    const lift = numberProperty("--avatar-group-lift", DEFAULT_LIFT);
    const falloff = numberProperty("--avatar-group-falloff", DEFAULT_FALLOFF);
    const scale = numberProperty("--avatar-group-scale", DEFAULT_SCALE);
    const easing = styles.getPropertyValue(
      phase === "out" ? "--avatar-group-ease-out" : "--avatar-group-ease-in",
    ).trim() || (phase === "out" ? EASE_OUT : EASE_IN);

    Array.from(root.children).forEach((element, index) => {
      if (!(element instanceof HTMLElement)) return;
      element.style.transitionTimingFunction = easing;
      if (activeIndex === null || reducedMotion) {
        element.style.setProperty("--avatar-group-shift", "0px");
        element.style.setProperty("--avatar-group-active-scale", "1");
        return;
      }
      const distance = Math.abs(index - activeIndex);
      element.style.setProperty(
        "--avatar-group-shift",
        `${(lift * Math.pow(falloff, distance)).toFixed(3)}px`,
      );
      element.style.setProperty(
        "--avatar-group-active-scale",
        index === activeIndex ? String(scale) : "1",
      );
    });
  };

  const liftHoveredAvatar = (event: MouseEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    if (!root) return;
    let avatar = event.target as HTMLElement | null;
    while (avatar && avatar.parentElement !== root) avatar = avatar.parentElement;
    if (!avatar) return;
    const index = Array.prototype.indexOf.call(root.children, avatar) as number;
    if (index >= 0) setShifts(index, "in");
  };

  return (
    <div
      ref={rootRef}
      className={`avatar-group${props.className ? ` ${props.className}` : ""}`}
      aria-label={props.ariaLabel}
      onMouseOver={liftHoveredAvatar}
      onMouseLeave={() => setShifts(null, "out")}
    >
      {props.children}
    </div>
  );
}
