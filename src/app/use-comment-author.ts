/**
 * Who signs the comments this window writes: a stable author id, and a name
 * taken from Git and the Overleaf session ahead of the "Your name" setting.
 */
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  loadAuthorNameSetting, loadEditorCommentAuthorId, persistAuthorNameSetting, resolveAuthorName,
} from "../editor/comments/editor-comment-data";
import type { OverleafStatus } from "../app-types";

export function useCommentAuthor(projectRoot: string | undefined, settingsOpen: boolean) {
  const id = useMemo(() => loadEditorCommentAuthorId(), []);
  const [setting, setSetting] = useState(loadAuthorNameSetting);
  // The writer's name as Git and the Overleaf session know it, which sign
  // comments ahead of the "Your name" setting.
  const [knownNames, setKnownNames] = useState<{ git: string | null; overleaf: string | null }>({
    git: null, overleaf: null,
  });
  // Re-read on a project switch (Git config is per repository) and whenever
  // Settings opens, which is where a writer goes after signing in to Overleaf.
  useEffect(() => {
    let cancelled = false;
    const projectOpen = Boolean(projectRoot);
    void Promise.all([
      projectOpen ? invoke<string | null>("git_user_name").catch(() => null) : Promise.resolve(null),
      invoke<OverleafStatus>("overleaf_status")
        .then((status) => (status?.connected ? status.name ?? null : null))
        .catch(() => null),
    ]).then(([git, overleaf]) => {
      // Keep the same object when neither name changed, so the lookup that
      // runs at every startup and Settings toggle does not re-render App.
      if (!cancelled) {
        setKnownNames((prev) => (
          prev.git === (git ?? null) && prev.overleaf === overleaf ? prev : { git: git ?? null, overleaf }
        ));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [projectRoot, settingsOpen]);
  return {
    id,
    name: resolveAuthorName({ ...knownNames, setting }),
    /** The "Your name" setting, as Settings edits it. */
    setting,
    changeSetting: (name: string) => {
      setSetting(name);
      persistAuthorNameSetting(name);
    },
    /** The name Git or Overleaf knows, which Settings and the palette suggest. */
    knownName: knownNames.git || knownNames.overleaf || null,
  };
}
