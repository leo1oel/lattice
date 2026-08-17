# Remotion video

Product videos for Lattice / Research-writer. Standalone from the Tauri app: its
own `package.json` and `node_modules`, and the root repo's `tsc`, `eslint`,
`knip` and `vitest` are all scoped to `src/`, so nothing here runs in
`pnpm check`.

## Commands

```console
pnpm install
pnpm dev              # Remotion Studio on http://localhost:3000
npx remotion render Recording out/recording.mp4
```

## Conventions

- **Canvas is 1280x720 @ 30fps** (`FPS`/`WIDTH`/`HEIGHT` in `src/Root.tsx`) —
  the standard remocn components are laid out for. Keep new compositions on it.
- Tailwind v4 is enabled through `@remotion/tailwind-v4`, so remocn/shadcn
  components work. `src/index.css` is imported once from `src/index.ts`.
- remocn components install with `npx shadcn@latest add @remocn/<name>`; the
  registry is wired up in `components.json` and components land in
  `src/components/`.

## The promo cut

Three compositions, all from the same pieces:

| id | what | length |
|---|---|---|
| `Promo` | the film: all three parts + outro | ~126s |
| `PartOne-Tour` | part one alone, no outro | ~53s |
| `PartTwo-Papers` | part two alone, no outro | ~39s |
| `PartThree-Agent` | part three alone, no outro | ~29s |

The section previews exist so iterating on one half doesn't mean re-rendering
the whole film each time.

**The `SEGMENTS` array in `partOne.tsx` / `partTwo.tsx` is the edit.** To retime
a run change `from`/`to` (source seconds); to reword a caption change
`label`/`headline`. Scene lengths, section lengths and each composition's
`durationInFrames` are all derived from those arrays, so they cannot drift out
of sync. The outro lives in `Promo.tsx` rather than in either section, because
it belongs to the film rather than to a part.

**A segment is an unbroken run of one take, not a feature.** Part one is a
single segment carrying eight captions; part two is three, split only where the
edit actually skips ahead. Do not slice a continuous take into one segment per
feature: the slices then have to overlap to cover their dissolves, and the
overlap replays the same second of footage twice — on screen it looks like the
user performed the action, then performed it again.

- **Part one** (`Research-writer.mp4`) — title → LaTeX → Markdown → interactive
  HTML → canvas → sheets.
- **Part two** (`Research-writer-2.mp4`) — section card → add a paper → library
  and alphaXiv write-up → paper as Markdown → original PDF → Markdown source.
- **Part three** (`Research-writer-3.mp4`) — section card → agent panel and the
  `.bib` guardrail → figure as context, `@attention-map.tldr` as target → the
  answer, and the figure redrawn on the canvas as editable shapes.

Each part runs straight into the next part's card. There is deliberately no
recap montage between them: replaying earlier features before starting a new
topic only delays it.

Every cut is a plain opacity crossfade (`fade()`), 24 frames, 30 at the cards —
see `transitions.ts` for why the optical presentations were dropped.

### Framing

The footage is full bleed: 3:2 source into a 16:9 canvas with
`objectFit: cover`, which trims ~167px off the top and bottom. That was checked
against the widest and the most zoomed-in frames of both recordings — it takes
desktop wallpaper, never app chrome. An earlier version floated the footage as a
rounded card on the backdrop, which just added black bars around the thing the
viewer came to look at.

### Two traps, both hit once already

1. **Transition length is not free.** `TransitionSeries` overlaps neighbours, so
   a dissolve eats the head of the incoming scene and the tail of the outgoing
   one. Any short scene — a section card, a 3s segment — has to be checked
   against the transitions landing on it.
2. **Segments must end where the screen changes.** Part two's Blog/Paper toggle
   flips at exactly 15.0s of the capture; an early cut ran the blog beat to
   20.4s, so "the alphaXiv write-up" was captioned over the paper view. When
   retiming, step the capture frame by frame at the boundary rather than
   guessing from a contact sheet.

- `CTA_URL` in `constants.ts` is `null`, so the outro has no URL line. Set it to
  the real domain to switch the line on.
- The recording has no audio track, so the cut is silent by design.
- The capture carries its own camera zooms. Don't add scene-level zoom on top —
  two layers of motion fight each other, which is why `ScreenCard` is static.

### Caption a beat for what is actually on screen

Every caption is a claim about the frame behind it, so it has to be checked
against the footage, not against the feature list:

- The `.bib` file never appears in the capture, so the caption only mentions it
  in passing rather than describing it as a shown feature.
- "Figures, equations, and tables" sits at 10.8s into its beat because Table 3
  only scrolls into view at ~26.5s of the source.

`src/components/remocn/` still holds `focus-pull`, `push-through` and `zoom-blur`
from when the cuts were optical. Nothing imports them now; they are kept as
reference for anyone reaching for a fancier transition later.

## Source footage

Copies of the captures in `~/Documents/`, all 3244x2160 @ 60fps with no audio
track, gitignored via `public/*.mp4`:

- `public/Research-writer.mp4` — 47.5s, the product tour (part one)
- `public/Research-writer-2.mp4` — 42.5s, the paper library (part two)
- `public/Research-writer-3.mp4` — 40.4s, the agent (part three)

They must be real files, not symlinks: the bundler does not follow symlinks out
of `public/`, so a link renders fine in the Studio but 404s during
`remotion render`.

Rendering occasionally dies with a `seek-to-frame` timeout on a freshly copied
capture — decoding 4K while the Studio is also running is enough to trip it.
Re-run; it is transient, not a bad edit.

## Environment gotchas (this machine)

The cac sandbox routes `fetch` through its proxy but leaves `node:https`
untrusted (`UNABLE_TO_GET_ISSUER_CERT_LOCALLY` for every host, even with
`NODE_EXTRA_CA_CERTS`). Anything downloading over `node:https` fails:

- `npx create-video` cannot clone its template — this project was scaffolded
  from `remotion-dev/template-empty` via `curl` instead.
- Remotion cannot auto-download Chrome Headless Shell. It was side-loaded to
  `node_modules/.remotion/chrome-headless-shell/` (`VERSION` = `149.0.7790.0`,
  binary under `mac-arm64/chrome-headless-shell-mac-arm64/`). **After a
  `remotion upgrade` that bumps `TESTED_VERSION`, re-download the matching zip
  with `curl` from `storage.googleapis.com/chrome-for-testing-public/` and
  update `VERSION`,** or rendering breaks again.

`curl` works normally, so it is the escape hatch for any of these.

## Config note

`remotion.config.ts` uses `Config.overrideBundlerConfig()`, not
`overrideWebpackConfig()` — with `setRspack(true)` the webpack override is
silently ignored and Tailwind never compiles.

## Docs

- [Remotion fundamentals](https://www.remotion.dev/docs/the-fundamentals)
- [remocn components](https://remocn.dev/llms-components.txt) (also installed as
  an agent skill in `.agents/skills/remocn`)
