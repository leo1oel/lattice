//! Cleanup of converter output, and the frontmatter conventions bundles share.

use super::ids::arxiv_base_id;
use regex::Regex;
use std::collections::HashMap;
use std::iter::Peekable;
use std::str::Split;

type Lines<'a> = Peekable<Split<'a, char>>;

/// The HTML conversion carries rendering artifacts the reader would show
/// verbatim: ar5iv's itemize glyph as list content ("- •"), prose
/// hard-wrapped at the source's line width, and a plain-text Contents
/// section. Fix the bytes once at import so every consumer — reader, agent,
/// full-text search — sees clean markdown.
pub(super) fn normalize_imported_markdown(markdown: &str) -> String {
    let collapsed = collapse_item_bullet_glyphs(markdown);
    let ordered = normalize_converter_ordered_items(&collapsed);
    let unwrapped = unwrap_hard_wrapped_paragraphs(&ordered);
    let separated = separate_adjacent_blocks(&unwrapped);
    link_contents_entries(&separated)
}

fn indent_of(line: &str) -> &str {
    &line[..line.len() - line.trim_start().len()]
}

fn is_fence(trimmed: &str) -> bool {
    trimmed.starts_with("```") || trimmed.starts_with("~~~")
}

/// Copy a leading YAML frontmatter block to `out` untouched, through the first
/// later line `closes` accepts.
fn pass_frontmatter(lines: &mut Lines, out: &mut Vec<String>, closes: fn(&str) -> bool) {
    if lines.peek() != Some(&"---") {
        return;
    }
    out.push(lines.next().unwrap().to_string());
    for line in lines.by_ref() {
        out.push(line.to_string());
        if closes(line) {
            break;
        }
    }
}

/// ar5iv marks every itemize entry with a literal "•" glyph, which the
/// conversion emits as the item's entire first line. Fold the real content up
/// into the marker so the reader shows one bullet instead of a bullet, a
/// glyph, and a line break.
fn collapse_item_bullet_glyphs(markdown: &str) -> String {
    let mut lines = markdown.split('\n').peekable();
    let mut out = Vec::new();
    while let Some(line) = lines.next() {
        let content = lines.next_if(|next| line.trim() == "- •" && !next.trim().is_empty());
        out.push(match content {
            Some(next) => format!("{}- {}", indent_of(line), next.trim_start()),
            None => line.to_string(),
        });
    }
    out.join("\n")
}

/// The number and the rest of the line when `trimmed` is a bullet whose only
/// content is an enumerate label: `- (1) …` or a bare `- 1.` / `- 1)`.
fn enumerate_label_in_bullet(trimmed: &str) -> Option<(&str, &str)> {
    if let Some(after_open) = trimmed.strip_prefix("- (") {
        let close = after_open.find(')')?;
        let (number, remainder) = (&after_open[..close], &after_open[close + 1..]);
        return (!number.is_empty()
            && number.chars().all(|ch| ch.is_ascii_digit())
            && (remainder.is_empty() || remainder.starts_with(char::is_whitespace)))
        .then_some((number, remainder));
    }
    let after_bullet = trimmed.strip_prefix("- ")?;
    let digits = after_bullet.chars().take_while(|ch| ch.is_ascii_digit()).count();
    let (number, after_number) = after_bullet.split_at(digits);
    let remainder = after_number.strip_prefix(['.', ')'])?;
    (!number.is_empty() && remainder.trim().is_empty()).then_some((number, remainder))
}

/// LaTeXML sometimes represents an enumerate label as text inside an
/// unordered item: `- (1)` or `- 1.`, followed by an indented or unindented
/// hard-wrapped body. Both produce a bullet and a number in the reader. Promote
/// the number to the Markdown marker and fold every prose continuation onto
/// the same item.
fn normalize_converter_ordered_items(markdown: &str) -> String {
    let mut lines = markdown.split('\n').peekable();
    let mut out = Vec::new();
    pass_frontmatter(&mut lines, &mut out, |line| line.trim_start() == "---");
    let mut in_code = false;
    while let Some(line) = lines.next() {
        let trimmed = line.trim_start();
        in_code ^= is_fence(trimmed);
        let label = if in_code { None } else { enumerate_label_in_bullet(trimmed) };
        let Some((number, remainder)) = label else {
            out.push(line.to_string());
            continue;
        };
        let indent = indent_of(line);
        let mut body = remainder.trim().to_string();
        while let Some(next) = lines.next_if(|next| {
            !next.trim().is_empty()
                && indent_of(next).len() >= indent.len()
                && !is_block_start(next.trim_start())
        }) {
            if !body.is_empty() {
                body.push(' ');
            }
            body.push_str(next.trim());
        }
        let separator = if body.is_empty() { "" } else { " " };
        out.push(format!("{indent}{number}.{separator}{body}"));
    }
    out.join("\n")
}

