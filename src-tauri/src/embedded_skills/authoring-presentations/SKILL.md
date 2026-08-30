---
name: authoring-presentations
display-name: Presentation Authoring
short-description: Create and edit native Open Slide decks in Lattice.
description: Creates and edits Open Slide presentations stored as React and TypeScript under slides/<deck-id>/. Use when a user asks for slides, decks, presentations, PPT, PPTX, PowerPoint, 演示文稿, or 幻灯片 content, speaker notes, visuals, transitions, or presentation structure in Lattice.
---

# Authoring Lattice presentations

Create and revise native Open Slide decks inside the current Lattice project.
Lattice hosts Open Slide directly, so the deck source, editor, presenter mode, comments, assets, design controls, and HTML or PDF export all use Open Slide's native behavior.

## Work on the native deck

- A deck id is a short, descriptive kebab-case directory name such as `attention-results`.
- The entry file is always `slides/<deck-id>/index.tsx`.
- Deck-local images, videos, and fonts belong under `slides/<deck-id>/assets/`.
- Assets reused by multiple decks belong under the project-root `assets/` directory and are imported through `@assets/...`.
- Themes belong under the project-root `themes/` directory.
- Speaker notes stay in the entry module's exported `notes` array.
- Do not create an alternate slide source, a separate notes file, or a Lattice-specific manifest.
- Do not add dependencies or modify `package.json` for ordinary deck authoring.
- The managed runtime uses the fixed directories above and deliberately does not execute `open-slide.config.ts`.
- Do not edit another deck or shared assets unless the request requires it.
- Preserve existing page order, notes, metadata, design tokens, transitions, and assets outside the requested change.

When the Lattice host context contains `presentation`, treat it as the live Open Slide cursor for the current turn.
Use `presentation.pagePath`, `pageIndex`, and `pageNumber` to resolve references such as “this slide,” and use `presentation.selection.line` and `column` as the source handle for references such as “this heading.”
Re-check the current host context on every turn that uses such a reference because the user can navigate or select another element between turns.

When the user asks for a presentation without naming an output format, create or edit a native Open Slide deck.
If the user explicitly requests `.pptx`, explain that Lattice does not author PowerPoint files and offer the native deck or Open Slide's HTML or PDF export instead.

## Use the file contract

Each entry module default-exports a non-empty array of zero-prop React page components in presentation order.
Keep helper components and constants in the same `index.tsx` file so Open Slide's inspector can edit source locations reliably.

```tsx
import type { DesignSystem, Page, SlideMeta } from '@open-slide/core';

export const design: DesignSystem = {
  palette: { bg: '#0f172a', text: '#f8fafc', accent: '#fbbf24' },
  fonts: {
    display: '"Inter Variable", Inter, "Avenir Next", "Segoe UI", sans-serif',
    body: '"Inter Variable", Inter, "Avenir Next", "Segoe UI", sans-serif',
  },
  typeScale: { hero: 168, body: 40 },
  radius: 12,
};

const Cover: Page = () => (
  <div
    style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      padding: '0 160px',
      background: 'var(--osd-bg)',
      color: 'var(--osd-text)',
      fontFamily: 'var(--osd-font-body)',
    }}
  >
    <h1
      style={{
        margin: 0,
        fontFamily: 'var(--osd-font-display)',
        fontSize: 'var(--osd-size-hero)',
        lineHeight: 1.05,
      }}
    >
      The Big Idea
    </h1>
  </div>
);

export const notes = [
  'Introduce the question before showing the result.',
];

export const meta: SlideMeta = {
  title: 'The Big Idea',
  createdAt: '2026-05-16T12:00:00Z',
};

export default [Cover] satisfies Page[];
```

Set `meta.createdAt` once when creating a deck, using the current ISO 8601 timestamp as a plain string literal.
The `notes` array is index-aligned with the exported pages, and an entry may be `undefined` when that page has no notes.
Set `meta.theme` only when the deck follows a matching `themes/<id>.md` theme.

