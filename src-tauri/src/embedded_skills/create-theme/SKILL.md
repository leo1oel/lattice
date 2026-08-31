---
name: create-theme
display-name: Create Theme
short-description: Create a reusable visual theme for Lattice presentations.
description: Creates or extracts reusable Open Slide themes under themes/. Use when the user asks to create a presentation theme, reuse a visual style, derive a theme from an existing deck or reference image, or invokes /create-theme.
---

# Create a Lattice presentation theme

Create a paired theme bundle in the current Lattice project.

- `themes/<id>.md` is the authoring specification that the presentation agent reads when creating a deck.
- `themes/<id>.demo.tsx` is a self-contained two- or three-page preview rendered in Open Slide's Themes screen.

The two files must share the same kebab-case stem so Open Slide can pair them automatically.
A theme is authoring-time direction rather than a runtime stylesheet, so changing it does not restyle existing decks automatically.

## Keep the change scoped

- Only create or update `themes/<id>.md` and `themes/<id>.demo.tsx`.
- Read an existing deck or supplied reference files when needed, but do not modify them.
- Do not modify `slides/`, `package.json`, `open-slide.config.ts`, or project dependencies.
- Do not create a separate demo under `slides/`; the sibling `.demo.tsx` file is the preview.
- Use the managed `@open-slide/core` runtime and standard React APIs only.

## Determine the visual source

A theme may come from one or more of these sources:

- A written direction such as “warm academic editorial with restrained blue accents.”
- Images, screenshots, a mood board, or brand assets supplied by the user.
- An existing deck under `slides/<deck-id>/index.tsx` whose visual language should be reused.

If the request already identifies the source and desired direction, proceed without asking another question.
If it does not, ask one concise question that lets the user choose a written brief, reference images, or an existing deck.

When extracting from an existing deck, inspect its exported `design`, palette and font constants, recurring spacing, fixed title and footer components, decorative motifs, and motion.
When using images, derive concrete colors, typography characteristics, layout rhythm, and recurring chrome rather than merely describing the images.
Resolve conflicting inputs with the user before writing files.

## Choose the theme id

Use a short kebab-case id such as `academic-minimal`, `editorial-noir`, or `product-bright`.
Check `themes/` first and do not overwrite an existing theme unless the user asked to revise it.

## Write the authoring specification

Write `themes/<id>.md` with the following structure.
Keep every choice concrete enough that another agent can reproduce the look without guessing.

````markdown
---
name: Academic Minimal
description: Quiet editorial slides with warm paper, dark ink, and restrained blue accents.
---

# Academic Minimal

## Palette

| Role   | Value     | Usage                         |
| ------ | --------- | ----------------------------- |
| bg     | `#f7f4ed` | page background               |
| text   | `#18202a` | primary text                  |
| accent | `#315f8c` | emphasis and key data         |
| muted  | `#68717a` | secondary text and dividers   |

## Typography

- Display font: `Georgia, "Times New Roman", serif` at weight 700.
- Body font: `"Inter Variable", Inter, "Avenir Next", "Segoe UI", sans-serif` at weight 400–500.
- Hero title: 156px with 1.02 line-height.
- Page heading: 72px with 1.08 line-height.
- Body text: 36px with 1.45 line-height.
- Caption: 24px with 1.35 line-height.

## Layout

- Use a 1920 × 1080 canvas with 128px horizontal and 96px vertical content padding.
- Prefer one dominant idea per page and a strong left alignment.
- Keep body copy below 1180px wide.
- Use 24px corners only for contained data or image surfaces.

## Fixed components

These components are paste-ready and must be copied into decks that use this theme.

### Title

```tsx
const Title = ({ children }: { children: React.ReactNode }) => (
  <h1
    style={{
      margin: 0,
      color: '#18202a',
      fontFamily: 'Georgia, "Times New Roman", serif',
      fontSize: 156,
      fontWeight: 700,
      letterSpacing: '-0.025em',
      lineHeight: 1.02,
    }}
  >
    {children}
  </h1>
);
```

### Footer

```tsx
import { useSlidePageNumber } from '@open-slide/core';

const Footer = () => {
  const { current, total } = useSlidePageNumber();
  return (
    <footer
      style={{
        position: 'absolute',
        right: 128,
        bottom: 56,
        left: 128,
        display: 'flex',
        justifyContent: 'space-between',
        color: '#68717a',
        fontSize: 22,
      }}
    >
      <span>ACADEMIC MINIMAL</span>
      <span>{current} / {total}</span>
    </footer>
  );
};
```

### Eyebrow

Define any recurring eyebrow, rule, card, or label component here as paste-ready TSX.

## Motion

- Use subtle 400–500ms entrance motion for the primary content only.
- Keep footers and persistent chrome static.
- Include paste-ready keyframes when the theme uses motion.

## Aesthetic

Describe the visual identity in one committed paragraph, including what to avoid.

## Example usage

Provide one paste-ready `Page` component that demonstrates the theme's principal composition.
````

Adapt the values and components to the user's source instead of copying the example aesthetic.
Define at least `bg`, `text`, `accent`, and `muted` colors as hex values.
State hero, heading, body, and caption sizes.
Include paste-ready Title and Footer components, plus any motif central to the theme.
Commit to one motion philosophy and one coherent aesthetic direction.

## Write the live preview

Write `themes/<id>.demo.tsx` as a normal Open Slide module with two or three pages.
The preview must be self-contained because the Themes screen loads it independently from real decks.

```tsx
import {
  type DesignSystem,
  type Page,
  useSlidePageNumber,
} from '@open-slide/core';

export const design: DesignSystem = {
  palette: {
    bg: '#f7f4ed',
    text: '#18202a',
    accent: '#315f8c',
    muted: '#68717a',
  },
  fonts: {
    display: 'Georgia, "Times New Roman", serif',
    body: '"Inter Variable", Inter, "Avenir Next", "Segoe UI", sans-serif',
  },
  typeScale: { hero: 156, body: 36 },
  radius: 24,
};

const Footer = () => {
  const { current, total } = useSlidePageNumber();
  return (
    <footer>
      <span>ACADEMIC MINIMAL</span>
      <span>{current} / {total}</span>
    </footer>
  );
};

const Cover: Page = () => (
  <div style={{ width: '100%', height: '100%' }}>
    {/* Demonstrate the real theme components and styles here. */}
    <Footer />
  </div>
);

const Content: Page = () => (
  <div style={{ width: '100%', height: '100%' }}>
    {/* Demonstrate body type, spacing, surfaces, and accents here. */}
    <Footer />
  </div>
);

export default [Cover, Content] satisfies Page[];
```

Use the actual palette, typography, layout, and components from the markdown rather than the placeholder comments above.
Inline the same Title, Footer, Eyebrow, and other fixed components verbatim so the preview matches what future decks will use.
Demonstrate a cover and at least one content composition.
Use a third page only when it communicates an important additional layout.
Do not import from `@/`, `slides/`, or another theme, and do not rely on local assets.

## Validate the bundle

Before finishing:

- Re-read both files and confirm that their stems match.
- Confirm that the markdown frontmatter contains a human-readable `name` and one-line `description`.
- Confirm that the markdown and demo use the same palette, typography, fixed components, and motion direction.
- Confirm that the demo default-exports a non-empty `Page[]` and every page root fills the 1920 × 1080 canvas.
- Confirm that all visible preview content fits without scrolling or cropping.
- Confirm that no dependency, real deck, configuration file, or unrelated theme changed.

Tell the user the theme id and both paths when complete.
Explain that it appears immediately in Open Slide's Themes screen and can be applied by asking the Lattice AI to create a presentation using that theme.
