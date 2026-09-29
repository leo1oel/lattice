import { useState } from "react";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";
import { ImagePlus } from "lucide-react";
import { Button } from "../../components/ui/button";
import { buttonClassName } from "../../components/ui/button-styles";
import { Input } from "../../components/ui/input";
import { PanelHeader } from "../../components/ui/panel-header";
import { MotionButton, PopIn } from "../../components/ui/motion";
import { DEFAULT_FIGURE_OPTIONS, type FigureInsertOptions } from "./figure-insertion";
import { ModalDialog } from "../../components/ui/modal-dialog";

const FIELDS: Array<[key: keyof FigureInsertOptions, name: MessageDescriptor, placeholder?: string | MessageDescriptor]> = [
  // eslint-disable-next-line lingui/no-unlocalized-strings -- LaTeX length
  ["width", msg`Width`, "0.8\\linewidth"],
  ["placement", msg`Placement`, "t"],
  ["caption", msg`Caption`],
  ["label", msg`Label`, msg`fig:name (optional)`],
];

export function FigureInsertDialog(props: {
  open: boolean;
  paths: string[];
  onClose: () => void;
  onInsert: (options: FigureInsertOptions) => void;
}) {
  const { i18n, t } = useLingui();
  const [options, setOptions] = useState<Required<FigureInsertOptions>>({ ...DEFAULT_FIGURE_OPTIONS, label: "" });

  if (!props.open || !props.paths.length) return null;
  const count = props.paths.length;

  return (
    <ModalDialog label={t`Insert figure`} onClose={props.onClose}>
      <PopIn className="modal figure-insert-modal">
        <div className="modal-icon"><ImagePlus size={19} /></div>
        <PanelHeader
          className="drawer-header"
          style={{ padding: 0, border: 0, marginBottom: 8 }}
          title={t`Insert figure`}
          onClose={props.onClose}
        />
        <p>{count === 1 ? props.paths[0] : t`${count} figures`}</p>
        {FIELDS.map(([key, name, placeholder]) => (
          <label key={key}>
            {i18n._(name)}
            <Input
              controlSize="form"
              value={options[key]}
              onChange={(event) => setOptions({ ...options, [key]: event.target.value })}
              placeholder={typeof placeholder === "string" || !placeholder ? placeholder : i18n._(placeholder)}
            />
          </label>
        ))}
        <div className="modal-actions">
          <Button variant="ghost" onClick={props.onClose}>{t`Cancel`}</Button>
          <MotionButton
            type="button"
            className={buttonClassName({ variant: "primary" })}
            onClick={() => props.onInsert({ ...options, label: options.label.trim() || undefined })}
          >
            {t`Insert`}
          </MotionButton>
        </div>
      </PopIn>
    </ModalDialog>
  );
}
