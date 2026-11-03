# Lattice design system (exported copy)

The design system lives in the Paper file
[Lattice design system](https://app.paper.design/file/01M6EKRMTWZ2JD6ZHKF830MAVP):
Guidelines (start there), Foundations, Components and Patterns. This folder
is its exported copy, for code and for agents that cannot reach Paper.

| File | What it is | Edit it? |
| --- | --- | --- |
| `tokens.css` | Every token as CSS custom properties; light on `:root`, dark under `[data-theme="dark"]` or `.dark` | No, generated |
| `tokens.json` | The same tokens with their light and dark values, use, and the app variable each mirrors | No, generated |
| `DESIGN.md` | The written rules from the Guidelines page, then every token in tables | No, generated |
| `paper-export.json` | The raw pull from Paper the three files above are rendered from | No, generated |
| `export.mjs` | The exporter | Yes |
| `README.md` | This file | Yes |

## Regenerate from Paper

With the Paper desktop app running and the file reachable from your account:

```bash
node design-system/export.mjs
pnpm vitest run src/styles/design-system-drift.test.ts
```

The exporter starts Paper's MCP server (`paper mcp`; set `PAPER_BIN` if
`paper` is not on `PATH` or in `~/.paper/bin`), reads the design tokens, the
`spec:motion` and `spec:shadow` blocks on Foundations (durations, curves and
shadows have no Paper token type), and the Start here and Guidelines
artboards, saves that pull as `paper-export.json`, and renders the rest from it.
`node design-system/export.mjs --from design-system/paper-export.json`
re-renders without Paper.

Paper has no theme modes, so a dark value is its own token there
(`--color-dark-chrome`, `--shadow-dark-popover`); the export folds each into its
light twin. A font token holds the face Paper can draw and its description
carries the real stack after `stack:`, which is what the export writes.

## Who reads these files

The Lattice app does not import `tokens.css`. Its own CSS stays its source:
`src/styles/theme.css` and `foundations.css` also declare scopes this export
does not cover (the theme and tint previews in Settings), and the drift check
below is the contract that keeps the app and this copy equal. `tokens.css`,
`tokens.json` and `DESIGN.md` are for everything else: the website, new
software built from the system, and agents without Paper.

## The drift check

`src/styles/design-system-drift.test.ts` resolves every token whose
description names an app variable (`app: --surface-chrome`) in the app's own
`theme.css` and `foundations.css`, in the right theme, tint, accent or Settings
scope, and fails on any difference. It never changes either side: when it fails,
decide which one is right, change that one at its source (the Paper file, or
the app's CSS), and re-export. Tokens with `app: none` are documentation only.

## Hand it to another agent

- An agent with the Paper MCP: give it the Paper link and tell it to read the
  Guidelines page first, then use the file's tokens (`get_tokens`) and look at
  the components it needs.
- An agent without Paper (cloud, another machine): give it this folder. It
  should read `DESIGN.md` first and take every value from `tokens.css` or
  `tokens.json`. Rules marked **[Lattice]** are specific to Lattice; the rest
  are meant for a new product too.

## The review loop

The captain does not comment in the Paper file. Review happens on the product.

1. The captain comments on the surface under review: the review page or board
   for the website, a film, or app screens.
2. The agent working on that surface fixes it.
3. When a comment implies a rule or a value of the system (a colour, a spacing
   step, a motion curve, a rule on the Guidelines page), that agent, not the
   captain, updates the Paper file: the token or rule, and the components and
   patterns that show it. It changes the app's CSS in the same change when the
   value is one the app uses.
4. It runs `node design-system/export.mjs` and the drift check, and opens the
   change for review, naming the comment it answers.

New work then follows the updated system.