/// Anything that must not be glued onto the previous prose line.
fn is_block_start(line: &str) -> bool {
    let trimmed = line.trim_start();
    if trimmed.is_empty() {
        return true;
    }
    let ordered_item = {
        let digits = trimmed.chars().take_while(|c| c.is_ascii_digit()).count();
        digits > 0
            && trimmed[digits..].starts_with(['.', ')'])
            && trimmed[digits + 1..].chars().next().is_none_or(|c| c == ' ')
    };
    const BLOCK_PREFIXES: [&str; 15] =
        ["#", "- ", "* ", "+ ", ">", "|", "<", "![", "$$", "```", "~~~", "---", "===", "___", "[^"];
    trimmed == "-"
        || ordered_item
        || BLOCK_PREFIXES.iter().any(|prefix| trimmed.starts_with(prefix))
}

/// The converter hard-wraps paragraphs at the HTML source's line width, and
/// the visual editor faithfully renders those single newlines — so one
/// paragraph read as a stack of one-line fragments. Rejoin consecutive plain
/// prose lines. Structural lines (headings, lists, tables, quotes, HTML
/// anchors, math, fences), indented continuations, explicit hard breaks, and
/// the YAML frontmatter all pass through untouched.
fn unwrap_hard_wrapped_paragraphs(markdown: &str) -> String {
    let mut lines = markdown.split('\n').peekable();
    let mut out = Vec::new();
    pass_frontmatter(&mut lines, &mut out, |line| line == "---");
    let (mut in_code, mut in_math) = (false, false);
    for line in lines {
        let trimmed = line.trim_start();
        if is_fence(trimmed) {
            in_code = !in_code;
            out.push(line.to_string());
            continue;
        }
        if !in_code && trimmed == "$$" {
            in_math = !in_math;
            out.push(line.to_string());
            continue;
        }
        let continues_previous = !in_code
            && !in_math
            && !line.starts_with(char::is_whitespace)
            && !is_block_start(line)
            && out.last().is_some_and(|previous: &String| {
                !previous.starts_with(char::is_whitespace)
                    && !is_block_start(previous)
                    && !previous.ends_with("  ")
                    && !previous.ends_with('\\')
            });
        match out.last_mut() {
            Some(previous) if continues_previous => {
                previous.push(' ');
                previous.push_str(line.trim_end());
            }
            _ => out.push(line.to_string()),
        }
    }
    out.join("\n")
}

fn separate_adjacent_blocks(markdown: &str) -> String {
    let lines = markdown.split('\n').collect::<Vec<_>>();
    let mut normalized = Vec::with_capacity(lines.len() + 16);
    let mut in_display_math = false;
    for (index, line) in lines.iter().enumerate() {
        normalized.push((*line).to_string());
        in_display_math ^= *line == "$$";
        let needs_gap = lines.get(index + 1).is_some_and(|next| {
            let heading_before_list = line.starts_with('#') && next.starts_with("- ");
            heading_before_list || (!in_display_math && !line.is_empty() && *next == "$$")
        });
        if needs_gap {
            normalized.push(String::new());
        }
    }
    normalized.join("\n")
}

/// Rust twin of `headingSlug` (src/editor/markdown/heading-slug.ts): NFKD,
/// strip combining marks, lowercase, collapse non-alphanumeric runs into
/// single hyphens, trim edge hyphens. The two must stay in lockstep or
/// Contents links stop landing on their headings.
fn wiki_link_slug(text: &str) -> String {
    use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};
    let mut slug = String::new();
    let mut pending_hyphen = false;
    for ch in text.trim().nfkd().filter(|ch| !is_combining_mark(*ch)) {
        if ch.is_alphanumeric() {
            if pending_hyphen && !slug.is_empty() {
                slug.push('-');
            }
            pending_hyphen = false;
            slug.extend(ch.to_lowercase());
        } else {
            pending_hyphen = true;
        }
    }
    slug
}

