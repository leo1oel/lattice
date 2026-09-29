/**
 * Views for the MDX components the visual engine models: Callout and
 * Accordion with their properties popovers (spec R-BLK-1, R-BLK-2, R-CHR-8),
 * and the converter's paper figures (R-BLK-15).
 *
 * The generic property panel of the old editor, with its icon and color
 * pickers, is not rebuilt: each component edits only its own fields.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { useState, type CSSProperties, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import {
  ChevronRight, Info, Lightbulb, MessageSquareWarning, OctagonAlert, Settings2, Trash2, TriangleAlert,
} from "lucide-react";
import { IconButton } from "../../../../components/ui/icon-button";
import { Input } from "../../../../components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../../../../components/ui/popover";
import { Switch } from "../../../../components/ui/switch";
import { propValue, withProp, type ComponentProp } from "../mdx-components";
import { deleteNode, Field, setNodeAttrs, useCommitKeys } from "./view-chrome";

type Tone = "note" | "tip" | "important" | "warning" | "caution";

const TONES: Tone[] = ["note", "tip", "important", "warning", "caution"];

/** Callout types as authors write them, onto the five tones Lattice draws. */
function toneOf(type: unknown): Tone {
  switch (String(type ?? "note").toLowerCase()) {
    case "tip":
    case "success":
      return "tip";
    case "important":
      return "important";
    case "warning":
      return "warning";
    case "caution":
    case "danger":
    case "error":
      return "caution";
    default:
      return "note";
  }
}

const TONE_ICONS: Record<Tone, typeof Info> = {
  note: Info,
  tip: Lightbulb,
  important: MessageSquareWarning,
  warning: TriangleAlert,
  caution: OctagonAlert,
};

function useToneLabels(): Record<Tone, string> {
  const { t } = useLingui();
  return { note: t`Note`, tip: t`Tip`, important: t`Important`, warning: t`Warning`, caution: t`Caution` };
}

/** Every modelled component, drawn by name. */
export function ComponentView(props: NodeViewProps) {
  switch (props.node.attrs.name) {
    case "Callout":
      return <CalloutView {...props} />;
    case "Accordion":
      return <AccordionView {...props} />;
    case "PaperFigure":
      return <PaperFigureView {...props} />;
    case "PaperFigureRow":
      return <PaperFigureRowView {...props} />;
    default:
      return <PaperFigurePanelView {...props} />;
  }
}

const propsOf = (props: NodeViewProps) => (props.node.attrs.props ?? []) as ComponentProp[];

/** Set properties and keep the caret where it was (outside the component). */
function useSetProps(props: NodeViewProps) {
  return (next: ComponentProp[]) => setNodeAttrs(props.editor, props.getPos, props.node, { props: next });
}

/** Return the caret to the start of the component's body (R-BLK-1). */
function focusBody(props: NodeViewProps) {
  const position = props.getPos();
  if (typeof position !== "number") return;
  const { state } = props.editor;
  const selection = TextSelection.near(state.doc.resolve(Math.min(position + 1, state.doc.content.size)));
  props.editor.view.dispatch(state.tr.setSelection(selection));
  props.editor.view.focus();
}

function CalloutView(props: NodeViewProps) {
  const { t } = useLingui();
  const toneLabels = useToneLabels();
  const values = propsOf(props);
  const tone = toneOf(propValue(values, "type"));
  const title = String(propValue(values, "title") ?? "");
  const collapsible = propValue(values, "collapsible") === true;
  const [open, setOpen] = useState(() => !collapsible || propValue(values, "defaultOpen") === true);
  const expanded = !collapsible || open;
  const Icon = TONE_ICONS[tone];
  const label = t`Callout`;
  return (
    <NodeViewWrapper
      className={`lx-md-callout${props.selected ? " is-selected" : ""}`}
      data-tone={tone}
      data-expanded={expanded}
      role="group"
      aria-label={title || toneLabels[tone]}
    >
      <span className="lx-md-callout-icon" contentEditable={false} aria-hidden="true"><Icon /></span>
      <div className="lx-md-callout-main">
        {(title || collapsible) && (
          <div className="lx-md-callout-header" contentEditable={false}>
            {collapsible
              ? (
                <button type="button" className="lx-md-callout-toggle" aria-expanded={expanded} onClick={() => setOpen(!open)}>
                  <span className="lx-md-callout-title">{title || toneLabels[tone]}</span>
                  <ChevronRight className="lx-md-callout-chevron" aria-hidden="true" />
                </button>
              )
              : <span className="lx-md-callout-title">{title}</span>}
          </div>
        )}
        <NodeViewContent className="lx-md-callout-body" hidden={!expanded} />
      </div>
      <BlockActions
        name={label}
        editable={props.editor.isEditable}
        onClose={() => focusBody(props)}
        onDelete={() => deleteNode(props.editor, props.getPos, props.node)}
        properties={(close) => <CalloutProperties {...props} close={close} />}
      />
    </NodeViewWrapper>
  );
}

