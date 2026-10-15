import { useEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Check, Copy, Download } from "lucide-react";
import { IconButton } from "../components/ui/icon-button";
import { PanelHeader } from "../components/ui/panel-header";
import { ModalDialog } from "../components/ui/modal-dialog";
import { useLatestRef } from "../hooks/use-latest-ref";
import type { Theme } from "../settings/app-settings";
import {
  parseAgentVisualSave, readAgentVisualMessage, saveAgentVisual, type AgentVisualExpand,
} from "./agent-visual-save";

/**
 * An Agent visual shown over the window, at the size the Agent panel cannot
 * give it. The frame loads the panel's own sandboxed host document unchanged:
 * an opaque origin (never `allow-same-origin`), no popups or top navigation,
 * and the document's policy blocks the network and the visual's navigations.
 * Lattice reads two things from it: the height its page reports, and an
 * Escape the page left alone.
 */
export function AgentVisualDialog({ visual, theme, onClose }: {
  visual: AgentVisualExpand;
  theme: Theme;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const closeRef = useLatestRef(onClose);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const message = readAgentVisualMessage(event.data);
      if (!message) return;
      if ("escape" in message) closeRef.current();
      else setHeight(message.height);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [closeRef]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = () => void writeText(visual.html).then(() => setCopied(true), () => undefined);
  const save = () => {
    const request = parseAgentVisualSave({ filename: visual.title, html: visual.html });
    if (request) saveAgentVisual(request);
  };
  return (
    // The dialog itself takes focus on open: a focused header button would
    // show its tooltip, and the first Escape would only close that.
    <ModalDialog label={visual.title} focusDialogOnOpen onClose={onClose}>
      <div className="modal sheet-dialog native-hover-scrollbar agent-visual-dialog">
        <PanelHeader
          className="drawer-header"
          title={visual.title}
          onClose={onClose}
          closeLabel={t`Close visual`}
          actions={<>
            <IconButton label={copied ? t`Copied` : t`Copy source`} onClick={copy}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </IconButton>
            <IconButton label={t`Download HTML`} onClick={save}>
              <Download size={14} />
            </IconButton>
          </>}
        />
        <iframe
          ref={frameRef}
          className="agent-visual-frame"
          title={visual.title}
          srcDoc={visual.document}
          sandbox="allow-scripts allow-forms"
          referrerPolicy="no-referrer"
          // The page is transparent only while its scheme matches the frame's.
          style={{ height: height ?? undefined, colorScheme: theme }}
        />
      </div>
    </ModalDialog>
  );
}
