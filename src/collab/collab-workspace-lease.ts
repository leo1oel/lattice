/**
 * Workspace lease shared by the v2 collaboration flows: a join/share binds the
 * session to one on-disk project root, and any async work that lands after the
 * user switched projects must fail instead of writing into the wrong folder.
 */
export type CollabWorkspaceLease = {
  projectRoot: string;
  generation: number;
  isCurrent: () => boolean;
};

export function assertCollabWorkspaceLease(lease: CollabWorkspaceLease): void {
  if (!lease.isCurrent()) {
    throw new Error("The collaboration workspace changed before the operation completed.");
  }
}

/** Serializes collaboration mutations by project path while retaining rejected tails. */
export class CollabDiskWriteQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(lease: CollabWorkspaceLease, path: string, work: () => Promise<T>): Promise<T> {
    const key = `${lease.projectRoot}\0${path}`;
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(async () => {
      assertCollabWorkspaceLease(lease);
      const value = await work();
      assertCollabWorkspaceLease(lease);
      return value;
    });
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void tail.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}
