import { useCallback, useRef, type RefObject } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import type { OverleafRemoteDelete } from "../settings/app-settings";
import { confirmAction, toMessage } from "../app-utils";
import { showError, showNotice } from "./notify";

/**
 * Files gone here but still on Overleaf. Deletion is never inferred from
 * absence: ordinary files obey the setting (leave, remove, or ask), app-owned
 * transient paths are cleaned silently. Either needs the entity id only the
 * realtime channel knows; without it the action waits for a later sync.
 */
export function useOverleafRemoteDeletes(
  policyRef: RefObject<OverleafRemoteDelete>,
  entitiesRef: RefObject<Map<string, { id: string; kind: string }>>,
  projectGuard: (root: string, generation: number) => () => boolean,
) {
  const { t } = useLingui();
  // Files the writer chose to keep on Overleaf when asked. Every sync reports
  // a file deleted here only, for as long as it stays that way, so without
  // this the same question came back on each one. Held for the session: the
  // safe side of forgetting is a file left on Overleaf, never one removed.
  const declinedRef = useRef(new Set<string>());
  return useCallback(async (paths: string[], projectRoot: string, generation: number, automatic = false) => {
    const stillCurrent = projectGuard(projectRoot, generation);
    if (!stillCurrent()) return;
    const policy = policyRef.current;
    if (!automatic && policy === "never") return;
    const asking = !automatic && policy === "ask";
    const key = (path: string) => `${projectRoot}\n${path}`;
    const known = paths.flatMap((path) => {
      const entity = entitiesRef.current.get(path);
      return entity && !(asking && declinedRef.current.has(key(path))) ? [{ path, entity }] : [];
    });
    if (!known.length) return;
    if (asking) {
      const names = known.map((entry) => entry.path).join(", ");
      const removeThem = await confirmAction({
        title: known.length === 1
          ? t`Remove one file from the Overleaf project?`
          : t({ message: `Remove ${known.length} files from the Overleaf project?` }),
        message: known.length === 1
          ? t({ message: `${names} was deleted from the local project, but is still on Overleaf. Even if you remove it now, Overleaf's history will keep it.` })
          : t({ message: `${names} were deleted from the local project, but are still on Overleaf. Even if you remove them now, Overleaf's history will keep them.` }),
        confirmLabel: t`Delete on Overleaf too`,
        destructive: true,
      });
      if (!removeThem) {
        for (const { path } of known) declinedRef.current.add(key(path));
        return;
      }
      if (!stillCurrent()) return;
    }
    for (const entry of known) {
      if (!stillCurrent()) return;
      try {
        await invoke("overleaf_delete_entity", { projectRoot, kind: entry.entity.kind, entityId: entry.entity.id });
      } catch (reason) {
        if (stillCurrent()) showError(t({ message: `Could not remove ${entry.path} from Overleaf: ${toMessage(reason)}` }), "Overleaf");
        return;
      }
    }
    if (stillCurrent() && !automatic) {
      showNotice(known.length === 1
        ? t`Removed one file from Overleaf`
        : t({ message: `Removed ${known.length} files from Overleaf` }), "Overleaf");
    }
  }, [entitiesRef, policyRef, projectGuard, t]);
}