/// The converter's "## Contents" section lists section names as plain text.
/// Rewrite every entry that names a real heading into an in-document link,
/// using the same slug (and duplicate suffixing, in document order) the
/// editor's HeadingAnchors decoration assigns — clicking an entry then
/// scrolls the reader to that section. Entries with no matching heading stay
/// plain text.
fn link_contents_entries(markdown: &str) -> String {
    let lines = markdown.split('\n').collect::<Vec<_>>();
    let mut slug_counts: HashMap<String, usize> = HashMap::new();
    let mut headings: Vec<(String, String)> = Vec::new();
    let mut in_code = false;
    for line in &lines {
        let trimmed = line.trim_start();
        if is_fence(trimmed) {
            in_code = !in_code;
            continue;
        }
        let level = trimmed.chars().take_while(|c| *c == '#').count();
        if in_code || !(1..=6).contains(&level) || !trimmed[level..].starts_with(' ') {
            continue;
        }
        let text = trimmed[level + 1..].trim().to_string();
        let base = wiki_link_slug(&text);
        if base.is_empty() {
            continue;
        }
        let count = slug_counts.entry(base.clone()).or_insert(0);
        let slug = if *count == 0 { base } else { format!("{base}-{count}") };
        *count += 1;
        headings.push((text, slug));
    }
    let Some(contents_at) = lines.iter().position(|line| *line == "## Contents") else {
        return markdown.to_string();
    };
    let mut consumed = vec![false; headings.len()];
    let mut out: Vec<String> = lines.iter().map(|line| line.to_string()).collect();
    for (offset, line) in lines[contents_at + 1..].iter().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() {
            continue;
        }
        let Some(text) = trimmed.strip_prefix("- ") else {
            break;
        };
        let text = text.trim();
        // Consume matches in order: the table of contents mirrors document
        // order, so duplicate section names resolve to distinct headings.
        let matched =
            headings.iter().enumerate().find(|(i, (heading, _))| !consumed[*i] && heading == text);
        if let Some((i, (_, slug))) = matched {
            consumed[i] = true;
            out[contents_at + 1 + offset] = format!("{}- [{text}](#{slug})", indent_of(line));
        }
    }
    out.join("\n")
}

/// arXiv's LaTeXML output inconsistently spells same-document links as either
/// `#S3.F1` or a complete, versioned arXiv URL. The converter preserves that
/// spelling, but a downloaded paper is a local document: make both source
/// shapes use the same fragment so clicking a section, figure, or table never
/// leaves the reader when the target was converted with it.
pub(super) fn localize_arxiv_fragment_links(markdown: &str, arxiv_id: &str) -> String {
    let base = regex::escape(arxiv_base_id(arxiv_id));
    let pattern = Regex::new(&format!(
        r"(?i)https?://(?:www\.)?arxiv\.org/html/{base}(?:v\d+)?(?P<fragment>#[A-Za-z][A-Za-z0-9_.:%-]*)"
    ))
    .unwrap();
    pattern.replace_all(markdown, "$fragment").into_owned()
}

/// Source conversion deliberately skips optional image runtimes. Keep every
/// caption, but do not leave broken source-relative links or raw TikZ programs
/// that dwarf the readable text.
pub(super) fn clean_arxiv_source_markdown(markdown: &str) -> String {
    let mut lines = markdown.split('\n').peekable();
    let mut cleaned = Vec::new();
    while let Some(line) = lines.next() {
        let figure_source = line.trim() == "<details>"
            && lines.peek().is_some_and(|summary| {
                let summary = summary.trim();
                summary.starts_with("<summary>Show ")
                    && summary.ends_with(" source</summary>")
                    && (summary.contains("TikZ") || summary.contains("PGFPlots"))
            });
        if figure_source {
            lines.find(|line| line.trim() == "</details>");
        } else {
            cleaned.push(rewrite_source_image(line));
        }
    }
    cleaned.join("\n")
}

fn rewrite_source_image(line: &str) -> String {
    let trimmed = line.trim_start();
    let Some(separator) = trimmed.rfind("](") else {
        return line.to_string();
    };
    if !trimmed.starts_with("![") || !trimmed.ends_with(')') {
        return line.to_string();
    }
    let target = &trimmed[separator + 2..trimmed.len() - 1];
    if target.contains("://") || target.starts_with("data:") || target.starts_with('#') {
        return line.to_string();
    }
    let indent = indent_of(line);
    match trimmed[2..separator].trim() {
        "" => format!("{indent}> **Figure unavailable in source conversion.**"),
        caption => format!("{indent}> **Figure:** {caption}"),
    }
}

