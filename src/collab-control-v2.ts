import { isCatalogV2, type CatalogV2 } from "../protocol/collab-v2";
import { loadCollabFeaturePolicy, mayWriteCollabProject } from "./collab-feature-policy";

// v2 is the only room type now; the env flag survives as an opt-out kill switch.
export const collabControlV2Enabled = import.meta.env.VITE_LATTICE_COLLAB_V2 !== "false";

/** Non-2xx control-plane response, preserving the parsed error body (e.g. the events stream's 409 refetch hint). */
export class CollabControlErrorV2 extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super(typeof body.message === "string" ? body.message : `Control-plane request failed (${status})`);
  }
  /** The coordinator's event buffer no longer covers our cursor; a full catalog pull is required. */
  get requiresRefetch(): boolean { return this.body.refetch === true; }
}

export type PresenceEntryV2 = { name: string; color: string; path: string | null; updatedAt: number };

export class CollabControlV2Client {
  constructor(private readonly baseUrl: string, private readonly projectInstanceId: string, private readonly credential?: string) {}

  async catalog(): Promise<CatalogV2> {
    const value = await this.request("catalog");
    if (!isCatalogV2(value)) throw new Error("Invalid v2 catalog response");
    return value;
  }

  /** Project-level presence heartbeat; per-file awareness rooms cannot see each other. */
  async presence(body: { instanceId: string; name: string; color: string; path: string | null; leave?: boolean }): Promise<Record<string, PresenceEntryV2>> {
    const value = await this.request("presence", { method: "POST", body: JSON.stringify(body) });
    const presence = (value as { presence?: unknown })?.presence;
    return (presence ?? {}) as Record<string, PresenceEntryV2>;
  }

  async events(since: number): Promise<{ catalogRevision: number; events: unknown[]; refetch: boolean }> {
    return this.request(`events?since=${since}`) as Promise<{ catalogRevision: number; events: unknown[]; refetch: boolean }>;
  }

  async grants(): Promise<Array<{ grantId: string; permission: "read" | "write"; revoked: boolean }>> {
    return this.request("grants") as Promise<Array<{ grantId: string; permission: "read" | "write"; revoked: boolean }>>;
  }

  async operation<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    if (!mayWriteCollabProject()) throw new Error("Collaboration writes are temporarily disabled; local recovery and export remain available");
    const policy = loadCollabFeaturePolicy();
    if (endpoint === "bootstrap" && !policy.allowCreateV2) throw new Error("Creating v2 projects is not enabled");
    return this.request(endpoint, { method: "POST", body: JSON.stringify(body) }) as Promise<T>;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    if (!collabControlV2Enabled) throw new Error("The v2 collaboration control plane is disabled");
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/v2/projects/${encodeURIComponent(this.projectInstanceId)}/${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(this.credential ? { Authorization: `Bearer ${this.credential}` } : {}), ...init.headers },
    });
    const value: unknown = await response.json();
    if (!response.ok) throw new CollabControlErrorV2(response.status, (value ?? {}) as Record<string, unknown>);
    return value;
  }
}
