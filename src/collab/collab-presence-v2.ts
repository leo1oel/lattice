/**
 * Who is in a v2 project, and where. Every file is its own awareness room, so
 * peers in the file the editor has bound come from that file's Awareness and
 * everyone else from the coordinator's project-wide presence table, which a
 * heartbeat keeps current. The two merge into one peer list.
 */
import type { Awareness } from "y-protocols/awareness";
import type { CollabControlV2Client, PresenceEntryV2 } from "./collab-control-v2";
import { readCollabPeers, scheduleFrame, type CollabPeer } from "./collab-session";
import { peerColorForKey } from "../components/ui/collab-colors";

/**
 * Stable synthetic id for a peer known only through coordinator presence. Used
 * purely as a UI key; collisions with live awareness ids only shuffle order.
 */
function presenceClientId(instanceId: string): number {
  let hash = 0;
  for (let index = 0; index < instanceId.length; index++) hash = (hash * 31 + instanceId.charCodeAt(index)) | 0;
  return hash;
}

export class CollabPresenceV2 {
  /** Stable per-session identity announced in awareness and coordinator presence. */
  readonly instanceId = crypto.randomUUID();
  private table: Record<string, PresenceEntryV2> = {};
  private queue: Promise<void> = Promise.resolve();
  private leaving = false;
  private disposed = false;
  private cancelRefresh?: () => void;
  private unbindAwareness?: () => void;
  private boardUserValue?: { id: string; name: string; color: string };

  constructor(private readonly options: {
    displayName?: string;
    /** Stable person identity shared with comment authorship, used only to choose a consistent color. */
    participantId?: string;
    onPeers?: (peers: CollabPeer[]) => void;
    control: () => CollabControlV2Client;
    /** The bound file's Awareness (a detached fallback while there is none). */
    awareness: () => Awareness;
    activePath: () => string;
  }) {}

  identity(): { name: string; color: string; colorLight: string } {
    const name = (this.options.displayName ?? "").trim() || "Anonymous";
    const { color, colorLight } = peerColorForKey(this.options.participantId?.trim() || `${name}\0${this.instanceId}`);
    return { name, color, colorLight };
  }

  /** Identity for board cursor presence: same name/color as the avatar list. */
  get boardUser(): { id: string; name: string; color: string } {
    // Memoized: this feeds React effect deps downstream — a fresh object per
    // access would detach/reattach the board bridge on every render.
    if (!this.boardUserValue) {
      const { name, color } = this.identity();
      this.boardUserValue = { id: this.instanceId, name, color };
    }
    return this.boardUserValue;
  }

  /** Announce who we are and which file we are in on that file's Awareness, and follow its changes. */
  announce(awareness: Awareness | undefined, path: string): void {
    this.unbindAwareness?.();
    this.unbindAwareness = undefined;
    if (!awareness) return;
    const { name, color, colorLight } = this.identity();
    awareness.setLocalState({ ...(awareness.getLocalState() ?? {}), user: { name, color, colorLight }, path, instanceId: this.instanceId });
    // Awareness can change many times per frame; render the peer list once per frame.
    const onChange = () => {
      if (this.cancelRefresh || this.disposed) return;
      this.cancelRefresh = scheduleFrame(() => {
        this.cancelRefresh = undefined;
        this.pushPeers();
      });
    };
    awareness.on("change", onChange);
    this.unbindAwareness = () => awareness.off("change", onChange);
    this.pushPeers();
  }

  private pushPeers(): void {
    const onPeers = this.options.onPeers;
    if (!onPeers || this.disposed) return;
    const awareness = this.options.awareness();
    const peers = readCollabPeers(awareness.getStates(), awareness.clientID);
    const seen = new Set<string>([this.instanceId]);
    for (const peer of peers) {
      if (!peer.instanceId) continue;
      seen.add(peer.instanceId);
      const presence = this.table[peer.instanceId];
      if (!presence) continue;
      // Awareness is peer-written, so the grant and who the host is come from
      // the coordinator's presence table even for someone in our own file.
      if (presence.grantId) peer.grantId = presence.grantId;
      if (presence.permission) peer.permission = presence.permission;
      // Their awareness state reaches us before they have announced a path
      // over it (and an older build never announces one at all). The
      // coordinator knows which file they are in, so follow-the-peer works
      // from the first frame instead of reporting them as nowhere.
      if (!peer.path && presence.path) peer.path = presence.path;
    }
    for (const [instanceId, { name, color, path, grantId, permission }] of Object.entries(this.table)) {
      if (seen.has(instanceId)) continue;
      peers.push({ clientId: presenceClientId(instanceId), name, color, path, instanceId, ...(grantId ? { grantId } : {}), ...(permission ? { permission } : {}) });
    }
    onPeers(peers.sort((left, right) => left.clientId - right.clientId));
  }

  /** Best-effort heartbeat; the server TTL prunes us if we stay offline. */
  async heartbeat(): Promise<void> {
    if (this.leaving) return;
    await this.enqueue(async () => {
      if (this.disposed || this.leaving) return;
      const { name, color } = this.identity();
      const table = await this.options.control().presence({ instanceId: this.instanceId, name, color, path: this.options.activePath() || null });
      if (this.disposed) return;
      this.table = table;
      this.pushPeers();
    }).catch(() => { /* keep last known presence */ });
  }

  /** Ordered after any in-flight heartbeat so a late heartbeat cannot recreate our entry. */
  leave(): Promise<void> {
    if (this.leaving) return this.queue;
    this.leaving = true;
    return this.enqueue(async () => {
      await this.options.control().presence({ instanceId: this.instanceId, name: "", color: "", path: null, leave: true });
    });
  }

  dispose(): void {
    this.disposed = true;
    this.cancelRefresh?.();
    this.cancelRefresh = undefined;
    this.unbindAwareness?.();
    this.unbindAwareness = undefined;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.catch(() => undefined).then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