/// Whether anything but YAML frontmatter is present. ar5iv serves a paper its
/// LaTeXML conversion choked on as an HTTP 200 stub, which arxiv2md turns into
/// a frontmatter-only file; that must not count as a paper.
pub(super) fn markdown_has_body(markdown: &str) -> bool {
    let mut lines = markdown.lines();
    if lines.next().is_some_and(|line| line.trim() == "---") {
        for line in &mut lines {
            if line.trim() == "---" {
                return lines.any(|body_line| !body_line.trim().is_empty());
            }
        }
        return false;
    }
    !markdown.trim().is_empty()
}

/// With --frontmatter, arxiv2md's clean title is the YAML `title:` field;
/// older output carried a plain `Title:` line, while the source converter
/// uses the document's first level-one heading. Prefer the frontmatter.
pub(super) fn parse_title(markdown: &str) -> Option<String> {
    yaml_frontmatter_title(markdown)
        .or_else(|| prefixed_line(markdown, "Title:"))
        .or_else(|| prefixed_line(markdown, "# "))
}

/// The rest of the first line starting with `prefix` that has any text.
pub(super) fn prefixed_line(markdown: &str, prefix: &str) -> Option<String> {
    markdown.lines().find_map(|line| {
        let text = line.strip_prefix(prefix)?.trim();
        (!text.is_empty()).then(|| text.to_string())
    })
}

