/**
 * The "Open from Overleaf" picker's state (`overleaf-project-picker.tsx`):
 * the account's connection, its project list, what the user has typed and
 * chosen, and the download or upload in flight.
 */
import type { OverleafProject, OverleafProjectList, OverleafStatus } from "../app-types";

export type PickerState = {
  status: OverleafStatus | null;
  statusLoading: boolean;
  statusError: string | null;
  list: OverleafProjectList | null;
  projectsLoading: boolean;
  projectsError: string | null;
  /** An invitation was opened in the browser, so the list may be out of date. */
  invitationOpened: boolean;
  search: string;
  showArchived: boolean;
  selected: string | null;
  cloning: OverleafProject | null;
  publishing: boolean;
  transferError: string | null;
  publishName: string;
};

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
  | { type: "search"; search: string }
  | { type: "showArchived"; showArchived: boolean }
  | { type: "select"; id: string }
  | { type: "publishName"; name: string }
  /** A download starts (clearing the last transfer's error) or ends. */
  | { type: "cloning"; project: OverleafProject | null }
  /** An upload starts (clearing the last transfer's error) or ends. */
  | { type: "publishing"; publishing: boolean }
  | { type: "transferFailed"; error: string };

export function initialPickerState(publishName: string): PickerState {
  return {
    status: null, statusLoading: false, statusError: null,
    list: null, projectsLoading: false, projectsError: null, invitationOpened: false,
    search: "", showArchived: false, selected: null,
    cloning: null, publishing: false, transferError: null, publishName,
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
    case "search": return { ...state, search: action.search };
    case "showArchived": return { ...state, showArchived: action.showArchived };
    case "select": return { ...state, selected: action.id };
    case "publishName": return { ...state, publishName: action.name };
    case "cloning":
      return { ...state, cloning: action.project, transferError: action.project ? null : state.transferError };
    case "publishing":
      return { ...state, publishing: action.publishing, transferError: action.publishing ? null : state.transferError };
    case "transferFailed": return { ...state, transferError: action.error };
  }
}
