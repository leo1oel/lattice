---
name: authoring-presentations
display-name: Presentation Authoring
short-description: Create clear Reveal.js slide decks in Lattice's supported Markdown format.
description: Creates and edits Lattice Reveal.js presentations stored as .slides.md files. Use when a user asks to make or revise slides, a deck, presentation, PPT, PPTX, PowerPoint, 演示文稿, or 幻灯片 content, speaker notes, slide images, code examples, or presentation structure in Lattice.
---

# Authoring Lattice presentations

Create and revise `.slides.md` decks that render correctly in Lattice's Reveal.js presentation editor.
Treat the Lattice dialect in this skill as authoritative even when upstream Reveal.js supports additional HTML, attributes, configuration, or plugins.

## Work on the source deck

- When the active editor path ends in `.slides.md`, read that file before planning or editing it.
- When a user asks for a presentation, PPT, PowerPoint, deck, slides, 演示文稿, or 幻灯片 without naming an output format, create a descriptive `.slides.md` file in Lattice's native Reveal.js Markdown format.
- Never create `.pptx` or HTML as a substitute for a Lattice presentation.
- If the user explicitly requests a real `.pptx`, PowerPoint, or standalone HTML deliverable, explain that Lattice's presentation editor does not author that external format; ask whether they want the native `.slides.md` deck instead.
- When creating a native deck, use a descriptive filename ending in `.slides.md` and place it where the user requested.
- Edit the `.slides.md` source instead of a generated PDF.
- Preserve existing theme, transition, slide order, notes, image paths, and content outside the requested change unless changing them is necessary.
- Make targeted edits for revision requests rather than rewriting the whole deck.
- Never claim to have visually inspected or exported a deck unless the relevant tool or app action was actually used.

## Use the supported file format

Deck metadata is optional and may appear once at the very beginning:

```markdown
---
theme: lattice
transition: fade
---

# Presentation title

Subtitle or opening idea
```

The supported themes are exactly `lattice`, `paper`, and `midnight`.
The supported transitions are exactly `none`, `fade`, `slide`, `convex`, `concave`, and `zoom`.
Use `lattice` and `fade` by default when creating a deck unless the user requests another supported style.

Separate horizontal slides with a line containing only `---`:

```markdown
## Motivation

- First point
- Second point

---

## Method

Explain the method here.
```

A separator inside a fenced code block is code and does not start a new slide.
Lattice presentations are a flat sequence of horizontal slides, so do not create vertical slide stacks.

Put speaker notes at the end of a slide after a line containing exactly `Notes:`:

```markdown
## Result

Accuracy improved across all evaluated settings.

Notes:
Explain the evaluation setup before discussing the result.
Mention the main limitation if the audience asks about generalization.
```

Content after `Notes:` belongs to the notes and is not visible on the slide.
Use the exact capitalization `Notes:` and keep all visible slide content before it.

## Prefer portable Markdown

Use ordinary Markdown and GitHub Flavored Markdown for:

- Headings, paragraphs, emphasis, strong text, and strikethrough.
- Ordered and unordered lists.
- Blockquotes, links, and autolinks.
- Tables and task lists when they remain readable at presentation size.
- Inline code and fenced code blocks with a language identifier.
- Markdown images with useful alternative text.

Reference project images relative to the deck's directory:

```markdown
![Attention map](figures/attention-map.png)
![Result with spaces](<figures/Main Result.png>)
```

Prefer project-local images over remote URLs so the deck remains local-first and portable.
Confirm that every referenced local image exists, and never invent an asset path.
Lattice resolves local Markdown images in the main preview and uses the first image when representing a slide in the navigator.
Lattice automatically centers an opening `#` title slide and gives later slides with a Markdown image a balanced image-and-text layout.
Keep one main image per slide so that automatic layout remains clear and predictable.

Use fenced code blocks for source examples:

````markdown
```python
scores = query @ keys.T
attention = softmax(scores, axis=-1)
```
````

Keep code short enough to read without horizontal scrolling or tiny text.

## Stay inside Lattice's Reveal.js subset

Do not use arbitrary `<style>` or `<script>` blocks, inline CSS, custom classes, or JavaScript.
Do not use raw Reveal.js section attributes such as `data-background`, `data-transition`, or `data-auto-animate`.
Do not use Markdown-plugin attribute comments such as `<!-- .element: ... -->` or `<!-- .slide: ... -->`.
Do not promise fragments, incremental bullet reveals, vertical slides, custom backgrounds, per-slide transitions, custom themes, layout helper classes, or extra Reveal.js plugins.
Do not add iframes, autoplay media, CDN dependencies, or third-party presentation scripts.
When a request requires an unsupported feature, explain the limitation briefly and approximate it with headings, lists, tables, code, and images, or ask before choosing a different source format.

## Build a useful deck

1. Identify the audience, purpose, desired length, source material, and whether the task is creation or revision.
2. Inspect the existing deck and relevant project assets before changing source.
3. Give each slide one clear job in the narrative, and order the slides so each one motivates the next.
4. Put the claim, question, or takeaway in the heading when possible.
5. Prefer concise visible content and move supporting detail, caveats, and delivery cues into `Notes:`.
6. Use a figure, table, or compact code example only when it explains the point more clearly than prose.
7. Preserve factual uncertainty, citations, terminology, numbers, and equations from the user's source material.
8. Split slides that are likely to overflow instead of shrinking their content or packing them with text.
9. Re-read the complete file after editing and check the deck structure before reporting completion.

For research presentations, a useful default narrative is motivation, question, approach, evidence, limitations, and takeaway.
Adapt that structure to the user's material instead of forcing every deck into the same template.

## Validate before finishing

Check all of the following:

- The filename ends in `.slides.md`.
- Frontmatter, when present, is the first block and contains only supported values for `theme` and `transition`.
- Every intended slide boundary is a standalone `---` line outside fenced code.
- Every notes block begins with the exact standalone marker `Notes:`.
- Local image paths resolve relative to the deck and point to existing files.
- The source contains no unsupported Reveal.js attributes, scripts, custom CSS, or plugin syntax.
- Headings, lists, tables, images, and code are concise enough for a 16:9 slide.
- The revised deck still preserves content the user did not ask to change.

Use Lattice's **Present** action for fullscreen playback and **Print / PDF** for export through the system print dialog.
Do not instruct the user to add `?print-pdf`, run DeckTape, start a web server, or install browser automation for a Lattice deck.

## Upstream references

- Reveal.js Markdown: <https://revealjs.com/markdown/>
- Reveal.js speaker notes: <https://revealjs.com/speaker-view/>
- Reveal.js transitions: <https://revealjs.com/transitions/>
- Reveal.js PDF export: <https://revealjs.com/pdf-export/>
- Official Reveal.js repository: <https://github.com/hakimel/reveal.js>

These references describe upstream Reveal.js, whose full feature set is broader than the Lattice subset documented above.
