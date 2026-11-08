import { useReducer } from "react";
import { useLingui } from "@lingui/react/macro";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { SettingsGroup, SettingsRow } from "../components/ui/settings-row";
import type { AppearanceSettings } from "./app-settings";
import { FONT_SIZE_RANGE, LINE_HEIGHT_RANGE, cssFontFamily, normalizeFontName } from "./editor-fonts";
import { SliderRow } from "./settings-controls";

type EditorFontSettingsProps = {
  appearance: AppearanceSettings;
  setAppearance: (appearance: AppearanceSettings) => void;
};

/** A face offered by name: its stored family, and the name the list shows. */
type Face = readonly [family: string, label: string];

/* eslint-disable lingui/no-unlocalized-strings -- font family and product names */
// Each list leaves out its editor's own default, which "Default" already is.
// The two bundled faces (assets/fonts/reading-aids) are on every Mac running
// Lattice; the rest ship with macOS. Inter is the bundled variable cut.
const SOURCE_FACES: readonly Face[] = [
  ["ui-monospace", "SF Mono"],
  ["Menlo", "Menlo"],
  ["Inter Variable", "Inter"],
  ["system-ui", "SF Pro"],
  ["Atkinson Hyperlegible", "Atkinson Hyperlegible"],
  ["OpenDyslexic", "OpenDyslexic"],
];
const PROSE_FACES: readonly Face[] = [
  ["system-ui", "SF Pro"],
  ["ui-serif", "New York"],
  ["Georgia", "Georgia"],
  ["Atkinson Hyperlegible", "Atkinson Hyperlegible"],
  ["OpenDyslexic", "OpenDyslexic"],
  ["Ioskeley Mono", "Ioskeley Mono"],
];
/* eslint-enable lingui/no-unlocalized-strings */

/* eslint-disable lingui/no-unlocalized-strings -- select values, CSS generic families and sample text */
// Radix Select reserves the empty value, so the default and the free-text
// choice take words no family is named.
const DEFAULT_CHOICE = "__default";
const OTHER_CHOICE = "__other";
const GENERICS = ["monospace", "serif", "sans-serif"];
const SAMPLE = "mmmmmmmmmmlli1WQ@#";

/**
 * Whether a face is installed: text set in it measures differently from the
 * bare generic families. Only asked of a typed name — a bundled face counts
 * as missing until its first use loads it.
 */
function fontInstalled(name: string): boolean {
  try {
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return true;
    return GENERICS.some((generic) => {
      context.font = `72px ${generic}`;
      const width = context.measureText(SAMPLE).width;
      context.font = `72px ${cssFontFamily(name)}, ${generic}`;
      return context.measureText(SAMPLE).width !== width;
    });
  } catch {
    return true;
  }
}
/* eslint-enable lingui/no-unlocalized-strings */

/**
 * One editor's face: a short list, or any installed face by name. The name
 * applies as it is typed; one that is not installed falls back to the
 * editor's default stack and says so.
 */
