/**
 * The pieces the Overleaf connection UI shares between Settings → Overleaf
 * and the "Open from Overleaf" picker: sign-in controls, retry and progress
 * rows, and the picker's centered stage messages.
 */
import type { ReactNode } from "react";
import { Cloud } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { InfinityLoader, ReloadButton } from "../components/ui/activity-icons";
import { Button } from "../components/ui/button";
import { buttonClassName } from "../components/ui/button-styles";
import { InlineMessage } from "../components/ui/inline-message";
import { MotionButton } from "../components/ui/motion";
import type { useOverleafLogin } from "./use-overleaf-login";
/** Notification source label for everything the Overleaf connection UI says. */
export const OVERLEAF_SOURCE = "Overleaf";

export type OverleafLogin = ReturnType<typeof useOverleafLogin>;

/** How the last sign-in attempt ended, when that needs saying. */
export function LoginMessages({ login }: { login: OverleafLogin }) {
  return (
    <>
      {login.error && <InlineMessage level="error" className="overleaf-inline">{login.error}</InlineMessage>}
      {login.notice && <InlineMessage level="info" className="overleaf-inline">{login.notice}</InlineMessage>}
    </>
  );
}

/** The sign-in button, or the wait for the sign-in window, plus how the last attempt ended. */
export function LoginControls(props: { login: OverleafLogin; label: string; hint?: string }) {
  const { t } = useLingui();
  const { login } = props;
  const button = (
    <MotionButton className={buttonClassName({ variant: "primary" })} onClick={login.begin}>
      <Cloud size={15} /> {props.label}
    </MotionButton>
  );
  return (
    <>
      {login.pending ? (
        <>
          <div className="overleaf-waiting" role="status">
            <InfinityLoader size={15} />
            <span>{t`Waiting for you to sign in in the Overleaf window…`}</span>
            <Button size="compact" variant="ghost" onClick={login.cancel}>{t`Cancel`}</Button>
          </div>
          {login.hint && <p className="overleaf-hint">{login.hint}</p>}
        </>
      ) : props.hint ? (
        <div className="overleaf-connect-row">
          {button}
          <p className="overleaf-hint">{props.hint}</p>
        </div>
      ) : button}
      <LoginMessages login={login} />
    </>
  );
}

/** An error line with a button to try the failed load again. */
export function RetryRow(props: { error: string; busy: boolean; label: string; onRetry: () => void }) {
  return (
    <>
      <InlineMessage level="error" className="overleaf-inline">{props.error}</InlineMessage>
      <div className="overleaf-retry-row">
        <ReloadButton size="compact" busy={props.busy} disabled={props.busy} onClick={props.onRetry}>
          {props.label}
        </ReloadButton>
      </div>
    </>
  );
}

export function Progress(props: { className?: string; text: string }) {
  return (
    <div className={props.className ?? "overleaf-loading"}>
      <InfinityLoader size={15} />
      <span>{props.text}</span>
    </div>
  );
}

/**
 * A small tinted tile holding an icon: the one visual anchor every Overleaf
 * card, empty state and prompt shares, so they read as one family.
 */
export function Glyph(props: { tone?: "accent" | "success" | "warning" | "danger" | "neutral"; size?: "compact" | "large"; children: ReactNode }) {
  return (
    <span className="overleaf-glyph" data-tone={props.tone ?? "accent"} data-size={props.size ?? "compact"} aria-hidden="true">
      {props.children}
    </span>
  );
}

/**
 * The centered state of the picker's list frame when there is no list to
 * show: not connected yet, a session that expired, nothing found, or a load
 * that failed. One layout, so switching between them never jumps.
 */
export function StageMessage(props: { glyph: ReactNode; tone?: "accent" | "warning" | "danger" | "neutral"; children: ReactNode }) {
  return (
    <div className="overleaf-stage-message">
      {props.glyph && <Glyph tone={props.tone} size="large">{props.glyph}</Glyph>}
      {props.children}
    </div>
  );
}
