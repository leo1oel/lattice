import { Cloud } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { InfinityLoader } from "../components/ui/activity-icons";
import { Button } from "../components/ui/button";
import { buttonClassName } from "../components/ui/button-styles";
import { InlineMessage } from "../components/ui/inline-message";
import { MotionButton } from "../components/ui/motion";
import type { OverleafStatus } from "../app-types";
import { OverleafBrowserLogin } from "./overleaf-browser-login";

/** Shared state from the native sign-in loop, consumed in Settings and the picker. */
interface OverleafLogin {
  pending: boolean;
  error: string | null;
  notice: string | null;
  hint: string | null;
  begin: () => void;
  cancel: () => void;
  accept: (session: OverleafStatus) => void;
}

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
export function LoginControls(props: { login: OverleafLogin; label: string; hint?: string; host?: string }) {
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
      {!login.pending && <OverleafBrowserLogin host={props.host ?? "https://www.overleaf.com"} onConnected={login.accept} />}
    </>
  );
}

