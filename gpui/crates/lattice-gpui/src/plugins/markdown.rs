//! A message result's Markdown (CommonMark, no raw HTML) as the palette's
//! scrollable block, as the Tauri app renders it (`plugin-markdown.tsx`,
//! react-markdown with `skipHtml`): headings, paragraphs, lists, quotes,
//! code, emphasis and http(s) links, which open in the browser. Raw HTML is
//! never interpreted: its source shows as text.

use std::ops::Range;

use gpui::{
    AnyElement, App, FontStyle, HighlightStyle, InteractiveText, IntoElement, ParentElement as _,
    SharedString, StrikethroughStyle, Styled as _, StyledText, UnderlineStyle, div, px,
};
use lattice_ui::{ActiveLattice as _, TextRole, TextRoleStyle as _, tokens::FONT_WEIGHT_SEMIBOLD};
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mark {
    Strong,
    Emphasis,
    Code,
    Strike,
    Link,
}

/// A run of text with its marks, and the links in it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Inline {
    pub text: String,
    pub marks: Vec<(Range<usize>, Mark)>,
    pub links: Vec<(Range<usize>, String)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Block {
    Heading(Inline),
    Paragraph(Inline),
    Quote(Inline),
    /// A list item at `depth` (0 outermost) with its marker.
    Item {
        depth: usize,
        marker: String,
        text: Inline,
    },
    Code(String),
    Rule,
}

enum Open {
    Paragraph,
    Heading,
    Item { depth: usize, marker: String },
}

#[derive(Default)]
struct Builder {
    blocks: Vec<Block>,
    open: Option<(Open, Inline)>,
    code: Option<String>,
    lists: Vec<Option<u64>>,
    quotes: usize,
    marks: Vec<(usize, Mark, Option<String>)>,
}

impl Builder {
    fn flush(&mut self) {
        let Some((open, mut text)) = self.open.take() else {
            return;
        };
        let trimmed = text.text.trim_end().len();
        text.text.truncate(trimmed);
        if text.text.trim().is_empty() && !matches!(open, Open::Item { .. }) {
            return;
        }
        self.blocks.push(match open {
            Open::Heading => Block::Heading(text),
            Open::Paragraph if self.quotes > 0 => Block::Quote(text),
            Open::Paragraph => Block::Paragraph(text),
            Open::Item { depth, marker } => Block::Item {
                depth,
                marker,
                text,
            },
        });
    }

    fn inline(&mut self) -> &mut Inline {
        &mut self
            .open
            .get_or_insert_with(|| (Open::Paragraph, Inline::default()))
            .1
    }

    fn push(&mut self, text: &str) {
        if let Some(code) = &mut self.code {
            code.push_str(text);
            return;
        }
        self.inline().text.push_str(text);
    }

    fn start_mark(&mut self, mark: Mark, link: Option<String>) {
        let at = self.inline().text.len();
        self.marks.push((at, mark, link));
    }

    fn end_mark(&mut self) {
        let Some((from, mark, link)) = self.marks.pop() else {
            return;
        };
        let inline = self.inline();
        let to = inline.text.len();
        if from < to {
            inline.marks.push((from..to, mark));
            if let Some(url) = link {
                inline.links.push((from..to, url));
            }
        }
    }
}

/// Whether a link may open: http(s) only, as the host checks actions.
fn openable(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://")
}

/// `markdown` as blocks.
pub fn parse(markdown: &str) -> Vec<Block> {
    let mut b = Builder::default();
    let options = Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    for event in Parser::new_ext(markdown, options) {
        match event {
            Event::Start(Tag::Paragraph) => {
                let continues_item = matches!(&b.open, Some((Open::Item { .. }, _)));
                if continues_item {
                    let inline = b.inline();
                    if !inline.text.is_empty() {
                        inline.text.push('\n');
                    }
                } else {
                    b.flush();
                    b.open = Some((Open::Paragraph, Inline::default()));
                }
            }
            Event::End(TagEnd::Paragraph) => {
                if matches!(&b.open, Some((Open::Paragraph, _))) {
                    b.flush();
                }
            }
            Event::Start(Tag::Heading { .. }) => {
                b.flush();
                b.open = Some((Open::Heading, Inline::default()));
            }
            Event::End(TagEnd::Heading(_)) => b.flush(),
            Event::Start(Tag::CodeBlock(_)) => {
                b.flush();
                b.code = Some(String::new());
            }
            Event::End(TagEnd::CodeBlock) => {
                if let Some(code) = b.code.take() {
                    b.blocks
                        .push(Block::Code(code.trim_end_matches('\n').to_string()));
                }
            }
            Event::Start(Tag::List(start)) => {
                b.flush();
                b.lists.push(start);
            }
            Event::End(TagEnd::List(_)) => {
                b.flush();
                b.lists.pop();
            }
            Event::Start(Tag::Item) => {
                b.flush();
                let depth = b.lists.len().saturating_sub(1);
                let marker = match b.lists.last_mut() {
                    Some(Some(number)) => {
                        let marker = format!("{number}.");
                        *number += 1;
                        marker
                    }
                    _ => "•".to_string(),
                };
                b.open = Some((Open::Item { depth, marker }, Inline::default()));
            }
            Event::End(TagEnd::Item) => b.flush(),
            Event::Start(Tag::BlockQuote(_)) => {
                b.flush();
                b.quotes += 1;
            }
            Event::End(TagEnd::BlockQuote(_)) => {
                b.flush();
                b.quotes = b.quotes.saturating_sub(1);
            }
            Event::Start(Tag::Strong) => b.start_mark(Mark::Strong, None),
            Event::Start(Tag::Emphasis) => b.start_mark(Mark::Emphasis, None),
            Event::Start(Tag::Strikethrough) => b.start_mark(Mark::Strike, None),
            Event::Start(Tag::Link { dest_url, .. }) => {
                let url = dest_url.to_string();
                let link = openable(&url).then_some(url);
                b.start_mark(Mark::Link, link);
            }
            Event::End(
                TagEnd::Strong | TagEnd::Emphasis | TagEnd::Strikethrough | TagEnd::Link,
            ) => b.end_mark(),
            Event::Code(text) => {
                b.start_mark(Mark::Code, None);
                b.push(&text);
                b.end_mark();
            }
            Event::Text(text) => b.push(&text),
            // Raw HTML stays its source, never markup.
            Event::Html(text) | Event::InlineHtml(text) => b.push(&text),
            Event::SoftBreak => b.push(" "),
            Event::HardBreak => b.push("\n"),
            Event::Rule => {
                b.flush();
                b.blocks.push(Block::Rule);
            }
            Event::TaskListMarker(done) => b.push(if done { "☑ " } else { "☐ " }),
            _ => {}
        }
    }
    b.flush();
    b.blocks
}

