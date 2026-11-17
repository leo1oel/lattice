import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useLingui } from "@lingui/react/macro";
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { Input } from "../components/ui/input";
import { IconButton } from "../components/ui/icon-button";
import { ResizableDrawer } from "../components/ui/resizable-drawer";
import { useTrellisController } from "../trellis/trellis-controller";
import { showError } from "../app/notify";
import { browserPanel } from "./link-destination";
import { browserPanelBounds } from "./browser-panel-bounds";
import "./browser-panel.css";

type Status = { url: string | null; canGoBack: boolean; canGoForward: boolean; loading: boolean };
type Command = { kind: "navigate"; url: string } | { kind: "place"; bounds: ReturnType<typeof browserPanelBounds> }
  | { kind: "back" | "forward" | "reload" | "status" | "close" };

const EMPTY = {
  status: { url: null, canGoBack: false, canGoForward: false, loading: false } satisfies Status,
  address: "",
  ready: false,
};
type PanelState = { status: Status; address: string; ready: boolean };
type PanelAction = { address: string } | { status: Status; followAddress: boolean; navigated: boolean };

function reducePanel(current: PanelState, action: PanelAction): PanelState {
  if ("address" in action) return { ...current, address: action.address };
  const { status } = action;
  const address = action.followAddress && status.url ? status.url : current.address;
  const ready = current.ready || action.navigated;
  const previous = current.status;
  if (previous.url === status.url && previous.canGoBack === status.canGoBack
    && previous.canGoForward === status.canGoForward && previous.loading === status.loading
    && address === current.address && ready === current.ready) return current;
  return { status, address, ready };
}
let commands: Promise<unknown> = Promise.resolve();

function browserCommand(command: Command) {
  const result = commands.then(() => invoke<Status>("browser_panel", { command }));
  commands = result.catch(() => undefined);
  return result;
}

function addressed(input: string) {
  const value = input.trim();
  if (!value) return null;
  return /^\w+:\/\//.test(value) ? value : `https://${value}`;
}

export default function BrowserPanel({ request }: { request: { url?: string } }) {
  const { t } = useLingui();
  const trellis = useTrellisController();
  const [{ status, address, ready }, dispatch] = useReducer(reducePanel, EMPTY);
  const writingAddress = useRef(false);
  const slot = useRef<HTMLDivElement>(null);
  const updateStatus = useCallback((next: Status, navigated = false) => {
    dispatch({ status: next, followAddress: !writingAddress.current, navigated });
  }, []);
  const send = useCallback((command: Command) => {
    void browserCommand(command).then(
      (next) => updateStatus(next, command.kind === "navigate"),
      () => showError(t`Could not open the page in the Browser panel.`),
    );
  }, [t, updateStatus]);

  useEffect(() => {
    trellis?.revealOpenTool("browser");
    if (request.url) void send({ kind: "navigate", url: request.url });
  }, [request, send, trellis]);

  useEffect(() => {
    if (!ready || !slot.current) return;
    const content = slot.current;
    let frame = 0;
    let last = "";
    let disposed = false;
    let visible = false;
    function place() {
      frame = 0;
      const bounds = browserPanelBounds(content);
      visible = bounds !== null;
      const fingerprint = JSON.stringify(bounds);
      if (last === fingerprint) return;
      last = fingerprint;
      void browserCommand({ kind: "place", bounds }).catch(() => { last = ""; });
    }
    function schedule() {
      if (!frame) frame = window.requestAnimationFrame(place);
    }
    const resize = new ResizeObserver(schedule);
    resize.observe(content);
    const changes = new MutationObserver(schedule);
    changes.observe(document.body, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ["style", "class", "open", "aria-hidden", "data-busy", "data-state"],
    });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    document.addEventListener("visibilitychange", schedule);
    const refresh = window.setInterval(() => {
      if (!visible) return;
      void browserCommand({ kind: "status" }).then((next) => {
        if (disposed) return;
        updateStatus(next);
      }).catch(() => undefined);
    }, 500);
    place();
    return () => {
      disposed = true;
      if (frame) window.cancelAnimationFrame(frame);
      resize.disconnect();
      changes.disconnect();
      window.clearInterval(refresh);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [ready, updateStatus]);

  useEffect(() => () => {
    void browserCommand({ kind: "close" }).catch(() => undefined);
  }, []);

  return (
    <ResizableDrawer className="browser-drawer" ariaLabel={t`Browser`} onClose={() => browserPanel.setState({ request: null })}>
      <form className="browser-toolbar" onSubmit={(event) => {
        event.preventDefault();
        const url = addressed(address);
        if (url) {
          writingAddress.current = false;
          void send({ kind: "navigate", url });
        }
      }}>
        <IconButton label={t`Back`} disabled={!status.canGoBack} onClick={() => void send({ kind: "back" })}><ArrowLeft size={15} /></IconButton>
        <IconButton label={t`Forward`} disabled={!status.canGoForward} onClick={() => void send({ kind: "forward" })}><ArrowRight size={15} /></IconButton>
        <IconButton label={t`Reload`} disabled={!status.url} onClick={() => void send({ kind: "reload" })}><RotateCw size={14} /></IconButton>
        <Input
          type="text" value={address} onChange={(event) => dispatch({ address: event.target.value })}
          onFocus={() => { writingAddress.current = true; }}
          onBlur={() => { writingAddress.current = false; }}
          aria-label={t`Web address`} placeholder={t`Enter a web address`}
          autoCapitalize="off" autoComplete="off" spellCheck={false}
        />
        <IconButton label={t`Open in default browser`} disabled={!status.url} onClick={() => {
          if (status.url) void openUrl(status.url).catch(() => undefined);
        }}><ExternalLink size={14} /></IconButton>
      </form>
      <div className="browser-content-slot" ref={slot} aria-busy={status.loading} />
    </ResizableDrawer>
  );
}
