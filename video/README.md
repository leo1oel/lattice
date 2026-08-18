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

## Following the Remotion guidance

Remotion publishes its own authoring guidance — as
[documentation](https://www.remotion.dev/docs/the-fundamentals) and as agent
skills from [`remotion-dev/skills`](https://github.com/remotion-dev/skills).
What this project does with it:

- **`<Video>` from `@remotion/media`**, not `OffthreadVideo` — the currently
  recommended media component.
- **`name` props** on the series, clips and caption sequences, so the Studio
  timeline is readable.
- **Inter, embedded in the stylesheet.** The type used to fall back to whatever
  `-apple-system` resolved to; it is now Inter. Getting there took three failed
  full renders and the reasoning is worth keeping:
  - `@remotion/google-fonts` (the skill's recommendation) fetches the woff2 from
    gstatic *during* the render and blocks on it — one network blip, one dead
    render.
  - `@remotion/fonts` with the file in `public/` failed too, and less obviously:
    `loadFont()` opens a `delayRender()`, and that handle leaked across frames,
    tripping the 28s timeout partway through a full render. Inlining the font as
    a data URI did not help, and neither did raising
    `setDelayRenderTimeoutInMilliseconds` — the handle was never cleared, not
    merely slow.
  - So the font is declared as a plain `@font-face` in generated `src/inter.css`
    with the woff2 as a base64 data URI. **No fetch and no `delayRender()` means
    nothing that can time out.** Regeneration command is in that file's header;
    `public/Inter-latin.woff2` is kept as the source.

**Knowingly not followed:** the video-editing guidance says to author every clip
as its own hardcoded `<TransitionSeries.Sequence>` with literal frame numbers, and
never to generate them with `.map()`. That unlocks dragging clip edges in the
Studio. This project generates them from the `SEGMENTS` arrays instead, because
the segment lengths, the section lengths and each composition's
`durationInFrames` are all derived from one source — and drift between those is
exactly the class of bug that has already cost this edit two re-renders. Dragging
a hardcoded clip in the Studio would also not update the composition's total
duration, so the film would end up truncated or padded. Worth revisiting if
timeline dragging becomes the main way the edit changes.

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
| `Promo` | the film: all four parts + outro, with sound | ~150s |
| `PartOne-Tour` | part one alone, silent, no outro | ~53s |
| `PartTwo-Papers` | part two alone, silent, no outro | ~39s |
| `PartThree-Agent` | part three alone, silent, no outro | ~29s |
| `PartFour-Together` | part four alone, silent, no outro | ~27s |

Only `Promo` carries audio: the cue frames are absolute, so they would not line
up inside a part preview that starts at its own frame 0.

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

- **Part four** (`share.mp4` + `Area.mp4`) — section card → collaborators in the
  project → Lattice and Overleaf editing the same `.tex` in real time.

There is no transition presentation at all. Every scene eases its own whole
screen in and out and drifts continuously in between (`SceneMotion.tsx`), and
the `TransitionSeries` uses `none()` purely to overlap neighbours so those
envelopes cross. See `transitions.ts`.

### Framing

The footage is full bleed via `objectFit: cover`, which crops whatever does not
fit 16:9. Checked against the widest and tightest frames of every capture: it
takes desktop wallpaper, never app chrome. One exception — `share.mp4` is 4:3
and loses 540px, and centred that ate the toolbar where the collaborator avatars
live, so it is anchored to the top (`focus` on `ScreenCard`). An earlier version
floated the footage as a rounded card, which just added bars around the thing
the viewer came to look at.

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
- The recordings have no audio; the soundtrack is generated (`Soundtrack.tsx`).
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

## Assets in `public/`

**Nothing in `video/public/` is tracked by Git or distributed with Lattice** —
the whole directory is ignored (see `.gitignore`) because it is roughly 700 MB
of screen captures plus generated audio. Cloning the repository gives you the
edit, not the media; you have to supply your own captures to render. The one
exception is the font, which is committed in base64 form inside
`src/inter.css` (see below).

### Source footage

Copy each screen capture into `public/` as a real file. They are
high-resolution 60fps captures with no audio track, mostly 16:9 — `share.mp4`
is the 4:3 one the framing notes above call out:

- `public/Research-writer.mp4` — 47.5s, the product tour (part one)
- `public/Research-writer-2.mp4` — 42.5s, the paper library (part two)
- `public/Research-writer-3.mp4` — 40.4s, the agent (part three)
- `public/share.mp4` + `public/Area.mp4` — collaboration (part four)

They must be real files, not symlinks: the bundler does not follow symlinks out
of `public/`, so a link renders fine in the Studio but 404s during
`remotion render`.

Rendering occasionally dies with a `seek-to-frame` timeout on a freshly copied
capture — decoding a high-resolution source while the Studio is also running is
enough to trip it. Re-run; it is transient, not a bad edit.

### Audio and fonts

- `public/audio/*.mp3` — the three music beds and the sound effects wired up in
  `src/promo/Soundtrack.tsx`. Generated, not licensed stock; see that file's
  header for how they were produced and normalised.
- `public/Inter-latin.woff2` — the Inter source file that `src/inter.css` is
  generated from. Unlike everything else here it does leave this directory:
  `src/inter.css` is tracked and carries the same bytes base64-encoded, so the
  font ships with the repository. Inter is under the SIL Open Font License 1.1,
  which requires the copyright notice and license to travel with the font —
  record it in the repository's `THIRD_PARTY_NOTICES.md` if it is not there
  already.

## Config note

`remotion.config.ts` uses `Config.overrideBundlerConfig()`, not
`overrideWebpackConfig()` — with `setRspack(true)` the webpack override is
silently ignored and Tailwind never compiles.

## Docs

- [Remotion fundamentals](https://www.remotion.dev/docs/the-fundamentals)
- [remocn components](https://remocn.dev/llms-components.txt)
