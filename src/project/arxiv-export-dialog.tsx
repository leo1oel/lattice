/**
 * Export for arXiv, checked first.
 *
 * Says what will be sent (Replit's "what you're publishing"), runs the checks
 * as one list of rows, each with a status and a muted detail (Vercel's
 * deployment checks), and names the result on its button. A warning never
 * blocks; only a failure does (Lovable's security scan). The pack and every
 * check come from the backend (`check_arxiv_package`): what the last build
 * read, with comments out and `\input` merged as the switches say, built
 * alone in a clean folder. The export (`export_arxiv_package`) writes that
 * same pack, and is refused when the project changed after its checks.
 *
 * Lazily loaded: nothing here is needed until the sheet opens.
 */
import { useEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { Channel, invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Check, ChevronDown, ChevronRight, CircleDashed, CircleX, FileArchive, LoaderCircle, TriangleAlert } from "lucide-react";
import { Button } from "../components/ui/button";
import { InlineMessage } from "../components/ui/inline-message";
import { ModalDialog } from "../components/ui/modal-dialog";
import { SwitchField } from "../components/ui/switch-field";
import { formatSize, toMessage } from "../app-utils";
import { useLatestRef } from "../hooks/use-latest-ref";
import { notifyCopied, notifyError, notifySuccess } from "../telemetry/app-notify";
import {
  archiveName, checkRows, leftOutLine, pendingRows, summaryLine,
  type ArxivCheck, type ArxivOptions, type CheckState,
} from "./arxiv-export";

type SheetState =
  | { phase: "checking"; check?: ArxivCheck }
  | { phase: "checked"; check: ArxivCheck }
  | { phase: "error"; message: string };

export default function ArxivExportDialog({ projectRoot, projectName, save, build, onClose }: {
  projectRoot: string;
  projectName: string;
  /** Write pending edits; false when they could not be. */
  save: () => Promise<boolean>;
  /** Build the paper, for a project never built here. */
  build: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [options, setOptions] = useState<ArxivOptions>({ stripComments: true, mergeInputs: true });
  const [state, setState] = useState<SheetState>({ phase: "checking" });
  const [attempt, setAttempt] = useState(0);
  const [filesOpen, setFilesOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [building, setBuilding] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Each check's number: the reply (or staged pack) of one the switches have
  // since replaced must not land over the newer one's.
  const checkRef = useRef(0);
  const saveRef = useLatestRef(save);

  useEffect(() => {
    const check = ++checkRef.current;
    const current = () => checkRef.current === check;
    const onStaged = new Channel<ArxivCheck>();
    onStaged.onmessage = (staged) => {
      if (current()) setState({ phase: "checking", check: staged });
    };
    void (async () => {
      if (!await saveRef.current()) throw new Error(t`Save your edits before exporting.`);
      return invoke<ArxivCheck>("check_arxiv_package", { projectRoot, options, onStaged });
    })().then(
      (checked) => { if (current()) setState({ phase: "checked", check: checked }); },
      (reason: unknown) => { if (current()) setState({ phase: "error", message: toMessage(reason) }); },
    );
  }, [attempt, options, projectRoot, saveRef, t]);

  // Whatever starts a new check says so first. The last pack stays on screen
  // while its replacement stages, but its test build no longer speaks for it.
  const recheck = () => {
    setState((previous) => ({ phase: "checking", check: previous.phase === "error" ? undefined : withoutBuild(previous.check) }));
    setAttempt((value) => value + 1);
  };
  const setOption = (update: Partial<ArxivOptions>) => {
    recheck();
    setOptions((current) => ({ ...current, ...update }));
  };

  // Closing stops the test build rather than leaving it to finish for nobody.
  useEffect(() => () => {
    checkRef.current += 1;
    void invoke("cancel_arxiv_check", { projectRoot }).catch(() => {});
  }, [projectRoot]);

  const check = state.phase === "error" ? undefined : state.check;
  const pack = check?.kind === "package" ? check : undefined;
  const rows = pack ? checkRows(pack) : [];
  const failures = rows.filter((row) => row.state === "fail").length;
  const warnings = rows.filter((row) => row.state === "warn").length;
  const running = state.phase === "checking";
  const fileName = archiveName(projectName);
  const rootDocument = check?.rootDocument ?? "main.tex";
  const copyLog = (log: string) => void navigator.clipboard.writeText(log).then(() => notifyCopied(t`Build log copied`));

  const exportZip = async () => {
    if (!pack) return;
    const zipPath = await saveDialog({
      title: t`Export for arXiv`,
      defaultPath: fileName,
      filters: [{ name: t`ZIP archive`, extensions: ["zip"] }],
    });
    if (!zipPath) return;
    setExporting(true);
    const exported = await invoke("export_arxiv_package", { projectRoot, options, digest: pack.digest, zipPath }).then(
      () => true,
      (reason: unknown) => {
        notifyError(t`Export for arXiv`, t`Could not export for arXiv`, { detail: toMessage(reason) });
        return false;
      },
    );
    setExporting(false);
    if (!exported) {
      // The pack changed after its checks, most likely: check what is there now.
      recheck();
      return;
    }
    notifySuccess(t`Export for arXiv`, t`Exported ${fileName}`, {
      primaryAction: { label: t`Show in Finder`, onClick: () => revealItemInDir(zipPath) },
    });
    onClose();
  };

  // The build reports its own failure; either way, check what it left.
  const buildFirst = async () => {
    setBuilding(true);
    await build().catch(() => {});
    setBuilding(false);
    recheck();
  };

  const status = running
    ? t`Checking…`
    : failures
      ? (failures === 1 ? t`1 to fix` : t`${failures} to fix`)
      : warnings
        ? (warnings === 1 ? t`Ready · 1 to look at` : t`Ready · ${warnings} to look at`)
        : pack ? t`Ready` : "";

  return (
    <ModalDialog label={t`Export for arXiv`} onClose={onClose}>
      <div className="modal arxiv-export-modal" aria-busy={running}>
        <h2>{t`Export for arXiv`}</h2>
        {state.phase === "error" && (
          <div className="arxiv-export-blocked">
            <InlineMessage level="error">{state.message}</InlineMessage>
            <Button variant="secondary" size="compact" onClick={recheck}>{t`Check again`}</Button>
          </div>
        )}
        {check?.kind === "unbuilt" && (
          <div className="arxiv-export-blocked">
            <InlineMessage level="info">
              {t`Build the paper first`}
            </InlineMessage>
            <Button variant="secondary" size="compact" disabled={building || running} onClick={() => void buildFirst()}>
              {building ? t`Building…` : t`Build`}
            </Button>
          </div>
        )}
        {(pack || (running && !check)) && (
          <>
            <div className="arxiv-export-summary">
              <span className="arxiv-export-icon" aria-hidden="true"><FileArchive size={18} /></span>
              <div className="arxiv-export-summary-text">
                <b title={fileName}>{fileName}</b>
                <span>{pack ? summaryLine(pack) : t`Gathering the files the paper uses…`}</span>
              </div>
              {pack && (
                <button
                  type="button"
                  className="arxiv-export-disclosure"
                  aria-expanded={filesOpen}
                  onClick={() => setFilesOpen((open) => !open)}
                >
                  {t`Files`}
                  {filesOpen ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
                </button>
              )}
            </div>
            {pack && filesOpen && (
              <ul className="arxiv-export-files" aria-label={t`Files in the package`}>
                {pack.files.map((file) => (
                  <li key={file.path}><span title={file.path}>{file.path}</span><span>{formatSize(file.bytes)}</span></li>
                ))}
              </ul>
            )}
            {pack && pack.leftOut.length > 0 && (
              <p className="arxiv-export-left-out">{leftOutLine(pack.leftOut)}</p>
            )}
            <ul className="arxiv-export-checks" aria-label={t`Checks`}>
              {(pack ? rows : pendingRows()).map((row) => (
                <li key={row.id} data-state={row.state} data-check={row.id}>
                  <div className="arxiv-check-row">
                    <span className="arxiv-check-icon" aria-hidden="true"><CheckIcon state={row.state} /></span>
                    <span className="arxiv-check-text">
                      <b>{row.label}</b>
                      <span title={row.detail}>{row.detail}</span>
                    </span>
                    {row.review && row.review.length > 0 && (
                      <Button variant="ghost" size="compact" aria-expanded={reviewOpen} onClick={() => setReviewOpen((open) => !open)}>
                        {t({ message: "Review", context: "arXiv export comments" })}
                      </Button>
                    )}
                    {row.id === "compile" && row.state === "fail" && pack?.compile?.log && (
                      <Button variant="ghost" size="compact" onClick={() => copyLog(pack.compile?.log ?? "")}>
                        {t`Copy log`}
                      </Button>
                    )}
                  </div>
                  {row.review && reviewOpen && (
                    <ul className="arxiv-export-comments" aria-label={t`Comments in the source`}>
                      {row.review.map((comment) => (
                        <li key={`${comment.file}:${comment.line}`} data-todo={comment.todo || undefined}>
                          <span className="arxiv-export-comment-where">{comment.file}:{comment.line}</span>
                          <span className="arxiv-export-comment-text" title={comment.text}>{comment.text}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
            <div className="arxiv-export-options">
              <SwitchField
                label={t`Remove % comments`}
                checked={options.stripComments}
                onChange={(stripComments) => setOption({ stripComments })}
              />
              <SwitchField
                label={t`Merge \\input files into ${rootDocument}`}
                checked={options.mergeInputs}
                onChange={(mergeInputs) => setOption({ mergeInputs })}
              />
            </div>
          </>
        )}
        <div className="modal-actions arxiv-export-actions">
          <span className="arxiv-export-status" role="status">{status}</span>
          <Button variant="ghost" onClick={onClose}>{t`Cancel`}</Button>
          <Button
            variant="primary"
            disabled={!pack || running || failures > 0 || exporting}
            onClick={() => void exportZip()}
          >
            {exporting ? t`Exporting…` : t`Export ZIP`}
          </Button>
        </div>
      </div>
    </ModalDialog>
  );
}

function withoutBuild(check: ArxivCheck | undefined): ArxivCheck | undefined {
  return check?.kind === "package" ? { ...check, compile: undefined } : check;
}

function CheckIcon({ state }: { state: CheckState }) {
  switch (state) {
    case "ok": return <Check size={13} />;
    case "warn": return <TriangleAlert size={13} />;
    case "fail": return <CircleX size={13} />;
    case "running": return <LoaderCircle size={13} className="spin" />;
    default: return <CircleDashed size={13} />;
  }
}
