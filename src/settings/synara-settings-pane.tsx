import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { EmptyState } from "../components/ui/empty-state";
import { InfinityLoader } from "../components/ui/activity-icons";
import type { SynaraRuntimeInfo } from "../agent/synara-runtime";
import { useSynaraNotificationBridge } from "../agent/synara-notifications";
import { useSynaraConfirmationBridge } from "../agent/synara-confirmations";
import { SynaraLoadingSurface } from "../agent/synara-loading-surface";
import {
  applySynaraSettingsHeight,
  applySynaraSettingsWheel,
  isSettingsViewportNearBottom,
  normalizeSynaraSettingsHeight,
} from "../agent/synara-settings-layout";

const DEFAULT_FRAME_HEIGHT = 470;

type FrameSlot = { current: number | null };

function cancelFrame(slot: FrameSlot) {
  if (slot.current !== null) window.cancelAnimationFrame(slot.current);
  slot.current = null;
}

function scheduleFrame(slot: FrameSlot, callback: () => void) {
  cancelFrame(slot);
  slot.current = window.requestAnimationFrame(() => {
    slot.current = null;
    callback();
  });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Providers, MCP and Skills are Synara's own settings pages, embedded without
 * their own scrolling: the iframe reports its content height and forwards wheel
 * gestures, and the host settings viewport does all of the scrolling.
 *
 * Stays mounted for the whole dialog so measured heights and the ready
 * handshake survive visits to the other tabs.
 */
export function SynaraSettingsPane(props: {
  runtime: SynaraRuntimeInfo;
  /** Set only on a Synara tab; null there while no project is open. */
  section: string | undefined;
  url: string | null;
  synaraSettingsLabel: string | undefined;
  viewportRef: RefObject<HTMLDivElement | null>;
  onRetry: () => void;
}) {
  const { runtime, section, url, synaraSettingsLabel, viewportRef } = props;
  const { t } = useLingui();
  const embedRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Keyed by `${url}#${section}`.
  const heightsRef = useRef<Record<string, number>>({});
  const listScrollRef = useRef<Record<string, number>>({});
  const detailKeysRef = useRef(new Set<string>());
  const pendingRestoreRef = useRef<{ key: string; top: number } | null>(null);
  const frameHeightRef = useRef(DEFAULT_FRAME_HEIGHT);
  const bottomPinFrameRef = useRef<number | null>(null);
  const navigationFrameRef = useRef<number | null>(null);
  const [readyUrl, setReadyUrl] = useState<string | null>(null);
  const origin = runtime.state === "ready" && runtime.origin ? new URL(runtime.origin).origin : null;
  const key = url && section ? `${url}#${section}` : null;
  const ready = Boolean(url && readyUrl === url);
  useSynaraNotificationBridge({ frameRef, origin, source: "Synara settings" });
  useSynaraConfirmationBridge({ frameRef, origin });

  const postSection = useCallback(() => {
    if (!origin || !section) return;
    frameRef.current?.contentWindow?.postMessage({ type: "lattice:set-settings-section", section }, origin);
  }, [origin, section]);

  // The geometry is written straight to the DOM rather than through state:
  // height and wheel messages from the iframe are ordered, but a React update
  // is not committed before the following wheel message, and that first wheel
  // has to use the real scroll range.
  const showHeight = useCallback((height: number) => {
    frameHeightRef.current = height;
    applySynaraSettingsHeight({ container: embedRef.current, frame: frameRef.current, height, active: true });
  }, []);

  useLayoutEffect(() => {
    cancelFrame(bottomPinFrameRef);
    detailKeysRef.current.clear();
    pendingRestoreRef.current = null;
    showHeight(key ? heightsRef.current[key] ?? DEFAULT_FRAME_HEIGHT : DEFAULT_FRAME_HEIGHT);
    postSection();
  }, [key, postSection, showHeight]);

  useEffect(() => () => {
    cancelFrame(bottomPinFrameRef);
    cancelFrame(navigationFrameRef);
  }, []);

  useEffect(() => {
    if (!origin || !url || !key) return;
    const restoreListScroll = (top: number) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      viewport.scrollTop = top;
      if (Math.abs(viewport.scrollTop - top) <= 1) pendingRestoreRef.current = null;
    };
    const receive = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow || event.origin !== origin) return;
      const data = event.data;
      const viewport = viewportRef.current;
      // The postMessage protocol spoken by the embedded Synara settings runtime.
      switch (data?.type) {
        case "synara:settings-content-height": {
          if (!isFiniteNumber(data.height) || typeof data.section !== "string") return;
          const height = normalizeSynaraSettingsHeight(data.height);
          heightsRef.current[`${url}#${data.section}`] = height;
          if (data.section !== section) return;
          const keepPinnedToBottom = Boolean(
            viewport &&
            height > frameHeightRef.current &&
            !detailKeysRef.current.has(key) &&
            pendingRestoreRef.current?.key !== key &&
            isSettingsViewportNearBottom(viewport),
          );
          showHeight(height);
          const pending = pendingRestoreRef.current;
          if (pending?.key === key) scheduleFrame(navigationFrameRef, () => restoreListScroll(pending.top));
          // A disclosure expanding at the old bottom otherwise leaves the
          // scrollbar there, with the newly added controls below the viewport.
          if (keepPinnedToBottom) {
            scheduleFrame(bottomPinFrameRef, () => {
              const current = viewportRef.current;
              if (current) current.scrollTop = current.scrollHeight;
            });
          }
          return;
        }
        case "synara:settings-navigation": {
          if (data.section !== section || (data.view !== "detail" && data.view !== "list") || !viewport) return;
          cancelFrame(bottomPinFrameRef);
          cancelFrame(navigationFrameRef);
          // A detail page replaces its list; returning restores the list's
          // scroll once its height has arrived.
          if (data.view === "detail") {
            if (!detailKeysRef.current.has(key)) listScrollRef.current[key] = viewport.scrollTop;
            detailKeysRef.current.add(key);
            pendingRestoreRef.current = null;
          } else {
            detailKeysRef.current.delete(key);
            const top = listScrollRef.current[key] ?? 0;
            pendingRestoreRef.current = { key, top };
            scheduleFrame(navigationFrameRef, () => restoreListScroll(top));
          }
          viewport.scrollTop = 0;
          return;
        }
        case "synara:embed-ready":
          setReadyUrl(url);
          return;
        case "synara:settings-wheel":
          if (!isFiniteNumber(data.deltaY) || !viewport) return;
          if (isFiniteNumber(data.contentHeight) && data.section === section) {
            const height = normalizeSynaraSettingsHeight(data.contentHeight);
            heightsRef.current[key] = height;
            showHeight(height);
          }
          applySynaraSettingsWheel(viewport, {
            deltaX: typeof data.deltaX === "number" ? data.deltaX : 0, deltaY: data.deltaY, deltaMode: data.deltaMode,
          });
          return;
        case "synara:open-external":
          if (typeof data.url === "string" && /^https?:\/\//i.test(data.url)) void openUrl(data.url);
          return;
        case "synara:show-in-folder":
          // The exact iframe window and origin were verified above. Ignore the
          // child-provided path and reveal only Lattice's own shared-skill folder.
          void invoke("synara_open_skills_folder");
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [key, origin, section, showHeight, url, viewportRef]);

  useEffect(() => {
    // WKWebView delivers wheel to the iframe element when scrolling="no", not
    // to the child document. Without this, Providers/MCP/Skills can only move
    // from the Lattice scrollbar thumb.
    const container = embedRef.current;
    if (!container || !section) return;
    const onWheel = (event: WheelEvent) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      applySynaraSettingsWheel(viewport, event);
      event.preventDefault();
    };
    container.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => container.removeEventListener("wheel", onWheel, { capture: true });
  }, [section, url, viewportRef]);

  if (!section) return null;
  if (!url) {
    return (
      <div className="synara-settings-state">
        {runtime.state === "ready"
          ? <EmptyState description={t`Open a project to manage Agent settings`} />
          : <SynaraLoadingSurface runtime={runtime} onRetry={props.onRetry} />}
      </div>
    );
  }
  return (
    <div ref={embedRef} className="synara-settings-embed" data-ready={ready} aria-busy={!ready}>
      <iframe
        ref={frameRef}
        className="synara-settings-frame"
        src={url}
        title={t`Synara ${synaraSettingsLabel} settings`}
        allow="clipboard-read; clipboard-write"
        sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
        scrolling="no"
        onLoad={postSection}
      />
      {!ready && (
        <div className="synara-settings-loading" role="status">
          <InfinityLoader size={14} /> {t`Loading settings…`}
        </div>
      )}
    </div>
  );
}