fn styled(id: SharedString, inline: &Inline, cx: &App) -> AnyElement {
    let palette = cx.palette();
    let highlights: Vec<(Range<usize>, HighlightStyle)> = inline
        .marks
        .iter()
        .map(|(range, mark)| {
            let style = match mark {
                Mark::Strong => HighlightStyle {
                    font_weight: Some(FONT_WEIGHT_SEMIBOLD),
                    ..Default::default()
                },
                Mark::Emphasis => HighlightStyle {
                    font_style: Some(FontStyle::Italic),
                    ..Default::default()
                },
                Mark::Code => HighlightStyle {
                    background_color: Some(palette.hover),
                    ..Default::default()
                },
                Mark::Strike => HighlightStyle {
                    strikethrough: Some(StrikethroughStyle {
                        thickness: px(1.),
                        color: None,
                    }),
                    ..Default::default()
                },
                Mark::Link => HighlightStyle {
                    color: Some(palette.accent),
                    underline: Some(UnderlineStyle {
                        thickness: px(1.),
                        color: None,
                        wavy: false,
                    }),
                    ..Default::default()
                },
            };
            (range.clone(), style)
        })
        .collect();
    let text = StyledText::new(SharedString::from(inline.text.clone())).with_highlights(highlights);
    if inline.links.is_empty() {
        return text.into_any_element();
    }
    let ranges: Vec<Range<usize>> = inline
        .links
        .iter()
        .map(|(range, _)| range.clone())
        .collect();
    let urls: Vec<String> = inline.links.iter().map(|(_, url)| url.clone()).collect();
    InteractiveText::new(id, text)
        .on_click(ranges, move |index, _, cx| {
            if let Some(url) = urls.get(index) {
                cx.open_url(url);
            }
        })
        .into_any_element()
}

/// `blocks` drawn, keyed by `id`.
pub fn render(id: &str, blocks: &[Block], cx: &App) -> AnyElement {
    let palette = cx.palette().clone();
    let mono = cx.lattice().fonts.editor.clone();
    div()
        .flex()
        .flex_col()
        .gap(px(8.))
        .text_role(TextRole::Body, cx)
        .text_color(palette.text)
        .children(blocks.iter().enumerate().map(|(index, block)| {
            let key = SharedString::from(format!("{id}-{index}"));
            match block {
                Block::Heading(text) => div()
                    .pt(px(if index == 0 { 0. } else { 4. }))
                    .text_role(TextRole::Subtitle, cx)
                    .font_weight(FONT_WEIGHT_SEMIBOLD)
                    .child(styled(key, text, cx))
                    .into_any_element(),
                Block::Paragraph(text) => div().child(styled(key, text, cx)).into_any_element(),
                Block::Quote(text) => div()
                    .pl(px(10.))
                    .border_l_2()
                    .border_color(palette.line_strong)
                    .text_color(palette.text_secondary)
                    .child(styled(key, text, cx))
                    .into_any_element(),
                Block::Item {
                    depth,
                    marker,
                    text,
                } => div()
                    .flex()
                    .gap(px(6.))
                    .pl(px(*depth as f32 * 16.))
                    .child(
                        div()
                            .flex_none()
                            .min_w(px(14.))
                            .text_color(palette.text_secondary)
                            .child(marker.clone()),
                    )
                    .child(div().flex_1().min_w_0().child(styled(key, text, cx)))
                    .into_any_element(),
                Block::Code(code) => div()
                    .p(px(8.))
                    .rounded(px(6.))
                    .bg(palette.hover)
                    .font_family(mono.clone())
                    .text_role(TextRole::Caption, cx)
                    .child(code.clone())
                    .into_any_element(),
                Block::Rule => div().h(px(1.)).bg(palette.line).into_any_element(),
            }
        }))
        .into_any_element()
}
