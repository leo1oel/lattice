/**
 * Files dragged in from the Finder onto the Agent panel, as the Tauri app's
 * window takes them (`use-project-tree.ts`): the island hands each phase of
 * the drag to its owner, which tells the page (`agent:file-drag`, `drops.rs`).
 * Files the Agent can read (figures and text sources alike) light the panel
 * while they are over it, and on the drop their bytes, read by the owner
 * from that drop's paths alone, go into the composer over the embed bridge,
 * as its "+" menu would add them (`agent-composer-files.ts`).
 */
import { useEffect, useReducer } from "react";
import { invoke } from "@tauri-apps/api/core";
import { msg } from "@lingui/core/macro";
import { host } from "../shared/host";
import { i18n } from "../../../src/i18n";
import { showError } from "../../../src/app/notify";
import { classifyExternalProjectDrop, toMessage } from "../../../src/app-utils";
import { buildAgentComposerFilesMessage, type AgentComposerFilePayload } from "../../../src/agent/agent-composer-files";

type Phase = "enter" | "over" | "leave" | "drop";

function parseDrag(payload: unknown): { phase: Phase; paths: string[] } {
  const { phase, paths } = (payload ?? {}) as { phase?: unknown; paths?: unknown };
  return {
    phase: phase === "enter" || phase === "over" || phase === "drop" ? phase : "leave",
    paths: Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string") : [],
  };
}

/** Whether a drag the Agent can take is over the panel; `post` relays a dropped file set to its frame. */
export function useAgentFileDrops(enabled: boolean, post: (message: object) => unknown): boolean {
  const [active, setActive] = useReducer((_: boolean, next: boolean) => next, false);
  useEffect(() => {
    if (!enabled) return;
    // WebKit names the files on entering and dropping only, as Tauri does.
    let dragged: string[] = [];
    const stop = host().on("agent:file-drag", (payload) => {
      const { phase, paths } = parseDrag(payload);
      if (phase === "enter") dragged = paths;
      const kind = classifyExternalProjectDrop(phase === "drop" ? paths : dragged);
      if (phase === "over" || phase === "enter") {
        setActive(kind !== "unsupported");
        return;
      }
      setActive(false);
      dragged = [];
      if (phase !== "drop" || !paths.length) return;
      if (kind === "unsupported") {
        showError(i18n._(msg`This file type can’t be opened in an editor`));
        return;
      }
      void invoke<AgentComposerFilePayload[]>("read_agent_composer_files", { paths })
        .then((files) => post(buildAgentComposerFilesMessage(files)))
        .catch((error: unknown) => showError(toMessage(error)));
    });
    return () => {
      stop();
      setActive(false);
    };
  }, [enabled, post]);
  return active;
}