fn yaml_frontmatter_title(markdown: &str) -> Option<String> {
    let mut lines = markdown.lines().map(str::trim);
    if lines.next()? != "---" {
        return None;
    }
    lines.take_while(|line| *line != "---").find_map(|line| {
        let value = line.strip_prefix("title:")?.trim().trim_matches('"').trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_converter_markdown_without_touching_latex_code_or_frontmatter() {
        for (source, expected) in [
            // Block structure: Contents gets separated, display math gets its
            // blank line, and LaTeX inside survives byte for byte.
            (
                "## Contents\n- Intro\n\n<a id=\"eq\"></a>\n$$\nx_{p} \\%\n$$\n\n- •\nContinuation with $x_{p}$\n",
                "## Contents\n\n- Intro\n\n<a id=\"eq\"></a>\n\n$$\nx_{p} \\%\n$$\n\n- Continuation with $x_{p}$\n",
            ),
            // Item bullet glyphs fold into their markers.
            (
                "- •\n  $p(\\textbf{x}|c)$. First item.\n- •\n  Second item.\n  - •\n    Nested item.\n",
                "- $p(\\textbf{x}|c)$. First item.\n- Second item.\n  - Nested item.\n",
            ),
            // Parenthesized enumerate glyphs become one ordered list instead
            // of two nested ones.
            (
                "- (1)\nConstrained visual capabilities:\nThe visual capacities are limited.\nDue to their smaller size, they can be a bottleneck.\n- (2)\nChallenges in efficient training and deployment:\nThe heterogeneous architecture reduces efficiency.\n\n- (aside) This remains a bullet.\n",
                "1. Constrained visual capabilities: The visual capacities are limited. Due to their smaller size, they can be a bottleneck.\n2. Challenges in efficient training and deployment: The heterogeneous architecture reduces efficiency.\n\n- (aside) This remains a bullet.\n",
            ),
            (
                "- •\n  (1)\n  Constrained visual capabilities.\n2. Existing ordered item.\n",
                "1. Constrained visual capabilities.\n2. Existing ordered item.\n",
            ),
            // Standalone bullet ordinals do too.
            ("- 1.\nFirst answer.\n- 2.\nSecond answer.\n", "1. First answer.\n2. Second answer.\n"),
            // Hard-wrapped paragraphs rejoin, but not structure.
            (
                "---\ntitle: \"T\"\nauthors: [\"A\", \"B\"]\n---\n\nOne sentence that was wrapped,\nand continues here.\nStill the same paragraph.\n\n## Heading stays\n\n- list item stays\n\n<a id=\"S1\"></a>\n\nNext paragraph after anchor,\nrejoined too.\n",
                "---\ntitle: \"T\"\nauthors: [\"A\", \"B\"]\n---\n\nOne sentence that was wrapped, and continues here. Still the same paragraph.\n\n## Heading stays\n\n- list item stays\n\n<a id=\"S1\"></a>\n\nNext paragraph after anchor, rejoined too.\n",
            ),
        ] {
            assert_eq!(normalize_imported_markdown(source), expected, "{source}");
        }
        // Samples inside frontmatter and fences, and display math, stay as-is.
        for unchanged in [
            "---\nexample:\n  - (3)\n---\n\n```md\n- (4)\n  Code sample.\n```\n",
            "---\nexample: - 3.\n---\n\n```md\n- 4.\nCode sample.\n```\n",
            "Before math\n\n$$\na = b\n+ c\n$$\n\n```\nline one\nline two\n```\n",
        ] {
            assert_eq!(normalize_imported_markdown(unchanged), unchanged);
        }
    }

    #[test]
    fn links_contents_entries_to_their_headings() {
        let source = "## Contents\n\n- 1 Introduction\n  - 1.1 Setup\n- Diffusion Models.\n- Diffusion Models.\n- No Such Section\n\n## 1 Introduction\n\n### 1.1 Setup\n\n#### Diffusion Models.\n\n#### Diffusion Models.\n";
        let normalized = normalize_imported_markdown(source);
        assert!(normalized.contains("- [1 Introduction](#1-introduction)"));
        assert!(normalized.contains("  - [1.1 Setup](#1-1-setup)"));
        // Duplicate section names consume headings in document order, with
        // the same numeric suffixing HeadingAnchors applies.
        assert!(normalized.contains("- [Diffusion Models.](#diffusion-models)\n"));
        assert!(normalized.contains("- [Diffusion Models.](#diffusion-models-1)"));
        // An entry with no matching heading stays plain text.
        assert!(normalized.contains("- No Such Section"));
    }

    #[test]
    fn slugs_match_the_editors_wiki_link_slugger() {
        for (text, slug) in [
            ("2.1 Conditional Video Generation", "2-1-conditional-video-generation"),
            ("Why Video?", "why-video"),
            ("Simulating the SE(3) Action Space", "simulating-the-se-3-action-space"),
            // NFKD + combining-mark stripping, as in toWikiLinkSlug.
            ("Café Décor", "cafe-decor"),
            ("  --- ", ""),
        ] {
            assert_eq!(wiki_link_slug(text), slug);
        }
    }

    #[test]
    fn same_paper_arxiv_links_become_local_fragments() {
        let markdown = concat!(
            "See [Figure 10(a)](https://arxiv.org/html/2407.06438v3#S7.F10.sf1), ",
            "[the paper](https://arxiv.org/html/2407.06438v3), and ",
            "[another paper](https://arxiv.org/html/2407.00001#S1).\n",
        );
        assert_eq!(
            localize_arxiv_fragment_links(markdown, "2407.06438"),
            concat!(
                "See [Figure 10(a)](#S7.F10.sf1), ",
                "[the paper](https://arxiv.org/html/2407.06438v3), and ",
                "[another paper](https://arxiv.org/html/2407.00001#S1).\n",
            )
        );
    }

    #[test]
    fn extracts_the_paper_title_from_each_converters_markdown() {
        for (markdown, title) in [
            ("Title: Attention Is All You Need\nArXiv: 1706.03762\n", "Attention Is All You Need"),
            (
                "# Unveiling the Visual Counting Bottleneck\n\n## Abstract\n",
                "Unveiling the Visual Counting Bottleneck",
            ),
            (
                "---\ntitle: \"Attention Is All You Need\"\nsections: 28\n---\n\n## Contents\n",
                "Attention Is All You Need",
            ),
        ] {
            assert_eq!(parse_title(markdown).as_deref(), Some(title));
        }
    }

    /// The frontmatter-only file arxiv2md writes for an ar5iv failed-
    /// conversion stub (HTTP 200, "Untitled Document", zero sections) must
    /// read as bodyless — that is what routes an exit-0 empty conversion to
    /// the fallbacks instead of caching a paper with no text.
    #[test]
    fn ar5iv_stub_output_has_no_body() {
        let stub = "---\ntitle: \"[2408.05088] Untitled Document\"\nurl: \"https://arxiv.org/abs/2408.05088\"\nsections: 0\nestimated_tokens: \"2\"\n---\n";
        assert!(!markdown_has_body(stub));
        assert!(markdown_has_body("---\ntitle: \"A Paper\"\n---\n\nA real body.\n"));
    }
}
