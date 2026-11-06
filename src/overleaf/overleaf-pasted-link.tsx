/**
 * A project or share link pasted into the "Open from Overleaf" search field.
 *
 * Projects shared through an invitation not yet accepted, or a share link
 * never opened, are not in the account's list, on Overleaf's dashboard or
 * here. Pasting the link finds out what it opens for this account
 * (`use-pasted-overleaf-link.ts`). The backend asks only what Overleaf's own
 * link page asks before anyone agrees to anything; joining a project and
 * accepting an invitation stay the user's to do on Overleaf, and this says how.
 */
import type { ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Link2Off, MailOpen, ShieldX } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { Button } from "../components/ui/button";
import type { PastedOverleafLink } from "../app-types";
import { StageMessage } from "./overleaf-connect-parts";

/** Why a pasted link opens nothing yet, and what to do about it on Overleaf. */
export function PastedLinkMessage(props: {
  answer: Exclude<PastedOverleafLink, { kind: "project" }>;
  /** Who is signed in, as the picker names the account. */
  account: string;
  host: string;
}) {
  const { t } = useLingui();
  const { answer } = props;
  const browse = (url: string, label: string) => (
    <Button size="compact" variant="tinted" onClick={() => void openUrl(url)}>
      <ExternalLink size={13} /> {label}
    </Button>
  );
  const say = (glyph: ReactNode, title: string, hint: string, action?: ReactNode) => (
    <StageMessage glyph={glyph} tone="warning">
      <p className="overleaf-stage-text"><strong>{title}</strong></p>
      <p className="overleaf-hint">{hint}</p>
      {action}
    </StageMessage>
  );
  switch (answer.kind) {
    case "needsJoin":
      return say(
        <Link2Off size={20} />,
        answer.projectName
          ? t`This account hasn’t joined “${answer.projectName}” yet`
          : t`This account hasn’t joined this shared project yet`,
        t`Open the link in your browser and choose Join project on Overleaf, then paste it here again.`,
        browse(answer.url, t`Open link in browser`),
      );
    case "invited":
      return say(
        <MailOpen size={20} />,
        answer.projectName
          ? t`Your invitation to “${answer.projectName}” is waiting on Overleaf`
          : t`This invitation is waiting on Overleaf`,
        t`Accept it on Overleaf, then paste the link here again.`,
        browse(answer.url, t`Open invitation`),
      );
    case "noAccess":
      return say(
        <ShieldX size={20} />,
        t`${props.account} can’t open this project`,
        t`If someone shared it with you, accept their invitation or open their share link once on Overleaf. If they shared it with another account, sign in with that one in Settings → Overleaf.`,
      );
    case "notFound":
      return say(
        <Link2Off size={20} />,
        t`Overleaf doesn’t recognize this link`,
        t`Its owner may have turned link sharing off or reset the link. Ask them for a new one.`,
      );
    case "otherHost":
      return say(
        <ShieldX size={20} />,
        t`This link is for ${answer.host}`,
        t`Lattice is signed in to ${props.host}. To open projects from another Overleaf server, sign in to it in Settings → Overleaf.`,
      );
    case "unrecognized":
      return say(
        <Link2Off size={20} />,
        t`That isn’t an Overleaf project link`,
        t`Copy the link from the project’s address bar or its Share menu.`,
      );
  }
}
