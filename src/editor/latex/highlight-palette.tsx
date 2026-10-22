import { useEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { Check, ChevronLeft, Eraser, Highlighter as PenIcon, PencilLine, Plus } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { ColorPicker } from "../../components/ui/color-picker";
import { FluidHoverSurface } from "../../components/ui/fluid-hover-surface";
import { spring } from "../../components/ui/motion-values";
import { contrastRatio, fitContrast } from "../../settings/theme-customization";
import { HIGHLIGHTERS, PAPER_INK, PAPER_TONES, saveHighlightMeanings, useHighlightPrefs, type Highlighter } from "./highlighters";
import "./highlight-palette.css";

// eslint-disable-next-line lingui/no-unlocalized-strings -- a type specimen on the tint, not copy
const SPECIMEN = "Aa";

/** Black text needs 4.5:1 on a highlight; "Lighten" goes well past that, to a paper tint. */
const READABLE = 4.5;
const LIGHTENED = 9;

/**
 * What the toolbar's highlighter caret opens: the six highlighters by what
 * they mean, each drawn as "Aa" on its tint so the printed result shows
 * before choosing, applied with one click or its digit. The pen's color is
 * marked, a meaning is renamed where it sits, and the writer's own colors end
 * in "+", which opens the custom picker.
 */
export function HighlightPalette(props: {
  /** The color of the highlight around the selection, or null outside one. */
  current: string | null;
  /** The selected text, which the custom picker sets on paper. */
  sample?: string;
  /** Highlight colors the document already uses, most used first. */
  documentColors?: readonly string[];
  onApply: (color: string) => void;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const { i18n, t } = useLingui();
  const prefs = useHighlightPrefs();
  const reduceMotion = useReducedMotion();
  const [view, setViewState] = useState<"list" | "custom">("list");
  // The first view opens with the popover; only a switch between views fades.
  const [switched, setSwitched] = useState(false);
  const setView = (next: "list" | "custom") => {
    setSwitched(true);
    setViewState(next);
  };
  const [renaming, setRenaming] = useState<string | null>(null);
  const current = props.current?.toUpperCase() ?? null;
  // The list takes focus itself, not its first row: the digits work at once,
  // and a pointer that opened it is not answered with a focus ring.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (view === "list" && renaming === null) listRef.current?.focus();
  }, [view, renaming]);
  // Switching views crossfades the content; the popover itself just resizes.
  const fade = {
    initial: switched ? { opacity: 0 } : false,
    animate: { opacity: 1 },
    transition: reduceMotion ? { duration: 0 } : spring.fast,
  } as const;

  if (view === "custom") {
    const sample = (props.sample ?? "").replace(/\s+/g, " ").trim().slice(0, 64) || t`Highlighted text`;
    return (
      <motion.div key="custom" className="hl-palette hl-palette-custom" {...fade}>
        <button type="button" className="hl-row hl-back" onClick={() => setView("list")}>
          <ChevronLeft size={14} strokeWidth={1.5} aria-hidden="true" />
          <span>{t`Highlighters`}</span>
        </button>
        <ColorPicker
          label={t`Custom highlight colour`}
          value={current && /^#[0-9A-F]{6}$/.test(current) ? current : prefs.last}
          confirmLabel={t`Highlight`}
          onConfirm={props.onApply}
          onCancel={props.onCancel}
          preview={(hex) => (
            <div className="hl-paper">
              <mark style={{ background: hex }}>{sample}</mark>
            </div>
          )}
          legibility={(hex) => {
            const ratio = contrastRatio(hex, PAPER_INK);
            return ratio >= READABLE ? { ok: true, ratio } : { ok: false, ratio, fix: fitContrast(hex, [PAPER_INK], LIGHTENED, "dark").toUpperCase() };
          }}
          swatches={[
            { id: "document", label: t`In this document`, colors: (props.documentColors ?? []).slice(0, 8) },
            { id: "yours", label: t`Your colours`, colors: prefs.custom },
            { id: "paper", label: t`Paper tones`, colors: PAPER_TONES },
          ]}
        />
      </motion.div>
    );
  }

  const row = (item: Highlighter) => {
    const meaning = prefs.meaningOf(item);
    const color = i18n._(item.name);
    if (renaming === item.hex) {
      return (
        <form
          key={item.hex}
          className="hl-item hl-item-rename"
          onSubmit={(event) => {
            event.preventDefault();
            const value = new FormData(event.currentTarget).get("meaning");
            const renamed = Object.fromEntries(HIGHLIGHTERS.filter(prefs.renamed).map((other) => [other.hex, prefs.meaningOf(other)]));
            saveHighlightMeanings({ ...renamed, [item.hex]: typeof value === "string" ? value : "" });
            setRenaming(null);
          }}
        >
          <span className="hl-chip" style={{ background: item.hex }} aria-hidden="true">{SPECIMEN}</span>
          <input
            name="meaning"
            className="hl-rename-input"
            autoFocus
            maxLength={40}
            defaultValue={prefs.renamed(item) ? meaning : ""}
            placeholder={i18n._(item.meaning)}
            aria-label={t`Meaning of ${color}`}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              // Esc reverts the name; a second one closes the palette.
              event.preventDefault();
              event.stopPropagation();
              setRenaming(null);
            }}
            onBlur={(event) => event.currentTarget.form?.requestSubmit()}
          />
          <kbd className="hl-key" aria-hidden="true">↩</kbd>
        </form>
      );
    }
    const on = current === item.hex;
    const pen = !on && prefs.last === item.hex;
    return (
      <div key={item.hex} className="hl-item" data-on={on || undefined}>
        <button
          type="button"
          className="hl-item-apply"
          aria-pressed={on}
          aria-label={pen ? t`${meaning}, ${color}, the pen's colour` : t`${meaning}, ${color}`}
          onClick={() => props.onApply(item.hex)}
        >
          <span className="hl-chip" style={{ background: item.hex }} aria-hidden="true">{SPECIMEN}</span>
          <span className="hl-meaning">{meaning}</span>
          {on
            ? <Check className="hl-mark" size={14} strokeWidth={1.8} aria-hidden="true" />
            : pen ? <PenIcon className="hl-mark hl-mark-pen" size={12} strokeWidth={1.8} aria-hidden="true" /> : <span aria-hidden="true" />}
          <kbd className="hl-key" aria-hidden="true">{item.key}</kbd>
        </button>
        <button type="button" className="hl-rename" aria-label={t`Rename ${meaning}`} title={t`Rename`} onClick={() => setRenaming(item.hex)}>
          <PencilLine size={12} strokeWidth={1.6} aria-hidden="true" />
        </button>
      </div>
    );
  };

  return (
    <motion.div
      key="list"
      ref={listRef}
      tabIndex={-1}
      className="hl-palette"
      role="group"
      aria-label={t`Highlight color`}
      {...fade}
      onKeyDown={(event) => {
        if (renaming !== null || event.metaKey || event.ctrlKey || event.altKey) return;
        const match = HIGHLIGHTERS.find((item) => item.key === event.key);
        if (!match) return;
        event.preventDefault();
        props.onApply(match.hex);
      }}
    >
      <div className="hl-list fluid-hover-surface">
        <FluidHoverSurface selector=".hl-item" follow={null} />
        {HIGHLIGHTERS.map(row)}
      </div>
      <div className="hl-yours" role="group" aria-label={t`Your colours`}>
        <span className="hl-yours-chips">
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
          <button type="button" className="hl-dot hl-dot-add" aria-label={t`Custom colour…`} title={t`Custom colour…`} onClick={() => setView("custom")}>
            <Plus size={12} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </span>
      </div>
      {current !== null && (
        <div className="hl-rows fluid-hover-surface">
          <FluidHoverSurface selector=".hl-row" follow={null} />
          <button type="button" className="hl-row" onClick={props.onRemove}>
            <Eraser size={14} strokeWidth={1.5} aria-hidden="true" />
            <span>{t`Remove highlight`}</span>
          </button>
        </div>
      )}
    </motion.div>
  );
}
