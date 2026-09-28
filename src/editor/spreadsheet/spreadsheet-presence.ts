import type { FUniver } from "@univerjs/core/facade";
import type { Awareness } from "y-protocols/awareness";
import { a1Range, parseA1Range } from "./spreadsheet-operations";
import { SPREADSHEET_AXES, inBounds, isRecord, type SpreadsheetPresence, type SpreadsheetPresenceUser } from "./spreadsheet-types";

const PRESENCE_THROTTLE_MS = 100;
const PRESENCE_FIELD = "spreadsheetPresence";
const AGENT_PRESENCE_FIELD = "spreadsheetAgentPresence";
export const DEFAULT_PRESENCE_COLOR = "#6366f1";

export type RemotePresence = {
  key: string;
  clientId: number;
  user: SpreadsheetPresenceUser;
  presence: SpreadsheetPresence;
};

function presenceRange(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 32) return undefined;
  try {
    return parseA1Range(value).sheetName ? undefined : value;
  } catch {
    return undefined;
  }
}

/** Validate a peer's awareness field; anything malformed or for another file is ignored. */
function readRemotePresence(value: unknown, path: string): SpreadsheetPresence | null {
  if (!isRecord(value)) return null;
  const candidate = value as Partial<SpreadsheetPresence>;
  if (candidate.path !== path || typeof candidate.sheetId !== "string" || candidate.sheetId.length === 0 || candidate.sheetId.length > 128
    || !Array.isArray(candidate.selections) || candidate.selections.length > 32) return null;
  const selections = candidate.selections.map(presenceRange);
  if (selections.some((range) => range === undefined)) return null;
  const activeCell = presenceRange(candidate.activeCell);
  const editingCell = presenceRange(candidate.editingCell);
  if ((candidate.activeCell !== undefined && !activeCell) || (candidate.editingCell !== undefined && !editingCell)) return null;
  const { pointer } = candidate;
  if (pointer !== undefined && (!inBounds(pointer.row, SPREADSHEET_AXES.row.max) || !inBounds(pointer.column, SPREADSHEET_AXES.column.max))) return null;
  return {
    path,
    sheetId: candidate.sheetId,
    selections: selections as string[],
    ...(activeCell ? { activeCell } : {}),
    ...(editingCell ? { editingCell } : {}),
    ...(pointer ? { pointer } : {}),
    ...(candidate.agent === true ? { agent: true } : {}),
  };
}

function remoteUser(state: Record<string, unknown>, clientId: number, agent: boolean): SpreadsheetPresenceUser {
  const user = (isRecord(state.user) ? state.user : {}) as Partial<SpreadsheetPresenceUser>;
  const name = typeof user.name === "string" && user.name.length > 0 && user.name.length <= 100 ? user.name : "Collaborator";
  return {
    id: typeof user.id === "string" ? user.id : `peer:${clientId}`,
    name: agent ? `${name}'s Agent` : name,
    color: typeof user.color === "string" && /^#[0-9a-f]{6}$/i.test(user.color) ? user.color : DEFAULT_PRESENCE_COLOR,
  };
}

/** Publish local selection/pointer/editing state and report every peer's (and peer Agent's) presence. */
export function attachSpreadsheetPresence(options: {
  api: FUniver;
  awareness: Awareness;
  path: string;
  user: SpreadsheetPresenceUser;
  onRemoteChange: (presence: RemotePresence[]) => void;
}): () => void {
  const { api, awareness, path, user, onRemoteChange } = options;
  let pending: SpreadsheetPresence | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let editingCell: string | undefined;
  const schedule = (sheetId: string, presence: Omit<SpreadsheetPresence, "path" | "sheetId">) => {
    pending = { path, sheetId, ...presence, ...(editingCell ? { editingCell } : {}) };
    timer ??= setTimeout(() => {
      timer = null;
      awareness.setLocalStateField(PRESENCE_FIELD, pending);
    }, PRESENCE_THROTTLE_MS);
  };
  const cell = (row: number, column: number) => a1Range({ startRow: row, endRow: row, startColumn: column, endColumn: column });
  const events = [
    api.addEvent(api.Event.SelectionChanged, ({ worksheet, selections }) => schedule(worksheet.getSheetId(), {
      activeCell: selections[0] ? a1Range(selections[0]) : undefined,
      selections: selections.map((range) => a1Range(range)),
    })),
    api.addEvent(api.Event.CellPointerMove, ({ worksheet, row, column }) => schedule(worksheet.getSheetId(), {
      activeCell: pending?.activeCell,
      selections: pending?.selections ?? [],
      pointer: { row, column, xRatio: 0.5, yRatio: 0.5 },
    })),
    api.addEvent(api.Event.SheetEditStarted, ({ worksheet, row, column }) => {
      editingCell = cell(row, column);
      schedule(worksheet.getSheetId(), { activeCell: editingCell, selections: pending?.selections ?? [editingCell] });
    }),
    api.addEvent(api.Event.SheetEditEnded, ({ worksheet }) => {
      editingCell = undefined;
      schedule(worksheet.getSheetId(), { activeCell: pending?.activeCell, selections: pending?.selections ?? [] });
    }),
  ];

  const applyRemote = () => {
    const remote: RemotePresence[] = [];
    for (const [clientId, state] of awareness.getStates()) {
      if (!isRecord(state)) continue;
      for (const field of [PRESENCE_FIELD, AGENT_PRESENCE_FIELD]) {
        if (clientId === awareness.clientID && field === PRESENCE_FIELD) continue;
        const presence = readRemotePresence(state[field], path);
        if (presence) remote.push({ key: `${clientId}:${field}`, clientId, presence, user: remoteUser(state, clientId, field === AGENT_PRESENCE_FIELD) });
      }
    }
    onRemoteChange(remote);
  };
  awareness.on("change", applyRemote);
  applyRemote();

  // Keep identity on the existing shared awareness object without replacing
  // the controller's path/instance fields.
  const local = awareness.getLocalState() ?? {};
  awareness.setLocalState({ ...local, user: { ...(local.user as object ?? {}), ...user } });

  return () => {
    for (const event of events) event.dispose();
    if (timer !== null) clearTimeout(timer);
    awareness.off("change", applyRemote);
    awareness.setLocalStateField(PRESENCE_FIELD, null);
    onRemoteChange([]);
  };
}
