// The design-system tokens as serialize.js binds them, for one theme.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The serializer's options for one theme: every colour token (dark ones by their Paper name), fonts and radii. */
export function tokenOptions(theme) {
  const tokens = JSON.parse(readFileSync(join(here, "../tokens.json"), "utf8")).tokens;
  const rgba = (value) => {
    if (value === "transparent") return [0, 0, 0, 0];
    const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value);
    if (hex) return [0, 2, 4].map((k) => parseInt(hex[1].slice(k, k + 2), 16)).concat(hex[2] ? parseInt(hex[2], 16) / 255 : 1);
    const raw = /rgba?\(([^)]+)\)/.exec(value)[1].split(/[\s,/]+/).filter(Boolean);
    const n = raw.map(parseFloat);
    return [n[0], n[1], n[2], raw[3] === undefined ? 1 : raw[3].endsWith("%") ? n[3] / 100 : n[3]];
  };
  const colors = [];
  for (const [name, token] of Object.entries(tokens)) {
    if (token.type !== "color") continue;
    if (theme === "dark" && token.dark) colors.push({ name: name.replace(/^--color-/, "--color-dark-"), rgba: rgba(token.dark) });
    else if (theme === "light" || !token.dark) colors.push({ name, rgba: rgba(token.value) });
  }
  const fonts = Object.entries(tokens).filter(([, t]) => t.type === "fontFamily").map(([name, t]) => ({ name, first: t.value.split(",")[0].trim().replace(/"/g, "") }));
  // Builds that embed the private Timeless family put its faces first in the same roles (scripts/private-fonts.ts).
  fonts.push({ name: "--font-ui", first: "Timeless Sans" }, { name: "--font-reading", first: "Timeless Serif Text" }, { name: "--font-display", first: "Timeless Serif" });
  const radii = Object.entries(tokens).filter(([, t]) => t.type === "radius" && /px$/.test(t.value)).map(([name, t]) => ({ name, px: parseFloat(t.value) }));
  return { colors, fonts, radii };
}
