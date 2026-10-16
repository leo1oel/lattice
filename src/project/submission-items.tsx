import { useId, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { Check, Circle, CircleDot, FileText, LayoutTemplate, Link2, Plus } from "lucide-react";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/ui/icon-button";
import { Input } from "../components/ui/input";
import { SegmentedControl } from "../components/ui/segmented-control";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import type { SubmissionItem } from "../app-types";
import {
  loadSubmissionTemplates,
  saveSubmissionTemplates,
  type SubmissionTemplate,
} from "../settings/app-settings";
import { itemCondition, type ItemCondition, type LinkedFileStat } from "./submission-item-state";

function newItem(title: string, from?: Partial<SubmissionItem>): SubmissionItem {
  return { ...from, id: crypto.randomUUID(), title, status: "todo" };
}

const isUrl = (source: string) => /^https?:\/\/\S+$/i.test(source);
const hostOf = (source: string) => {
  try {
    return new URL(source).host;
  } catch {
    return source;
  }
};
// eslint-disable-next-line lingui/no-unlocalized-strings -- Intl options, not interface text; a bare "YYYY-MM-DD" parses as UTC midnight
const CHECKED_DAY: Intl.DateTimeFormatOptions = { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" };
const signedOff = (condition: ItemCondition) => condition === "confirmed" || condition === "pending";
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function ItemMark(props: { condition: ItemCondition }) {
  const { condition } = props;
  return (
    <i className="checklist-status" aria-hidden="true">
      {condition === "confirmed"
        ? <Check size={12} />
        : condition === "review"
          ? <CircleDot size={12} />
          : condition === "todo" || condition === "pending"
            ? <Circle size={10} />
            : (
              <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                <path d="M12 5v9M12 19h.01" />
              </svg>
            )}
    </i>
  );
}

/**
 * The requirements and materials the writer tracks by hand, under the
 * automatic checks: one hairline list as ClickUp's checklist sets it, each row
 * a status mark you can tick, the title, and Basecamp-style meta under it
 * (who, which file, where the requirement came from). A row opens in place
 * into its fields, as the deadline card does.
 */
export function SubmissionItems(props: {
  items: SubmissionItem[];
  fileStats: Record<string, LinkedFileStat>;
  /** Project files offered when linking one, the compiled PDF first. */
  filePaths: string[];
  onChange: (items: SubmissionItem[]) => void;
  onOpenFile: (path: string) => void;
  onOpenSource: (url: string) => void;
}) {
  const { t } = useLingui();
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState("");
  const [templates, setTemplates] = useState(loadSubmissionTemplates);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const listId = useId();
  const { items } = props;
  // `items` changes only when a write answers, so an edit made before the last
  // one answered builds on the list that edit sent: built on `items`, ticking
  // one item and then another would send the first back unticked. A new list
  // from the manifest (any answer, another project) replaces what was sent.
  const sent = useRef<{ base: SubmissionItem[]; items: SubmissionItem[] } | null>(null);
  const save = (update: (latest: SubmissionItem[]) => SubmissionItem[]) => {
    const next = update(sent.current?.base === items ? sent.current.items : items);
    sent.current = { base: items, items: next };
    props.onChange(next);
  };
  const replace = (id: string, next: (item: SubmissionItem) => SubmissionItem | null) =>
    save((latest) => latest.flatMap((item) => {
      if (item.id !== id) return [item];
      const changed = next(item);
      return changed ? [changed] : [];
    }));
  const add = () => {
    const title = adding.trim();
    if (!title) return;
    save((latest) => [...latest, newItem(title)]);
    setAdding("");
  };
  const storeTemplates = (next: SubmissionTemplate[]) => {
    saveSubmissionTemplates(next);
    setTemplates(next);
  };
  const total = items.length;
  const confirmedCount = items.filter((item) => itemCondition(item, props.fileStats[item.file ?? ""]) === "confirmed").length;

  return (
    <section className="submission-items" aria-label={t`Materials and sign-offs`}>
      <header className="submission-items-head">
        <div className="submission-items-title">
          <h3>{t`Materials and sign-offs`}</h3>
          {total > 0 && <span>{t`${confirmedCount} of ${total} confirmed`}</span>}
        </div>
        {/* Nothing to save and nothing saved: no menu to open. */}
        {(total > 0 || templates.length > 0) && <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <IconButton label={t`Checklist templates`} size="compact">
              <LayoutTemplate size={13} aria-hidden="true" />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="submission-template-menu">
            {templates.length > 0 && <DropdownMenuLabel>{t`Add items from`}</DropdownMenuLabel>}
            {templates.map((template) => (
              <DropdownMenuItem
                key={template.name}
                onSelect={() => save((latest) => [
                  ...latest,
                  // A template line already on the list is not added twice.
                  ...template.items
                    .filter((line) => !latest.some((item) => item.title === line.title))
                    .map((line) => newItem(line.title, { file: line.file, source: line.source })),
                ])}
              >
                <span className="submission-template-name">{template.name}</span>
                <span className="submission-template-count">{template.items.length}</span>
              </DropdownMenuItem>
            ))}
            {templates.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem disabled={items.length === 0} onSelect={() => setSavingTemplate(true)}>
              {templates.length ? t`Save or remove a template…` : t`Save these items as a template…`}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>}
      </header>
      {savingTemplate && (
        <TemplateForm
          templates={templates}
          onCancel={() => setSavingTemplate(false)}
          onRemove={(name) => storeTemplates(templates.filter((template) => template.name !== name))}
          onSave={(name) => {
            const lines = items.map(({ title, file, source }) => ({ title, file, source }));
            storeTemplates([...templates.filter((template) => template.name !== name), { name, items: lines }]);
            setSavingTemplate(false);
          }}
        />
      )}
      <div className="checklist-rows submission-rows">
        {items.map((item) => {
          const condition = itemCondition(item, props.fileStats[item.file ?? ""]);
          if (editing === item.id) {
            return (
              <ItemForm
                key={item.id}
                item={item}
                listId={listId}
                onCancel={() => setEditing(null)}
                onRemove={() => {
                  replace(item.id, () => null);
                  setEditing(null);
                }}
                onSave={(next) => {
                  replace(item.id, () => next);
                  setEditing(null);
                }}
              />
            );
          }
          return (
            <ItemRow
              key={item.id}
              item={item}
              condition={condition}
              // A confirmation whose file is not read yet unticks too: confirming
              // it again would restamp a change the writer has not seen.
              onToggle={() => replace(item.id, (latest) => signedOff(condition)
                ? { ...latest, status: "todo", confirmedMtimeMs: undefined }
                // Confirming again takes the file as it is now.
                : { ...latest, status: "confirmed", confirmedMtimeMs: undefined })}
              onEdit={() => setEditing(item.id)}
              onOpenFile={props.onOpenFile}
              onOpenSource={props.onOpenSource}
            />
          );
        })}
        <form
          className="submission-add"
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <Plus size={13} aria-hidden="true" />
          <input
            value={adding}
            maxLength={200}
            aria-label={t`New item`}
            placeholder={items.length ? t`Add an item` : t`Add an item, e.g. supplementary.pdf checked`}
            onChange={(event) => setAdding(event.target.value)}
          />
        </form>
      </div>
      <datalist id={listId}>
        {props.filePaths.map((path) => <option key={path} value={path} />)}
      </datalist>
    </section>
  );
}

function ItemRow(props: {
  item: SubmissionItem;
  condition: ItemCondition;
  onToggle: () => void;
  onEdit: () => void;
  onOpenFile: (path: string) => void;
  onOpenSource: (url: string) => void;
}) {
  const { t, i18n } = useLingui();
  const { item, condition } = props;
  const title = item.title;
  const tone = condition === "confirmed" ? "ok" : condition === "missing" || condition === "changed" ? "warn" : "";
  const state = {
    todo: t`To do`,
    review: t`To check`,
    confirmed: t`Confirmed`,
    pending: t`Confirmed`,
    missing: t`File missing`,
    changed: t`Changed since confirmed`,
  }[condition];
  const checked = item.sourceChecked
    ? new Date(item.sourceChecked).toLocaleDateString(i18n.locale || "en", CHECKED_DAY)
    : null;
  return (
    <div className={`checklist-row submission-row ${tone}`} data-condition={condition}>
      <button
        type="button"
        className="submission-toggle"
        aria-label={signedOff(condition) ? t`Mark “${title}” not confirmed` : t`Confirm “${title}”`}
        aria-pressed={signedOff(condition)}
        onClick={props.onToggle}
      >
        <ItemMark condition={condition} />
      </button>
      <button type="button" className="submission-title" title={t`Edit item`} onClick={props.onEdit}>
        <strong>{item.title}</strong>
        <span className="submission-state">{state}</span>
      </button>
      {(item.owner || item.file || item.source) && (
        <small className="submission-meta">
          {item.owner && <span className="submission-owner">{item.owner}</span>}
          {item.file && (
            <button type="button" className="submission-chip" title={item.file} onClick={() => props.onOpenFile(item.file!)}>
              <FileText size={12} aria-hidden="true" />
              <span>{baseName(item.file)}</span>
            </button>
          )}
          {item.source && (isUrl(item.source)
            ? (
              <button type="button" className="submission-chip" title={item.source} onClick={() => props.onOpenSource(item.source!)}>
                <Link2 size={12} aria-hidden="true" />
                <span>{hostOf(item.source)}</span>
              </button>
            )
            : <span className="submission-source" title={item.source}>{item.source}</span>)}
          {checked && <span className="submission-checked">{t`checked ${checked}`}</span>}
        </small>
      )}
    </div>
  );
}

function ItemForm(props: {
  item: SubmissionItem;
  listId: string;
  onCancel: () => void;
  onRemove: () => void;
  onSave: (item: SubmissionItem) => void;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState(props.item);
  const field = (key: "owner" | "file" | "source" | "sourceChecked") => ({
    value: draft[key] ?? "",
    onChange: (event: { target: { value: string } }) => setDraft({ ...draft, [key]: event.target.value }),
  });
  return (
    <form
      className="deadline-form submission-form"
      aria-label={t`Edit item`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!draft.title.trim()) return;
        // A new status or file is confirmed against the file as it is now.
        const restamp = draft.status !== props.item.status || (draft.file ?? "") !== (props.item.file ?? "");
        props.onSave(restamp ? { ...draft, confirmedMtimeMs: undefined } : draft);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          props.onCancel();
        }
      }}
    >
      <label>
        {t`Item`}
        <Input controlSize="compact" value={draft.title} maxLength={200} autoFocus onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
      </label>
      <SegmentedControl<SubmissionItem["status"]>
        ariaLabel={t`Status`}
        value={draft.status}
        onChange={(status) => setDraft({ ...draft, status })}
        items={[
          { value: "todo", label: t`To do` },
          { value: "review", label: t`To check` },
          { value: "confirmed", label: t`Confirmed` },
        ]}
      />
      <label>
        {t`Who`}
        <Input controlSize="compact" maxLength={80} placeholder={t`e.g. all authors`} {...field("owner")} />
      </label>
      <label>
        {t`Material file`}
        <Input controlSize="compact" maxLength={500} list={props.listId} placeholder={t`A file in this project`} {...field("file")} />
      </label>
      <div className="deadline-form-when">
        <label>
          {t`Requirement source`}
          <Input controlSize="compact" maxLength={500} placeholder={t`Call for papers URL or note`} {...field("source")} />
        </label>
        <label>
          {t`Checked against it on`}
          <Input controlSize="compact" type="date" {...field("sourceChecked")} />
        </label>
      </div>
      <div className="deadline-form-actions">
        <Button variant="ghost" size="compact" className="deadline-form-remove" onClick={props.onRemove}>{t`Remove`}</Button>
        <Button variant="ghost" size="compact" onClick={props.onCancel}>{t`Cancel`}</Button>
        <Button variant="primary" size="compact" type="submit" disabled={!draft.title.trim()}>{t`Save item`}</Button>
      </div>
    </form>
  );
}

function TemplateForm(props: {
  templates: SubmissionTemplate[];
  onCancel: () => void;
  onRemove: (name: string) => void;
  onSave: (name: string) => void;
}) {
  const { t } = useLingui();
  const [name, setName] = useState("");
  const namesId = useId();
  const trimmed = name.trim();
  const existing = props.templates.some((template) => template.name === trimmed);
  return (
    <form
      className="deadline-card deadline-form submission-template-form"
      aria-label={t`Checklist template`}
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed) props.onSave(trimmed);
      }}
    >
      <label>
        {t`Template name`}
        <Input
          controlSize="compact"
          value={name}
          maxLength={60}
          list={namesId}
          placeholder={t`e.g. Camera-ready`}
          autoFocus
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <datalist id={namesId}>
        {props.templates.map((template) => <option key={template.name} value={template.name} />)}
      </datalist>
      <p className="deadline-card-local">{t`Saved on this Mac for your other papers: item names, files and sources, not their status.`}</p>
      <div className="deadline-form-actions">
        {existing && (
          <Button variant="ghost" size="compact" className="deadline-form-remove" onClick={() => {
            props.onRemove(trimmed);
            setName("");
          }}>
            {t`Remove template`}
          </Button>
        )}
        <Button variant="ghost" size="compact" onClick={props.onCancel}>{t`Cancel`}</Button>
        <Button variant="primary" size="compact" type="submit" disabled={!trimmed}>
          {existing ? t`Replace template` : t`Save template`}
        </Button>
      </div>
    </form>
  );
}
