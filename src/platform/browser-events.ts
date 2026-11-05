const LOCAL_EVENT_START = -1;

export function physicalWindowSize() {
  return {
    width: Math.round(window.innerWidth * window.devicePixelRatio),
    height: Math.round(window.innerHeight * window.devicePixelRatio),
  };
}

const WINDOW_EVENTS = new Map([["tauri://resize", "resize"], ["tauri://focus", "focus"], ["tauri://blur", "blur"]]);

export class BrowserEventRegistry {
  private nextLocalId = LOCAL_EVENT_START;
  private readonly entries = new Map<string, {
    callbackId: number;
    cleanup?: () => void;
  }>();

  constructor(private readonly runCallback: (id: number, payload: unknown) => void) {}

  listen(event: string, callbackId: number): number | null {
    const domEvent = WINDOW_EVENTS.get(event);
    if (!domEvent) return null;
    return this.subscribe(event, callbackId, domEvent, (emit) => {
      emit(event === "tauri://resize" ? physicalWindowSize() : event === "tauri://focus");
    });
  }

  track(event: string, eventId: number, callbackId: number): void {
    this.entries.set(this.key(event, eventId), { callbackId });
  }

  unregister(event: string, eventId: number, unregisterCallback: (id: number) => void): void {
    const key = this.key(event, eventId);
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.cleanup?.();
    unregisterCallback(entry.callbackId);
    this.entries.delete(key);
  }

  /** Emulates a Tauri event with a window DOM event under a negative local id. */
  private subscribe(
    event: string,
    callbackId: number,
    domEvent: string,
    handle: (emit: (payload: unknown) => void) => void,
  ): number {
    const eventId = this.nextLocalId--;
    const emit = (payload: unknown) => this.runCallback(callbackId, { event, id: eventId, payload });
    const listener = () => handle(emit);
    window.addEventListener(domEvent, listener);
    this.entries.set(this.key(event, eventId), {
      callbackId,
      cleanup: () => window.removeEventListener(domEvent, listener),
    });
    return eventId;
  }

  private key(event: string, eventId: number): string {
    return `${event}:${eventId}`;
  }
}

