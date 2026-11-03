# Lattice design system (exported copy)

The design system lives in the Paper file
[Lattice design system](https://app.paper.design/file/01M6EKRMTWZ2JD6ZHKF830MAVP):
Guidelines (start there), Foundations, Components, Patterns and App screens.
This folder
is its exported copy, for code and for agents that cannot reach Paper.

| File | What it is | Edit it? |
| --- | --- | --- |
| `tokens.css` | Every token as CSS custom properties; light on `:root`, dark under `[data-theme="dark"]` or `.dark` | No, generated |
| `tokens.json` | The same tokens with their light and dark values, use, and the app variable each mirrors | No, generated |
| `DESIGN.md` | The written rules from the Guidelines page, then every token in tables | No, generated |
| `paper-export.json` | The raw pull from Paper the three files above are rendered from | No, generated |
| `export.mjs` | The exporter | Yes |
| `paper.mjs` | The Paper file's id and a client for Paper's MCP server | Yes |
| `screens/` | Draws the App screens page from the running app (below) | Yes |
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
scope, and fails on any difference. A code-theme token (`app: code-theme github
--syntax-keyword`) is checked against the palette the editor computes for that
theme (`codeThemeProperties` in `src/settings/code-themes.ts`). It never changes either side: when it fails,
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

The captain reviews the product, never the system pages: the app on the Paper
file's App screens page, the website and films on their own review pages or
boards.

1. The captain comments on what is under review. For the app, that is a
   comment pinned to a screen's artboard in Paper.
2. The agent reads the open threads (`list_comment_threads`, then
   `get_comment_thread` for each in full) and fixes the screen in Paper, or the
   website or film on its own surface.
3. When a comment implies a rule or a value of the system (a colour, a spacing
   step, a motion curve, a rule on the Guidelines page), that agent, not the
   captain, updates the Paper file: the token or rule, and the components and
   patterns that show it. It runs `node design-system/export.mjs` and the drift
   check.
4. An app screen's change reaches the app's code only once the captain picks
   it; the drift check then holds the app and the exported copy together. The
   agent resolves the thread (`set_comment_thread_status`) when its change is
   in, and names the thread in the pull request.

## App screens

The App screens page holds the app's main screens (main window, Agent panel,
references, Markdown, HTML and slides viewers, Settings, welcome) in light and
dark, as editable layers whose colours, fonts and radii are the file's tokens.
They are drawn from the app as it runs, not from screenshots, by `screens/`:
each screen is staged on the mock-backend page over the tutorial project and
its built PDF (`scenes.mjs`), every rendered element becomes a Paper layer at
its measured place (`serialize.js`), and `draw.mjs` writes it to the artboard
of that name. Redraw a screen this way after the app changes rather than
editing it by hand to match:

```bash
pnpm perf:bench --serve --dev --port 0     # prints the page's URL; keep it running
BENCH_URL=<url> node design-system/screens/agent.mjs <synara checkout>   # the Agent panel, first
BENCH_URL=<url> node design-system/screens/draw.mjs [screen…]            # --dry-run to only write HTML
```

The Agent panel is Synara's own chat view at the pinned revision, rendered by
`agent.mjs` in Synara's browser test harness in Lattice's embed mode and host
theme. Slides come from the Open Slide runtime over a throwaway copy of the
deck (`pnpm --dir tools/open-slide-runtime install` first). Colours that match
no token are counted; inside the app's own chrome every colour is a token, or a
token at reduced opacity.

Builds that embed the private Timeless family set the interface, reading and
display roles in its faces; the screens bind those roles to the font tokens.
Paper cannot draw Timeless (or the bundled Ioskeley Mono), so each font token
holds the closest face Paper has, chosen by glyph overlap and set width against
the app's own face: Inter (interface), Libre Caslon Text (reading), Lora
(display), Roboto Mono (code). The export still writes the app's stacks.
