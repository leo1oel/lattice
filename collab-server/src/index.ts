import { routePartykitRequest } from "partyserver";
import { YServer } from "y-partyserver";
import { applyUpdate, encodeStateAsUpdate } from "yjs";

type Env = {
  LatticeDoc: DurableObjectNamespace<LatticeDoc>;
};

/** Storage key for the room's access token (see auth notes below). */
const TOKEN_KEY = "lattice:roomToken";
/** How many chunks the persisted snapshot was split into. */
const DOC_COUNT_KEY = "lattice:doc:chunks";
/** Prefix for the persisted snapshot's chunk values. */
const DOC_CHUNK_PREFIX = "lattice:doc:chunk:";
/**
 * Chunk size for the persisted snapshot. 128 KiB is the per-value ceiling on the
 * classic Durable Object storage backend, so staying under it keeps this correct
 * regardless of backend.
 */
const CHUNK_BYTES = 128_000;
/** Durable Object storage caps get()/put()/delete() at 128 keys per call. */
const STORAGE_BATCH = 128;
/** Reclaim a room's storage after this long with no host/guest activity. */
const ROOM_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Only rewrite the expiry alarm once it has drifted more than a day from full TTL. */
const EXPIRY_REFRESH_SLACK_MS = 24 * 60 * 60 * 1000;

/**
 * A single Lattice live-sharing room.
 *
 * Two things this adds on top of the bare `YServer`:
 *
 *  - **Room-level auth.** Every room is protected by a secret token carried in
 *    the invite (the `k` query param on the connection URL). The first *host* to
 *    connect claims the room with its token (trust-on-first-use); everyone after
 *    must present the same token. The check runs in `fetch`, *before* the
 *    WebSocket upgrade completes, so a rejected client's socket is never
 *    established (closing later, inside `onConnect`, races the 101 handshake and
 *    the close frame is lost). A guest cannot open a room, so an unopened room
 *    code cannot be squatted.
 *
 *  - **Document persistence.** With `hibernate: true` the in-memory doc is
 *    evicted when the room goes idle, so without persistence a room that
 *    hibernated and woke would come back empty and diverge from its clients.
 *    `onLoad`/`onSave` snapshot the Yjs state into Durable Object storage,
 *    chunked so the up-to-15 MB base64 blobs the project may sync still fit.
 *    All writes in a save happen within one handler, which the runtime commits
 *    atomically, so a crash mid-save cannot leave a torn snapshot.
 */
export class LatticeDoc extends YServer {
  static options = {
    hibernate: true,
  };

  // Persist a little lazily; debounceMaxWait bounds how much editing a crash
  // between saves could lose.
  static callbackOptions = {
    debounceWait: 3_000,
    debounceMaxWait: 15_000,
  };

  /** The room's access token, or null until a host claims the room. */
  #roomToken: string | null = null;
  #tokenLoaded = false;

  async #loadRoomToken(): Promise<void> {
    if (this.#tokenLoaded) return;
    this.#roomToken = (await this.ctx.storage.get<string>(TOKEN_KEY)) ?? null;
    this.#tokenLoaded = true;
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const url = new URL(request.url);
      const token = url.searchParams.get("k") ?? "";
      const role = url.searchParams.get("r") === "host" ? "host" : "guest";
      await this.#loadRoomToken();
      if (!this.#authorize(token, role)) {
        return new Response("Forbidden: invalid or missing room token.", {
          status: 403,
        });
      }
      await this.#bumpExpiry();
    }
    return super.fetch(request);
  }

  /**
   * Push the room's idle-expiry alarm out to now + TTL. Called on every connect
   * and save; throttled so an active room rewrites the alarm at most once a day.
   */
  async #bumpExpiry(): Promise<void> {
    const now = Date.now();
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current < now + ROOM_TTL_MS - EXPIRY_REFRESH_SLACK_MS) {
      await this.ctx.storage.setAlarm(now + ROOM_TTL_MS);
    }
  }

  override async onAlarm(): Promise<void> {
    // Idle past the TTL — reclaim the whole room (snapshot + token). The room
    // code becomes unclaimed again, so a fresh host may reuse it later.
    await this.ctx.storage.deleteAll();
    this.#roomToken = null;
    this.#tokenLoaded = true;
  }

  async onLoad(): Promise<void> {
    await this.#loadRoomToken();

    const count = (await this.ctx.storage.get<number>(DOC_COUNT_KEY)) ?? 0;
    if (count <= 0) return;

    const parts: Uint8Array[] = [];
    for (let start = 0; start < count; start += STORAGE_BATCH) {
      const keys: string[] = [];
      for (let i = start; i < Math.min(start + STORAGE_BATCH, count); i += 1) {
        keys.push(`${DOC_CHUNK_PREFIX}${i}`);
      }
      const map = await this.ctx.storage.get<Uint8Array>(keys);
      for (const key of keys) {
        const part = map.get(key);
        // A missing chunk means an incomplete snapshot; better an empty doc the
        // host reseeds than applying a truncated (corrupt) update.
        if (!part) return;
        parts.push(part);
      }
    }
    applyUpdate(this.document, concatChunks(parts));
  }

  async onSave(): Promise<void> {
    const update = encodeStateAsUpdate(this.document);

    const entries: [string, Uint8Array][] = [];
    for (let offset = 0; offset < update.length; offset += CHUNK_BYTES) {
      // .slice (not .subarray) so each stored value owns a tight buffer rather
      // than a view over the whole multi-MB update.
      entries.push([
        `${DOC_CHUNK_PREFIX}${entries.length}`,
        update.slice(offset, offset + CHUNK_BYTES),
      ]);
    }
    const count = entries.length;
    if (count <= 0) return; // Nothing meaningful to persist yet.

    const prevCount = (await this.ctx.storage.get<number>(DOC_COUNT_KEY)) ?? 0;

    for (let start = 0; start < entries.length; start += STORAGE_BATCH) {
      await this.ctx.storage.put(
        Object.fromEntries(entries.slice(start, start + STORAGE_BATCH)),
      );
    }
    // Write the count only after the chunks it points at are in place.
    await this.ctx.storage.put(DOC_COUNT_KEY, count);

    // Drop chunks left over from a larger previous snapshot.
    if (prevCount > count) {
      const stale: string[] = [];
      for (let i = count; i < prevCount; i += 1) {
        stale.push(`${DOC_CHUNK_PREFIX}${i}`);
      }
      for (let start = 0; start < stale.length; start += STORAGE_BATCH) {
        await this.ctx.storage.delete(stale.slice(start, start + STORAGE_BATCH));
      }
    }

    // A save is activity too — keep the room alive past the idle TTL.
    await this.#bumpExpiry();
  }

  #authorize(token: string, role: "host" | "guest"): boolean {
    if (!token) return false;
    if (this.#roomToken === null) {
      // Trust on first use, but only a host may open a room — this stops a
      // guest from claiming (squatting) a room code before its host arrives.
      if (role !== "host") return false;
      this.#roomToken = token;
      void this.ctx.storage.put(TOKEN_KEY, token);
      return true;
    }
    return timingSafeEqualStr(token, this.#roomToken);
  }
}

function concatChunks(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Constant-time-ish string compare so the token check does not leak by timing. */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routePartykitRequest(request, env as never))
      ?? new Response("Lattice collab server", { status: 200 })
    );
  },
} satisfies ExportedHandler<Env>;
