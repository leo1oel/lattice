type RecordToWrite = { line: string; priority: number; bytes: number };
export type LogLosses = { overflow: number; failed: number };

/** Bounded, serial delivery. A rejected IPC call may already have written, so
 * retries retain the original event id/time and consumers can deduplicate it. */
export class AppLogFileQueue {
  private pending: RecordToWrite[] = [];
  private bytes = 0;
  private current: RecordToWrite | undefined;
  private running = false;
  private losses: LogLosses = { overflow: 0, failed: 0 };
  private reportedLosses = 0;

  constructor(
    private readonly write: (line: string, priority: number) => Promise<void>,
    private readonly reportLoss: (losses: LogLosses) => string,
  ) {}

  enqueue(line: string, priority: number): void {
    const bytes = new TextEncoder().encode(line).byteLength;
    if (bytes > 512 * 1024) {
      this.lose("overflow");
      return;
    }
    // Include the in-flight record in both limits. Never evict/retry an IPC
    // that is still pending: its outcome is unknown, and there is no cancel API.
    while (this.pending.length + Number(Boolean(this.current)) >= 256 || this.bytes + bytes > 512 * 1024) {
      let candidate = -1;
      for (let index = 0; index < this.pending.length; index++) {
        if (this.pending[index].priority <= priority
          && (candidate < 0 || this.pending[index].priority < this.pending[candidate].priority)) candidate = index;
      }
      if (candidate < 0) {
        this.lose("overflow");
        return;
      }
      this.bytes -= this.pending.splice(candidate, 1)[0].bytes;
      this.lose("overflow");
    }
    this.pending.push({ line, priority, bytes });
    this.bytes += bytes;
    if (!this.running) void this.drain();
  }

  private lose(reason: keyof LogLosses): void {
    this.losses[reason]++;
    // The callback updates local history without feeding back into this queue.
    this.reportLoss({ ...this.losses });
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while ((this.current = this.pending.shift())) {
        let delivered = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await this.write(this.current.line, this.current.priority);
            delivered = true;
            break;
          } catch {
            if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 250 : 1_000));
          }
        }
        this.bytes -= this.current.bytes;
        this.current = undefined;
        if (!delivered) {
          this.lose("failed");
          // Do not turn an unavailable sink into a tight retry loop. A bounded
          // backlog still drains; a later event can recover without restarting.
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          continue;
        }
        const total = this.losses.overflow + this.losses.failed;
        if (total > this.reportedLosses) {
          try {
            await this.write(this.reportLoss({ ...this.losses }), 1);
            this.reportedLosses = total;
          } catch {
            // Retry the loss summary only after another normal write succeeds.
            // A failed summary must not generate another loss-summary loop.
          }
        }
      }
    } finally {
      this.running = false;
    }
  }
}
