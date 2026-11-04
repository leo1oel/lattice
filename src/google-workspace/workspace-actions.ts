/** Network workflows own their try/finally cleanup outside React render compilation. */
import { invoke } from "@tauri-apps/api/core";
import type { Dispatch } from "react";
import type { AccountAction, AccountStatus } from "./google-workspace-settings";
import type { WorkspaceState, WorkspaceAction } from "./workspace-operations";
type Mutable<T> = { current: T };
export async function runAccountAction(
  action: () => Promise<void>,
  context: {
    pending: Mutable<boolean>;
    requestGeneration: Mutable<number>;
    live: Mutable<boolean>;
    dispatch: Dispatch<AccountAction>;
  },
) {
  const { pending, requestGeneration, live, dispatch } = context;
  if (pending.current) return;
  pending.current = true;
  const generation = ++requestGeneration.current;
  dispatch({ type: "start" });
  let failed = false;
  try {
    await action();
    const value = await invoke<AccountStatus>("google_workspace_status");
    if (live.current && requestGeneration.current === generation)
      dispatch({ type: "status", value });
  } catch {
    failed = true;
  } finally {
    pending.current = false;
    if (live.current && requestGeneration.current === generation)
      dispatch({ type: "finish", failed });
  }
}
export async function runWorkspaceOperation(
  operation: string,
  context: {
    state: WorkspaceState;
    pending: Mutable<boolean>;
    generation: Mutable<number>;
    live: Mutable<boolean>;
    dispatch: Dispatch<WorkspaceAction>;
  },
) {
  const { state, pending, generation, live, dispatch } = context;
  if (pending.current) return;
  pending.current = true;
  dispatch({ type: "start" });
  const current = ++generation.current;
  try {
    const body =
      operation === "create" && state.product !== "calendar"
        ? { title: state.title }
        : operation === "update" || operation === "create"
          ? JSON.parse(state.body)
          : null;
    const result = await invoke<unknown>("google_workspace_request", {
      request: {
        product: state.product,
        operation,
        resourceId: state.resourceId.trim(),
        itemId: state.itemId.trim(),
        range: state.range,
        body,
      },
    });
    if (!live.current || generation.current !== current) return;
    if (operation === "export") {
      const value = result as { base64: string; mimeType: string };
      const bytes = Uint8Array.from(atob(value.base64), (character) =>
        character.charCodeAt(0),
      );
      const url = URL.createObjectURL(
        new Blob([bytes], { type: value.mimeType }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "google-workspace.pdf";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      dispatch({ type: "result", value: { downloaded: true } });
    } else {
      if (operation === "create" && result && typeof result === "object") {
        const value = result as Record<string, unknown>;
        const id =
          value.documentId ??
          value.spreadsheetId ??
          value.presentationId ??
          value.formId ??
          value.id;
        if (typeof id === "string")
          dispatch({
            type: "field",
            field: state.product === "calendar" ? "itemId" : "resourceId",
            value: id,
          });
      }
      dispatch({ type: "result", value: result });
    }
  } catch {
    if (live.current && generation.current === current)
      dispatch({ type: "error" });
  } finally {
    pending.current = false;
  }
}
