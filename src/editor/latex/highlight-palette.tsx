import { useEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { Check, ChevronLeft, Eraser, Palette, PencilLine } from "lucide-react";
import { AppleColorPicker } from "../../components/ui/apple-color-picker";
import { Button } from "../../components/ui/button";
import { FluidHoverSurface } from "../../components/ui/fluid-hover-surface";
import { Input } from "../../components/ui/input";
import { HIGHLIGHTERS, saveHighlightMeanings, useHighlightPrefs } from "./highlighters";
import "./highlight-palette.css";

// eslint-disable-next-line lingui/no-unlocalized-strings -- a type specimen on the tint, not copy
const SPECIMEN = "Aa";

/**
 * What the toolbar's highlighter caret opens: the six highlighters by what
 * they mean, each drawn as "Aa" on its tint so the printed result shows
 * before choosing, applied with one click or its digit; the writer's custom
 * colours; Remove when the selection sits in a highlight; and, behind "Custom
 * colour…", the full picker the tool used to open straight away.
 */
export function HighlightPalette(props: {
  /** The colour of the highlight around the selection, or null outside one. */
  current: string | null;
  onApply: (color: string) => void;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const { i18n, t } = useLingui();
  const prefs = useHighlightPrefs();
  const [view, setView] = useState<"list" | "edit" | "custom">("list");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const current = props.current?.toUpperCase() ?? null;
  // The list takes focus itself, not its first row: the digits work at once,
  // and a pointer that opened it is not answered with a focus ring.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (view === "list") listRef.current?.focus();
  }, [view]);

  if (view === "custom") {
    return (
      <div className="hl-palette hl-palette-custom">
        <button type="button" className="hl-row hl-back" onClick={() => setView("list")}>
          <ChevronLeft size={14} strokeWidth={1.5} aria-hidden="true" />
          <span>{t`Highlighters`}</span>
        </button>
        <AppleColorPicker
          value={current && /^#[0-9A-F]{6}$/.test(current) ? current : prefs.last}
          onConfirm={(color, opacity) => props.onApply(blendOnPaper(color, opacity))}
          onCancel={props.onCancel}
        />
      </div>
    );
  }

  if (view === "edit") {
    const save = () => {
      saveHighlightMeanings(Object.fromEntries(HIGHLIGHTERS.map((item) => [item.hex, drafts[item.hex] ?? ""])));
      setView("list");
    };
    return (
      <form
        className="hl-palette hl-palette-edit"
        aria-label={t`Highlighter meanings`}
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        {HIGHLIGHTERS.map((item, index) => (
          <label key={item.hex} className="hl-edit-row">
            <span className="hl-chip" style={{ background: item.hex }} aria-hidden="true">{SPECIMEN}</span>
            <Input
              controlSize="compact"
              autoFocus={index === 0}
              aria-label={i18n._(item.name)}
              placeholder={i18n._(item.meaning)}
              maxLength={40}
              value={drafts[item.hex] ?? ""}
              onChange={(event) => setDrafts((existing) => ({ ...existing, [item.hex]: event.target.value }))}
            />
          </label>
        ))}
        <div className="hl-edit-actions">
          <Button type="button" size="compact" variant="ghost" onClick={() => setDrafts({})}>{t`Reset`}</Button>
          <Button type="submit" size="compact" variant="tinted">{t`Done`}</Button>
        </div>
      </form>
    );
  }

  return (
    <div
      ref={listRef}
      tabIndex={-1}
      className="hl-palette"
      role="group"
      aria-label={t`Highlight color`}
      onKeyDown={(event) => {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        const match = HIGHLIGHTERS.find((item) => item.key === event.key);
        if (!match) return;
        event.preventDefault();
        props.onApply(match.hex);
      }}
    >
      <div className="hl-list fluid-hover-surface">
        <FluidHoverSurface selector=".hl-item" follow={null} />
        {HIGHLIGHTERS.map((item) => {
          const meaning = prefs.meaningOf(item);
          const color = i18n._(item.name);
          const on = current === item.hex;
          return (
            <button
              key={item.hex}
              type="button"
              className="hl-item"
              aria-pressed={on}
              aria-label={t`${meaning}, ${color}`}
              onClick={() => props.onApply(item.hex)}
            >
              <span className="hl-chip" style={{ background: item.hex }} aria-hidden="true">{SPECIMEN}</span>
              <span className="hl-meaning">{meaning}</span>
              {on && <Check className="hl-check" size={14} strokeWidth={1.5} aria-hidden="true" />}
              <kbd className="hl-key" aria-hidden="true">{item.key}</kbd>
            </button>
          );
        })}
      </div>
      {prefs.custom.length > 0 && (
        <div className="hl-custom" role="group" aria-label={t`Your colours`}>
          {prefs.custom.map((hex) => (
            <button
              key={hex}
              type="button"
              className="hl-dot"
              style={{ background: hex }}
              aria-pressed={current === hex}
              aria-label={t`Highlight ${hex}`}
              title={hex}
              onClick={() => props.onApply(hex)}
            />
          ))}
        </div>
      )}
      <div className="hl-rows fluid-hover-surface">
        <FluidHoverSurface selector=".hl-row" follow={null} />
        {current !== null && (
          <button type="button" className="hl-row" onClick={props.onRemove}>
            <Eraser size={14} strokeWidth={1.5} aria-hidden="true" />
            <span>{t`Remove highlight`}</span>
          </button>
        )}
        <button type="button" className="hl-row" onClick={() => setView("custom")}>
          <Palette size={14} strokeWidth={1.5} aria-hidden="true" />
          <span>{t`Custom colour…`}</span>
        </button>
        <button
          type="button"
          className="hl-row"
          onClick={() => {
            setDrafts(Object.fromEntries(HIGHLIGHTERS.filter(prefs.renamed).map((item) => [item.hex, prefs.meaningOf(item)])));
            setView("edit");
          }}
        >
          <PencilLine size={14} strokeWidth={1.5} aria-hidden="true" />
          <span>{t`Edit meanings…`}</span>
        </button>
      </div>
    </div>
  );
}

/** `color` at `opacity` percent, laid over white paper: LaTeX's `\colorbox` takes no alpha. */
function blendOnPaper(color: string, opacity: number): string {
  if (opacity >= 100) return color.toUpperCase();
  const channels = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(color.slice(offset, offset + 2), 16);
    return Math.round(channel * (opacity / 100) + 255 * (1 - opacity / 100)).toString(16).padStart(2, "0");
  });
  return `#${channels.join("")}`.toUpperCase();
}
