import { describe, expect, it } from "vitest";
import {
  applySlashCommand,
  filterSlashCommands,
  slashAtCaret,
  type AgentCommand,
} from "./slash-commands";

const COMMANDS: AgentCommand[] = [
  { name: "compact", description: "Compact the conversation", subcommands: ["soft", "remote"] },
  { name: "context", description: "Show context usage", subcommands: [] },
  { name: "fast", description: "Toggle fast mode", hint: "[on|off|status]", subcommands: ["on", "off"] },
  { name: "model", description: "Show current model selection", subcommands: [] },
];

describe("slashAtCaret", () => {
  it("offers the menu while the leading command name is being typed", () => {
    expect(slashAtCaret("/comp", 5)).toEqual({ start: 0, end: 5, query: "comp" });
    expect(slashAtCaret("/", 1)).toEqual({ start: 0, end: 1, query: "" });
  });

  it("stops once the name is settled and arguments begin", () => {
    expect(slashAtCaret("/fast on", 8)).toBeNull();
  });

  it("leaves ordinary prose alone", () => {
    // OMP only reads a command when the message opens with it.
    expect(slashAtCaret("see /tmp/notes.txt", 18)).toBeNull();
    expect(slashAtCaret("Rewrite this.", 13)).toBeNull();
    expect(slashAtCaret("first line\n/context", 19)).toBeNull();
  });
});

describe("filterSlashCommands", () => {
  it("returns everything for a bare slash", () => {
    expect(filterSlashCommands(COMMANDS, "")).toHaveLength(4);
  });

  it("puts prefix matches ahead of incidental ones", () => {
    const names = filterSlashCommands(COMMANDS, "co").map((command) => command.name);
    expect(names[0]).toBe("compact");
    expect(names[1]).toBe("context");
  });

  it("also matches on what the command does", () => {
    expect(filterSlashCommands(COMMANDS, "conversation").map((c) => c.name)).toEqual(["compact"]);
  });

  it("is case insensitive", () => {
    // "fast" trails because it only matches through its description ("mode").
    expect(filterSlashCommands(COMMANDS, "MOD").map((c) => c.name)).toEqual(["model", "fast"]);
  });
});

describe("applySlashCommand", () => {
  it("leaves the caret after a space when the command takes arguments", () => {
    const state = slashAtCaret("/fa", 3)!;
    expect(applySlashCommand("/fa", state, COMMANDS[2])).toEqual({ value: "/fast ", caret: 6 });
  });

  it("completes an argument-less command ready to send", () => {
    const state = slashAtCaret("/cont", 5)!;
    expect(applySlashCommand("/cont", state, COMMANDS[1])).toEqual({ value: "/context", caret: 8 });
  });

  it("replaces only up to the caret, keeping the rest of the line", () => {
    const value = "/cont notes";
    const state = slashAtCaret(value, 5)!;
    expect(applySlashCommand(value, state, COMMANDS[1]).value).toBe("/context notes");
  });
});
