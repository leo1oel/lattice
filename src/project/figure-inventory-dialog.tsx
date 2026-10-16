import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Images } from "lucide-react";
import type { AssetPreview, OpenProjectFile, ProjectSnapshot } from "../app-types";
import { flattenProjectPaths } from "../build/compile-diagnostics";
import { toMessage } from "../app-utils";
import { Button } from "../components/ui/button";
import { InlineMessage } from "../components/ui/inline-message";
import { PanelHeader } from "../components/ui/panel-header";
import { SheetDialog } from "../components/ui/sheet-dialog";
import { figureArgument, figureReplacement, isFigureAsset, scanFigureInventory, type FigureUse } from "./figure-inventory";
import { referenceAssetPreviewDataUrl } from "./reference-preview";
import type { FigureEdit as Edit } from "./figure-undo";
import "./figure-inventory.css";

/** Each successful file is undoable, including when a later compare-and-swap fails. */
async function writeFigureEdits(root: string, edits: Edit[], current: () => boolean, applied: (edit: Edit) => void) {
  for (const edit of edits) {
    if (!current()) return;
    await invoke("write_project_file", { projectRoot: root, path: edit.path, content: edit.after, expectedContent: edit.before });
    applied(edit);
  }
}


/** Keep the asynchronous transaction outside render, including partial-write recovery. */
async function applyFigureEdits(options: {
  root: string; edits: Edit[]; ownsProject: () => boolean; mounted: { current: boolean };
  beforeWrite: () => Promise<boolean>; afterWrite: () => Promise<void>;
  setBusy: (busy: boolean) => void; setError: (error: string | null) => void;
  setUndo: (update: (previous: Edit[]) => Edit[]) => void; restoring: boolean; finish: () => void;
}) {
  const { root, edits, ownsProject, mounted, beforeWrite, afterWrite, setBusy, setError, setUndo, restoring, finish } = options;
  const current = () => mounted.current && ownsProject();
  setBusy(true); setError(null);
  const applied: Edit[] = [];
  try {
    if (!(await beforeWrite()) || !current()) return;
    // Validate all sources before writing; each write rechecks under the host lock.
    for (const edit of edits) {
      const disk = await invoke<string>("read_project_file", { path: edit.path, projectRoot: root });
      if (!current()) return;
      if (disk !== edit.before) throw new Error(t`A source file changed. Refresh and preview the replacement again.`);
    }
    await writeFigureEdits(root, edits, current, (edit) => {
      applied.push(edit);
      if (ownsProject()) setUndo((previous) => restoring ? previous.filter((item) => item.path !== edit.path) : [...previous.filter((item) => item.path !== edit.path), { ...edit, before: previous.find((item) => item.path === edit.path)?.before ?? edit.before }]);
    });
  } catch (reason) { if (current()) setError(toMessage(reason)); }
  finally {
    if (ownsProject() && applied.length) {
      try { await afterWrite(); } catch (reason) { if (current()) setError(toMessage(reason)); }
    }
    if (current()) { setBusy(false); finish(); }
  }
}

