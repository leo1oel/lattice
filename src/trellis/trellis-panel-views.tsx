/**
 * The workspace's own panels: the navigators, the Agent, the PDF and the
 * tool drawers, each adopting the host App renders it into, and the empty
 * states a panel shows while its content is not mounted.
 */
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { useView } from "@danfessler/trellis-react";
import { FolderTree, Moon, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { ResearchArt } from "@/components/ui/research-art";
import { MANUSCRIPT_CLIPBOARD } from "@/components/ui/research-art-clipboard";
import type { TrellisController, TrellisSingleton, TrellisToolKind } from "./trellis-controller";
import { PANEL_TITLES, spaceMixedScript } from "./trellis-titles";
import { PANEL_ICONS } from "./trellis-icons";

/**
 * Adopt a host element App portals into; it never leaves this slot while
 * mounted. `inline` slots sit in a tab bar and take only their content's
 * width: a full-size slot there would cover the bar and swallow the drags
 * and clicks that belong to it.
 */
export function HostSlot({ host, className, inline = false }: { host: HTMLElement; className?: string; inline?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = ref.current;
    if (!slot) return;
    slot.appendChild(host);
    return () => {
      if (host.parentElement === slot) slot.removeChild(host);
    };
  }, [host]);
  return <div ref={ref} className={cn(inline ? "trellis-slot-inline" : "trellis-slot", className)} />;
}

/** Report a singleton panel's presence and visibility to the controller. */
function useReportPanel(controller: TrellisController, kind: TrellisSingleton) {
  const view = useView();
  const visible = view.visible;
  useEffect(() => {
    const { present, visible: shown } = controller.ui.get();
    controller.ui.set({ present: { ...present, [kind]: true }, visible: { ...shown, [kind]: visible } });
  }, [controller, kind, visible]);
  useEffect(() => () => {
    const { present, visible: shown } = controller.ui.get();
    controller.ui.set({ present: { ...present, [kind]: false }, visible: { ...shown, [kind]: false } });
  }, [controller, kind]);
  return view;
}

export function NavigatorView({ controller, kind }: { controller: TrellisController; kind: "project" | "papers" }) {
  useReportPanel(controller, kind);
  return <HostSlot host={controller.hosts[kind]} className="trellis-navigator" />;
}

export function AgentView({ controller }: { controller: TrellisController }) {
  useReportPanel(controller, "agent");
  useEffect(() => { controller.bridge?.agentShown(); }, [controller]);
  return <HostSlot host={controller.hosts.agent} className="trellis-agent" />;
}

/** A quiet placeholder for a panel whose content is not mounted right now. */
export function EmptyState({ icon, art, title, children, onActivate, className }: {
  icon?: ReactNode;
  /** A drawing in place of the icon, for a panel with room to show one. */
  art?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  onActivate?: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn("trellis-empty", onActivate && "trellis-empty-activatable", className)}
      onClick={onActivate}
      role={onActivate ? "button" : undefined}
      tabIndex={onActivate ? 0 : undefined}
      onKeyDown={onActivate ? (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onActivate();
        }
      } : undefined}
    >
      {art ? <span className="trellis-empty-art">{art}</span> : <span className="trellis-empty-icon">{icon}</span>}
      <strong>{title}</strong>
      {children && <div className="trellis-empty-actions">{children}</div>}
    </div>
  );
}

export function PdfView({ controller }: { controller: TrellisController }) {
  const { t } = useLingui();
  useReportPanel(controller, "pdf");
  const live = useSyncExternalStore(controller.ui.subscribe, () => controller.ui.get().pdfLive);
  return (
    <>
      <HostSlot host={controller.hosts.pdf} className="trellis-pdf" />
      {!live && (
        <EmptyState icon={<Moon size={16} />} title={t`PDF preview paused`} />
      )}
    </>
  );
}

export function ToolView({ controller, kind }: { controller: TrellisController; kind: TrellisToolKind }) {
  const { t, i18n } = useLingui();
  useReportPanel(controller, kind);
  const open = useSyncExternalStore(controller.openDrawers.subscribe, () => Boolean(controller.openDrawers.get()[kind]));
  // A tool panel restored from a saved layout re-opens its drawer once.
  useEffect(() => {
    if (!controller.openDrawers.get()[kind]) controller.bridge?.openTool(kind);
  }, [controller, kind]);
  const title = i18n._(PANEL_TITLES[kind]);
  return (
    <>
      <HostSlot host={controller.toolHost(kind)} className="trellis-tool" />
      {!open && (
        <EmptyState icon={PANEL_ICONS[kind]} title={title}>
          <button type="button" className="trellis-empty-button" onClick={() => controller.bridge?.openTool(kind)}>
            {spaceMixedScript(t`Open ${title}`)}
          </button>
        </EmptyState>
      )}
    </>
  );
}

/** Quick open's keys beside its button, from the command table rather than typed out. */
function QuickOpenKeys({ controller }: { controller: TrellisController }) {
  const keys = controller.bridge?.shortcut("quick-open");
  return keys ? <kbd>{keys}</kbd> : null;
}

/** A document panel with no document in it: the next one opened lands here. */
export function SlotView({ controller }: { controller: TrellisController }) {
  const { t } = useLingui();
  return (
    <EmptyState
      art={<ResearchArt drawing={MANUSCRIPT_CLIPBOARD} />}
      title={t`No document open`}
    >
      <button type="button" className="trellis-empty-button" onClick={() => controller.bridge?.quickOpen()}>
        <Search size={13} />
        {t`Quick open`}
        <QuickOpenKeys controller={controller} />
      </button>
    </EmptyState>
  );
}

/** Only when every panel is closed: panels fill each other's space otherwise. */
export function WorkspaceEmpty({ controller }: { controller: TrellisController }) {
  const { t } = useLingui();
  return (
    <EmptyState
      className="trellis-workspace-empty"
      art={<ResearchArt drawing={MANUSCRIPT_CLIPBOARD} />}
      title={t`Every panel is closed`}
    >
      <button type="button" className="trellis-empty-button" onClick={() => controller.bridge?.quickOpen()}>
        <Search size={13} />
        {t`Quick open`}
        <QuickOpenKeys controller={controller} />
      </button>
      <button type="button" className="trellis-empty-button" onClick={() => void controller.resetLayout()}>
        <FolderTree size={13} />
        {t`Reset layout`}
      </button>
    </EmptyState>
  );
}
