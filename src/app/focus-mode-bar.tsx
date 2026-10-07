import { useSyncExternalStore } from "react";
import { useLingui } from "@lingui/react/macro";
import { Columns2, Eye, FileText, Minimize2, PenLine } from "lucide-react";
import { Tip } from "../components/icon-tip";
import { Button } from "../components/ui/button";
import { Keycaps } from "../components/ui/keycaps";
import { SegmentedControl } from "../components/ui/segmented-control";
import type { TrellisController, TrellisViewMode } from "../trellis/trellis-controller";
import { FOCUS_MODE_EXIT_KEY, FOCUS_MODE_KEY } from "../trellis/trellis-keymap";
import { comboKeys, comboText, parseKeyName } from "./key-combos";

/**
 * The title bar in focus mode: the document's name, quiet in the middle,
 * and what focus mode keeps of the chrome: a Markdown or HTML document's
 * Edit, Split and Preview (its panel header is gone), the PDF beside the
 * editor, and the way out.
 */
export function FocusModeBar({ controller, title, pdf, onPdfChange, onExit }: {
  controller: TrellisController;
  title: string;
  pdf: boolean;
  onPdfChange: (pdf: boolean) => void;
  onExit: () => void;
}) {
  const { t } = useLingui();
  const pdfLabel = pdf ? t`Hide the PDF` : t`Show the PDF beside the editor`;
  const exitKeys = comboText({ mod: true, ...FOCUS_MODE_KEY });
  const tools = useSyncExternalStore(controller.docTools.subscribe, controller.docTools.get);
  return (
    <div className="focus-bar">
      <span className="focus-bar-title">{title}</span>
      <div className="focus-bar-actions">
        {tools.viewModes && (
          <SegmentedControl<TrellisViewMode>
            value={tools.viewMode}
            onChange={(mode) => controller.bridge?.setViewMode(mode)}
            ariaLabel={t`Document view`}
            items={[
              { value: "source", label: <PenLine size={13} aria-hidden="true" />, title: t`Edit` },
              { value: "split", label: <Columns2 size={13} aria-hidden="true" />, title: t`Split` },
              { value: "pdf", label: <Eye size={13} aria-hidden="true" />, title: t`Preview` },
            ]}
          />
        )}
        <Tip label={pdfLabel}>
          <button type="button" className="ui-compact-selectable focus-bar-pdf" aria-label={pdfLabel} aria-pressed={pdf} onClick={() => onPdfChange(!pdf)}>
            <FileText size={13} aria-hidden="true" />
            <span>{t`PDF`}</span>
          </button>
        </Tip>
        <Tip label={t`Leave focus mode · ${exitKeys} or Esc`}>
          <Button variant="ghost" size="compact" className="focus-bar-exit" onClick={onExit}>
            <Minimize2 size={13} aria-hidden="true" />
            {t`Exit focus`}
            <Keycaps keys={comboKeys(parseKeyName(FOCUS_MODE_EXIT_KEY))} className="focus-bar-keys" />
          </Button>
        </Tip>
      </div>
    </div>
  );
}
