type CollabDiagnosticNameV2 = "join_latency" | "first_file_open" | "durable_ack_latency" | "oldest_outbox" | "disk_conflict" | "markdown_draft" | "events_poll_error";
type CollabDiagnosticV2 = { name: CollabDiagnosticNameV2; at: number; durationMs?: number; count?: number; fileId?: string };
export type CollabDiagnosticSinkV2 = (event: CollabDiagnosticV2) => void;