function FigurePreview({ root, path, uses }: { root: string; path: string; uses: FigureUse[] }) {
  const { t } = useLingui();
  const [preview, setPreview] = useState<{ url: string; width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const vector = /\.(pdf|svg|eps)$/i.test(path);
  useEffect(() => {
    let disposed = false;
    void invoke<AssetPreview>("read_project_asset", { projectRoot: root, path })
      .then((asset) => disposed ? null : referenceAssetPreviewDataUrl(asset)).then((url) => {
        if (disposed || !url) { if (!disposed) setFailed(true); return; }
        const image = new Image();
        image.onload = () => { if (!disposed) setPreview({ url, width: image.naturalWidth, height: image.naturalHeight }); };
        image.onerror = () => { if (!disposed) setFailed(true); };
        image.src = url;
      }).catch(() => { if (!disposed) setFailed(true); });
    return () => { disposed = true; };
  }, [root, path]);
  return <div className="figure-preview">
    {preview && <img src={preview.url} alt={path} />}
    <p>{vector ? t`PDF / vector format — raster DPI does not apply` : preview
      ? t({ message: `${{ width: preview.width }} × ${{ height: preview.height }} pixels` }) : t`Dimensions unknown`}</p>
    {failed && <p>{t`Preview unavailable. Open the original file to inspect it.`}</p>}
    {!vector && uses.map((use) => <p key={`${use.source}:${use.from}`}>
      {use.source}:{use.line} · {preview && use.widthInches
        ? t({ message: `${{ dpi: Math.round(preview.width / use.widthInches) }} DPI at the specified width` })
        : t`Effective DPI unknown — physical width is not established`}
    </p>)}
  </div>;
}

export function FigureInventoryDialog(props: {
  project: ProjectSnapshot; activeFile: string; activeSource: string;
  onOpen: OpenProjectFile; onClose: () => void;
  beforeWrite: () => Promise<boolean>; afterWrite: () => Promise<void>;
  captureProjectScope: () => () => boolean;
  undo: Edit[]; setUndo: (update: (previous: Edit[]) => Edit[]) => void;
}) {
  const { t } = useLingui();
  const paths = useMemo(() => flattenProjectPaths(props.project.files), [props.project.files]);
  const [loaded, setLoaded] = useState<{ request: object; sources: Record<string, string>; unreadable: string[] } | null>(null);
  const [revision, setRevision] = useState(0);
  const request = useMemo(() => ({ paths, root: props.project.root, revision }), [paths, props.project.root, revision]);
  const loading = loaded?.request !== request;
  const sources = useMemo(() => loading ? {} : loaded.sources, [loading, loaded]);
  const unreadable = loading ? [] : loaded.unreadable;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [plan, setPlan] = useState<Edit[] | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let disposed = false;
    // Read serially: large projects must not flood the IPC queue on opening this tool.
    void (async () => {
      const next: Record<string, string> = {};
      const failed: string[] = [];
      for (const path of request.paths.filter((path) => /\.tex$/i.test(path))) {
        if (disposed) return;
        try { next[path] = await invoke<string>("read_project_file", { projectRoot: request.root, path }); }
        catch { failed.push(path); }
      }
      if (!disposed) { setLoaded({ request, sources: next, unreadable: failed }); }
    })();
    return () => { disposed = true; };
  }, [request]);
  const liveSources = useMemo(() => ({ ...sources, ...(props.activeFile.endsWith(".tex") ? { [props.activeFile]: props.activeSource } : {}) }), [sources, props.activeFile, props.activeSource]);
  const inventory = useMemo(() => scanFigureInventory(liveSources, paths), [liveSources, paths]);
  const groups = useMemo(() => {
    const grouped = new Map<string, FigureUse[]>();
    for (const use of inventory.uses) {
      const key = use.asset ?? use.raw;
      grouped.set(key, [...(grouped.get(key) ?? []), use]);
    }
    return [...grouped];
  }, [inventory]);
  const chosen = groups.find(([key]) => key === selected)?.[1] ?? [];
  // A new buffer invalidates the preview immediately, even before a refresh finishes.
  const freshPlan = !loading && plan && plan.every((edit) => liveSources[edit.path] === edit.before) ? plan : null;
  const navigate = (path: string, line?: number) => { props.onClose(); void props.onOpen(path, { line }); };
  const write = (edits: Edit[], restoring: boolean) => applyFigureEdits({
    root: props.project.root, edits, ownsProject: props.captureProjectScope(), mounted,
    beforeWrite: props.beforeWrite, afterWrite: props.afterWrite,
    setBusy, setError, setUndo: props.setUndo, restoring,
    finish: () => { setPlan(null); setRevision((value) => value + 1); },
  });
  const count = inventory.uses.length;
  return <SheetDialog label={t`Figure inventory`} className="figure-inventory" dirty={busy || !!plan} onClose={() => { if (!busy) props.onClose(); }}>
    <PanelHeader className="drawer-header" icon={<Images size={16} />} title={t`Figure inventory`} onClose={() => { if (!busy) props.onClose(); }} />
    <p className="drawer-copy">{t`All project TeX files and the active buffer. Literal graphics only; macros, conditions, subfigures and build order need manual review. PDF/SVG files are not scored as raster images.`}</p>
    <div className="figure-actions">
      <Button disabled={busy || loading} onClick={() => setRevision((value) => value + 1)}>{t`Refresh`}</Button>
      {!!props.undo.length && <Button disabled={busy} onClick={() => void write(props.undo.map((edit) => ({ path: edit.path, before: edit.after, after: edit.before })), true)}>{t`Undo replacement`}</Button>}
    </div>
    {busy && <p role="status">{t`Applying figure changes…`}</p>}
    {error && <InlineMessage level="error">{error}</InlineMessage>}
    {!!props.undo.length && <InlineMessage>{t`Changes are recorded per file in project history. Undo remains available if a later file fails.`}</InlineMessage>}
    {loading ? <p role="status">{t`Reading figure usages…`}</p> : <p>{t`${count} literal graphics commands found`}</p>}
    {!!unreadable.length && <InlineMessage level="warning">{t`Could not read:`} {unreadable.join(", ")}</InlineMessage>}
    {!!inventory.limited.length && <InlineMessage level="warning">{t`Static coverage is limited in:`} {inventory.limited.join(", ")}</InlineMessage>}
    {!loading && !count && <p>{t`No literal graphics commands found in the readable TeX sources. Macro-generated figures may still be present.`}</p>}
    {groups.map(([key, uses]) => <section className="figure-card" key={key}>
      <h3>{key}</h3>
      <div className="figure-actions">
        {uses[0].asset && <Button size="compact" disabled={busy} onClick={() => navigate(uses[0].asset!)}>{t`Open original`}</Button>}
        <Button size="compact" disabled={busy || loading} onClick={() => { setSelected(selected === key ? null : key); setTarget(""); setPlan(null); }}>{selected === key ? t`Hide details` : t`Inspect and replace`}</Button>
      </div>
      {uses.map((use) => <div className="figure-use" key={`${use.source}:${use.from}`}>
        <Button variant="ghost" size="compact" disabled={busy} onClick={() => navigate(use.source, use.line)}>{use.source}:{use.line}</Button>
        {!use.asset && <InlineMessage level="warning">{use.dynamic ? t`Path unresolved — macro or ambiguous filename` : t`Missing image`}</InlineMessage>}
        <p>{use.caption || t`Empty or unresolved caption`}</p>
        <p>{use.labels.join(", ") || t`No literal label`}</p>
        {!!use.duplicateLabels.length && <InlineMessage level="warning">{t`Duplicate labels:`} {use.duplicateLabels.join(", ")}</InlineMessage>}
        <div className="figure-actions">{use.references.length ? use.references.map((ref, index) => <Button key={index} variant="ghost" size="compact" disabled={busy} onClick={() => navigate(ref.source, ref.line)}>{t`Reference:`} {ref.source}:{ref.line}</Button>) : <span>{t`No literal references found`}</span>}</div>
      </div>)}
      {selected === key && <>
        {uses[0].asset && <FigurePreview key={`${props.project.root}:${uses[0].asset}`} root={props.project.root} path={uses[0].asset} uses={uses} />}
        <label>{t`Replace these usages with`}
          <select value={target} disabled={busy || uses.some((use) => use.dynamic) || !!unreadable.length} onChange={(event) => { setTarget(event.target.value); setPlan(null); }}>
            <option value="">{t`Choose a project image`}</option>
            {paths.filter((path) => isFigureAsset(path) && path !== uses[0].asset).map((path) => <option key={path} value={path}>{path}</option>)}
          </select>
        </label>
        {target && <FigurePreview key={`${props.project.root}:${target}`} root={props.project.root} path={target} uses={chosen} />}
        <Button disabled={!target || busy || loading} onClick={() => {
          try { setPlan(figureReplacement(liveSources, uses, target)); setError(null); }
          catch (reason) { setError(toMessage(reason)); }
        }}>{t`Preview replacement`}</Button>
        {freshPlan && <div className="figure-replacement">
          <p>{t`Only the listed graphics arguments will change. Image files stay in place.`}</p>
          {uses.map((use) => <p key={`${use.source}:${use.from}`}>{use.source}:{use.line}<br /><del>{use.raw}</del> → <ins>{figureArgument(target)}</ins></p>)}
          <Button variant="primary" disabled={busy} onClick={() => void write(freshPlan, false)}>{t`Replace listed usages`}</Button>
        </div>}
      </>}
    </section>)}
  </SheetDialog>;
}
