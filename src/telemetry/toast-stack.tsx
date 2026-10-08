import { useEffect, useState } from "react";
import { Toast } from "@base-ui/react/toast";
import { CheckCircle2, CircleAlert, Info } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { CloseButton } from "../components/ui/icon-button";
import { InfinityLoader } from "../components/ui/activity-icons";
import { buttonClassName } from "../components/ui/button-styles";
import { CopyButton } from "../components/copy-button";
import type { ToastPosition } from "../settings/app-settings";
import {
  dismissAppToast,
  getVisibleAppToastIds,
  useAppToastsSnapshot,
  visibleToastDetail,
  type AppToastProgress,
  type AppToastView,
} from "./app-log-store";
import { useToastPosition } from "./toast-position";
import "./toast-stack.css";

/*
 * The window's one notification surface.
 *
 * `app-log-store.ts` decides what is on screen — every notification is a log
 * entry first, and its dedupe, retraction and four-toast cap live there. This
 * module only draws that list, on Base UI's Toast: the stack that compresses
 * into a pile and fans out under the pointer or keyboard focus, swipe and Esc
 * to dismiss, F6 to reach it, and an auto-dismiss clock that holds while the
 * stack is hovered or focused and while the window is in the background.
 *
 * The store stays the authority, so the two lists are kept in step in one
 * direction: each visible view is upserted into Base UI by its entry id, a view
 * that left the store is closed there, and a close Base UI starts itself
 * (timer, swipe, Esc, ×) is reported back to the store as a dismissal.
 */

// One silhouette for every level: severity reads from the status colour.
const LEVEL_ICON = { info: Info, success: CheckCircle2, warning: CircleAlert, error: CircleAlert };
/** The store keeps at most four on screen; Base UI's own limit must not hide one of those. */
const STACK_LIMIT = 4;

type ToastData = { view: AppToastView };
type StackToast = Toast.Root.ToastObject<ToastData>;

function toastTimeout({ entry, options }: AppToastView): number {
  // A running operation is settled by its owner, never by the clock.
  if (options?.progress !== undefined) return 0;
  const timeoutMs = options?.timeoutMs ?? (entry.level === "error" ? 9_000 : 6_000);
  return timeoutMs === 0 ? 0 : Math.max(1_000, timeoutMs);
}

/** Swipe toward the edge the stack stands on, or off the side it is pinned to. */
function swipeDirections(at: ToastPosition): Array<"up" | "down" | "right"> {
  const vertical = at.startsWith("top") ? "up" : "down";
  return at.endsWith("right") ? [vertical, "right"] : [vertical];
}

