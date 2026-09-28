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

/** Run `work` once every earlier task with the same key has settled; a failure never blocks the next. */
export function keyedQueue(): <T>(key: string, work: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>();
  return (key, work) => {
    const result = (tails.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
    const tail = result.then(() => undefined, () => undefined);
    tails.set(key, tail);
    void tail.finally(() => { if (tails.get(key) === tail) tails.delete(key); });
    return result;
  };
}

/** Serializes collaboration mutations by project path, checking the lease on both sides of each. */
export class CollabDiskWriteQueue {
  private readonly enqueue = keyedQueue();

  run<T>(lease: CollabWorkspaceLease, path: string, work: () => Promise<T>): Promise<T> {
    return this.enqueue(`${lease.projectRoot}\0${path}`, async () => {
      assertCollabWorkspaceLease(lease);
      const value = await work();
      assertCollabWorkspaceLease(lease);
      return value;
    });
  }
}
