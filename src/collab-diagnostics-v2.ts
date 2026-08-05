export type CollabDiagnosticNameV2 = "join_latency" | "first_file_open" | "durable_ack_latency" | "oldest_outbox" | "disk_conflict" | "markdown_draft" | "events_poll_error";
export type CollabDiagnosticV2 = { name: CollabDiagnosticNameV2; at: number; durationMs?: number; count?: number; fileId?: string };
export type CollabDiagnosticSinkV2 = (event: CollabDiagnosticV2) => void;

export class CollabDiagnosticsStoreV2 {
  private events: CollabDiagnosticV2[] = [];
  constructor(private readonly capacity = 200) {}
  record(event: CollabDiagnosticV2): void { this.events.push(Object.freeze({ ...event })); if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity); }
  snapshot(): readonly CollabDiagnosticV2[] { return this.events.slice(); }
}
