/**
 * The "Open from Overleaf" picker's state (`overleaf-project-picker.tsx`):
 * the account's connection, its project list, what the user has typed and
 * chosen, and the download or upload in flight.
 */
import type { LocalCopy, OverleafProject, OverleafProjectList, OverleafStatus } from "../app-types";

export type PickerState = {
  status: OverleafStatus | null;
  statusLoading: boolean;
  statusError: string | null;
  list: OverleafProjectList | null;
  projectsLoading: boolean;
  projectsError: string | null;
  /** An invitation was opened in the browser, so the list may be out of date. */
  invitationOpened: boolean;
  /** The folder on this Mac already linked to a listed project, by project id. */
  localCopies: Record<string, LocalCopy>;
  search: string;
  showArchived: boolean;
  selected: string | null;
  /** Opening a project, until it is known whether it opens a local copy or downloads. */
  opening: OverleafProject | null;
  cloning: OverleafProject | null;
  /** How much of the download has arrived, once Overleaf starts sending it. */
  downloaded: DownloadProgress | null;
  publishing: boolean;
  transferError: string | null;
  publishName: string;
};

/** `overleaf-download-progress`: bytes so far, and the size when Overleaf says it up front. */
export type DownloadProgress = { received: number; total: number | null };

export type PickerAction =
  | { type: "statusLoading" }
  | { type: "status"; status: OverleafStatus }
  | { type: "statusFailed"; error: string }
  | { type: "projectsLoading" }
  | { type: "projects"; list: OverleafProjectList }
  | { type: "projectsFailed"; error: string }
  /** The session expired: no list, and no error, as the reconnect state takes over. */
  | { type: "projectsCleared" }
  | { type: "invitationOpened" }
  | { type: "localCopies"; copies: Record<string, LocalCopy> }
  | { type: "search"; search: string }
  | { type: "showArchived"; showArchived: boolean }
  | { type: "select"; id: string }
  | { type: "publishName"; name: string }
  /** A download starts (clearing the last transfer's error) or ends. */
  | { type: "opening"; project: OverleafProject | null }
  | { type: "cloning"; project: OverleafProject | null }
  | { type: "downloaded"; progress: DownloadProgress }
  /** An upload starts (clearing the last transfer's error) or ends. */
  | { type: "publishing"; publishing: boolean }
  | { type: "transferFailed"; error: string };

export function initialPickerState(publishName: string): PickerState {
  return {
    status: null, statusLoading: false, statusError: null,
    list: null, projectsLoading: false, projectsError: null, invitationOpened: false, localCopies: {},
    search: "", showArchived: false, selected: null,
    opening: null, cloning: null, downloaded: null, publishing: false, transferError: null, publishName,
  };
}

export function reducePicker(state: PickerState, action: PickerAction): PickerState {
  switch (action.type) {
    case "statusLoading": return { ...state, statusLoading: true };
    case "status": return { ...state, status: action.status, statusError: null, statusLoading: false };
    case "statusFailed": return { ...state, statusError: action.error, statusLoading: false };
    case "projectsLoading": return { ...state, projectsLoading: true, list: null, invitationOpened: false };
    case "projects": return { ...state, list: action.list, projectsError: null, projectsLoading: false };
    case "projectsFailed": return { ...state, projectsError: action.error, projectsLoading: false };
    case "projectsCleared": return { ...state, list: null, projectsError: null, projectsLoading: false };
    case "invitationOpened": return { ...state, invitationOpened: true };
    case "localCopies": return { ...state, localCopies: action.copies };
    case "search": return { ...state, search: action.search };
    case "showArchived": return { ...state, showArchived: action.showArchived };
    case "select": return { ...state, selected: action.id };
    case "publishName": return { ...state, publishName: action.name };
    case "opening":
      return { ...state, opening: action.project, transferError: action.project ? null : state.transferError };
    case "cloning":
      return {
        ...state, cloning: action.project, downloaded: null, transferError: action.project ? null : state.transferError,
      };
    // Late progress from a download that has already ended is dropped.
    case "downloaded": return state.cloning ? { ...state, downloaded: action.progress } : state;
    case "publishing":
      return { ...state, publishing: action.publishing, transferError: action.publishing ? null : state.transferError };
    case "transferFailed": return { ...state, transferError: action.error };
  }
}