function CalloutProperties(props: NodeViewProps & { close: () => void }) {
  const { t } = useLingui();
  const toneLabels = useToneLabels();
  const values = propsOf(props);
  const setProps = useSetProps(props);
  const tone = toneOf(propValue(values, "type"));
  const [title, setTitle] = useState(String(propValue(values, "title") ?? ""));
  const keys = useCommitKeys(props.close, props.close);
  return (
    <div className="lx-md-properties">
      <Field label={t`Title`}>
        <Input
          aria-label={t`Title`}
          value={title}
          controlSize="compact"
          autoFocus
          onChange={(event) => {
            setTitle(event.target.value);
            setProps(withProp(propsOf(props), "title", event.target.value || null));
          }}
          {...keys}
        />
      </Field>
      <Field label={t`Type`}>
        <span className="lx-md-tone-picker" role="radiogroup" aria-label={t`Type`}>
          {TONES.map((option) => {
            const Icon = TONE_ICONS[option];
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={option === tone}
                aria-label={toneLabels[option]}
                title={toneLabels[option]}
                data-tone={option}
                className="lx-md-tone-option"
                onClick={() => setProps(withProp(propsOf(props), "type", option))}
              >
                <Icon aria-hidden="true" />
              </button>
            );
          })}
        </span>
      </Field>
      <div className="lx-md-field lx-md-field-inline">
        <span className="lx-md-field-label">{t`Collapsible`}</span>
        <Switch
          label={t`Collapsible`}
          checked={propValue(values, "collapsible") === true}
          onChange={(checked) => setProps(withProp(propsOf(props), "collapsible", checked))}
        />
      </div>
    </div>
  );
}

function AccordionView(props: NodeViewProps) {
  const { t } = useLingui();
  const values = propsOf(props);
  const title = String(propValue(values, "title") ?? "");
  const [open, setOpen] = useState(() => propValue(values, "defaultOpen") === true);
  return (
    <NodeViewWrapper className={`lx-md-accordion${props.selected ? " is-selected" : ""}`} data-expanded={open} role="group" aria-label={title || t`Accordion`}>
      <div className="lx-md-accordion-header" contentEditable={false}>
        <button type="button" className="lx-md-accordion-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronRight className="lx-md-accordion-chevron" aria-hidden="true" />
          <span className={title ? "lx-md-accordion-title" : "lx-md-accordion-title is-placeholder"}>{title || t`Untitled`}</span>
        </button>
        <BlockActions
          name={t`Accordion`}
          editable={props.editor.isEditable}
          onClose={() => focusBody(props)}
          onDelete={() => deleteNode(props.editor, props.getPos, props.node)}
          properties={(close) => <AccordionProperties {...props} close={close} />}
        />
      </div>
      <NodeViewContent className="lx-md-accordion-body" hidden={!open} />
    </NodeViewWrapper>
  );
}

function AccordionProperties(props: NodeViewProps & { close: () => void }) {
  const { t } = useLingui();
  const values = propsOf(props);
  const setProps = useSetProps(props);
  const [title, setTitle] = useState(String(propValue(values, "title") ?? ""));
  const keys = useCommitKeys(props.close, props.close);
  return (
    <div className="lx-md-properties">
      <Field label={t`Title`}>
        <Input
          aria-label={t`Title`}
          value={title}
          controlSize="compact"
          autoFocus
          onChange={(event) => {
            setTitle(event.target.value);
            setProps(withProp(propsOf(props), "title", event.target.value || null));
          }}
          {...keys}
        />
      </Field>
      <div className="lx-md-field lx-md-field-inline">
        <span className="lx-md-field-label">{t`Open by default`}</span>
        <Switch
          label={t`Open by default`}
          checked={propValue(values, "defaultOpen") === true}
          onChange={(checked) => setProps(withProp(propsOf(props), "defaultOpen", checked ? true : null))}
        />
      </div>
    </div>
  );
}

/**
 * The hover actions of a component: its properties popover and delete. The
 * popover returns the caret to the component's body when it closes (R-BLK-1).
 */
function BlockActions({ name, editable, onDelete, onClose, properties }: {
  name: string;
  editable: boolean;
  onDelete: () => void;
  onClose: () => void;
  properties: (close: () => void) => ReactNode;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  if (!editable) return null;
  const change = (next: boolean) => {
    setOpen(next);
    if (!next) onClose();
  };
  return (
    <span className="lx-md-block-actions" data-open={open || undefined}>
      <Popover open={open} onOpenChange={change}>
        <PopoverTrigger asChild>
          <IconButton label={t`${name} properties`} size="compact" tooltip={false}>
            <Settings2 aria-hidden="true" />
          </IconButton>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="lx-md-popover w-64"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {properties(() => change(false))}
        </PopoverContent>
      </Popover>
      <IconButton label={t`Delete ${name}`} size="compact" tooltip={false} onClick={onDelete}>
        <Trash2 aria-hidden="true" />
      </IconButton>
    </span>
  );
}

function PaperFigureView(props: NodeViewProps) {
  const id = propValue(propsOf(props), "id");
  return (
    <NodeViewWrapper as="figure" className="lx-md-paper-figure" id={typeof id === "string" ? id : undefined}>
      <NodeViewContent className="lx-md-paper-figure-content" />
    </NodeViewWrapper>
  );
}

/** Column shares as grid tracks: `columns="3 3 3"` is three equal columns. */
function columnTracks(columns: unknown): string | undefined {
  const shares = String(columns ?? "").trim().split(/\s+/).map(Number).filter((share) => share > 0);
  return shares.length ? shares.map((share) => `minmax(0, ${share}fr)`).join(" ") : undefined;
}

function PaperFigureRowView(props: NodeViewProps) {
  const tracks = columnTracks(propValue(propsOf(props), "columns"));
  return (
    <NodeViewWrapper className="lx-md-paper-figure-row" style={tracks ? { "--lx-md-figure-columns": tracks } as CSSProperties : undefined}>
      <NodeViewContent className="lx-md-paper-figure-row-content" />
    </NodeViewWrapper>
  );
}

function PaperFigurePanelView(props: NodeViewProps) {
  const id = propValue(propsOf(props), "id");
  return (
    <NodeViewWrapper className="lx-md-paper-figure-panel" id={typeof id === "string" ? id : undefined} data-empty={props.node.childCount === 0 || undefined}>
      <NodeViewContent className="lx-md-paper-figure-panel-content" />
    </NodeViewWrapper>
  );
}