## Design for the fixed canvas

Every page uses a fixed 1920 × 1080 canvas that Open Slide scales to the available surface.
The root element of every page must fill `100% × 100%`.
Use absolute pixel values for typography, spacing, and fixed geometry, and never depend on page scrolling.

- Keep content 100–160px from the canvas edges.
- Use roughly 140–200px for hero titles, 80–120px for section headings, 56–80px for page headings, 32–44px for body text, and 22–28px for labels.
- Keep each page focused on one idea, with at most five short bullets.
- Split crowded content into more pages instead of shrinking body text below 28px or hiding overflow.
- Verify the vertical budget: content height plus gaps and top and bottom padding must not exceed 1080px.

Default new decks to an exported `DesignSystem` so users can tune the palette, fonts, type scale, and radius in Open Slide's Design panel.
Use `var(--osd-bg)`, `var(--osd-text)`, `var(--osd-accent)`, `var(--osd-font-display)`, `var(--osd-font-body)`, `var(--osd-size-hero)`, `var(--osd-size-body)`, and `var(--osd-radius)` in visual styles.
Keep the design object as a literal without spreads or helper calls so the Design panel can update it.

## Use assets and native primitives

Import deck-local assets as modules:

```tsx
import hero from './assets/hero.jpg';

<img src={hero} alt="Attention map" style={{ width: 960, height: 540, objectFit: 'cover' }} />
```

Import a reusable global asset through the alias:

```tsx
import logo from '@assets/logos/lattice.svg';
```

When a specific user-owned image is required but unavailable, use `ImagePlaceholder` with a concrete content hint instead of inventing an asset.
Do not use placeholders for decoration or generic stock imagery.

Use `Steps` and direct-child `Step` elements only when the order of ideas matters:

```tsx
import { Step, Steps } from '@open-slide/core';

<Steps>
  <h2>The framing appears immediately.</h2>
  <Step><p>The first consequence appears next.</p></Step>
  <Step><p>The conclusion appears last.</p></Step>
</Steps>
```

Non-`Step` children appear immediately, and every `Step` must be a direct child of `Steps`.
Pages reached from the overview or by backward navigation appear fully revealed, so the complete composition must remain readable.

Use `useSlidePageNumber()` for a dynamic page-number footer rather than hardcoding the current page or total.
Use one restrained `SlideTransition` family across a deck, or omit transitions entirely.
Use `MorphElement` only for the same visual object across adjacent pages, with a stable id and deterministic geometry.

## Keep inspector edits independent

For repeated cards, tiles, logos, or diagram nodes, define one helper component in `index.tsx` and instantiate each item explicitly.
Do not render inspector-editable repeated visuals by mapping a data array because every rendered instance would share one source location.
Ordinary literal `<li>` elements are already independent and do not need a helper component.

## Validate before finishing

- Confirm that `slides/<deck-id>/index.tsx` default-exports a non-empty `Page[]`.
- Confirm that every page root fills the 1920 × 1080 canvas and all visible content fits without scrolling or cropping.
- Confirm that `notes` remains aligned with the exported pages.
- Confirm that every imported asset exists under the deck's `assets/` directory or the project-root `assets/` directory.
- Confirm that no dependency, unrelated deck, alternate slide source, or generated export was added.
- Re-read the changed page and the exports after editing.
- Never claim to have visually inspected, presented, or exported the deck unless the corresponding app action or tool was actually used.

Open Slide provides live editing, thumbnails, comments, asset management, design controls, presenter view, fullscreen navigation, speaker notes, and HTML or PDF export inside Lattice.
Do not instruct the user to run a separate Vite server or `npx @open-slide/cli` for a Lattice project.

## Upstream references

- Open Slide repository: <https://github.com/1weiho/open-slide>
- Open Slide package: <https://www.npmjs.com/package/@open-slide/core>

Use Open Slide's native TypeScript and React contract when upstream behavior is required.
