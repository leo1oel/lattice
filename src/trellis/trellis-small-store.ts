/** A plain object store the controller's slices live in: `set` notifies only when a field changed. Eager, like the controller. */
export type Listener = () => void;

export class SmallStore<T extends object> {
  private listeners = new Set<Listener>();
  constructor(private value: T) {}
  get = () => this.value;
  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  set(patch: Partial<T>) {
    let changed = false;
    for (const key of Object.keys(patch) as Array<keyof T>) {
      if (!Object.is(this.value[key], patch[key])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.value = { ...this.value, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}
