/**
 * Routing for tests of code that talks to the Tauri backend. The test file
 * still declares its own `vi.mock("@tauri-apps/api/core", …)` (and `/event`)
 * factory; these helpers only decide what the mocked functions answer.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { act } from "@testing-library/react";
import { vi } from "vitest";

/** Each command's canned answer, or a function of the call's arguments computing it. */
export type CommandTable = Record<string, unknown>;

/** Answer mocked `invoke` calls from a table; a command missing from it rejects, like an unregistered Tauri command. */
export function mockInvoke(commands: CommandTable): void {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    // eslint-disable-next-line lingui/no-unlocalized-strings -- test helper, never shipped
    if (!Object.hasOwn(commands, command)) throw new Error(`Unexpected command: ${command}`);
    const answer = commands[command];
    return typeof answer === "function" ? answer((args ?? {}) as Record<string, unknown>) : answer;
  });
}

/** Every argument object `invoke` was called with for one command, in order. */
export function invokeCalls(command: string): Record<string, unknown>[] {
  return vi.mocked(invoke).mock.calls
    .filter(([name]) => name === command)
    .map(([, args]) => (args ?? {}) as Record<string, unknown>);
}

/**
 * Register mocked `listen` subscriptions and return an emitter that delivers a
 * backend event payload to every live one, inside `act`.
 */
export function mockListen(): (payload: unknown) => void {
  const handlers = new Set<(event: { payload: unknown }) => void>();
  vi.mocked(listen).mockImplementation(async (_name, handler) => {
    const typed = handler as (event: { payload: unknown }) => void;
    handlers.add(typed);
    return () => { handlers.delete(typed); };
  });
  return (payload) => act(() => {
    for (const handler of [...handlers]) handler({ payload });
  });
}
