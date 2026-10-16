import { useEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ProjectVenue } from "../app-types";
import { toMessage } from "../app-utils";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { CheckboxField } from "../components/ui/checkbox-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { ModalDialog } from "../components/ui/modal-dialog";
import "./local-templates.css";

type LocalTemplate = {
  id: string; name: string; sourceUrl: string; version: string;
  files: string[]; root: string; engine: string; preview: string | null;
};
type TemplateSource = Pick<LocalTemplate, "files" | "root" | "engine">;

// Keep async cleanup outside render functions so React Compiler can memoize
// the form; closing a dialog must not publish a late reply into its successor.
async function templateTask(work: () => Promise<void>, failed: (reason: unknown) => void, finished: () => void) {
  try { await work(); } catch (reason) { failed(reason); } finally { finished(); }
}

export function LocalTemplates({ selected, onSelect, currentProject = false }: {
  selected: ProjectVenue; onSelect: (value: ProjectVenue) => void; currentProject?: boolean;
}) {
  const { t } = useLingui();
  const [items, setItems] = useState<LocalTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    let disposed = false;
    void invoke<LocalTemplate[]>("list_local_templates").then((value) => {
      if (!disposed) setItems((previous) => [...value, ...previous.filter((item) => !value.some((saved) => saved.id === item.id))]);
    }).catch((reason) => { if (!disposed) setError(toMessage(reason)); });
    return () => { disposed = true; };
  }, []);
  const active = items.find((item) => selected === `local:${item.id}`);
  return (
    <section className="local-templates" aria-label={t`My templates`}>
      <span>{t`My templates`}</span>
      {items.length > 0 && <Select value={active?.id ?? ""} onValueChange={(id) => onSelect(`local:${id}`)}>
        <SelectTrigger aria-label={t`My templates`} title={active?.name}><SelectValue placeholder={t`Choose a saved template`} /></SelectTrigger>
        <SelectContent position="popper" className="local-template-options">{items.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
      </Select>}
      {active && <small className="template-details">{[active.version, active.sourceUrl, active.root, active.engine].filter(Boolean).join(" · ")}</small>}
      {active && <details><summary>{t`Files`}</summary><ul className="template-saved-files">{active.files.map((file) => <li key={file}>{file}</li>)}</ul></details>}
      {!items.length && !error && <small>{t`Save your school, journal or lab files to reuse them in new projects.`}</small>}
      <Button variant="secondary" onClick={() => setEditing(true)}>{t`Save a local template…`}</Button>
      {error && <p className="field-error" role="alert">{error}</p>}
      {editing && <SaveTemplateDialog currentProject={currentProject} onClose={() => setEditing(false)} onSaved={(item) => {
        setItems((previous) => [...previous, item]);
        setError(null);
        onSelect(`local:${item.id}`);
        setEditing(false);
      }} />}
    </section>
  );
}

function SaveTemplateDialog({ currentProject, onClose, onSaved }: {
  currentProject: boolean; onClose: () => void; onSaved: (item: LocalTemplate) => void;
}) {
  const { t } = useLingui();
  const [source, setSource] = useState<string | null>(null);
  const [review, setReview] = useState<TemplateSource | null>(null);
  const [draft, setDraft] = useState<LocalTemplate>({ id: "", name: "", sourceUrl: "", version: "", files: [], root: "", engine: "pdf", preview: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const update = (patch: Partial<LocalTemplate>) => setDraft((value) => ({ ...value, ...patch }));
  const choose = (kind: "folder" | "zip" | "current") => {
    setBusy(true); setError(null);
    return templateTask(async () => {
      const path = kind === "current" ? null : await open({ directory: kind === "folder", multiple: false,
        title: t`Choose template source`, ...(kind === "zip" ? { filters: [{ name: t`ZIP archive`, extensions: ["zip"] }] } : {}) });
      if (!mounted.current || (kind !== "current" && !path)) return;
      const result = await invoke<TemplateSource>("inspect_template_source", { source: path });
      if (!mounted.current) return;
      setSource(path as string | null); setReview(result);
      update({ files: [], root: result.root, engine: result.engine, preview: null });
    }, (reason) => { if (mounted.current) setError(toMessage(reason)); },
    () => { if (mounted.current) setBusy(false); });
  };
  const save = () => {
    setBusy(true); setError(null);
    return templateTask(async () => {
      const result = await invoke<LocalTemplate>("save_local_template", { source, template: draft });
      if (mounted.current) onSaved(result);
    }, (reason) => { if (mounted.current) setError(toMessage(reason)); },
    () => { if (mounted.current) setBusy(false); });
  };
  return <ModalDialog label={t`Save a local template`} onClose={onClose} closeDisabled={busy} keepOnOutsideClick>
    <div className="modal local-template-modal">
      <h2>{t`Save a local template`}</h2>
      <p>{t`Choose reusable source files, styles and images. Hidden files, project history, comments, sessions and credentials are excluded. Only saved files are copied.`}</p>
      <div className="template-source-actions">
        <Button disabled={busy} onClick={() => void choose("folder")}>{t`From folder`}</Button>
        <Button disabled={busy} onClick={() => void choose("zip")}>{t`From ZIP`}</Button>
        {currentProject && <Button disabled={busy} onClick={() => void choose("current")}>{t`Current project`}</Button>}
      </div>
      {review && <fieldset disabled={busy} className="template-fields">
        <label>{t`Template name`}<Input value={draft.name} onChange={(e) => update({ name: e.target.value })} maxLength={300} /></label>
        <label>{t`Source URL (optional)`}<Input type="url" value={draft.sourceUrl} onChange={(e) => update({ sourceUrl: e.target.value })} /></label>
        <label>{t`Version or year (optional)`}<Input value={draft.version} onChange={(e) => update({ version: e.target.value })} maxLength={300} /></label>
        <label>{t`Compile root`}<select className="ui-input" value={draft.root} onChange={(e) => update({ root: e.target.value })}>
          {review.files.filter((file) => file.endsWith(".tex")).map((file) => <option key={file} value={file}>{file}</option>)}
        </select></label>
        <label>{t`LaTeX engine`}<select className="ui-input" value={draft.engine} onChange={(e) => update({ engine: e.target.value })}>
          <option value="pdf">pdfLaTeX</option><option value="xelatex">XeLaTeX</option><option value="lualatex">LuaLaTeX</option>
        </select></label>
        <label>{t`Preview image (optional)`}<select className="ui-input" value={draft.preview ?? ""} onChange={(e) => update({ preview: e.target.value || null })}>
          <option value="">{t`None`}</option>
          {draft.files.filter((file) => /\.(png|jpe?g|pdf|svg)$/.test(file)).map((file) => <option key={file} value={file}>{file}</option>)}
        </select></label>
        <span>{t`Select files to copy`}</span>
        <div className="template-file-list">
          {review.files.map((file) => <CheckboxField key={file} label={file} checked={draft.files.includes(file)} onChange={(e) => update({
            files: e.target.checked ? [...draft.files, file] : draft.files.filter((path) => path !== file),
            preview: !e.target.checked && draft.preview === file ? null : draft.preview,
          })} />)}
        </div>
        {!draft.files.includes(draft.root) && <small>{t`Select the compile root in the file list to continue.`}</small>}
      </fieldset>}
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <Button variant="ghost" disabled={busy} onClick={onClose}>{t`Cancel`}</Button>
        <Button variant="primary" disabled={busy || !review || !draft.name.trim() || !draft.files.includes(draft.root)} onClick={() => void save()}>{busy ? t`Working…` : t`Save template`}</Button>
      </div>
    </div>
  </ModalDialog>;
}
