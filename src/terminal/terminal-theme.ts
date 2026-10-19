/**
 * The terminal's colours, read from the design system rather than written
 * here: terminal.css maps each xterm.js colour onto a semantic role (the code
 * theme's ground, ink, caret and selection; the status colours for red,
 * green, yellow and blue), so the terminal follows light and dark, the tint
 * and the code theme the way the source editor does.
 *
 * xterm.js wants plain colours, and a role can resolve to `color-mix()` or
 * `oklch()`, so each one is painted once on a 1×1 canvas and read back.
 */
import type { ITheme } from "@xterm/xterm";

/* eslint-disable lingui/no-unlocalized-strings -- CSS property and xterm theme keys */

const ROLES: Array<[keyof ITheme, string]> = [
  ["background", "--terminal-ground"],
  ["foreground", "--terminal-ink"],
  ["cursor", "--terminal-caret"],
  ["cursorAccent", "--terminal-ground"],
  ["selectionBackground", "--terminal-selection"],
  ["selectionInactiveBackground", "--terminal-selection-inactive"],
  ["black", "--terminal-black"],
  ["red", "--terminal-red"],
  ["green", "--terminal-green"],
  ["yellow", "--terminal-yellow"],
  ["blue", "--terminal-blue"],
  ["magenta", "--terminal-magenta"],
  ["cyan", "--terminal-cyan"],
  ["white", "--terminal-white"],
  ["brightBlack", "--terminal-bright-black"],
  ["brightRed", "--terminal-bright-red"],
  ["brightGreen", "--terminal-bright-green"],
  ["brightYellow", "--terminal-bright-yellow"],
  ["brightBlue", "--terminal-bright-blue"],
  ["brightMagenta", "--terminal-bright-magenta"],
  ["brightCyan", "--terminal-bright-cyan"],
  ["brightWhite", "--terminal-bright-white"],
];

let canvas: CanvasRenderingContext2D | null | undefined;

/** `color` as `#rrggbb` (or `rgba()` when translucent); null when it does not parse. */
function plainColor(color: string): string | null {
  canvas ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!canvas || !color) return null;
  canvas.clearRect(0, 0, 1, 1);
  canvas.fillStyle = "#000000";
  canvas.fillStyle = color;
  canvas.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data;
  if (a < 255) return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/** The theme for a terminal drawn inside `element` (which carries terminal.css's roles). */
export function terminalTheme(element: HTMLElement): ITheme {
  // A probe resolves each role through the element's cascade (its tint,
  // theme and code theme), including roles that refer to other roles.
  const probe = document.createElement("span");
  probe.style.display = "none";
  element.appendChild(probe);
  const theme: ITheme = {};
  try {
    for (const [key, role] of ROLES) {
      probe.style.color = `var(${role})`;
      const color = plainColor(getComputedStyle(probe).color);
      if (color) (theme as Record<string, string>)[key] = color;
    }
  } finally {
    probe.remove();
  }
  return theme;
}

/** The source editor's font stack, which the terminal shares. */
export function terminalFontFamily(element: HTMLElement): string {
  return getComputedStyle(element).getPropertyValue("--editor-font").trim() || "ui-monospace, Menlo, monospace";
}
