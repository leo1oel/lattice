import { useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { ZoomIn, ZoomOut } from "lucide-react";
import { Tip } from "../components/icon-tip";
import { useNonPassiveWheel } from "../hooks/use-non-passive-wheel";
import type { ZoomScaleUpdate } from "./use-zoom-scale";

const step = (delta: number) => (current: number) => Number((current + delta).toFixed(1));

/** Zoom out / typed percentage (also scroll-to-zoom) / zoom in, shared by the HTML and image previews. */
export function ZoomControls({ scale, min, max, onScale, className, groupLabel, inputLabel }: {
  scale: number;
  min: number;
  max: number;
  onScale: (next: ZoomScaleUpdate) => void;
  className: string;
  /** Names the control group for assistive technology when the surrounding UI does not. */
  groupLabel?: string;
  inputLabel: string;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState<string | null>(null);
  const labelRef = useRef<HTMLLabelElement | null>(null);
  useNonPassiveWheel(labelRef, (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!event.deltaY) return;
    onScale(step(event.deltaY < 0 ? 0.1 : -0.1));
  });
  const commitDraft = () => {
    const percent = Number((draft ?? "").trim().replace(/%$/, ""));
    if (Number.isFinite(percent) && percent > 0) onScale(percent / 100);
    setDraft(null);
  };
  return (
    <div className={className} {...(groupLabel ? { role: "group", "aria-label": groupLabel } : {})}>
      <Tip label={t`Zoom out`}>
        <button type="button" disabled={scale <= min} onClick={() => onScale(step(-0.1))}>
          <ZoomOut size={14} aria-hidden="true" />
        </button>
      </Tip>
      <label ref={labelRef} className="asset-preview-zoom-value" title={t`Enter a zoom percentage or scroll to zoom`}>
        <input
          aria-label={inputLabel}
          inputMode="decimal"
          value={draft ?? String(Math.round(scale * 100))}
          onFocus={(event) => {
            const input = event.currentTarget;
            setDraft(String(Math.round(scale * 100)));
            requestAnimationFrame(() => input.select());
          }}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitDraft}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <span aria-hidden="true">%</span>
      </label>
      <Tip label={t`Zoom in`}>
        <button type="button" disabled={scale >= max} onClick={() => onScale(step(0.1))}>
          <ZoomIn size={14} aria-hidden="true" />
        </button>
      </Tip>
    </div>
  );
}