export function ToastStack() {
  const { t } = useLingui();
  const views = useAppToastsSnapshot();
  const at = useToastPosition();
  // Nothing of Base UI mounts until the first notification: most launches show
  // none, and startup should not pay for an empty viewport. Once mounted it
  // stays, so the last toast can finish its exit.
  const [mounted, setMounted] = useState(false);
  if (views.length > 0 && !mounted) setMounted(true);
  if (!mounted) return null;
  return (
    <Toast.Provider limit={STACK_LIMIT}>
      <Toast.Portal>
        <Toast.Viewport className="app-toast-viewport" data-position={at} aria-label={t`Notifications`}>
          <ToastList views={views} at={at} />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

function ToastList({ views, at }: { views: readonly AppToastView[]; at: ToastPosition }) {
  const { toasts, add, close } = Toast.useToastManager<ToastData>();
  useEffect(() => {
    const visible = new Set(views.map((view) => view.entry.id));
    for (const toast of toasts) {
      if (!visible.has(toast.id) && toast.transitionStatus !== "ending") close(toast.id);
    }
    // Oldest first: Base UI puts a new toast at the front, so the newest ends there.
    for (const view of [...views].reverse()) {
      const { entry } = view;
      const current = toasts.find((toast) => toast.id === entry.id);
      if (current?.data?.view === view && current.transitionStatus !== "ending") continue;
      add({
        id: entry.id,
        title: entry.title,
        // Title and description are also what an urgent toast announces.
        description: visibleToastDetail(entry.detail) || undefined,
        type: entry.level,
        priority: entry.level === "error" ? "high" : "low",
        // Re-adding an id updates it in place and restarts its clock, which is
        // what a collapsed repeat needs: a full window after the latest one.
        timeout: toastTimeout(view),
        data: { view },
        // Base UI closed it (clock, swipe, Esc, ×). A close the store asked for
        // finds the id already gone and reports nothing.
        onClose: () => {
          if (getVisibleAppToastIds().includes(entry.id)) dismissAppToast(entry.id);
        },
      });
    }
  }, [add, close, toasts, views]);
  return toasts.map((toast) => toast.data && (
    <AppToast key={toast.id} toast={toast} view={toast.data.view} at={at} onClose={() => close(toast.id)} />
  ));
}

function AppToast({ toast, view, at, onClose }: { toast: StackToast; view: AppToastView; at: ToastPosition; onClose: () => void }) {
  const { t } = useLingui();
  const { entry, options } = view;
  const detail = visibleToastDetail(entry.detail);
  const progress = options?.progress;
  const Icon = LEVEL_ICON[entry.level];
  const actions = [options?.primaryAction, options?.secondaryAction].flatMap((action) => action ? [action] : []);
  const hasActions = Boolean(options?.copyText) || actions.length > 0;
  // Messages migrated off the old one-line banners arrive as a title with no
  // detail, so length has to be judged across both — a 200-character title
  // clipped to one line is the failure this replaced.
  const multiline = detail.length > 72 || entry.title.length > 72 || hasActions || progress !== undefined;
  return (
    <Toast.Root
      toast={toast}
      swipeDirection={swipeDirections(at)}
      className={`app-toast ${entry.level}${multiline ? " multiline" : ""}`}
      data-app-toast=""
      // Notifications arrive while someone is writing. Taking the caret out of
      // the editor to dismiss one — and losing the selection with it — is worse
      // than the interruption itself, so the card refuses focus on press and
      // lets the click through to the button underneath. Keyboard users reach
      // the stack with F6.
      onMouseDown={(event) => event.preventDefault()}
    >
      <Toast.Content className="app-toast-content">
        <span className="app-toast-icon">
          {progress !== undefined ? <InfinityLoader size={15} /> : <Icon size={15} aria-hidden="true" />}
        </span>
        <div className="app-toast-body">
          <Toast.Title className="app-toast-title">{entry.title}</Toast.Title>
          {detail && <Toast.Description className="app-toast-description" title={detail}>{detail}</Toast.Description>}
          {progress !== undefined && <ToastProgress progress={progress} label={entry.title} />}
          {hasActions && (
            <div className="app-toast-actions">
              {options?.copyText && (
                <CopyButton className={buttonClassName({ size: "compact" })} text={options.copyText} title={t`Copy notification command`}>
                  {t`Copy`}
                </CopyButton>
              )}
              {actions.map((action, index) => (
                <button
                  key={index}
                  type="button"
                  className={buttonClassName({ size: "compact", variant: index === 0 ? "primary" : "secondary" })}
                  onClick={() => {
                    void action.onClick();
                    // The action was the answer, so it is not also reported as a dismissal.
                    if (!action.keepOpen) dismissAppToast(entry.id, false);
                  }}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <CloseButton label={t`Dismiss notification`} size="compact" onClick={onClose} />
      </Toast.Content>
    </Toast.Root>
  );
}

function ToastProgress({ progress, label }: { progress: AppToastProgress; label: string }) {
  const determinate = typeof progress === "number";
  const percent = determinate ? Math.round(Math.min(1, Math.max(0, progress)) * 100) : null;
  return (
    <div className="app-toast-progress-row">
      <div
        className="app-toast-progress"
        role="progressbar"
        aria-label={label}
        aria-valuemin={determinate ? 0 : undefined}
        aria-valuemax={determinate ? 100 : undefined}
        aria-valuenow={percent ?? undefined}
        data-indeterminate={determinate ? undefined : ""}
      >
        <div className="app-toast-progress-fill" style={percent === null ? undefined : { width: `${percent}%` }} />
      </div>
      {percent !== null && <span className="app-toast-progress-value">{percent}%</span>}
    </div>
  );
}
