/**
 * Local memory of live-sharing rooms the user has taken part in, so they can
 * rejoin from a list instead of re-pasting an invite. Kept entirely client-side
 * in localStorage; the server has no room registry to query.
 */

export type CollabRoomRecord = {
  /** Room code, e.g. LT-XXXXXX. */
  room: string;
  /** Secret room token (the invite's password). */
  token: string;
  /** Sync host the room lives on. */
  host: string;
  /** Whether we opened the room (host) or joined it (guest). */
  role: "host" | "guest";
  /** Human label for the list — the project name. */
  title: string;
  /** For a host room: the project folder to reopen on reconnect. */
  projectRoot: string | null;
  /** Last time we used this room (ms), for ordering and staleness. */
  lastUsed: number;
};

const ROOMS_KEY = "lattice.collab.rooms.v1";
const MAX_ROOMS = 24;
/** Matches the server's idle-expiry: past this a room is gone, so hide it. */
const ROOM_ACTIVE_MS = 30 * 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is CollabRoomRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<CollabRoomRecord>;
  return (
    typeof record.room === "string"
    && typeof record.token === "string"
    && typeof record.host === "string"
    && (record.role === "host" || record.role === "guest")
  );
}

function readRooms(): CollabRoomRecord[] {
  try {
    const raw = JSON.parse(localStorage.getItem(ROOMS_KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(isRecord);
  } catch {
    return [];
  }
}

function writeRooms(rooms: CollabRoomRecord[]): void {
  try {
    localStorage.setItem(ROOMS_KEY, JSON.stringify(rooms.slice(0, MAX_ROOMS)));
  } catch {
    // Non-fatal: the list is a convenience, not a source of truth.
  }
}

/** Active (recent) rooms, newest first — what the dialog shows. */
export function loadActiveCollabRooms(now = Date.now()): CollabRoomRecord[] {
  return readRooms()
    .filter((room) => now - (room.lastUsed || 0) < ROOM_ACTIVE_MS)
    .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
}

/** Record (or refresh) a room, de-duped by host+room, stamped as just used. */
export function rememberCollabRoom(
  record: Omit<CollabRoomRecord, "lastUsed">,
  now = Date.now(),
): void {
  const rest = readRooms().filter(
    (room) => !(room.room === record.room && room.host === record.host),
  );
  writeRooms([{ ...record, lastUsed: now }, ...rest]);
}

/** Drop a room from the list (host stopped it, or a reconnect found it gone). */
export function forgetCollabRoom(host: string, room: string): void {
  writeRooms(readRooms().filter((entry) => !(entry.room === room && entry.host === host)));
}
