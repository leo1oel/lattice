/**
 * What the website's demo shows in place of the parts of Lattice that need
 * the Mac: the Agent (it drives the AI tools signed in there), whiteboards
 * (tldraw is licensed for the app, not the website) and Open Slide (a local
 * server). Each is a card that says so and offers the download, standing in
 * the panel or tab the real surface would fill.
 *
 * Loaded only in the demo build (`import.meta.env.LATTICE_WEB_DEMO`), through
 * the loaders the real surfaces use, so its exports take their names and props.
 */
import type { ComponentProps, ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useLingui } from "@lingui/react/macro";
import { Bot, Presentation, Shapes } from "lucide-react";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import type { BoardEditorProps } from "../editor/board/board-editor";
import type { OpenSlideWorkspaceProps } from "../editor/presentation/open-slide-workspace";
import type TrellisAgentSurface from "../trellis/trellis-agent-surface";
import attentionMapStill from "./attention-map-board.webp";
import "./desktop-only.css";

// The latest release's page, where the disk image is.
const DOWNLOAD_URL = "https://github.com/leo1oel/lattice/releases/latest";

function DesktopOnlyCard({ icon, title, description, still }: {
  icon: ReactNode;
  title: string;
  description: string;
  still?: { src: string; alt: string };
}) {
  const { t } = useLingui();
  return (
    <div className="web-demo-desktop-only" data-tour="web-demo-desktop-only">
      {still && <img className="web-demo-desktop-only-still" src={still.src} alt={still.alt} draggable={false} />}
      <EmptyState
        icon={icon}
        title={title}
        description={description}
        actions={(
          <Button variant="tinted" onClick={() => void openUrl(DOWNLOAD_URL)}>
            {t`Download Lattice for Mac`}
          </Button>
        )}
      />
    </div>
  );
}

/** The Agent panel. */
export default function DemoAgentSurface(_props: ComponentProps<typeof TrellisAgentSurface>) {
  const { t } = useLingui();
  return (
    <div className="synara-frame-shell" data-tour="agent-panel">
      <DesktopOnlyCard
        icon={<Bot size={20} />}
        title={t`The Agent runs on your Mac`}
        description={t`It works through the AI tools you are signed in to there. Proofread, Polish and Revise from annotations answer here from a script.`}
      />
    </div>
  );
}

/** A whiteboard's tab: the tutorial's board as a still image. */
export function BoardEditor({ path }: BoardEditorProps) {
  const { t } = useLingui();
  const tutorialBoard = path.endsWith("attention-map.tldr");
  return (
    <DesktopOnlyCard
      icon={<Shapes size={20} />}
      title={t`Whiteboards run on your Mac`}
      description={t`In Lattice you draw here, and the Agent can sketch on the board with you.`}
      still={tutorialBoard ? { src: attentionMapStill, alt: t`The tutorial's whiteboard: a map of how attention connects queries, keys and values` } : undefined}
    />
  );
}

/** An Open Slide deck's tab. */
export function OpenSlideWorkspace(_props: OpenSlideWorkspaceProps) {
  const { t } = useLingui();
  return (
    <DesktopOnlyCard
      icon={<Presentation size={20} />}
      title={t`Slides run on your Mac`}
      description={t`In Lattice, Open Slide edits and presents this deck beside the paper.`}
    />
  );
}
