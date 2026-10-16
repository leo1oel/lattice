import { useEffect, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { Minus, Plus } from "lucide-react";
import { renderKeycaps } from "../components/ui/render-keycaps";
import { INTERFACE_SCALE_STEPS, interfaceScalePercent, nearestInterfaceStep, type InterfaceZoomChange } from "../settings/interface-scale";

/** How long the pill stays after the last change, unless the pointer is on it. */
const HUD_SHOWN_MS = 1_600;

/**
 * The pill ⌘+, ⌘− and ⌘0 raise at the top of the window, as Notion's zoom
 * pill does: the new size for a moment, with − and + and Reset under the
 * pointer for a writer who reached for the mouse. `revealKey` changes with
 * each change from a key or the menu; Settings changes the size without it.
 */
export function InterfaceZoomHud({ scale, revealKey, onChange }: {
  scale: number;
  revealKey: number;
  onChange: (change: InterfaceZoomChange) => void;
}) {
  const { t } = useLingui();
  // The change whose moment has passed: the pill shows while a newer one is on.
  const [settledKey, setSettledKey] = useState(0);
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    if (!revealKey || hovered) return;
    const timer = window.setTimeout(() => setSettledKey(revealKey), HUD_SHOWN_MS);
    return () => window.clearTimeout(timer);
  }, [hovered, revealKey]);
  const shown = revealKey > 0 && (hovered || settledKey !== revealKey);
  const step = nearestInterfaceStep(scale);
  return (
    <div
      className="interface-zoom-hud"
      data-shown={shown || undefined}
      aria-hidden={!shown}
      inert={!shown}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <button type="button" aria-label={t`Smaller interface`} title={t`Smaller interface`}
        disabled={step <= INTERFACE_SCALE_STEPS[0]} onClick={() => onChange("out")}>
        <Minus size={13} aria-hidden="true" />
      </button>
      <span className="interface-zoom-value" role="status" aria-live="polite">{interfaceScalePercent(step)}</span>
      <button type="button" aria-label={t`Larger interface`} title={t`Larger interface`}
        disabled={step >= INTERFACE_SCALE_STEPS[INTERFACE_SCALE_STEPS.length - 1]} onClick={() => onChange("in")}>
        <Plus size={13} aria-hidden="true" />
      </button>
      <span className="interface-zoom-divider" aria-hidden="true" />
      <button type="button" className="interface-zoom-reset" disabled={step === 1} onClick={() => onChange("reset")}>
        {t`Reset`}{renderKeycaps(["⌘", "0"], undefined, "run")}
      </button>
    </div>
  );
}
