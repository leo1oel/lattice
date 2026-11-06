/**
 * Builds compile the main document Overleaf compiles. A downloaded project's
 * root is detected from its files, which picks main.tex over the main_v2.tex
 * Overleaf names; the live channel reports Overleaf's choice on joining and on
 * every tree change, and the backend follows it when it changed (see
 * src-tauri/src/overleaf/root_document.rs, which also keeps a main document
 * chosen here until someone changes Overleaf's).
 */
import { useEffect, type RefObject } from "react";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectManifest, RefreshProject } from "../app-types";
import { toMessage } from "../app-utils";
import { useLatestRef } from "../hooks/use-latest-ref";
import { useStoreSlice } from "../hooks/use-store-slice";
import { notifyInfo, notifyWarning } from "../telemetry/app-notify";
import type { OverleafConnectionState, OverleafConnectionStore } from "./overleaf-connection-store";

const rootDocumentField = ({ rootDocument }: OverleafConnectionState) => ({ rootDocument });

export function useOverleafRootDocument(
  store: OverleafConnectionStore, projectRoot: string | null, refreshProject: RefreshProject, generationRef: RefObject<number>,
) {
  const { rootDocument } = useStoreSlice(store, rootDocumentField);
  // Asked once per report, not again whenever the callers' functions change.
  const refreshRef = useLatestRef(refreshProject);
  useEffect(() => {
    if (!projectRoot || !rootDocument) return;
    const generation = generationRef.current;
    // The backend reads the path from this project's own connection; the
    // report here only says when to ask.
    void invoke<ProjectManifest | null>("overleaf_adopt_root_document", { projectRoot })
      .then(async (manifest) => {
        if (!manifest) return;
        await refreshRef.current({ expectedRoot: projectRoot, generation });
        notifyInfo("Overleaf", i18n._(msg`Build now compiles ${rootDocument}, the main document on Overleaf.`));
      })
      // Builds still compile the main document set here; the next join asks again.
      .catch((reason: unknown) => notifyWarning("Overleaf", i18n._(msg`Could not follow Overleaf’s main document ${rootDocument}`), {
        detail: toMessage(reason),
      }));
  }, [generationRef, projectRoot, refreshRef, rootDocument]);
}