function FontFaceRows(props: {
  id: string;
  label: string;
  faces: readonly Face[];
  value: string;
  onChange: (family: string) => void;
}) {
  const { t } = useLingui();
  const listed = props.faces.some(([family]) => family === props.value);
  // Whether the free-text row is open, and what is typed in it: the typed
  // text keeps its spaces while the stored name is trimmed.
  const [{ other, draft }, update] = useReducer(
    (state: { other: boolean; draft: string }, next: Partial<{ other: boolean; draft: string }>) => ({ ...state, ...next }),
    null,
    () => {
      const typed = Boolean(props.value) && !listed;
      return { other: typed, draft: typed ? props.value : "" };
    },
  );
  const choice = other ? OTHER_CHOICE : props.value || DEFAULT_CHOICE;
  const name = normalizeFontName(draft);
  const missing = other && Boolean(name) && !fontInstalled(name);

  const choose = (next: string) => {
    if (next === OTHER_CHOICE) {
      update({ other: true });
      if (name) props.onChange(name);
      return;
    }
    update({ other: false });
    props.onChange(next === DEFAULT_CHOICE ? "" : next);
  };

  return (
    <>
      <SettingsRow label={props.label} data-setting={props.id}>
        <Select value={choice} onValueChange={choose}>
          <SelectTrigger aria-label={props.label}><SelectValue /></SelectTrigger>
          <SelectContent data-settings-control="true" position="popper" align="end">
            <SelectItem value={DEFAULT_CHOICE}>{t`Default`}</SelectItem>
            {props.faces.map(([family, label]) => (
              <SelectItem key={family} value={family}>
                <span style={{ fontFamily: cssFontFamily(family) }}>{label}</span>
              </SelectItem>
            ))}
            <SelectItem value={OTHER_CHOICE}>{t`Other installed font…`}</SelectItem>
          </SelectContent>
        </Select>
      </SettingsRow>
      {other && (
        <SettingsRow
          label={t`Font name`}
          htmlFor={`${props.id}-name`}
          description={missing ? t`Not installed, so the default is shown` : undefined}
        >
          <Input
            id={`${props.id}-name`}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            maxLength={80}
            aria-invalid={missing || undefined}
            // eslint-disable-next-line lingui/no-unlocalized-strings -- a font name as an example
            placeholder="Fira Code"
            value={draft}
            onChange={(event) => {
              update({ draft: event.target.value });
              props.onChange(normalizeFontName(event.target.value));
            }}
          />
        </SettingsRow>
      )}
    </>
  );
}

const lineHeightLabel = (value: number) => value.toFixed(2);

/**
 * Settings → Appearance: the face, size and line height of the source editor
 * and of the visual Markdown editor, chosen apart. Every editor on screen,
 * split views and snapshots included, takes a change as it is made.
 */
export function EditorFontSettingsGroups(props: EditorFontSettingsProps) {
  const { t } = useLingui();
  const { appearance } = props;
  const patch = (next: Partial<AppearanceSettings>) => props.setAppearance({ ...appearance, ...next });
  const [minimumSize, maximumSize] = FONT_SIZE_RANGE;
  const [minimumLine, maximumLine] = LINE_HEIGHT_RANGE;

  return (
    <>
      <SettingsGroup title={t`Source editor`} data-setting="source-editor-type">
        <FontFaceRows
          id="source-font"
          label={t`Font`}
          faces={SOURCE_FACES}
          value={appearance.sourceFont}
          onChange={(sourceFont) => patch({ sourceFont })}
        />
        <SliderRow
          id="editor-font-size"
          data-setting="editor-font-size"
          label={t`Font size`}
          min={minimumSize}
          max={maximumSize}
          value={appearance.editorFontSize}
          unit="px"
          onChange={(editorFontSize) => patch({ editorFontSize })}
        />
        <SliderRow
          id="source-line-height"
          data-setting="source-line-height"
          label={t`Line height`}
          min={minimumLine}
          max={maximumLine}
          step={0.05}
          value={appearance.sourceLineHeight}
          format={lineHeightLabel}
          onChange={(sourceLineHeight) => patch({ sourceLineHeight })}
        />
      </SettingsGroup>
      <SettingsGroup title={t`Visual Markdown editor`} data-setting="prose-editor-type">
        <FontFaceRows
          id="prose-font"
          label={t`Font`}
          faces={PROSE_FACES}
          value={appearance.proseFont}
          onChange={(proseFont) => patch({ proseFont })}
        />
        <SliderRow
          id="prose-font-size"
          data-setting="prose-font-size"
          label={t`Font size`}
          min={minimumSize}
          max={maximumSize}
          value={appearance.proseFontSize}
          unit="px"
          onChange={(proseFontSize) => patch({ proseFontSize })}
        />
        <SliderRow
          id="prose-line-height"
          data-setting="prose-line-height"
          label={t`Line height`}
          min={minimumLine}
          max={maximumLine}
          step={0.05}
          value={appearance.proseLineHeight}
          format={lineHeightLabel}
          onChange={(proseLineHeight) => patch({ proseLineHeight })}
        />
      </SettingsGroup>
    </>
  );
}
